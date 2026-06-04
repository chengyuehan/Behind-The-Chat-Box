# AI Fuel Station

Visualize AI API pricing as a fuel station: drag a model's nozzle onto the robot to
fuel it. The meter ticks by the model's **real output price** and **real output
speed**, and the robot's brain is sized by its **IQ**.

**Live demo:** enable GitHub Pages (see below) → `https://<you>.github.io/<repo>/`

## How the data works

All data comes from [LLM Stats](https://llm-stats.com). The catalogue can't be
fetched from the browser (the leaderboard/telemetry pages block cross-origin
requests), so `build-data.js` fetches everything **server-side** and writes a static
`fuel-data.json`. A scheduled GitHub Action re-runs it and commits the refreshed
snapshot; GitHub Pages serves the static site that reads it.

| Field | Source |
|---|---|
| company / model / input + output price | LLM Stats API (`api.llm-stats.com`) |
| **output speed** (tok/s) | per-model `throughput` telemetry (real; `~` = price estimate when missing) |
| **IQ** | the model's **LLM Stats Score** (composite TrueSkill across every benchmark) |

Which models show: OpenAI (all GPT‑5.x), Google (all closed Gemini), Anthropic (all),
xAI, MiniMax, Qwen (closed only), Zhipu, Moonshot, DeepSeek — only models that have a
LLM Stats Score.

## Deploy to GitHub Pages

1. Create a new GitHub repo and push these files to `main`.
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   branch **`main`**, folder **`/ (root)`**. Save.
3. **Settings → Actions → General → Workflow permissions: Read and write**
   (lets the scheduled job commit the refreshed `fuel-data.json`).
4. Open the **Actions** tab → run **“Refresh fuel data”** once (workflow_dispatch) to
   generate a fresh snapshot. After that it refreshes hourly on its own.
5. Visit `https://<you>.github.io/<repo>/`.

> The API key is embedded in `build-data.js` (it only runs in the Action / locally,
> never in the visitor's browser). To keep it out of the code, set a repo secret
> `LLM_STATS_KEY` and add `env: { LLM_STATS_KEY: ${{ secrets.LLM_STATS_KEY }} }` to the
> build step — `build-data.js` already reads `process.env.LLM_STATS_KEY` first.

## Run locally

```bash
node build-data.js     # refresh fuel-data.json
node server.js         # → http://localhost:8753  (also serves a live /api/fuel-data)
```

Node 18+ only, no dependencies.

## Files

- `index.html` — the app (reads `fuel-data.json`)
- `fuel-data.json` — the committed data snapshot
- `build-data.js` — fetches LLM Stats live → writes `fuel-data.json`
- `server.js` — optional local dev server
- `.github/workflows/refresh-data.yml` — hourly refresh + commit
