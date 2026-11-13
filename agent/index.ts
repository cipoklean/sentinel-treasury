/**
 * index.ts — the Sentinel agent loop.
 *
 *   npx tsx --env-file=.env.agent.hot agent/index.ts
 *
 * Each poll the agent scans the InvoiceRegistry, decides per policy, signs an
 * EIP-712 receipt, and submits pay()/payWithMandate(). The vault arbitrates on
 * chain: PaymentExecuted and PaymentRefused events are the audit trail. The
 * agent never holds a PQ secret — it cannot open or widen its own window.
 */
import { createPublicClient, createWalletClient, http, parseEventLogs, formatEther } from "viem";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { evmWindowStatus } from "@qorechain/evm";
import { getNetwork, evmToQor } from "@qorechain/sdk";
import {
  qoreDiana,
  agentAccount,
  ADDRESSES,
  REGISTRY_ABI,
  VAULT_ABI,
  POLL_MS,
  STATE_FILE,
  DECISIONS_LOG,
  MANDATES_DIR,
} from "./config.js";
import { decide, type Invoice, type Verdict } from "./policy.js";
import { llmReview } from "./llm.js";
import { signDecision } from "./receipt.js";

const net = getNetwork("testnet");
const publicClient = createPublicClient({ chain: qoreDiana, transport: http() });
const walletClient = createWalletClient({ account: agentAccount(), chain: qoreDiana, transport: http() });

interface State {
  attempted: string[]; // invoice ids already sent to the vault once
  mandateAttempted: string[]; // ids where a mandate path was consumed
}

