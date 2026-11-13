/**
 * env.ts — the guardian needs BOTH full credential sets: the operator's
 * (signs mandates, owns the vault) and the agent's (renews/closes the scoped
 * window). Each env file is parsed separately; the agent process never sees
 * either recovery code.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unifiedAccountFromSeed, type UnifiedAccount } from "@qorechain/sdk";

function parseEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function accountFromEnv(path: string): UnifiedAccount {
  const env = parseEnv(path);
  const key = env.PRIVATE_KEY?.trim();
  const recoveryCode = env.QORE_PQC_RECOVERY_CODE?.trim();
  if (!key || !recoveryCode) throw new Error(`${path} needs PRIVATE_KEY + QORE_PQC_RECOVERY_CODE`);
  return unifiedAccountFromSeed(Uint8Array.from(Buffer.from(key.slice(2), "hex")), { recoveryCode });
}

const root = join(import.meta.dirname, "..");
export const operatorAccount = () => accountFromEnv(join(root, ".env"));
export const agentAccount = () => accountFromEnv(join(root, ".env.agent"));

export const GUARDIAN_POLL_MS = Number(process.env.GUARDIAN_POLL_MS ?? 60_000);
/** Reopen when fewer than this many blocks or txs remain. */
export const RENEW_BLOCKS = BigInt(process.env.GUARDIAN_RENEW_BLOCKS ?? "2000");
export const RENEW_TXS = BigInt(process.env.GUARDIAN_RENEW_TXS ?? "4");
/** Auto-issue mandates up to this amount; larger ones need human approval. */
export const MANDATE_AUTO_MAX_WEI = BigInt(process.env.GUARDIAN_MANDATE_AUTO_MAX_WEI ?? "4000000000000000000");
export const MANDATE_TTL_SECS = Number(process.env.GUARDIAN_MANDATE_TTL_SECS ?? 3600);
export const KILL_FILE = join(root, "logs", "KILL");
export const MANDATES_DIR = join(root, "logs", "mandates");
