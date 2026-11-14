import type { IncomingMessage, ServerResponse } from "node:http";
import { getState, writeSnapshot } from "../dashboard/state.js";

let lastGood: string | null = null;

export default async function handler(_req: IncomingMessage, res: ServerResponse) {
  try {
    const body = JSON.stringify(await getState());
    lastGood = body;
    writeSnapshot();
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "public, s-maxage=6, stale-while-revalidate=30",
    });
    res.end(body);
  } catch {
    // Serve the last-good payload rather than a bare 502 — a stale board beats
    // an empty one. No raw RPC errors reach visitors.
    if (lastGood) {
      res.writeHead(200, { "content-type": "application/json", "x-sentinel-stale": "1", "cache-control": "no-store" });
      res.end(lastGood);
      return;
    }
    res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "qorechain-diana unreachable — retrying" }));
  }
}