function loadState(): State {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { attempted: [], mandateAttempted: [] };
  }
}
function saveState(s: State) {
  mkdirSync(join(STATE_FILE, ".."), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function logDecision(entry: Record<string, unknown>) {
  mkdirSync(join(DECISIONS_LOG, ".."), { recursive: true });
  appendFileSync(DECISIONS_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

/** A mandate file dropped by the guardian: logs/mandates/mandate-<id>.json */
function mandateFor(id: bigint): { expiry: bigint; signature: `0x${string}` } | null {
  const file = join(MANDATES_DIR, `mandate-${id}.json`);
  if (!existsSync(file)) return null;
  const m = JSON.parse(readFileSync(file, "utf8"));
  return { expiry: BigInt(m.expiry), signature: m.signature as `0x${string}` };
}

async function readInvoice(id: bigint): Promise<Invoice> {
  const [vendor, amount, ref, status, createdAt] = (await publicClient.readContract({
    address: ADDRESSES.registry,
    abi: REGISTRY_ABI,
    functionName: "invoice",
    args: [id],
  })) as [`0x${string}`, bigint, `0x${string}`, number, bigint];
  return { id, vendor, amount, ref, status, createdAt };
}

async function poll() {
  const nextId = (await publicClient.readContract({
    address: ADDRESSES.registry,
    abi: REGISTRY_ABI,
    functionName: "nextId",
  })) as bigint;

  const [perTxCap, dailyCap, mandateThreshold, spentToday, spentDay, paused] = await Promise.all([
    publicClient.readContract({ address: ADDRESSES.vault, abi: VAULT_ABI, functionName: "perTxCap" }),
    publicClient.readContract({ address: ADDRESSES.vault, abi: VAULT_ABI, functionName: "dailyCap" }),
    publicClient.readContract({ address: ADDRESSES.vault, abi: VAULT_ABI, functionName: "mandateThreshold" }),
    publicClient.readContract({ address: ADDRESSES.vault, abi: VAULT_ABI, functionName: "spentToday" }),
    publicClient.readContract({ address: ADDRESSES.vault, abi: VAULT_ABI, functionName: "spentDay" }),
    publicClient.readContract({ address: ADDRESSES.vault, abi: VAULT_ABI, functionName: "paused" }),
  ] as const);

  const state = loadState();
  const nowDay = BigInt(Math.floor(Date.now() / 86_400_000));
  let acted = 0;

  for (let id = 1n; id < nextId; id++) {
    const inv = await readInvoice(id);
    if (inv.status !== 0) continue;
    const mandate = mandateFor(id);
    const key = id.toString();
    if (state.attempted.includes(key) && !(mandate && !state.mandateAttempted.includes(key))) continue;

    const vendorAllowed = (await publicClient.readContract({
      address: ADDRESSES.vault,
      abi: VAULT_ABI,
      functionName: "vendorAllowed",
      args: [inv.vendor],
    })) as boolean;

    const base: Verdict = decide(
      inv,
      { paused, vendorAllowed, perTxCap, dailyCap, mandateThreshold, spentToday, spentDay, mandateAvailable: !!mandate },
      nowDay,
    );

    // Optional LLM review: may veto, never approve.
    const llm = await llmReview(inv, {
      paused,
      vendorAllowed,
      perTxCap,
      dailyCap,
      mandateThreshold,
      spentToday,
      spentDay,
      mandateAvailable: !!mandate,
    }, base);
    const verdict: Verdict = llm?.vetoed
      ? { action: "refuse", reason: `llm veto: ${llm.reason}` }
      : base;

    const ts = BigInt(Math.floor(Date.now() / 1000));
    const { decisionRef, receipt } = await signDecision(inv, verdict, ts);

    // Submission rules:
    // - policy-refused: still submit once so the refusal lands on chain
    // - llm-vetoed: do NOT submit — the vault would simply pay it; the veto
    //   is agent-side judgment and lives in the signed receipt only
    // - approve: pay / payWithMandate
    let txHash: `0x${string}` | null = null;
    let outcome: string = "refused-offchain";
    if (llm?.vetoed) {
      state.attempted.push(key);
    } else if (verdict.action === "payWithMandate" && mandate) {
      txHash = await walletClient.writeContract({
        address: ADDRESSES.vault,
        abi: VAULT_ABI,
        functionName: "payWithMandate",
        args: [inv.id, decisionRef, mandate.expiry, mandate.signature],
      });
      state.mandateAttempted.push(key);
    } else {
      txHash = await walletClient.writeContract({
        address: ADDRESSES.vault,
        abi: VAULT_ABI,
        functionName: "pay",
        args: [inv.id, decisionRef],
      });
      state.attempted.push(key);
    }

    if (txHash) {
      const r = await publicClient.waitForTransactionReceipt({ hash: txHash });
      const logs = parseEventLogs({ abi: VAULT_ABI, logs: r.logs });
      for (const l of logs) {
        if (l.eventName === "PaymentExecuted") outcome = `executed ${formatEther((l.args as any).amount)} QOR`;
        if (l.eventName === "PaymentRefused") outcome = `refused: ${(l.args as any).reason}`;
      }
    }

    logDecision({
      invoiceId: key,
      verdict,
      decisionRef,
      txHash,
      outcome,
      receipt,
      llm,
    });
    console.log(`[invoice ${key}] ${verdict.action} (${verdict.reason}) -> ${outcome} ${txHash ?? ""}`);
    acted++;
  }

  saveState(state);
  return { scanned: Number(nextId - 1n), acted };
}

async function windowLine(): Promise<string> {
  try {
    const w = await evmWindowStatus({ rest: net.endpoints.rest, address: evmToQor(agentAccount().address) });
    if (!w.found) return "window: none";
    return `window: ${w.live ? "live" : "expired"} ${w.remainingBlocks} blocks ${w.remainingTxs} txs ${w.remainingValue} uqor left`;
  } catch {
    return "window: status unavailable";
  }
}

async function main() {
  mkdirSync(MANDATES_DIR, { recursive: true });
  console.log(`sentinel agent ${agentAccount().address}`);
  console.log(`vault ${ADDRESSES.vault}  registry ${ADDRESSES.registry}`);
  for (;;) {
    try {
      const { scanned, acted } = await poll();
      if (acted || scanned) console.log(`poll: scanned ${scanned}, acted on ${acted} | ${await windowLine()}`);
    } catch (e) {
      console.error(`poll error: ${e instanceof Error ? e.message : e}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main();
