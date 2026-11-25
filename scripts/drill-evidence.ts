/**
 * drill-evidence.ts — read-only reconstruction of the 18 Nov Q-Day drill window.
 *
 *   pnpm drill-evidence
 *
 * No keys are required. The script reports the drill target's scoped-window
 * timestamps, computes the UTC drill-day block range, and scans vault/registry
 * contract logs in that range. It exists so the project can distinguish
 * demonstrated controls from missing drill-day liveness evidence.
 */
import { createPublicClient, defineChain, http, type Hex } from "viem";
import { evmWindowStatus } from "@qorechain/evm";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const deployments = JSON.parse(readFileSync(join(ROOT, "deployments.testnet.json"), "utf8"));
const REST = process.env.QORE_REST_URL?.trim() || "https://api-testnet.qore.host";
const EVM_RPC = process.env.QORE_EVM_RPC?.trim() || "https://evm-testnet.qore.host";
const LOG_CHUNK = 8_000n;

const chain = defineChain({
  id: 9800,
  name: "qorechain-diana",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [EVM_RPC] } },
});
const client = createPublicClient({ chain, transport: http(undefined, { retryCount: 2, timeout: 15_000 }) });

const VAULT = deployments.contracts.PolicyVault.address as Hex;
const REGISTRY = deployments.contracts.InvoiceRegistry.address as Hex;
const drillAgent = deployments.previousAgents?.[0] ?? deployments.agent;

async function blockTime(blockNumber: bigint): Promise<number> {
  const block = await client.getBlock({ blockNumber });
  return Number(block.timestamp);
}

async function firstBlockAtOrAfter(timestampSec: number, lo: bigint, hi: bigint): Promise<{ height: bigint; timestamp: number }> {
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if ((await blockTime(mid)) >= timestampSec) hi = mid;
    else lo = mid + 1n;
  }
  return { height: lo, timestamp: await blockTime(lo) };
}

function iso(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

async function main() {
  const head = await client.getBlockNumber();
  const headTs = await blockTime(head);
  const drillStartTs = Math.floor(Date.UTC(2026, 10, 18, 0, 0, 0) / 1000);
  const drillEndTs = Math.floor(Date.UTC(2026, 10, 19, 0, 0, 0) / 1000);

  const window = await evmWindowStatus({ rest: REST, address: drillAgent.cosmos });
  const openedTs = window.found ? await blockTime(window.openedHeight) : null;
  const expiryTs = window.found ? await blockTime(window.expiryHeight) : null;

  // Binary search is enough here because the EVM and native heights advance
  // together. The public RPC prunes very old blocks, so start from the nearest
  // known pre-drill floor rather than genesis.
  let searchFloor = 0n;
  try {
    searchFloor = (await client.getTransactionReceipt({ hash: deployments.contracts.InvoiceRegistry.deployTx as Hex })).blockNumber;
  } catch {
    searchFloor = window.found ? window.openedHeight : 0n;
  }
  if (window.found && openedTs! <= drillStartTs && window.openedHeight > searchFloor) {
    searchFloor = window.openedHeight;
  }
  const start = await firstBlockAtOrAfter(drillStartTs, searchFloor, head);
  const end = await firstBlockAtOrAfter(drillEndTs, start.height, head);

  const logs: any[] = [];
  for (let from = start.height; from < end.height; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n >= end.height ? end.height - 1n : from + LOG_CHUNK - 1n;
    if (to < from) break;
    logs.push(...await client.getLogs({ address: [VAULT, REGISTRY], fromBlock: from, toBlock: to }));
  }

  const result = {
    generatedAt: new Date().toISOString(),
    drillDateUtc: "2026-11-18",
    drillAgent: { evm: drillAgent.evm, cosmos: drillAgent.cosmos },
    head: { height: Number(head), time: iso(headTs) },
    scopedWindow: window.found
      ? {
          found: true,
          liveNow: window.live,
          openedHeight: Number(window.openedHeight),
          openedTime: iso(openedTs!),
          expiryHeight: Number(window.expiryHeight),
          expiryTime: iso(expiryTs!),
          expiredBeforeDrill: expiryTs! < drillStartTs,
          remainingBlocks: Number(window.remainingBlocks),
          remainingTxs: Number(window.remainingTxs),
          allowedTargets: window.allowedTargets,
        }
      : { found: false },
    drillDayUtcRange: {
      startBlock: Number(start.height),
      startTime: iso(start.timestamp),
      endBlockExclusive: Number(end.height),
      endTime: iso(end.timestamp),
    },
    contractLogsInDrillRange: {
      vault: VAULT,
      registry: REGISTRY,
      count: logs.length,
      logs: logs.map((l) => ({
        address: l.address,
        blockNumber: Number(l.blockNumber),
        transactionHash: l.transactionHash,
        logIndex: l.logIndex,
        topics: l.topics,
      })),
    },
    interpretation: {
      scopedWindowLiveDuringDrill: window.found ? expiryTs! >= drillStartTs : false,
      caution:
        "Zero contract logs is not proof that no attack was attempted: protocol-level refusals can occur before contract execution. Use native transaction evidence for attack transcripts.",
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
