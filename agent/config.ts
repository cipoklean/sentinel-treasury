/**
 * config.ts — chain, contract and key wiring for the Sentinel agent process.
 *
 * The agent process holds ONLY the classical secp256k1 key. It cannot open or
 * widen its own EVM window: that needs the account's ML-DSA-87 key, which is
 * derived from QORE_PQC_RECOVERY_CODE and lives only with the guardian.
 */
import { defineChain, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const qoreDiana = defineChain({
  id: 9800,
  name: "qorechain-diana",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [process.env.QORE_EVM_RPC?.trim() || "https://evm-testnet.qore.host"] } },
});

const deployments = JSON.parse(readFileSync(join(import.meta.dirname, "..", "deployments.testnet.json"), "utf8"));

export const ADDRESSES = {
  registry: deployments.contracts.InvoiceRegistry.address as `0x${string}`,
  vault: deployments.contracts.PolicyVault.address as `0x${string}`,
  operator: deployments.operator.evm as `0x${string}`,
};

let _agent: ReturnType<typeof privateKeyToAccount> | null = null;
/** The agent's classical key — resolved lazily so importing config (e.g. from
 *  the guardian) doesn't require PRIVATE_KEY in the environment. */
export function agentAccount() {
  if (!_agent) {
    const pk = process.env.PRIVATE_KEY?.trim();
    if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      throw new Error("agent needs PRIVATE_KEY (0x + 64 hex) — its classical key only");
    }
    _agent = privateKeyToAccount(pk as `0x${string}`);
  }
  return _agent;
}

export const REGISTRY_ABI = parseAbi([
  "function nextId() view returns (uint256)",
  "function invoice(uint256) view returns (address vendor, uint256 amount, bytes32 ref, uint8 status, uint64 createdAt)",
  "event InvoiceSubmitted(uint256 indexed id, address indexed vendor, uint256 amount, bytes32 ref)",
]);

export const VAULT_ABI = parseAbi([
  "function pay(uint256 invoiceId, bytes32 decisionRef)",
  "function payWithMandate(uint256 invoiceId, bytes32 decisionRef, uint64 expiry, bytes signature)",
  "function vendorAllowed(address) view returns (bool)",
  "function perTxCap() view returns (uint256)",
  "function dailyCap() view returns (uint256)",
  "function mandateThreshold() view returns (uint256)",
  "function spentToday() view returns (uint256)",
  "function spentDay() view returns (uint64)",
  "function paused() view returns (bool)",
  "function setPaused(bool p)",
  "function agent() view returns (address)",
  "event PaymentExecuted(uint256 indexed invoiceId, address indexed vendor, uint256 amount, bytes32 decisionRef, bool withMandate)",
  "event PaymentRefused(uint256 indexed invoiceId, address indexed vendor, uint256 amount, string reason)",
]);

export const POLL_MS = Number(process.env.AGENT_POLL_MS ?? 15_000);
export const STATE_FILE = join(import.meta.dirname, "..", "logs", "agent-state.json");
export const DECISIONS_LOG = join(import.meta.dirname, "..", "logs", "decisions.jsonl");
export const MANDATES_DIR = join(import.meta.dirname, "..", "logs", "mandates");
