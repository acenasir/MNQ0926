// Cloud ingest + read endpoint for MNQ 09-26 bars.
//
// POST /api/bars  (from the NinjaTrader exporter, every ~30s)
//   headers: Authorization: Bearer <INGEST_TOKEN>
//   body: { bars: [{t,o,h,l,c,v}, ...], last: {p, t} }
// GET /api/bars
//   -> { bars, last, updatedAt, source: "cloud" }
//
// Storage: in-memory on the warm lambda, mirrored to Vercel Blob when a
// BLOB_READ_WRITE_TOKEN is configured so data survives cold starts.

const MAX_BARS = 3000;
const BLOB_KEY = "mnq0926/bars.json";
const DEFAULT_TOKEN = "change-me-mnq0926";

let memory = null; // { bars, last, updatedAt }
let lastBlobWrite = 0;

function token() {
  return process.env.INGEST_TOKEN || DEFAULT_TOKEN;
}

async function blob() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    return await import("@vercel/blob");
  } catch {
    return null;
  }
}

function validBar(b) {
  return (
    b &&
    [b.t, b.o, b.h, b.l, b.c, b.v].every((x) => typeof x === "number" && isFinite(x)) &&
    b.h >= b.l
  );
}

function sanitize(payload) {
  const bars = (Array.isArray(payload.bars) ? payload.bars : [])
    .filter(validBar)
    .sort((a, b) => a.t - b.t);
  // dedupe by open time, last write wins
  const byTime = new Map();
  for (const b of bars) byTime.set(b.t, b);
  const clean = [...byTime.values()].slice(-MAX_BARS);
  const last =
    payload.last &&
    typeof payload.last.p === "number" &&
    typeof payload.last.t === "number"
      ? { p: payload.last.p, t: payload.last.t }
      : null;
  return { bars: clean, last };
}

function merge(existing, incoming) {
  if (!existing) return incoming;
  const byTime = new Map(existing.bars.map((b) => [b.t, b]));
  for (const b of incoming.bars) byTime.set(b.t, b);
  const bars = [...byTime.values()].sort((a, b) => a.t - b.t).slice(-MAX_BARS);
  return { bars, last: incoming.last || existing.last };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "POST") {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${token()}`) {
      return res.status(401).json({ error: "bad token" });
    }
    let payload = req.body;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        return res.status(400).json({ error: "invalid json" });
      }
    }
    const incoming = sanitize(payload || {});
    if (!incoming.bars.length && !incoming.last) {
      return res.status(400).json({ error: "no valid bars" });
    }
    const merged = merge(memory, incoming);
    memory = { ...merged, updatedAt: Math.floor(Date.now() / 1000) };

    // Mirror to Blob at most every 25s to stay inside free-tier operations.
    const b = await blob();
    if (b && Date.now() - lastBlobWrite > 25000) {
      lastBlobWrite = Date.now();
      try {
        await b.put(BLOB_KEY, JSON.stringify(memory), {
          access: "public",
          addRandomSuffix: false,
          contentType: "application/json",
          allowOverwrite: true,
        });
      } catch (e) {
        console.error("blob write failed:", e.message);
      }
    }
    return res.status(200).json({ ok: true, stored: memory.bars.length });
  }

  if (req.method === "GET") {
    if (!memory) {
      const b = await blob();
      if (b) {
        try {
          const head = await b.head(BLOB_KEY);
          if (head && head.url) {
            const r = await fetch(head.url, { cache: "no-store" });
            if (r.ok) memory = await r.json();
          }
        } catch {
          // no blob yet — fine, report empty
        }
      }
    }
    res.setHeader("Cache-Control", "no-store");
    if (!memory) {
      return res.status(200).json({ bars: [], last: null, updatedAt: 0, source: "cloud" });
    }
    return res.status(200).json({ ...memory, source: "cloud" });
  }

  return res.status(405).json({ error: "method not allowed" });
};
