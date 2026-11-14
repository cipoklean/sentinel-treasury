/**
 * export-receipts.ts — publish the agent's signed decision receipts.
 *
 *   pnpm receipts:export
 *
 * Copies logs/decisions.jsonl (gitignored runtime log) to
 * dashboard/receipts.json so the hosted site can join each EIP-712 receipt to
 * its on-chain event. Receipts hold only public data: the decision, its
 * signature and the agent address. The site re-verifies every signature.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const src = join(root, "logs", "decisions.jsonl");
const dst = join(root, "dashboard", "receipts.json");

if (!existsSync(src)) throw new Error(`no decision log at ${src}`);
const rows = readFileSync(src, "utf8")
  .split("\n")
  .filter(Boolean)
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
writeFileSync(dst, JSON.stringify(rows, null, 2) + "\n");
console.log(`exported ${rows.length} receipts -> dashboard/receipts.json`);
