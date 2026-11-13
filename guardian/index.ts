/**
 * index.ts — the Sentinel guardian service.
 *
 *   npx tsx guardian/index.ts
 *
 * Holds the credentials the agent process must never see: the agent account's
 * recovery code (to renew its scoped EVM window) and the operator's full
 * account (to issue ML-DSA-87 mandates and run the kill switch).
 *
 * Each poll:
 *   1. renew the agent's scoped window when it runs low
 *   2. auto-issue mandates for pending over-threshold invoices within the
 *      auto-approve ceiling (larger ones wait for a human operator)
 *   3. if logs/KILL exists: close the agent's window + pause the vault
 */
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  getNetwork,
  openEvmWindowMsg,
  closeEvmWindowMsg,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { evmWindowStatus, evmWindowCost } from "@qorechain/evm";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import {
  operatorAccount,
  agentAccount,
  GUARDIAN_POLL_MS,
  RENEW_BLOCKS,
  RENEW_TXS,
  MANDATE_AUTO_MAX_WEI,
  MANDATE_TTL_SECS,
  KILL_FILE,
  MANDATES_DIR,
} from "./env.js";
import { issueMandate } from "./mandate.js";
import { qoreDiana, ADDRESSES, REGISTRY_ABI, VAULT_ABI } from "../agent/config.js";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const net = getNetwork("testnet");
const publicClient = createPublicClient({ chain: qoreDiana, transport: http() });

const FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };

async function accountSequence(address: string) {
  const res = await fetch(`${net.endpoints.rest}/cosmos/auth/v1beta1/accounts/${address}`);
  const body = (await res.json()) as any;
  const acc = body.account?.base_account ?? body.account ?? {};
  return { accountNumber: BigInt(acc.account_number ?? "0"), sequence: BigInt(acc.sequence ?? "0") };
}

async function broadcast(acc: UnifiedAccount, mode: "hybrid" | "classical", messages: any[]): Promise<string> {
  const { accountNumber, sequence } = await accountSequence(acc.cosmos);
  const signer = new EthNativeSigner(acc, { signMode: mode, rest: net.endpoints.rest });
  const transport = await StargateClient.connect(net.endpoints.rpc);
  try {
    const res = await signer.signAndBroadcast(transport, {
      chainId: net.chainId,
      accountNumber,
      sequence,
      fee: FEE,
      messages,
    });
    return res.transactionHash;
  } finally {
    transport.disconnect();
  }
}

const WINDOW_SCOPE = {
  blocks: 17_280n,
  maxTxs: 20n,
  maxValue: 4_000_000n,
  allowedTargets: [ADDRESSES.vault, ADDRESSES.registry],
};

async function renewWindowIfNeeded(agent: UnifiedAccount): Promise<string | null> {
  const w = await evmWindowStatus({ rest: net.endpoints.rest, address: agent.cosmos });
  const low = !w.found || !w.live || BigInt(w.remainingBlocks) < RENEW_BLOCKS || BigInt(w.remainingTxs) < RENEW_TXS;
  if (!low) return null;
  const msg = openEvmWindowMsg({ sender: agent.cosmos, ...WINDOW_SCOPE });
  const tx = await broadcast(agent, "hybrid", [msg]);
  console.log(`[guardian] window renewed: ${tx}`);
  return tx;
}

async function issueDueMandates(operator: UnifiedAccount) {
  const nextId = (await publicClient.readContract({
    address: ADDRESSES.registry,
    abi: REGISTRY_ABI,
    functionName: "nextId",
  })) as bigint;
  const mandateThreshold = (await publicClient.readContract({
    address: ADDRESSES.vault,
    abi: VAULT_ABI,
    functionName: "mandateThreshold",
  })) as bigint;

  for (let id = 1n; id < nextId; id++) {
    const inv = (await publicClient.readContract({
      address: ADDRESSES.registry,
      abi: REGISTRY_ABI,
      functionName: "invoice",
      args: [id],
    })) as [`0x${string}`, bigint, `0x${string}`, number, bigint];
    const [vendor, amount, , status] = inv;
    if (status !== 0 || amount <= mandateThreshold || amount > MANDATE_AUTO_MAX_WEI) continue;
    if (existsSync(join(MANDATES_DIR, `mandate-${id}.json`))) continue;
    const vendorAllowed = (await publicClient.readContract({
      address: ADDRESSES.vault,
      abi: VAULT_ABI,
      functionName: "vendorAllowed",
      args: [vendor],
    })) as boolean;
    if (!vendorAllowed) continue;
    const expiry = BigInt(Math.floor(Date.now() / 1000) + MANDATE_TTL_SECS);
    const file = await issueMandate(operator, id, vendor, amount, expiry);
    console.log(`[guardian] mandate issued for invoice ${id} -> ${file}`);
  }
}

async function kill(agent: UnifiedAccount, operator: UnifiedAccount) {
  const closeMsg = closeEvmWindowMsg({ sender: agent.cosmos });
  const tx = await broadcast(agent, "hybrid", [closeMsg]);
  console.log(`[guardian] agent window closed: ${tx}`);

  // Pause the vault: an operator EVM call, needs an operator window.
  const opEnv = Object.fromEntries(
    readFileSync(join(import.meta.dirname, "..", ".env"), "utf8")
      .split(/\r?\n/)
      .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => [m[1], m[2]]),
  );
  const opKey = privateKeyToAccount(opEnv.PRIVATE_KEY as `0x${string}`);
  const w = await evmWindowStatus({ rest: net.endpoints.rest, address: operator.cosmos });
  if (!w.live) {
    const perTx = evmWindowCost({ gas: 3_000_000n, maxFeePerGas: 250_000_000_000n });
    const open = openEvmWindowMsg({ sender: operator.cosmos, blocks: 600n, maxTxs: 3n, maxValue: perTx * 3n });
    console.log(`[guardian] operator window opened: ${await broadcast(operator, "hybrid", [open])}`);
  }
  const opWallet = createWalletClient({ account: opKey, chain: qoreDiana, transport: http() });
  const pauseTx = await opWallet.writeContract({
    address: ADDRESSES.vault,
    abi: VAULT_ABI,
    functionName: "setPaused",
    args: [true],
  });
  console.log(`[guardian] vault paused: ${pauseTx}`);
  unlinkSync(KILL_FILE);
}

async function main() {
  mkdirSync(MANDATES_DIR, { recursive: true });
  const operator = operatorAccount();
  const agent = agentAccount();
  console.log(`guardian: operator ${operator.evm}, agent ${agent.evm}`);
  for (;;) {
    try {
      if (existsSync(KILL_FILE)) {
        await kill(agent, operator);
        console.log("[guardian] kill switch executed");
      }
      await renewWindowIfNeeded(agent);
      await issueDueMandates(operator);
    } catch (e) {
      console.error(`[guardian] poll error: ${e instanceof Error ? e.message : e}`);
    }
    await new Promise((r) => setTimeout(r, GUARDIAN_POLL_MS));
  }
}

main();
