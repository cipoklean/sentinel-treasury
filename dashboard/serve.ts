/**
 * serve.ts — Sentinel dashboard: live state API + static page.
 *
 * Read-only. Needs no keys: everything here is public chain state plus the
 * local decision log the agent writes. Run:
 *   pnpm dashboard            (http://localhost:8787)
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, formatEther, hexToString } from "viem";
import { getNetwork } from "@qorechain/sdk";
import { evmWindowStatus } from "@qorechain/evm";
import { qoreDiana, ADDRESSES, REGISTRY_ABI, VAULT_ABI, DECISIONS_LOG } from "../agent/config.js";

const PORT = Number(process.env.DASH_PORT ?? 8787);
const PUBLIC_DIR = join(import.meta.dirname, "public");
const EXPLORER_TX = "https://explore.qore.network/tx/";

const deployments = JSON.parse(readFileSync(join(import.meta.dirname, "..", "deployments.testnet.json"), "utf8"));
const AGENT_COSMOS: string = deployments.agent.cosmos;
const rest = getNetwork("testnet").endpoints.rest;
const client = createPublicClient({ chain: qoreDiana, transport: http() });

const STATUS = ["PENDING", "PAID", "REFUSED", "CANCELLED"] as const;

function readDecisions() {
  if (!existsSync(DECISIONS_LOG)) return [];
  return readFileSync(DECISIONS_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as {
          ts: string;
          invoiceId: string;
          verdict: { action: string; reason: string };
          decisionRef: string;
          txHash?: string;
          outcome?: string;
          receipt?: { signature: string; signer: string };
          llm?: { model: string; vetoed: boolean; confidence: number; reason: string };
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function state() {
  const [nextId, perTxCap, dailyCap, mandateThreshold, spentToday, paused, vaultAgent, vaultBalance, window] =
    await Promise.all([
      client.readContract({ address: ADDRESSES.registry, abi: REGISTRY_ABI, functionName: "nextId" }),
      client.readContract({ address: ADDRESSES.vault, abi: VAULT_ABI, functionName: "perTxCap" }),
      client.readContract({ address: ADDRESSES.vault, abi: VAULT_ABI, functionName: "dailyCap" }),
      client.readContract({ address: ADDRESSES.vault, abi: VAULT_ABI, functionName: "mandateThreshold" }),
      client.readContract({ address: ADDRESSES.vault, abi: VAULT_ABI, functionName: "spentToday" }),
      client.readContract({ address: ADDRESSES.vault, abi: VAULT_ABI, functionName: "paused" }),
      client.readContract({ address: ADDRESSES.vault, abi: VAULT_ABI, functionName: "agent" }),
      client.getBalance({ address: ADDRESSES.vault }),
      evmWindowStatus({ rest, address: AGENT_COSMOS }).catch(() => null),
    ]);

  const ids = Array.from({ length: Math.max(0, Number(nextId) - 1) }, (_, i) => BigInt(i + 1));
  const invoices = await Promise.all(
    ids.map(async (id) => {
      const inv = await client.readContract({ address: ADDRESSES.registry, abi: REGISTRY_ABI, functionName: "invoice", args: [id] });
      const [vendor, amount, ref, status, createdAt] = inv as unknown as [string, bigint, `0x${string}`, number, bigint];
      return {
        id: Number(id),
        vendor,
        amountQor: formatEther(amount),
        ref: hexToString(ref, { size: 32 }).replace(/\0/g, ""),
        status: STATUS[status] ?? `UNKNOWN(${status})`,
        createdAt: Number(createdAt),
      };
    }),
  );

  const decisions = readDecisions();
  const byInvoice = new Map<string, (typeof decisions)[number]>();
  for (const d of decisions) if (d) byInvoice.set(String(d.invoiceId), d);

  // Payments settled before the receipt loop existed still have their tx on
  // record in deployments.proofTxs; backfill so every board row cites a tx.
  const proofBackfill: Record<number, { tx: string; note: string }> = {
    1: { tx: deployments.proofTxs.agentPaidInvoice1, note: "paid by agent" },
    4: { tx: deployments.proofTxs.aaExecutedPay_invoice4, note: "paid via abstract-account rail" },
  };
  const rows = invoices.map((inv) => {
    const d = byInvoice.get(String(inv.id));
    const vetoed = d?.llm?.vetoed === true;
    const verdict =
      inv.status === "PAID" ? "PAID"
      : vetoed ? "VETOED"
      : d?.verdict.action === "refuse" || inv.status === "REFUSED" ? "REFUSED"
      : "PENDING";
    const backfill = proofBackfill[inv.id];
    const txHash = d?.txHash ?? backfill?.tx ?? null;
    return {
      ...inv,
      verdict,
      decisionRef: d?.decisionRef ?? null,
      txHash,
      txUrl: txHash ? EXPLORER_TX + txHash : null,
      reason: d?.verdict.reason ?? backfill?.note ?? null,
      llm: d?.llm ?? null,
      receiptSigner: d?.receipt?.signer ?? null,
    };
  });

  return {
    ts: new Date().toISOString(),
    network: { name: "qorechain-diana", evmChainId: 9800 },
    agent: { evm: deployments.agent.evm, cosmos: AGENT_COSMOS },
    contracts: { vault: ADDRESSES.vault, registry: ADDRESSES.registry },
    window: window
      ? {
          found: true,
          live: window.live,
          remainingBlocks: Number(window.remainingBlocks),
          remainingTxs: Number(window.remainingTxs),
          remainingValueUqor: window.remainingValue.toString(),
          scopedTo: deployments.agent.scopedWindow.allowedTargets,
        }
      : { found: false },
    policy: {
      paused,
      perTxCapQor: formatEther(perTxCap),
      dailyCapQor: formatEther(dailyCap),
      mandateThresholdQor: formatEther(mandateThreshold),
      spentTodayQor: formatEther(spentToday),
      vaultBalanceQor: formatEther(vaultBalance),
      vaultAgent,
    },
    invoices: rows,
    explorerTx: EXPLORER_TX,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname === "/api/state") {
    try {
      const body = JSON.stringify(await state());
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
    } catch (err) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const path = join(PUBLIC_DIR, file);
  if (!path.startsWith(PUBLIC_DIR) || !existsSync(path)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(readFileSync(path));
});

server.listen(PORT, () => console.log(`sentinel dashboard: http://localhost:${PORT}`));
