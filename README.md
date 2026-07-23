# MNQ 09-26 Strategy Dashboard

**Live site:** https://mnq0926-dashboard.vercel.app

> First-time setup: in the Vercel dashboard open the project → **Settings →
> Deployment Protection → Vercel Authentication → Disabled**. New Vercel
> projects are login-protected by default; until you disable it, only your
> Vercel account can view the site and the NinjaTrader exporter's pushes to
> `/api/bars` are rejected.

A TradingView-style charting website for the **Micro E-mini Nasdaq-100 September 2026**
futures contract (MNQ 09-26), fed by your own NinjaTrader/Apex real-time data.
It overlays **ORB** (Opening Range Breakout), **FVG** (Fair Value Gaps) and
**engulfing-candle** signals, and explains — in plain English, on the page —
whether current price action reads as a **buying run or a selling run**, while
teaching you how to read each candle (click any candle).

## How data flows

```
NinjaTrader (your machine, real-time Apex feed)
  └─ MNQWebExporter indicator
       ├─ serves ticks at http://localhost:8077/data   ← LIVE mode (tick-by-tick)
       └─ POSTs snapshot to <site>/api/bars every 30s  ← CLOUD mode (any device)

Website (Vercel)
  └─ tries local feed → cloud feed → simulated replay (clearly labelled)
```

- **LIVE (tick-by-tick):** open the site in a browser **on the machine running
  NinjaTrader**. The page polls the exporter's localhost endpoint every second
  and updates the developing candle tick by tick.
- **CLOUD (~30s):** from any other device, the chart uses the snapshots the
  exporter pushes to the site's API every 30 seconds.
- **SIMULATED:** if neither feed is available, the site generates a realistic
  replay and says so with a banner — it never silently fakes live data.

## Setup

### 1. Install the NinjaTrader exporter

1. NinjaTrader 8 → **New → NinjaScript Editor** → right-click **Indicators** →
   **Add New…**, name it `MNQWebExporter`.
2. Replace the generated file with [`ninjatrader/MNQWebExporter.cs`](ninjatrader/MNQWebExporter.cs)
   and press **F5** to compile.
3. Open a **1-minute chart of MNQ 09-26** and add the `MNQWebExporter` indicator.
4. In the indicator settings set:
   - **Cloud endpoint URL** — `https://<your-deployment>.vercel.app/api/bars`
   - **Secret token** — the same value as the `INGEST_TOKEN` env var on Vercel.
5. Leave the chart open; the NinjaScript Output window logs feed status.

If the local server can't start, run once in an elevated prompt:
`netsh http add urlacl url=http://localhost:8077/ user=Everyone`

### 2. Deploy the site (Vercel)

The repo is zero-config for Vercel: `public/` is served statically and
`api/bars.js` becomes a serverless function.

Recommended environment variables (Project → Settings → Environment Variables):

| Variable | Purpose |
| --- | --- |
| `INGEST_TOKEN` | Shared secret the exporter must present when pushing bars. **Set this** — until you do, the API accepts the placeholder token `change-me-mnq0926`. |
| `BLOB_READ_WRITE_TOKEN` | Optional. Create a Vercel Blob store to persist cloud snapshots across serverless cold starts. Without it, cloud data lives in warm-instance memory and may occasionally reset (LIVE mode is unaffected). |

### 3. Local development

```bash
npx vercel dev        # serves public/ + /api/bars on localhost:3000
```

## What's on the chart

- **Candles** — green = bullish close, blue = bearish close (10-minute default;
  1/5/10/15-minute selectable).
- **ORB** — amber band marking the first 5/15/30 minutes (configurable) after the
  9:30 AM ET equities open, with OR-high/OR-low rays. Arrows flag candle *closes*
  beyond the range; red dots flag failed breakouts that closed back inside.
- **FVG** — green/blue boxes marking 3-candle imbalances, extended right until
  price fills them; dimmed once price has partially tapped ("mitigated") them.
- **Engulfing markers** — the researched third confirmation tool. Chosen over pin
  bars and momentum candles because it's the most objective single-bar shift
  signal (one side's body fully absorbs the other's), and it's volume-aware:
  `engulf+vol` markers mean above-average participation.
- **Bias panel** — combines all three into **BUYING RUN / SELLING RUN /
  NEUTRAL–WAIT** with the reasoning spelled out against the actual candles.
- **Bias alerts (🔔)** — optional sound + tab flash + desktop notification when
  the verdict changes. Arms only on LIVE/CLOUD data, never on simulated replay.
- **Session open selector** — anchor the ORB to the 9:30 ET equities open or
  the 8:30 ET economic-news open.
- **Backtest scoreboard** — replays the loaded history through the ORB and
  engulfing rules (entries, stops, targets spelled out in the UI) and scores
  each setup with trade count, win rate, and net points. Scores computed on
  simulated data are clearly flagged. Fully automated order execution is
  deliberately out of scope: this tool has no broker connection, and prop-firm
  rules (including Apex's) prohibit unattended automated trading.
- **Candle school** — click any candle for a breakdown of its body, wicks, close
  location and volume, and what each says about buyers vs sellers.

## Repo layout

```
public/           static site (chart, strategies, UI)
api/bars.js       cloud ingest/read endpoint (serverless)
ninjatrader/      MNQWebExporter.cs — NinjaTrader 8 indicator
```

*Educational tool — not financial advice.*
