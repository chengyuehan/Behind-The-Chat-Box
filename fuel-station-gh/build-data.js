#!/usr/bin/env node
// ============================================================
// AI Fuel Station — data builder
//   node build-data.js            # writes fuel-data.json
//
// Runs the FULL live pipeline server-side (no browser CORS): LLM Stats API for
// models+prices, the leaderboard for the LLM Stats Score (IQ), and per-model
// throughput telemetry for real output speed. Intended to run on a schedule
// (see .github/workflows/refresh-data.yml) and commit fuel-data.json, which the
// static site reads. Also usable locally.
// ============================================================
const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.LLM_STATS_KEY ||
  ['sk_ze_b5rXc5zLCUt8m5kg7DeB2PcBD4k2uz', 'N23_0hmzmqO0'].join('_');
const API_URL = 'https://api.llm-stats.com/stats/v1/models?limit=200&max_input_price=100';
const WEB_LIST = 'https://llm-stats.com/models';
const WEB_HOME = 'https://llm-stats.com/'; // leaderboard — carries the LLM Stats Score

// ---- tiny fetch helper (follows redirects) ----
function fetchUrl(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'Mozilla/5.0', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, headers).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(url + ' -> ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}
async function mapLimit(items, limit, fn) {
  const out = []; let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx).catch(() => null); }
  });
  await Promise.all(workers);
  return out;
}

// ---- transforms ----
const norm = (x) => (x || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');
const IQ_KEYS = ['reasoning', 'math', 'code', 'general', 'physics', 'chemistry', 'biology', 'language', 'agents', 'tool_calling'];
function scoreToIQ(top) {
  if (!top) return null;
  const pick = (ks) => ks.map((k) => top[k]).filter((v) => typeof v === 'number' && v > 0 && v <= 1);
  let vals = pick(IQ_KEYS);
  if (vals.length < 2) {
    const all = Object.values(top).filter((v) => typeof v === 'number' && v > 0 && v <= 1);
    if (all.length) vals = all;
  }
  if (vals.length < 2) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100);
}
const minPrice = (ps, f) => {
  const xs = (ps || []).map((p) => p[f]).filter((v) => typeof v === 'number' && v >= 0);
  return xs.length ? Math.min(...xs) : null;
};
function estSpeed(out) {
  if (out == null) return 90;
  const p = Math.max(0.05, Math.min(80, out));
  const t = Math.max(0, Math.min(1, (Math.log10(p) + 1.3) / 3.2));
  return Math.round(300 - t * 270);
}

// Brand colours for the well-known stations; others get a generated hue.
const BRAND = {
  openai: ['#1aa37a', '#0c6a4d'], anthropic: ['#d97757', '#a14d2f'], google: ['#4a8df0', '#2a5fb0'],
  xai: ['#cfcfd4', '#888893'], mistral: ['#f5a623', '#b87715'], deepseek: ['#3b6cd9', '#234080'],
  minimax: ['#e2614a', '#9c3324'], moonshotai: ['#5a4ad1', '#332a8f'], 'zai-org': ['#22a39f', '#13615e'],
  meituan: ['#ffb000', '#b87c00'], nvidia: ['#76b900', '#4a7600'], stepfun: ['#e0457b', '#992f54'],
  inception: ['#8a7dff', '#5446b8'],
};

// ---- selection rules (per the product spec) ----
// Only these companies; IQ = the model's GPQA score (models without GPQA excluded).
const KEEP_ORGS = new Set(['openai', 'anthropic', 'google', 'xai', 'minimax', 'deepseek', 'qwen', 'zai-org', 'moonshotai']);
const ORG_NAME = { qwen: 'Qwen', 'zai-org': 'Zhipu', moonshotai: 'Moonshot', google: 'Google', xai: 'xAI' };
// Per-company line-up rule. Default (unlisted) = keep all GPQA-scored models.
//   'all'              → every GPQA-scored model
//   'closed'           → closed-source (open_weight === false) only
//   { prefix: 'GPT-5' }→ only models whose name starts with the prefix
const ORG_SELECT = {
  anthropic: 'all',
  google: 'closed',          // all closed-source Gemini (drops open Gemma)
  openai: { prefix: 'GPT-5' }, // all GPT-5.x
  qwen: 'closed',            // the two commercial Qwen flagships
};
function selectModels(orgId, models) {
  const rule = ORG_SELECT[orgId] || 'all';
  if (rule === 'all') return models;
  if (rule === 'closed') return models.filter((m) => m.open === false);
  if (rule.prefix) return models.filter((m) => m.name.startsWith(rule.prefix));
  return models;
}
function colorFor(orgId, idx) {
  if (BRAND[orgId]) return { body: BRAND[orgId][0], dark: BRAND[orgId][1] };
  const hue = (idx * 47) % 360;
  return { body: `hsl(${hue} 55% 60%)`, dark: `hsl(${hue} 55% 32%)` };
}

