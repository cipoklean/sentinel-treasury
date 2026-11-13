/**
 * receipt.ts — EIP-712-signed decision receipts.
 *
 * Every decision is signed by the agent's classical key and its signature's
 * keccak becomes the `decisionRef` anchored in the PaymentExecuted /
 * PaymentRefused-adjacent call. Anyone can later recompute the hash from the
 * logged receipt and match it to the on-chain call.
 */
import { keccak256 } from "viem";
import { agentAccount, ADDRESSES } from "./config.js";
import type { Invoice, Verdict } from "./policy.js";

export const DECISION_TYPES = {
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

export async function signDecision(inv: Invoice, verdict: Verdict, timestamp: bigint) {
  const signature = await agentAccount.signTypedData({
    domain: {
      name: "Sentinel",
      version: "1",
      chainId: 9800,
      verifyingContract: ADDRESSES.vault,
    },
    types: DECISION_TYPES,
    primaryType: "Decision",
    message: {
      invoiceId: inv.id,
      vendor: inv.vendor,
      amount: inv.amount,
      ref: inv.ref,
      action: verdict.action,
      reason: verdict.reason,
      timestamp,
    },
  });
  return {
    signature,
    decisionRef: keccak256(signature),
    receipt: {
      domain: { name: "Sentinel", version: "1", chainId: 9800, verifyingContract: ADDRESSES.vault },
      message: {
        invoiceId: inv.id.toString(),
        vendor: inv.vendor,
        amount: inv.amount.toString(),
        ref: inv.ref,
        action: verdict.action,
        reason: verdict.reason,
        timestamp: timestamp.toString(),
      },
      signature,
      signer: agentAccount.address,
    },
  };
}
