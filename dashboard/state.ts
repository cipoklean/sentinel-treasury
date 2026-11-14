/**
 * state.ts — everything the Sentinel site shows, derived from chain state.
 *
 * Read-only and keyless. The decision history is rebuilt from vault and
 * registry event logs (eth_getLogs on qorechain-diana), so it runs the same
 * locally and in a stateless serverless function. The agent's signed EIP-712
 * receipts (dashboard/receipts.json, exported from logs/decisions.jsonl) are
 * joined in and re-verified here; they annotate the chain record, never
 * replace it.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  defineChain,
  formatEther,
  hexToString,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  verifyTypedData,
  type Hex,
} from "viem";
import { evmWindowStatus } from "@qorechain/evm";

const ROOT = process.env.SENTINEL_ROOT ?? process.cwd();
const readJson = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

const deployments = readJson("deployments.testnet.json");
const RECEIPTS_FILE = join(ROOT, "dashboard", "receipts.json");

export const EXPLORER = "https://explore.qore.network";
const REST = process.env.QORE_REST_URL?.trim() || "https://api-testnet.qore.host";
const LOG_CHUNK = 20_000n;

const chain = defineChain({
  id: 9800,
  name: "qorechain-diana",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [process.env.QORE_EVM_RPC?.trim() || "https://evm-testnet.qore.host"] } },
});
const client = createPublicClient({ chain, transport: http(undefined, { retryCount: 2, timeout: 15_000 }) });

const VAULT = deployments.contracts.PolicyVault.address as Hex;
const REGISTRY = deployments.contracts.InvoiceRegistry.address as Hex;
const AGENT = deployments.agent.evm as Hex;

const REGISTRY_ABI = parseAbi([
  "function nextId() view returns (uint256)",
  "function invoice(uint256) view returns ((address vendor, uint256 amount, bytes32 ref, uint8 status, uint64 createdAt))",
  "event InvoiceSubmitted(uint256 indexed id, address indexed vendor, uint256 amount, bytes32 ref)",
  "event InvoiceCancelled(uint256 indexed id)",
  "event InvoiceSettled(uint256 indexed id, uint8 status)",
  "event VaultSet(address indexed vault)",
]);

const VAULT_ABI = parseAbi([
  "function perTxCap() view returns (uint256)",
  "function dailyCap() view returns (uint256)",
  "function mandateThreshold() view returns (uint256)",
  "function spentToday() view returns (uint256)",
  "function spentDay() view returns (uint64)",
  "function totalPaid() view returns (uint256)",
  "function paused() view returns (bool)",
  "function agent() view returns (address)",
  "event Deposited(address indexed from, uint256 amount)",
  "event PaymentExecuted(uint256 indexed invoiceId, address indexed vendor, uint256 amount, bytes32 decisionRef, bool withMandate)",
  "event PaymentRefused(uint256 indexed invoiceId, address indexed vendor, uint256 amount, string reason)",
  "event VendorAllowed(address indexed vendor, bool allowed)",
  "event PolicySet(uint256 perTxCap, uint256 dailyCap, uint256 mandateThreshold)",
  "event AgentSet(address indexed agent)",
  "event PauseSet(bool paused)",
  "event Withdrawn(address indexed to, uint256 amount)",
]);

const DECISION_TYPES = {
  Decision: [
    { name: "invoiceId", type: "uint256" },
    { name: "vendor", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "ref", type: "bytes32" },
    { name: "action", type: "string" },
    { name: "reason", type: "string" },
    { name: "timestamp", type: "uint256" },
  ],
} as const;

const INVOICE_STATUS = ["PENDING", "PAID", "REJECTED", "CANCELLED"] as const;

// Payments that settled through a rail whose EVM logs are not exposed over
// eth_getLogs (the abstract-account MsgExecute path) are cited by their
// Cosmos tx hash from deployments.testnet.json.
const RAIL_PROOFS: Record<string, { tx: string; rail: string }> = {
  "4": { tx: deployments.proofTxs.aaExecutedPay_invoice4, rail: "abstract-account rail · x/abstractaccount MsgExecute" },
};

interface StoredReceipt {
  ts: string;
  invoiceId: string;
  verdict: { action: string; reason: string };
  decisionRef: Hex;
  txHash?: Hex | null;
  outcome?: string;
  receipt?: {
    domain: { name: string; version: string; chainId: number; verifyingContract: Hex };
    message: Record<string, string>;
    signature: Hex;
    signer: Hex;
  };
  llm?: { model: string; vetoed: boolean; confidence: number | null; reason: string } | null;
}

export interface ChainEvent {
  kind: string;
  contract: "vault" | "registry";
  block: number;
  ts: number | null;
  tx: Hex;
  logIndex: number;
  invoiceId?: string;
  amountQor?: string;
  detail: string;
}

// Warm-instance caches: logs below `scannedTo` and block timestamps are final.
const cache = {
  deployBlock: null as bigint | null,
  scannedTo: 0n,
  logs: [] as any[],
  blockTs: new Map<bigint, number>(),
  verified: new Map<string, boolean>(),
  cosmosTx: new Map<string, { height: number; ts: number } | null>(),
};

async function cosmosTxMeta(hash: string) {
  if (cache.cosmosTx.has(hash)) return cache.cosmosTx.get(hash)!;
  try {
    const res = await fetch(`${REST}/cosmos/tx/v1beta1/txs/${hash}`, { signal: AbortSignal.timeout(8_000) });
    const tr = ((await res.json()) as any).tx_response;
    const meta = tr ? { height: Number(tr.height), ts: Math.floor(Date.parse(tr.timestamp) / 1000) } : null;
    cache.cosmosTx.set(hash, meta);
    return meta;
  } catch {
    return null;
  }
}

async function deployBlock() {
  if (cache.deployBlock == null) {
    const r = await client.getTransactionReceipt({ hash: deployments.contracts.InvoiceRegistry.deployTx });
    cache.deployBlock = r.blockNumber;
    cache.scannedTo = r.blockNumber - 1n;
  }
  return cache.deployBlock;
}

async function syncLogs(head: bigint) {
  await deployBlock();
  for (let from = cache.scannedTo + 1n; from <= head; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n > head ? head : from + LOG_CHUNK - 1n;
    const raw = await client.getLogs({ address: [VAULT, REGISTRY], fromBlock: from, toBlock: to });
    const vault = parseEventLogs({ abi: VAULT_ABI, logs: raw.filter((l) => l.address.toLowerCase() === VAULT.toLowerCase()) });
    const reg = parseEventLogs({ abi: REGISTRY_ABI, logs: raw.filter((l) => l.address.toLowerCase() === REGISTRY.toLowerCase()) });
    cache.logs.push(...vault.map((l) => ({ ...l, contract: "vault" })), ...reg.map((l) => ({ ...l, contract: "registry" })));
    cache.scannedTo = to;
  }
  cache.logs.sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
}

async function blockTimes(blocks: bigint[]) {
  const missing = [...new Set(blocks)].filter((b) => !cache.blockTs.has(b));
  await Promise.all(
    missing.map(async (b) => {
      const blk = await client.getBlock({ blockNumber: b }).catch(() => null);
      if (blk) cache.blockTs.set(b, Number(blk.timestamp));
    }),
  );
}

function readReceipts(): StoredReceipt[] {
  if (!existsSync(RECEIPTS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(RECEIPTS_FILE, "utf8"));
  } catch {
    return [];
  }
}

async function verifyReceipt(r: StoredReceipt) {
  if (!r.receipt) return false;
  const key = r.receipt.signature;
  if (cache.verified.has(key)) return cache.verified.get(key)!;
  let ok = false;
  try {
    const m = r.receipt.message;
    ok =
      keccak256(r.receipt.signature) === r.decisionRef &&
      r.receipt.signer.toLowerCase() === AGENT.toLowerCase() &&
      (await verifyTypedData({
        address: AGENT,
        domain: r.receipt.domain,
        types: DECISION_TYPES,
        primaryType: "Decision",
        message: {
          invoiceId: BigInt(m.invoiceId),
          vendor: m.vendor as Hex,
          amount: BigInt(m.amount),
          ref: m.ref as Hex,
          action: m.action,
          reason: m.reason,
          timestamp: BigInt(m.timestamp),
        },
        signature: r.receipt.signature,
      }));
  } catch {
    ok = false;
  }
  cache.verified.set(key, ok);
  return ok;
}

const qor = (wei: bigint) => formatEther(wei);
const bytes32Text = (h: Hex) => {
  try {
    const s = hexToString(h, { size: 32 }).replace(/\0/g, "");
    return /^[\x20-\x7e]+$/.test(s) ? s : null;
  } catch {
    return null;
  }
};

function describe(l: any): ChainEvent {
  const a = l.args ?? {};
  const base = {
    kind: l.eventName as string,
    contract: l.contract,
    block: Number(l.blockNumber),
    ts: cache.blockTs.get(l.blockNumber) ?? null,
    tx: l.transactionHash as Hex,
    logIndex: l.logIndex as number,
  };
  switch (l.eventName) {
    case "InvoiceSubmitted":
      return { ...base, invoiceId: String(a.id), amountQor: qor(a.amount), detail: `${bytes32Text(a.ref) ?? a.ref} submitted` };
    case "InvoiceSettled":
      return { ...base, invoiceId: String(a.id), detail: `registry marked ${INVOICE_STATUS[Number(a.status)] ?? a.status}` };
    case "InvoiceCancelled":
      return { ...base, invoiceId: String(a.id), detail: "cancelled" };
    case "PaymentExecuted":
      return { ...base, invoiceId: String(a.invoiceId), amountQor: qor(a.amount), detail: a.withMandate ? "paid · ML-DSA-87 mandate verified by pqcVerify" : "paid within policy" };
    case "PaymentRefused":
      return { ...base, invoiceId: String(a.invoiceId), amountQor: qor(a.amount), detail: `refused · ${a.reason}` };
    case "Deposited":
      return { ...base, amountQor: qor(a.amount), detail: `deposit from ${a.from}` };
    case "Withdrawn":
      return { ...base, amountQor: qor(a.amount), detail: `withdrawn to ${a.to}` };
    case "PolicySet":
      return { ...base, detail: `policy set · per-tx ${qor(a.perTxCap)} · daily ${qor(a.dailyCap)} · mandate > ${qor(a.mandateThreshold)} QOR` };
    case "VendorAllowed":
      return { ...base, detail: `vendor ${a.vendor} ${a.allowed ? "allowed" : "removed"}` };
    case "AgentSet":
      return { ...base, detail: `agent set to ${a.agent}` };
    case "PauseSet":
      return { ...base, detail: a.paused ? "vault PAUSED" : "vault unpaused" };
    case "VaultSet":
      return { ...base, detail: `registry bound to vault ${a.vault}` };
    default:
      return { ...base, detail: l.eventName };
  }
}

export async function getState() {
  const head = await client.getBlockNumber();
  const [nextId, perTxCap, dailyCap, mandateThreshold, spentToday, spentDay, totalPaid, paused, vaultAgent, vaultBalance, window, headBlock] =
    await Promise.all([
      client.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: "nextId" }),
      client.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "perTxCap" }),
      client.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "dailyCap" }),
      client.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "mandateThreshold" }),
      client.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "spentToday" }),
      client.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "spentDay" }),
      client.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "totalPaid" }),
      client.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "paused" }),
      client.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "agent" }),
      client.getBalance({ address: VAULT }),
      evmWindowStatus({ rest: REST, address: deployments.agent.cosmos }).catch(() => null),
      client.getBlock({ blockNumber: head }),
      syncLogs(head),
    ]);

  await blockTimes(cache.logs.map((l) => l.blockNumber));
  const events = cache.logs.map(describe);

  const ids = Array.from({ length: Math.max(0, Number(nextId) - 1) }, (_, i) => BigInt(i + 1));
  const onchain = await Promise.all(
    ids.map((id) => client.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: "invoice", args: [id] })),
  );

  const railMeta = Object.fromEntries(
    await Promise.all(Object.entries(RAIL_PROOFS).map(async ([id, p]) => [id, await cosmosTxMeta(p.tx)] as const)),
  );

  for (const [id, meta] of Object.entries(railMeta)) {
    if (!meta) continue;
    events.push({
      kind: "AccountExecute",
      contract: "vault",
      block: meta.height,
      ts: meta.ts,
      tx: RAIL_PROOFS[id].tx as Hex,
      logIndex: 0,
      invoiceId: id,
      detail: "paid via abstract-account rail · spending rule sentinel-agent-evm",
    });
  }
  events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);

  const receipts = readReceipts();
  const verified = await Promise.all(receipts.map(verifyReceipt));
  const receiptByRef = new Map<string, StoredReceipt & { verified: boolean }>();
  const receiptByTx = new Map<string, StoredReceipt & { verified: boolean }>();
  receipts.forEach((r, i) => {
    const v = { ...r, verified: verified[i] };
    receiptByRef.set(r.decisionRef.toLowerCase(), v);
    if (r.txHash) receiptByTx.set(r.txHash.toLowerCase(), v);
  });

  const receiptView = (r: (StoredReceipt & { verified: boolean }) | undefined) =>
    r
      ? {
          verified: r.verified,
          signer: r.receipt?.signer ?? null,
          signature: r.receipt?.signature ?? null,
          action: r.verdict.action,
          reason: r.verdict.reason,
          signedAt: r.receipt ? Number(r.receipt.message.timestamp) : null,
          llm: r.llm ?? null,
        }
      : null;

  const invoices = onchain.map((inv, i) => {
    const id = String(ids[i]);
    const status = INVOICE_STATUS[inv.status] ?? `UNKNOWN(${inv.status})`;
    const mine = events.filter((e) => e.invoiceId === id);
    const submitted = mine.find((e) => e.kind === "InvoiceSubmitted");
    const attempts: any[] = cache.logs
      .filter((l) => (l.eventName === "PaymentExecuted" || l.eventName === "PaymentRefused") && String(l.args.invoiceId) === id)
      .map((l) => {
        const ev = describe(l);
        const r =
          l.eventName === "PaymentExecuted"
            ? receiptByRef.get(String(l.args.decisionRef).toLowerCase())
            : receiptByTx.get(String(l.transactionHash).toLowerCase());
        const decisionRef = l.eventName === "PaymentExecuted" ? (l.args.decisionRef as Hex) : (r?.decisionRef ?? null);
        return {
          outcome: l.eventName === "PaymentExecuted" ? "executed" : "refused",
          reason: l.eventName === "PaymentRefused" ? l.args.reason : l.args.withMandate ? "over threshold · operator mandate" : "within policy",
          withMandate: l.eventName === "PaymentExecuted" ? Boolean(l.args.withMandate) : false,
          block: ev.block,
          ts: ev.ts,
          tx: ev.tx,
          txUrl: `${EXPLORER}/tx/${ev.tx}`,
          rail: "evm · scoped window",
          decisionRef,
          decisionRefText: decisionRef ? bytes32Text(decisionRef) : null,
          receipt: receiptView(r),
        };
      });

    const rail = RAIL_PROOFS[id];
    if (rail && status === "PAID" && !attempts.some((a) => a.outcome === "executed")) {
      attempts.push({
        outcome: "executed",
        reason: "abstract-account spending rule admitted the call",
        withMandate: false,
        block: railMeta[id]?.height ?? null,
        ts: railMeta[id]?.ts ?? null,
        tx: rail.tx,
        txUrl: `${EXPLORER}/tx/${rail.tx}`,
        rail: rail.rail,
        decisionRef: null,
        decisionRefText: null,
        receipt: null,
      });
    }

    // Off-chain-only decisions (e.g. an LLM veto never reaches the vault).
    const offchain = receipts
      .filter((r) => r.invoiceId === id && !r.txHash)
      .map((r) => ({
        outcome: r.llm?.vetoed ? "vetoed" : "refused-offchain",
        reason: r.verdict.reason,
        withMandate: false,
        block: null,
        ts: Math.floor(Date.parse(r.ts) / 1000),
        tx: null,
        txUrl: null,
        rail: "agent · signed receipt only",
        decisionRef: r.decisionRef,
        decisionRefText: null,
        receipt: receiptView(receiptByRef.get(r.decisionRef.toLowerCase())),
      }));
    attempts.push(...offchain);

    const vetoed = offchain.some((a) => a.outcome === "vetoed");
    const verdict =
      status === "PAID" ? "PAID"
      : status === "CANCELLED" ? "CANCELLED"
      : vetoed ? "VETOED"
      : status === "REJECTED" || attempts.some((a) => a.outcome === "refused") ? "REFUSED"
      : "PENDING";

    const last = [...attempts].reverse().find((a) => a.outcome === "executed") ?? attempts[attempts.length - 1] ?? null;

    return {
      id: Number(id),
      ref: bytes32Text(inv.ref) ?? inv.ref,
      vendor: inv.vendor,
      amountQor: qor(inv.amount),
      status,
      verdict,
      createdAt: Number(inv.createdAt),
      submitTx: submitted?.tx ?? null,
      overThreshold: inv.amount > mandateThreshold,
      overPerTxCap: inv.amount > perTxCap,
      reason: last?.reason ?? null,
      proof: last ? { tx: last.tx, txUrl: last.txUrl, decisionRef: last.decisionRef, rail: last.rail } : null,
      llm: attempts.map((a) => a.receipt?.llm).filter(Boolean).pop() ?? null,
      attempts,
    };
  });

  const nowDay = Math.floor(Date.now() / 86_400_000);
  const spentTodayEffective = Number(spentDay) === nowDay ? spentToday : 0n;
  const settledQor = invoices.filter((i) => i.status === "PAID").reduce((s, i) => s + Number(i.amountQor), 0);

  return {
    ts: new Date().toISOString(),
    network: { name: "qorechain-diana", evmChainId: 9800, head: Number(head), headTs: Number(headBlock.timestamp) },
    agent: { evm: AGENT, cosmos: deployments.agent.cosmos },
    operator: { evm: deployments.operator.evm, cosmos: deployments.operator.cosmos },
    contracts: { vault: VAULT, registry: REGISTRY },
    window: window?.found
      ? {
          found: true,
          live: window.live,
          openedHeight: Number(window.openedHeight),
          expiryHeight: Number(window.expiryHeight),
          maxTxs: Number(window.maxTxs),
          usedTxs: Number(window.usedTxs),
          maxValueUqor: window.maxValue.toString(),
          usedValueUqor: window.usedValue.toString(),
          remainingBlocks: Number(window.remainingBlocks),
          remainingTxs: Number(window.remainingTxs),
          remainingValueUqor: window.remainingValue.toString(),
          nativeOnly: window.nativeOnly,
          allowedTargets: window.allowedTargets,
        }
      : { found: false },
    policy: {
      paused,
      perTxCapQor: qor(perTxCap),
      dailyCapQor: qor(dailyCap),
      mandateThresholdQor: qor(mandateThreshold),
      spentTodayQor: qor(spentTodayEffective),
      totalPaidQor: qor(totalPaid),
      vaultBalanceQor: qor(vaultBalance),
      vaultAgent,
    },
    stats: {
      invoices: invoices.length,
      paid: invoices.filter((i) => i.verdict === "PAID").length,
      refusedOnChain: events.filter((e) => e.kind === "PaymentRefused").length,
      settledQor: String(settledQor),
      receipts: receipts.length,
      receiptsVerified: verified.filter(Boolean).length,
    },
    provenance: {
      fromBlock: Number(cache.deployBlock),
      toBlock: Number(cache.scannedTo),
      logs: cache.logs.length,
      rpc: chain.rpcUrls.default.http[0],
      rest: REST,
    },
    invoices,
    events: events.reverse(),
    explorer: EXPLORER,
  };
}
