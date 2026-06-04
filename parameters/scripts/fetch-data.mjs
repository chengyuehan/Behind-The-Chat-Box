// Runs in GitHub Actions (server-side — no CORS, key from a Secret), NOT in the
// browser. The parameter page needs param_count, which lives only on the LLM Stats
// `stats` catalog — an endpoint the browser is CORS-blocked from. So the Action
// fetches it here and writes a static JSON the page reads. (The context page doesn't
// need this: it fetches the CORS-enabled gateway directly in the browser.)
//
//   data/parameters.json  ← stats catalog: param_count + release_date + org
//
// Run:  LLM_STATS_KEY=sk_... node scripts/fetch-data.mjs

import { writeFile, mkdir } from "node:fs/promises";

const KEY = process.env.LLM_STATS_KEY;
if (!KEY) { console.error("Missing LLM_STATS_KEY env var"); process.exit(1); }

const STATS = "https://api.llm-stats.com/stats/v1/models";
const headers = { Authorization: `Bearer ${KEY}` };

async function getJSON(url) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

const all = [];
let cursor = null;
for (let i = 0; i < 10; i++) {
  const u = `${STATS}?limit=200` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
  const page = await getJSON(u);
  all.push(...(page.models || []));
  cursor = page.next_cursor;
  if (!cursor) break;
}

const models = all
  .filter((m) => m.param_count)
  .map((m) => ({
    name: (m.name || "").replace("  ", " ").trim(),
    params: Number(m.param_count),
    year: m.release_date ? Number(m.release_date.slice(0, 4)) : null,
    date: m.release_date || null,
    org: (m.organization || {}).name || null,
    open: !!m.open_weight,
  }));
models.sort((a, b) => a.params - b.params || a.name.localeCompare(b.name));

const fetched_at = Math.floor(Date.now() / 1000);
await mkdir("data", { recursive: true });
await writeFile("data/parameters.json", JSON.stringify({ models, fetched_at }));
console.log(`data/parameters.json: ${models.length} models`);
