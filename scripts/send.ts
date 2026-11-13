/**
 * send.ts - native-lane uqor transfer (hybrid-signed, no EVM window needed).
 *
 *   npx tsx --env-file=.env scripts/send.ts <qor1-or-0x-to> <amount-qor>
 *
 * Reuses the same account/broadcast machinery as window.ts.
 */
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  getNetwork,
  deriveUnifiedAccount,
  unifiedAccountFromSeed,
  type UnifiedAccount,
} from "@qorechain/sdk";

const net = getNetwork((process.env.QORE_NETWORK ?? "testnet") as "testnet" | "mainnet");
const REST = process.env.QORE_REST_URL?.trim() || net.endpoints.rest;
const RPC = process.env.QORE_RPC_URL?.trim() || net.endpoints.rpc;

async function account(): Promise<UnifiedAccount> {
  const mnemonic = process.env.QORE_MNEMONIC?.trim();
  if (mnemonic) return deriveUnifiedAccount(mnemonic, 0);
  const key = process.env.PRIVATE_KEY!.trim();
  const recoveryCode = process.env.QORE_PQC_RECOVERY_CODE!.trim();
  return unifiedAccountFromSeed(Uint8Array.from(Buffer.from(key.slice(2), "hex")), { recoveryCode });
}

async function accountSequence(address: string) {
  const res = await fetch(`${REST}/cosmos/auth/v1beta1/accounts/${address}`);
  if (!res.ok) throw new Error(`account query failed: HTTP ${res.status}`);
  const body = (await res.json()) as any;
  const acc = body.account?.base_account ?? body.account ?? {};
  return { accountNumber: BigInt(acc.account_number ?? "0"), sequence: BigInt(acc.sequence ?? "0") };
}

async function main() {
  const [to, amountQor] = process.argv.slice(2);
  if (!to || !amountQor) throw new Error("usage: send.ts <to> <amount-qor>");
  const acc = await account();
  const { accountNumber, sequence } = await accountSequence(acc.cosmos);
  const signer = new EthNativeSigner(acc, { signMode: "hybrid", rest: REST });
  const transport = await StargateClient.connect(RPC);
  const amount = BigInt(Math.round(parseFloat(amountQor) * 1e6)).toString();
  try {
    const res = await signer.signAndBroadcast(transport, {
      chainId: net.chainId,
      accountNumber,
      sequence,
      fee: { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" },
      messages: [
        {
          typeUrl: "/cosmos.bank.v1beta1.MsgSend",
          value: {
            fromAddress: acc.cosmos,
            toAddress: to,
            amount: [{ denom: "uqor", amount }],
          },
        },
      ],
    });
    console.log(`sent ${amountQor} QOR from ${acc.cosmos} to ${to}: ${res.transactionHash}`);
  } finally {
    transport.disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
