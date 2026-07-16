/* MNQ 09-26 strategy chart.
 *
 * Data sources, best first:
 *   1. local  — NinjaTrader exporter at http://127.0.0.1:8077 (tick-by-tick)
 *   2. cloud  — /api/bars snapshots pushed by the exporter every ~30s
 *   3. sim    — generated replay so the tools are explorable with no feed
 *
 * All strategy math runs on 1-minute base bars (ORB) or the displayed
 * aggregation (FVG, engulfing). Candles: green = bullish, blue = bearish.
 */

(() => {
  "use strict";

  const LOCAL_FEED = "http://127.0.0.1:8077/data";
  const CLOUD_FEED = "/api/bars";
  const TICK = 0.25;

  const COLORS = {
    bull: "#22c55e",
    bear: "#3b82f6",
    bullSoft: "rgba(34,197,94,0.28)",
    bearSoft: "rgba(59,130,246,0.28)",
    orb: "rgba(245,158,11,0.18)",
    orbLine: "#f59e0b",
    muted: "#8b98a9",
  };

  const state = {
    base1m: [],          // canonical 1-minute bars, ascending t (unix sec, bar open)
    last: null,          // {p, t} most recent trade
    source: "sim",       // local | cloud | sim
    lastDataAt: 0,       // ms clock of last successful feed event
    interval: 10,
    orbMinutes: 15,
    show: { orb: true, fvg: true, eng: true },
    alertsOn: false,
    displayed: [],       // aggregated bars currently on chart
    analysis: null,      // last strategy run
    localFails: 0,
    selectedTime: null,
  };

  // ---------- time helpers ----------

  const etFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });

  function etParts(unix) {
    const parts = {};
    for (const p of etFmt.formatToParts(new Date(unix * 1000))) parts[p.type] = p.value;
    return {
      wd: parts.weekday,
      y: +parts.year, mo: +parts.month, d: +parts.day,
      h: +parts.hour % 24, mi: +parts.minute,
    };
  }

  function etClock(unix) {
    const p = etParts(unix);
    return `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")} ET`;
  }

  // display times in the viewer's local timezone (lightweight-charts plots UTC)
  function dispTime(t) {
    return t - new Date(t * 1000).getTimezoneOffset() * 60;
  }
  function realTime(dt) {
    // invert dispTime; offset is stable enough within a session for our use
    return dt + new Date(dt * 1000).getTimezoneOffset() * 60;
  }

  function marketStatus(unix) {
    const p = etParts(unix);
    const mins = p.h * 60 + p.mi;
    if (p.wd === "Sat") return { open: false, label: "CLOSED — weekend" };
    if (p.wd === "Sun" && mins < 18 * 60) return { open: false, label: "CLOSED — opens 6 PM ET" };
    if (p.wd === "Fri" && mins >= 17 * 60) return { open: false, label: "CLOSED — weekend" };
    if (mins >= 17 * 60 && mins < 18 * 60) return { open: false, label: "HALT — daily 5–6 PM ET" };
    return { open: true, label: "MARKET OPEN" };
  }

  // Most recent weekday 9:30 ET at or before `unix`, as unix seconds.
  function latestSessionOpen(unix) {
    for (let back = 0; back < 7; back++) {
      const dayRef = unix - back * 86400;
      const p = etParts(dayRef);
      if (p.wd === "Sat" || p.wd === "Sun") continue;
      // walk to 9:30 ET of that ET calendar day
      const ref = etParts(dayRef);
      const deltaMin = (ref.h * 60 + ref.mi) - (9 * 60 + 30);
      const open = dayRef - deltaMin * 60 - (dayRef % 60);
      if (open <= unix) return open;
    }
    return null;
  }

  // ---------- aggregation ----------

  function aggregate(bars1m, intervalMin) {
    if (intervalMin === 1) return bars1m.slice();
    const size = intervalMin * 60;
    const out = [];
    let cur = null;
    for (const b of bars1m) {
      const bucket = Math.floor(b.t / size) * size;
      if (!cur || cur.t !== bucket) {
        if (cur) out.push(cur);
        cur = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      } else {
        cur.h = Math.max(cur.h, b.h);
        cur.l = Math.min(cur.l, b.l);
        cur.c = b.c;
        cur.v += b.v;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  // ---------- strategies ----------

  function computeORB(bars1m, orbMinutes) {
    if (!bars1m.length) return null;
    const lastT = bars1m[bars1m.length - 1].t;
    const open = latestSessionOpen(lastT);
    if (!open) return null;
    const end = open + orbMinutes * 60;
    const inRange = bars1m.filter((b) => b.t >= open && b.t < end);
    if (!inRange.length) return null;
    const hi = Math.max(...inRange.map((b) => b.h));
    const lo = Math.min(...inRange.map((b) => b.l));
    const after = bars1m.filter((b) => b.t >= end);

    const events = [];
    let stance = "inside"; // inside | above | below
    for (const b of after) {
      if (stance !== "above" && b.c > hi) {
        events.push({ type: "breakout-up", t: b.t, price: b.c });
        stance = "above";
      } else if (stance !== "below" && b.c < lo) {
        events.push({ type: "breakout-down", t: b.t, price: b.c });
        stance = "below";
      } else if (stance === "above" && b.c < hi) {
        events.push({ type: "failed-up", t: b.t, price: b.c });
        stance = "inside";
      } else if (stance === "below" && b.c > lo) {
        events.push({ type: "failed-down", t: b.t, price: b.c });
        stance = "inside";
      }
    }
    return { open, end, hi, lo, events, stance, formed: lastT >= end };
  }

  function computeFVGs(allBars) {
    const bars = allBars.slice(-150); // recent gaps only; ancient ones are noise
    const zones = [];
    for (let i = 2; i < bars.length; i++) {
      const a = bars[i - 2], c = bars[i];
      if (c.l > a.h + TICK / 2) {
        zones.push({ dir: "bull", top: c.l, bottom: a.h, t: bars[i - 1].t, filled: false, touched: false });
      } else if (c.h < a.l - TICK / 2) {
        zones.push({ dir: "bear", top: a.l, bottom: c.h, t: bars[i - 1].t, filled: false, touched: false });
      }
    }
    // fill / mitigation tracking with later bars
    for (const z of zones) {
      const idx = bars.findIndex((b) => b.t === z.t);
      for (let j = idx + 2; j < bars.length; j++) {
        const b = bars[j];
        if (z.dir === "bull") {
          if (b.l < z.top) z.touched = true;
          if (b.l <= z.bottom) { z.filled = true; break; }
        } else {
          if (b.h > z.bottom) z.touched = true;
          if (b.h >= z.top) { z.filled = true; break; }
        }
      }
    }
    return zones;
  }

  function computeEngulfing(bars) {
    const marks = [];
    if (bars.length < 22) return marks;
    for (let i = 21; i < bars.length; i++) {
      const p = bars[i - 1], b = bars[i];
      const avgV = bars.slice(i - 20, i).reduce((s, x) => s + x.v, 0) / 20;
      const volOk = avgV > 0 && b.v > 1.2 * avgV;
      const pBull = p.c > p.o, bBull = b.c > b.o;
      const engulfs = Math.max(b.o, b.c) >= Math.max(p.o, p.c) &&
                      Math.min(b.o, b.c) <= Math.min(p.o, p.c) &&
                      Math.abs(b.c - b.o) > Math.abs(p.c - p.o);
      if (!engulfs) continue;
      if (!pBull && bBull) marks.push({ t: b.t, dir: "bull", volOk });
      else if (pBull && !bBull) marks.push({ t: b.t, dir: "bear", volOk });
    }
    return marks;
  }

  function candleAnatomy(b) {
    const range = b.h - b.l;
    const body = Math.abs(b.c - b.o);
    const bull = b.c >= b.o;
    const upperWick = b.h - Math.max(b.o, b.c);
    const lowerWick = Math.min(b.o, b.c) - b.l;
    const closeLoc = range > 0 ? (b.c - b.l) / range : 0.5;
    return {
      bull, range, body,
      bodyPct: range > 0 ? body / range : 0,
      upperPct: range > 0 ? upperWick / range : 0,
      lowerPct: range > 0 ? lowerWick / range : 0,
      closeLoc,
    };
  }

  // ---------- bias engine ----------

  function runAnalysis() {
    const bars1m = state.base1m;
    const displayed = aggregate(bars1m, state.interval);
    state.displayed = displayed;
    if (displayed.length < 5) {
      state.analysis = null;
      return;
    }

    const orb = computeORB(bars1m, state.orbMinutes);
    const fvgs = computeFVGs(displayed);
    const engulfs = computeEngulfing(displayed);
    const price = state.last ? state.last.p : displayed[displayed.length - 1].c;

    let score = 0;
    const reasons = []; // {pro: bool, text}

    if (orb && orb.formed) {
      const lastEvent = orb.events[orb.events.length - 1];
      if (orb.stance === "above") {
        score += 2;
        reasons.push({ pro: true, text: `Price broke and is holding above the opening range high (${fmt(orb.hi)}). Buyers won the opening auction.` });
      } else if (orb.stance === "below") {
        score -= 2;
        reasons.push({ pro: false, text: `Price broke and is holding below the opening range low (${fmt(orb.lo)}). Sellers won the opening auction.` });
      } else if (lastEvent && lastEvent.type === "failed-up") {
        score -= 1;
        reasons.push({ pro: false, text: `Failed breakout above ${fmt(orb.hi)} at ${etClock(lastEvent.t)} — trapped buyers often fuel a move down.` });
      } else if (lastEvent && lastEvent.type === "failed-down") {
        score += 1;
        reasons.push({ pro: true, text: `Failed breakdown below ${fmt(orb.lo)} at ${etClock(lastEvent.t)} — trapped sellers often fuel a move up.` });
      } else {
        reasons.push({ pro: null, text: `Price is still inside the opening range (${fmt(orb.lo)}–${fmt(orb.hi)}). No breakout verdict yet.` });
      }
    } else if (orb) {
      reasons.push({ pro: null, text: `Opening range is still forming (until ${etClock(orb.end)}).` });
    }

    const open = fvgs.filter((z) => !z.filled);
    const support = open.filter((z) => z.dir === "bull" && z.top <= price).slice(-2);
    const resist = open.filter((z) => z.dir === "bear" && z.bottom >= price).slice(-2);
    for (const z of support) {
      score += 1;
      reasons.push({ pro: true, text: `Unfilled bullish FVG below price at ${fmt(z.bottom)}–${fmt(z.top)} — likely support if price pulls back.` });
    }
    for (const z of resist) {
      score -= 1;
      reasons.push({ pro: false, text: `Unfilled bearish FVG above price at ${fmt(z.bottom)}–${fmt(z.top)} — likely resistance overhead.` });
    }

    const recentEng = engulfs.filter((m) => m.t >= displayed[Math.max(0, displayed.length - 10)].t);
    const lastEng = recentEng[recentEng.length - 1];
    if (lastEng) {
      const w = lastEng.volOk ? 2 : 1;
      if (lastEng.dir === "bull") {
        score += w;
        reasons.push({ pro: true, text: `Bullish engulfing at ${etClock(lastEng.t)}${lastEng.volOk ? " on above-average volume" : ""} — buyers absorbed the prior down candle.` });
      } else {
        score -= w;
        reasons.push({ pro: false, text: `Bearish engulfing at ${etClock(lastEng.t)}${lastEng.volOk ? " on above-average volume" : ""} — sellers absorbed the prior up candle.` });
      }
    }

    // anatomy of the last CLOSED displayed candle
    const closed = displayed.length >= 2 ? displayed[displayed.length - 2] : displayed[displayed.length - 1];
    const an = candleAnatomy(closed);
    if (an.bodyPct > 0.6) {
      if (an.bull) {
        score += 1;
        reasons.push({ pro: true, text: `Last closed candle (${etClock(closed.t)}) is a full-bodied green bar closing near its high — conviction buying, follow-through likely.` });
      } else {
        score -= 1;
        reasons.push({ pro: false, text: `Last closed candle (${etClock(closed.t)}) is a full-bodied blue bar closing near its low — conviction selling, follow-through likely.` });
      }
    } else if (an.upperPct > 0.45) {
      score -= 1;
      reasons.push({ pro: false, text: `Last closed candle left a long upper wick — buyers pushed up but sellers rejected the highs.` });
    } else if (an.lowerPct > 0.45) {
      score += 1;
      reasons.push({ pro: true, text: `Last closed candle left a long lower wick — sellers pushed down but buyers defended the lows.` });
    }

    let verdict = "NEUTRAL — WAIT", cls = "neutral";
    if (score >= 3) { verdict = "BUYING RUN"; cls = "buy"; }
    else if (score <= -3) { verdict = "SELLING RUN"; cls = "sell"; }

    const pros = reasons.filter((r) => r.pro === true).length;
    const cons = reasons.filter((r) => r.pro === false).length;
    let confidence;
    if (pros && cons) confidence = `Signals disagree (${pros} bullish vs ${cons} bearish) — score ${score >= 0 ? "+" : ""}${score}. Lower confidence; wait for alignment.`;
    else confidence = `Score ${score >= 0 ? "+" : ""}${score} · ${pros + cons} active signal${pros + cons === 1 ? "" : "s"}, all pointing the same way.`;

    state.analysis = { orb, fvgs, engulfs, score, reasons, verdict, cls, confidence, price };
  }

  const fmt = (p) => p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ---------- chart ----------

  const chartEl = document.getElementById("chart");
  const overlayEl = document.getElementById("overlay");
  const octx = overlayEl.getContext("2d");

  const chart = LightweightCharts.createChart(chartEl, {
    layout: { background: { type: "solid", color: "#0d1117" }, textColor: "#8b98a9" },
    grid: { vertLines: { color: "#161d27" }, horzLines: { color: "#161d27" } },
    rightPriceScale: { borderColor: "#26303f" },
    timeScale: { borderColor: "#26303f", timeVisible: true, secondsVisible: false },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  });

  const series = chart.addCandlestickSeries({
    upColor: COLORS.bull, borderUpColor: COLORS.bull, wickUpColor: COLORS.bull,
    downColor: COLORS.bear, borderDownColor: COLORS.bear, wickDownColor: COLORS.bear,
    priceFormat: { type: "price", precision: 2, minMove: TICK },
  });

  let priceLines = [];

  function renderChart(fitContent) {
    const data = state.displayed.map((b) => ({
      time: dispTime(b.t), open: b.o, high: b.h, low: b.l, close: b.c,
    }));
    series.setData(data);
    if (fitContent) chart.timeScale().fitContent();

    for (const pl of priceLines) series.removePriceLine(pl);
    priceLines = [];

    const a = state.analysis;
    const markers = [];

    if (a && a.orb && state.show.orb) {
      priceLines.push(series.createPriceLine({
        price: a.orb.hi, color: COLORS.orbLine, lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed, title: "OR high",
      }));
      priceLines.push(series.createPriceLine({
        price: a.orb.lo, color: COLORS.orbLine, lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed, title: "OR low",
      }));
      for (const ev of a.orb.events) {
        const bucket = Math.floor(ev.t / (state.interval * 60)) * state.interval * 60;
        if (ev.type === "breakout-up") markers.push({ time: dispTime(bucket), position: "belowBar", color: COLORS.orbLine, shape: "arrowUp", text: "ORB ↑" });
        if (ev.type === "breakout-down") markers.push({ time: dispTime(bucket), position: "aboveBar", color: COLORS.orbLine, shape: "arrowDown", text: "ORB ↓" });
        if (ev.type === "failed-up") markers.push({ time: dispTime(bucket), position: "aboveBar", color: "#ef4444", shape: "circle", text: "failed" });
        if (ev.type === "failed-down") markers.push({ time: dispTime(bucket), position: "belowBar", color: "#ef4444", shape: "circle", text: "failed" });
      }
    }

    if (a && state.show.eng) {
      for (const m of a.engulfs) {
        markers.push(m.dir === "bull"
          ? { time: dispTime(m.t), position: "belowBar", color: COLORS.bull, shape: "arrowUp", text: m.volOk ? "engulf+vol" : "engulf" }
          : { time: dispTime(m.t), position: "aboveBar", color: COLORS.bear, shape: "arrowDown", text: m.volOk ? "engulf+vol" : "engulf" });
      }
    }

    markers.sort((x, y) => x.time - y.time);
    series.setMarkers(markers);
    drawOverlay();
  }

  // shaded zones (OR band, FVG boxes) on a synced canvas
  function drawOverlay() {
    const w = chartEl.clientWidth, h = chartEl.clientHeight;
    if (overlayEl.width !== w * devicePixelRatio || overlayEl.height !== h * devicePixelRatio) {
      overlayEl.width = w * devicePixelRatio;
      overlayEl.height = h * devicePixelRatio;
      overlayEl.style.width = w + "px";
      overlayEl.style.height = h + "px";
    }
    octx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    octx.clearRect(0, 0, w, h);
    const a = state.analysis;
    if (!a || !state.displayed.length) return;
    const ts = chart.timeScale();
    const xOf = (t) => ts.timeToCoordinate(dispTime(t));
    const yOf = (p) => series.priceToCoordinate(p);
    const lastT = state.displayed[state.displayed.length - 1].t;
    const rightX = xOf(lastT);

    if (a.orb && state.show.orb) {
      const x1 = xOf(Math.floor(a.orb.open / (state.interval * 60)) * state.interval * 60);
      const yTop = yOf(a.orb.hi), yBot = yOf(a.orb.lo);
      if (x1 != null && yTop != null && yBot != null) {
        const x2 = rightX != null ? rightX + 8 : w;
        octx.fillStyle = COLORS.orb;
        octx.fillRect(x1, yTop, Math.max(0, x2 - x1), yBot - yTop);
      }
    }

    if (state.show.fvg) {
      for (const z of a.fvgs) {
        if (z.filled) continue;
        const x1 = xOf(z.t);
        const yTop = yOf(z.top), yBot = yOf(z.bottom);
        if (x1 == null || yTop == null || yBot == null) continue;
        const x2 = rightX != null ? rightX + 8 : w;
        octx.fillStyle = z.dir === "bull" ? COLORS.bullSoft : COLORS.bearSoft;
        if (z.touched) octx.globalAlpha = 0.45;
        octx.fillRect(x1, yTop, Math.max(0, x2 - x1), yBot - yTop);
        octx.globalAlpha = 1;
        octx.strokeStyle = z.dir === "bull" ? COLORS.bull : COLORS.bear;
        octx.setLineDash([3, 3]);
        octx.strokeRect(x1, yTop, Math.max(0, x2 - x1), yBot - yTop);
        octx.setLineDash([]);
        octx.fillStyle = z.dir === "bull" ? COLORS.bull : COLORS.bear;
        octx.font = "10px sans-serif";
        octx.fillText("FVG", x1 + 4, yTop + 11);
      }
    }
  }

  chart.timeScale().subscribeVisibleTimeRangeChange(drawOverlay);
  new ResizeObserver(() => { chart.applyOptions({ width: chartEl.clientWidth, height: chartEl.clientHeight }); drawOverlay(); })
    .observe(chartEl);

  // ---------- candle click → education panel ----------

  chart.subscribeClick((param) => {
    if (!param.time) return;
    const t = realTime(param.time);
    const bar = state.displayed.find((b) => b.t === t);
    if (bar) showAnatomy(bar);
  });

  function showAnatomy(b) {
    const an = candleAnatomy(b);
    const avgV = state.displayed.slice(-20).reduce((s, x) => s + x.v, 0) / Math.min(20, state.displayed.length);
    const el = document.getElementById("anatomy-body");
    const pct = (x) => Math.round(x * 100) + "%";
    const lessons = [];

    if (an.bodyPct > 0.6) lessons.push(`The body is ${pct(an.bodyPct)} of the range — one side controlled this candle start to finish. Big bodies = conviction.`);
    else if (an.bodyPct < 0.3) lessons.push(`The body is only ${pct(an.bodyPct)} of the range — lots of fighting, little progress. Small bodies = indecision; don't trust direction from this bar alone.`);
    else lessons.push(`The body is ${pct(an.bodyPct)} of the range — moderate conviction.`);

    if (an.upperPct > 0.35) lessons.push(`Long upper wick (${pct(an.upperPct)}): buyers pushed price up but sellers slammed it back — the highs were rejected. Bearish clue.`);
    if (an.lowerPct > 0.35) lessons.push(`Long lower wick (${pct(an.lowerPct)}): sellers pushed price down but buyers bought it right back — the lows were defended. Bullish clue.`);

    if (an.closeLoc > 0.7) lessons.push(`It closed in the top ${pct(1 - an.closeLoc)} of its range — buyers still in charge at the bell. Strength tends to follow through.`);
    else if (an.closeLoc < 0.3) lessons.push(`It closed in the bottom of its range — sellers still in charge at the bell. Weakness tends to follow through.`);
    else lessons.push(`It closed mid-range — neither side finished in control.`);

    if (avgV > 0) {
      lessons.push(b.v > 1.2 * avgV
        ? `Volume ${Math.round((b.v / avgV) * 100)}% of the 20-bar average — real participation behind this candle; the signal carries weight.`
        : `Volume is ordinary vs the 20-bar average — treat this candle as routine, not a statement.`);
    }

    let verdict, vcls;
    const lean = (an.bull ? 1 : -1) * (an.bodyPct > 0.5 ? 2 : 1) + (an.lowerPct > 0.35 ? 1 : 0) - (an.upperPct > 0.35 ? 1 : 0);
    if (lean >= 2) { verdict = "This candle reads BULLISH — a buying candle."; vcls = "buy"; }
    else if (lean <= -2) { verdict = "This candle reads BEARISH — a selling candle."; vcls = "sell"; }
    else { verdict = "This candle is INDECISIVE on its own — read it with its neighbours and the overlays."; vcls = "neutral"; }

    el.innerHTML = `
      <div class="row"><span>Candle</span><b>${etClock(b.t)} · ${state.interval}m · ${an.bull ? "green (bullish)" : "blue (bearish)"}</b></div>
      <div class="row"><span>O / H / L / C</span><b>${fmt(b.o)} / ${fmt(b.h)} / ${fmt(b.l)} / ${fmt(b.c)}</b></div>
      <div class="row"><span>Range · Body</span><b>${fmt(an.range)} pts · ${pct(an.bodyPct)}</b></div>
      <div class="row"><span>Wicks (up / down)</span><b>${pct(an.upperPct)} / ${pct(an.lowerPct)}</b></div>
      <div class="verdict ${vcls}">${verdict}</div>
      <ul>${lessons.map((l) => `<li>${l}</li>`).join("")}</ul>`;
  }

  // ---------- verdict-change alerts ----------
  // Armed via the 🔔 checkbox; fires ONLY on live/cloud data, never on the
  // simulated replay (those verdicts are random and must not drive trades).

  let prevVerdict = null, lastAlertAt = 0, audioCtx = null, flashTimer = null;

  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audioCtx.currentTime;
      for (const [freq, delay] of [[880, 0], [660, 0.18], [880, 0.36]]) {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = freq; o.connect(g); g.connect(audioCtx.destination);
        g.gain.setValueAtTime(0.001, t0 + delay);
        g.gain.exponentialRampToValueAtTime(0.3, t0 + delay + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + delay + 0.16);
        o.start(t0 + delay); o.stop(t0 + delay + 0.2);
      }
    } catch { /* audio unavailable */ }
  }

  function flashTitle(msg) {
    const original = "MNQ 09-26 — Strategy Chart";
    let on = false;
    clearInterval(flashTimer);
    flashTimer = setInterval(() => { document.title = (on = !on) ? msg : original; }, 900);
    setTimeout(() => { clearInterval(flashTimer); document.title = original; }, 20000);
    window.addEventListener("focus", () => { clearInterval(flashTimer); document.title = original; }, { once: true });
  }

  function maybeAlert() {
    const a = state.analysis;
    if (!a) return;
    const v = a.verdict;
    if (prevVerdict === null) { prevVerdict = v; return; }
    if (v === prevVerdict) return;
    const from = prevVerdict;
    prevVerdict = v;
    if (!state.alertsOn || state.source === "sim") return;
    if (Date.now() - lastAlertAt < 20000) return; // don't machine-gun on oscillation
    lastAlertAt = Date.now();
    beep();
    flashTitle("🔔 " + v);
    const card = document.getElementById("bias-card");
    card.classList.add("alerting");
    setTimeout(() => card.classList.remove("alerting"), 6500);
    if ("Notification" in window && Notification.permission === "granted") {
      try {
        new Notification("MNQ 09-26 bias changed", {
          body: `${from} → ${v} · price ${fmt(a.price)} · ${etClock(Math.floor(Date.now() / 1000))}`,
        });
      } catch { /* notifications blocked */ }
    }
  }

  // ---------- bias panel ----------

  function renderPanel() {
    const a = state.analysis;
    const v = document.getElementById("bias-verdict");
    const c = document.getElementById("bias-confidence");
    const ul = document.getElementById("bias-reasons");
    if (!a) {
      v.textContent = "WAITING FOR DATA";
      v.className = "neutral";
      c.textContent = "";
      ul.innerHTML = "";
      return;
    }
    v.textContent = a.verdict;
    v.className = a.cls;
    c.textContent = a.confidence;
    ul.innerHTML = a.reasons
      .map((r) => `<li class="${r.pro === true ? "pro" : r.pro === false ? "con" : ""}">${r.text}</li>`)
      .join("");
  }

  function renderHeader() {
    const priceEl = document.getElementById("last-price");
    const chgEl = document.getElementById("price-change");
    const p = state.last ? state.last.p : null;
    if (p != null && state.displayed.length) {
      priceEl.textContent = fmt(p);
      const dayOpen = state.analysis && state.analysis.orb
        ? state.base1m.find((b) => b.t >= state.analysis.orb.open)
        : null;
      const ref = dayOpen ? dayOpen.o : state.displayed[0].o;
      const chg = p - ref;
      chgEl.textContent = `${chg >= 0 ? "+" : ""}${fmt(chg)} (${((chg / ref) * 100).toFixed(2)}%) since 9:30 ET`;
      chgEl.className = chg > 0 ? "up" : chg < 0 ? "down" : "flat";
    }

    const ms = marketStatus(Math.floor(Date.now() / 1000));
    const msEl = document.getElementById("market-status");
    msEl.textContent = ms.label;
    msEl.className = "badge " + (ms.open ? "open" : "closed");

    const feedEl = document.getElementById("feed-status");
    const map = {
      local: ["LIVE — tick feed (local NinjaTrader)", "live"],
      cloud: ["CLOUD — 30s snapshots", "cloud"],
      sim: ["SIMULATED replay", "sim"],
    };
    feedEl.textContent = map[state.source][0];
    feedEl.className = "badge " + map[state.source][1];
    document.getElementById("sim-banner").classList.toggle("hidden", state.source !== "sim");

    const fr = document.getElementById("freshness");
    if (state.lastDataAt) {
      const s = Math.round((Date.now() - state.lastDataAt) / 1000);
      fr.textContent = s <= 1 ? "updated just now" : `updated ${s}s ago`;
    }
  }

  // ---------- data feeds ----------

  function mergeBars(incoming) {
    if (!incoming || !incoming.length) return;
    const byT = new Map(state.base1m.map((b) => [b.t, b]));
    for (const b of incoming) byT.set(b.t, b);
    state.base1m = [...byT.values()].sort((a, b) => a.t - b.t).slice(-4000);
  }

  async function fetchJson(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      if (!r.ok) throw new Error("http " + r.status);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function pollLocal() {
    try {
      const d = await fetchJson(LOCAL_FEED, 900);
      if (d && Array.isArray(d.bars)) {
        mergeBars(d.bars);
        if (d.last) state.last = d.last;
        state.source = "local";
        state.localFails = 0;
        state.lastDataAt = Date.now();
        onData(false);
        return true;
      }
    } catch { /* exporter not running on this machine */ }
    state.localFails++;
    return false;
  }

  async function pollCloud() {
    try {
      const d = await fetchJson(CLOUD_FEED, 5000);
      const fresh = d && d.updatedAt && Date.now() / 1000 - d.updatedAt < 120;
      if (fresh && d.bars && d.bars.length >= 30) {
        mergeBars(d.bars);
        if (d.last) state.last = d.last;
        if (state.source !== "local") {
          state.source = "cloud";
          state.lastDataAt = Date.now();
          onData(false);
        }
        return true;
      }
    } catch { /* cloud unreachable */ }
    return false;
  }

  // ---------- simulated replay ----------

  function mulberry32(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  let simRand = mulberry32(20260913);
  let simBurst = 0, simBurstDir = 0;

  function simStep(prevClose, t) {
    // occasional momentum bursts create real FVGs and ORB breaks
    if (simBurst <= 0 && simRand() < 0.02) {
      simBurst = 3 + Math.floor(simRand() * 5);
      simBurstDir = simRand() < 0.5 ? -1 : 1;
    }
    const drift = simBurst-- > 0 ? simBurstDir * 12 : 0;
    const vol = 7;
    const o = prevClose;
    const c = Math.round((o + drift + (simRand() - 0.5) * 2 * vol) / TICK) * TICK;
    const h = Math.round((Math.max(o, c) + simRand() * vol * 0.7) / TICK) * TICK;
    const l = Math.round((Math.min(o, c) - simRand() * vol * 0.7) / TICK) * TICK;
    const v = Math.round(300 + simRand() * 900 + (simBurst > 0 ? 800 : 0));
    return { t, o, h, l, c, v };
  }

  function buildSimHistory() {
    const now = Math.floor(Date.now() / 1000);
    const bars = [];
    let close = 29550;
    let t = now - now % 60 - 2 * 24 * 3600;
    while (t <= now - 60) {
      if (marketStatus(t).open) {
        const b = simStep(close, t);
        bars.push(b);
        close = b.c;
      }
      t += 60;
    }
    return bars;
  }

  function simTick() {
    if (state.source !== "sim") return;
    const now = Math.floor(Date.now() / 1000);
    const minute = now - (now % 60);
    let lastBar = state.base1m[state.base1m.length - 1];
    if (!lastBar) return;
    if (lastBar.t < minute) {
      lastBar = simStep(lastBar.c, minute);
      lastBar.h = lastBar.o; lastBar.l = lastBar.o; lastBar.c = lastBar.o; lastBar.v = 0;
      state.base1m.push(lastBar);
    }
    const p = Math.round((lastBar.c + (simRand() - 0.5) * 3) / TICK) * TICK;
    lastBar.c = p;
    lastBar.h = Math.max(lastBar.h, p);
    lastBar.l = Math.min(lastBar.l, p);
    lastBar.v += Math.round(simRand() * 12);
    state.last = { p, t: now };
    state.lastDataAt = Date.now();
    onData(false);
  }

  // ---------- orchestration ----------

  let firstRender = true;
  let lastFullAnalysis = 0;

  function onData(force) {
    const now = Date.now();
    // full strategy recompute at most every 2s; cheap candle update in between
    if (force || now - lastFullAnalysis > 2000 || firstRender) {
      lastFullAnalysis = now;
      runAnalysis();
      renderChart(firstRender);
      renderPanel();
      maybeAlert();
      firstRender = false;
    } else if (state.displayed.length && state.base1m.length) {
      const tail = aggregate(state.base1m.slice(-state.interval * 2), state.interval);
      const lastAgg = tail[tail.length - 1];
      if (lastAgg) {
        series.update({ time: dispTime(lastAgg.t), open: lastAgg.o, high: lastAgg.h, low: lastAgg.l, close: lastAgg.c });
      }
    }
    renderHeader();
  }

  async function mainLoop() {
    const okLocal = await pollLocal();
    if (!okLocal && state.localFails % 15 === 3) {
      const okCloud = await pollCloud();
      if (!okCloud && !state.base1m.length) {
        state.base1m = buildSimHistory();
        state.source = "sim";
        state.last = { p: state.base1m[state.base1m.length - 1].c, t: Math.floor(Date.now() / 1000) };
        state.lastDataAt = Date.now();
        onData(true);
      } else if (!okCloud && state.source === "cloud" && Date.now() - state.lastDataAt > 180000) {
        // cloud went stale; keep chart but be honest about it
        renderHeader();
      }
    }
  }

  // controls
  document.getElementById("interval-select").addEventListener("change", (e) => {
    state.interval = +e.target.value;
    firstRender = true;
    onData(true);
  });
  document.getElementById("orb-select").addEventListener("change", (e) => {
    state.orbMinutes = +e.target.value;
    onData(true);
  });
  document.getElementById("toggle-alerts").addEventListener("change", (e) => {
    state.alertsOn = e.target.checked;
    if (state.alertsOn) {
      prevVerdict = state.analysis ? state.analysis.verdict : null;
      if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
      beep(); // user gesture unlocks audio + confirms sound works
    }
  });
  for (const [id, key] of [["toggle-orb", "orb"], ["toggle-fvg", "fvg"], ["toggle-eng", "eng"]]) {
    document.getElementById(id).addEventListener("change", (e) => {
      state.show[key] = e.target.checked;
      onData(true);
    });
  }

  chart.applyOptions({ width: chartEl.clientWidth, height: chartEl.clientHeight });
  mainLoop();
  setInterval(mainLoop, 1000);   // local feed: tick cadence
  setInterval(pollCloud, 30000); // cloud snapshots
  setInterval(simTick, 900);     // sim replay animation
  setInterval(renderHeader, 1000);
})();
