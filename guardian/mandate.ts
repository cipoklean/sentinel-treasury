/**
 * mandate.ts — issue an operator ML-DSA-87 mandate for one invoice.
 *
 * The guardian reads the exact bytes the vault will verify (mandateMessage()),
 * signs them with the operator's chain-registered PQ key, and drops
 * logs/mandates/mandate-<id>.json for the agent to submit via payWithMandate().
 */
import { createPublicClient, http, parseAbi, hexToBytes, toHex, type Hex } from "viem";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pqcSign, type UnifiedAccount } from "@qorechain/sdk";
import { qoreDiana, ADDRESSES } from "../agent/config.js";
import { MANDATES_DIR } from "./env.js";

const client = createPublicClient({ chain: qoreDiana, transport: http() });

const MANDATE_ABI = parseAbi([
  "function mandateMessage(uint256 invoiceId, address vendor, uint256 amount, uint64 expiry) view returns (bytes)",
]);

export async function issueMandate(
  operator: UnifiedAccount,
  invoiceId: bigint,
  vendor: `0x${string}`,
  amount: bigint,
  expiry: bigint,
): Promise<string> {
  const message = (await client.readContract({
    address: ADDRESSES.vault,
    abi: MANDATE_ABI,
    functionName: "mandateMessage",
    args: [invoiceId, vendor, amount, expiry],
  })) as Hex;

  const sigHex = toHex(pqcSign(operator.pqc.secretKey, hexToBytes(message))) as Hex;

  mkdirSync(MANDATES_DIR, { recursive: true });
  const file = join(MANDATES_DIR, `mandate-${invoiceId}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        invoiceId: invoiceId.toString(),
        vendor,
        amount: amount.toString(),
        expiry: expiry.toString(),
        message,
        signature: sigHex,
        signer: "operator ML-DSA-87",
        issuedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  return file;
}