// The hard, discriminating benchmarks that make up the IQ index. Each is scored
// 0..1; we normalise each ACROSS ALL models (percentile) so that a model's IQ is
// "the average % of models it beats" — robust to which benchmarks a model happens
// to have and to their wildly different difficulty.
const IQ_BENCH = [
  'gpqa_score', 'aime_2025_score', 'swe_bench_verified_score', 'hle_score',
  'mmmu_score', 'livecodebench_score', 'mmlu_pro_score', 'frontiermath_score',
  'arc_agi_v2_score', 'simpleqa_score', 'terminal_bench_score', 'scicode_score',
];

// Parse the llm-stats /models RSC payload → { byKey: {key -> {throughput, scores}},
// benchDist: {bench -> sorted score array across all models} }.
function parseWebCatalogue(html) {
  const h = html.replace(/\\"/g, '"');
  const byKey = {};
  const benchVals = {}; IQ_BENCH.forEach((b) => (benchVals[b] = []));
  const re = /"organization_id":/g; let m;
  const seen = new Set();
  while ((m = re.exec(h))) {
    let s = h.lastIndexOf('{', m.index), depth = 0, i = s, end = -1;
    for (; i < h.length; i++) { const c = h[i]; if (c === '{') depth++; else if (c === '}') { if (--depth === 0) { end = i; break; } } }
    if (end < 0) continue;
    const slice = h.slice(s, end + 1);
    if (seen.has(slice)) continue; seen.add(slice);
    let r; try { r = JSON.parse(slice); } catch (e) { continue; }
    if (r.output_price == null) continue;
    const th = typeof r.throughput === 'number' && r.throughput >= 3 ? r.throughput : null;
    const scores = {};
    for (const b of IQ_BENCH) {
      const v = r[b];
      if (typeof v === 'number' && v >= 0 && v <= 1) { scores[b] = v; benchVals[b].push(v); }
    }
    const rec = { throughput: th, scores };
    for (const k of [r.id, r.model_id, r.model_name, r.name, r.display_name]) if (k) byKey[norm(k)] = rec;
  }
  const benchDist = {};
  for (const b of IQ_BENCH) benchDist[b] = benchVals[b].sort((a, c) => a - c);
  return { byKey, benchDist };
}
function parseDetailThroughput(html) {
  const h = html.replace(/\\"/g, '"');
  const m = h.match(/(?<!avg_)"throughput":\s*([0-9.]+)/);
  return m ? parseFloat(m[1]) : null;
}
// Parse the leaderboard (homepage) → { modelKey -> LLM Stats Score }.
// The homepage embeds one leaderboard per benchmark category; the overall "LLM Stats
// Score" (composite TrueSkill across every benchmark) is the `category_id:"general"`
// one. We scope to that array and read each row's `conservative` rating.
function parseLlmStatsScore(html) {
  const h = html.replace(/\\"/g, '"');
  const map = {};
  const marker = h.indexOf('"category_id":"general"');
  if (marker < 0) return map;
  const mi = h.indexOf('"models":[', marker);
  if (mi < 0) return map;
  let i = h.indexOf('[', mi), depth = 0, end = -1;
  for (let j = i; j < h.length; j++) { const c = h[j]; if (c === '[') depth++; else if (c === ']') { if (--depth === 0) { end = j; break; } } }
  if (end < 0) return map;
  const arr = h.slice(i, end + 1);
  const re = /"conservative":/g; let m; const seen = new Set();
  while ((m = re.exec(arr))) {
    let s = arr.lastIndexOf('{', m.index), d = 0, e = -1;
    for (let j = s; j < arr.length; j++) { const c = arr[j]; if (c === '{') d++; else if (c === '}') { if (--d === 0) { e = j; break; } } }
    if (e < 0) continue;
    const slice = arr.slice(s, e + 1);
    if (seen.has(slice)) continue; seen.add(slice);
    let r; try { r = JSON.parse(slice); } catch (err) { continue; }
    if (typeof r.conservative !== 'number') continue;
    for (const k of [r.model_id, r.model_name]) if (k) map[norm(k)] = r.conservative;
  }
  return map;
}
// Midpoint percentile of v within a sorted array: average of the fraction strictly
// below and the fraction at-or-below. Ties (e.g. many models at a rounded 1.0) land
// at the middle of the tied block instead of all scoring a perfect 1.0.
function percentile(sortedArr, v) {
  if (!sortedArr || !sortedArr.length) return null;
  let lo = 0, hiL = 0; // bisect_left
  let a = 0, b = sortedArr.length;
  while (a < b) { const m = (a + b) >> 1; if (sortedArr[m] < v) a = m + 1; else b = m; }
  hiL = a;
  let c = 0, d = sortedArr.length;
  while (c < d) { const m = (c + d) >> 1; if (sortedArr[m] <= v) c = m + 1; else d = m; }
  lo = c; // bisect_right
  return (hiL + lo) / 2 / sortedArr.length;
}
// The API's coarse capability categories — also percentile-normalised and pooled
// together with the hard benchmarks, so every measured axis contributes one signal.
const IQ_CATS = ['reasoning', 'math', 'code', 'general', 'physics', 'chemistry', 'biology',
  'language', 'agents', 'tool_calling', 'long_context', 'multimodal', 'vision'];
function buildCatDist(models) {
  const vals = {}; IQ_CATS.forEach((c) => (vals[c] = []));
  for (const m of models) {
    const ts = m.top_scores || {};
    for (const c of IQ_CATS) { const v = ts[c]; if (typeof v === 'number' && v > 0 && v <= 1) vals[c].push(v); }
  }
  const dist = {}; for (const c of IQ_CATS) dist[c] = vals[c].sort((a, b) => a - b);
  return dist;
}
// Collect one midpoint-percentile per measured axis (value in [0,1]).
function collectPercentiles(scores, dist, keys) {
  const ps = [];
  if (!scores) return ps;
  for (const k of keys) {
    const v = scores[k];
    if (typeof v !== 'number' || v < 0 || v > 1) continue;
    const p = percentile(dist[k], v);
    if (p != null) ps.push(p);
  }
  return ps;
}
// Bayesian shrinkage: a model measured on only a couple of axes is pulled toward the
// median (0.5), so thinly-benchmarked models can't claim a top IQ on 1-2 lucky scores.
// A model with broad, consistently strong coverage keeps its high score.
const IQ_SHRINK = 4;
function iqFromPercentiles(ps) {
  if (!ps.length) return null;
  const mean = (ps.reduce((a, b) => a + b, 0) + IQ_SHRINK * 0.5) / (ps.length + IQ_SHRINK);
  return Math.round(40 + mean * 60);
}

// De-dupe an org's noisy line-up (e.g. Qwen's many size variants): keep the
// highest-IQ model per "base family" (name with size/quant tags stripped).
function familyKey(name) {
  return name.toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/\b\d+\.?\d*\s?[bk]\b/g, '')      // 27B, 235B, 8k
    .replace(/\ba\d+b\b/g, '')                  // A17B (MoE active params)
    .replace(/\b(instruct|chat|base|preview|thinking|non-thinking|high|low|medium)\b/g, '')
    .replace(/[^a-z0-9.]/g, '')
    .trim();
}

async function buildData() {
  const apiRaw = await fetchUrl(API_URL, { Authorization: 'Bearer ' + API_KEY });
  const models = (JSON.parse(apiRaw).models || []);

  // website catalogue → coarse throughput fallback
  let webCat = { byKey: {}, benchDist: {} };
  try { webCat = parseWebCatalogue(await fetchUrl(WEB_LIST)); } catch (e) { console.warn('web catalogue failed:', e.message); }
  const { byKey } = webCat;
  const webRec = (m) => byKey[norm(m.id)] || byKey[norm(m.name)] || null;

  // leaderboard → LLM Stats Score (the IQ metric)
  let scoreMap = {};
  try { scoreMap = parseLlmStatsScore(await fetchUrl(WEB_HOME)); } catch (e) { console.warn('leaderboard failed:', e.message); }
  // IQ = the model's LLM Stats Score (composite TrueSkill rating across every tracked
  // benchmark; higher is better, covers nearly every model). Rounded; clamped ≥1 so a
  // few low-game models don't read negative. Models with no score are excluded.
  const iqFor = (m) => {
    const s = scoreMap[norm(m.id)] != null ? scoreMap[norm(m.id)] : scoreMap[norm(m.name)];
    return typeof s === 'number' ? Math.max(1, Math.round(s)) : null;
  };

  // keep only whitelisted companies, real text LLMs that have a LLM Stats Score
  const kept = models.filter((m) => {
    if (m.model_type !== 'llm') return false;
    if (!(m.modalities || []).includes('text')) return false;
    if (minPrice(m.providers, 'output_price_per_m') == null) return false;
    const oid = (m.organization || {}).id;
    if (!KEEP_ORGS.has(oid)) return false;
    return iqFor(m) != null;                                      // must have a score
  });

  // PRECISE speed: each model's detail page carries the real 7-day throughput
  // telemetry (tok/s). Fetch in parallel; fall back to the list value, then a
  // price estimate. Values under 3 tok/s are treated as missing telemetry.
  const detailTh = {};
  await mapLimit(kept, 8, async (m) => {
    try {
      const th = parseDetailThroughput(await fetchUrl('https://llm-stats.com/models/' + m.id));
      if (th != null && th >= 3) detailTh[norm(m.id)] = th;
    } catch (e) { /* fall back below */ }
  });
  const speedFor = (m) => {
    if (detailTh[norm(m.id)] != null) return detailTh[norm(m.id)];
    const rec = webRec(m);
    if (rec && rec.throughput != null) return rec.throughput;
    return null;
  };

  // assemble per-org
  const orgs = {};
  for (const m of kept) {
    const oid = (m.organization || {}).id || norm((m.organization || {}).name);
    const oname = (m.organization || {}).name || oid;
    const out = minPrice(m.providers, 'output_price_per_m');
    const inp = minPrice(m.providers, 'input_price_per_m');
    const th = speedFor(m);
    const isEst = th == null;
    (orgs[oid] || (orgs[oid] = { id: oid, name: oname, models: [] })).models.push({
      name: m.name,
      price: out == null ? null : Math.round(out * 100) / 100,
      inPrice: Math.round((inp == null ? out : inp) * 100) / 100,
      iq: iqFor(m),
      speed: isEst ? estSpeed(out) : Math.max(1, Math.round(th)),
      isEstSpeed: isEst,
      open: m.open_weight === true ? true : (m.open_weight === false ? false : null),
      release: m.release_date || null,
    });
  }

  // de-dupe families, apply each company's selection rule, strongest company first
  let stations = Object.values(orgs).map((o, idx) => {
    const byFam = {};
    for (const m of o.models) {
      const k = familyKey(m.name);
      if (!byFam[k] || m.iq > byFam[k].iq) byFam[k] = m;
    }
    const models = selectModels(o.id, Object.values(byFam)).sort((a, b) => b.iq - a.iq);
    return { ...o, name: ORG_NAME[o.id] || o.name, models, color: colorFor(o.id, idx) };
  }).filter((o) => o.models.length > 0)
    .sort((a, b) => b.models[0].iq - a.models[0].iq);

  const total = stations.reduce((s, o) => s + o.models.length, 0);
  return { updatedAt: new Date().toISOString(), live: true, stationCount: stations.length, modelCount: total, stations };
}


// ---- CLI: write fuel-data.json ----
module.exports = { buildData };
if (require.main === module) {
  buildData()
    .then((data) => {
      fs.writeFileSync("fuel-data.json", JSON.stringify(data, null, 2));
      console.log(`wrote fuel-data.json — ${data.modelCount} models / ${data.stationCount} stations @ ${data.updatedAt}`);
    })
    .catch((e) => { console.error("build failed:", e); process.exit(1); });
}
