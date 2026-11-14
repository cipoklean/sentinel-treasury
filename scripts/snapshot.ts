/**
 * snapshot.ts — regenerate dashboard/chain-snapshot.json.
 *
 * Run before a deploy so the serverless cold start only scans the delta:
 *   npx tsx scripts/snapshot.ts
 */
import { getState, writeSnapshot } from "../dashboard/state.js";

const s = await getState();
writeSnapshot();
console.log(`snapshot written: ${s.provenance.logs} logs, scanned to block ${s.provenance.toBlock}`);
