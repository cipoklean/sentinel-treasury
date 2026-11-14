import type { IncomingMessage, ServerResponse } from "node:http";
import { getState } from "../dashboard/state.js";

export default async function handler(_req: IncomingMessage, res: ServerResponse) {
  try {
    const body = JSON.stringify(await getState());
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "public, s-maxage=6, stale-while-revalidate=30",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
}
