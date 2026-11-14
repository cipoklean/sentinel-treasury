/**
 * aa.ts — x/abstractaccount operations for Sentinel.
 *
 *   npx tsx scripts/aa.ts status           authenticators + rules on the operator account
 *   npx tsx scripts/aa.ts link             link the agent key (evm perm + bounded rule)
 *   npx tsx scripts/aa.ts pay <id> <ref>   agent-authorized vault.pay() relayed by operator
 *
 * The authenticator signature IS the authorization: the agent's secp256k1 key
 * signs an EVM-execution digest; the chain checks it against the linked key +
 * spending rules, then runs the call AS the operator's account. No EVM window
 * and no PQ signature needed on the agent's side — the rule bound is the
 * protocol-level enforcement layer.
 */
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  getNetwork,
  unifiedAccountFromSeed,
  authenticatorLinkMessage,
  evmAuthSignBytesV2,
  executeEvmMsg,
  linkAuthenticatorMsgs,
  fetchAuthNonce,
  fetchAuthenticators,
  fetchSpendingRules,
  evmToQor,
  abstractaccount,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { hexToBytes, toHex, encodeFunctionData, parseAbi, toFunctionSelector } from "viem";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const net = getNetwork("testnet");
const REST = net.endpoints.rest;
const RPC = net.endpoints.rpc;
const FEE = { amount: [{ denom: "uqor", amount: "150000" }], gas: "1500000" };

const deployments = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "deployments.testnet.json"), "utf8"),
);
const VAULT = deployments.contracts.PolicyVault.address as `0x${string}`;

// "0x<target>" alone = any function of the contract (it executes as the
// operator). Scope to the two functions the agent ever needs.
const SELECTOR_SCOPED_CALLS = [
  `${VAULT}/${toFunctionSelector("pay(uint256,bytes32)")}`,
  `${VAULT}/${toFunctionSelector("payWithMandate(uint256,bytes32,uint64,bytes)")}`,
];

function parseEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const root = join(import.meta.dirname, "..");
const opEnv = parseEnv(join(root, ".env"));
const agentEnv = parseEnv(join(root, ".env.agent"));

function unified(env: Record<string, string>): UnifiedAccount {
  return unifiedAccountFromSeed(Uint8Array.from(Buffer.from(env.PRIVATE_KEY.slice(2), "hex")), {
    recoveryCode: env.QORE_PQC_RECOVERY_CODE,
  });
}

const operator = unified(opEnv);
const agent = unified(agentEnv);
const agentEth = privateKeyToAccount(agentEnv.PRIVATE_KEY as `0x${string}`);
const agentAddrBytes = hexToBytes(agentEth.address);

async function accountSequence(address: string) {
  const res = await fetch(`${REST}/cosmos/auth/v1beta1/accounts/${address}`);
  const body = (await res.json()) as any;
  const acc = body.account?.base_account ?? body.account ?? {};
  return { accountNumber: BigInt(acc.account_number ?? "0"), sequence: BigInt(acc.sequence ?? "0") };
}

async function broadcast(acc: UnifiedAccount, messages: any[]): Promise<string> {
  const { accountNumber, sequence } = await accountSequence(acc.cosmos);
  const signer = new EthNativeSigner(acc, { signMode: "hybrid", rest: REST });
  const transport = await StargateClient.connect(RPC);
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

async function status() {
  const auths = await fetchAuthenticators({ rest: REST, address: operator.cosmos });
  const rules = await fetchSpendingRules({ rest: REST, address: operator.cosmos });
  console.log(JSON.stringify({ account: operator.cosmos, auths, rules }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

async function link() {
  // Possession proof: the agent's EIP-191 personal_sign over the link message.
  const linkMsg = authenticatorLinkMessage(net.chainId, operator.cosmos, "secp256k1", agentAddrBytes);
  const proofHex = await agentEth.signMessage({ message: linkMsg });
  const possessionProof = hexToBytes(proofHex);

  const expiryUnix = Math.floor(Date.now() / 1000) + 7 * 86_400;
  const msgs = linkAuthenticatorMsgs({
    owner: operator.cosmos,
    account: operator.cosmos,
    chainId: net.chainId,
    scheme: "secp256k1",
    pubkey: agentAddrBytes,
    permissions: ["evm"],
    expiryUnix,
    label: "sentinel-agent",
    possessionProof,
    spendingRule: {
      id: "sentinel-agent-evm",
      // Bounds the operator account's own outflow when this key authorizes it.
      // The vault-internal caps are a separate contract layer.
      perTxLimit: "1000000",
      dailyLimit: "5000000",
      allowedDenoms: [],
      enabled: true,
      // Selector-scoped: pay/payWithMandate only. A bare address would trust
      // every function — including operator-only withdraw/setPolicy — since
      // the call executes as the operator.
      allowedEvmCalls: SELECTOR_SCOPED_CALLS,
      denomLimits: [],
    },
  });
  console.log(`linking ${agentEth.address} -> ${operator.cosmos}`);
  console.log(`linked: ${await broadcast(operator, msgs)}`);
}

/** Re-scope the linked rule to function-selector granularity. Without this the
 * agent key can run ANY vault function as the operator — withdraw included. */
async function scope() {
  const rules = await fetchSpendingRules({ rest: REST, address: operator.cosmos });
  const list = (rules.rules ?? rules) as any[];
  const patched = list.map((r: any) =>
    r.id === "sentinel-agent-evm" ? { ...r, allowedEvmCalls: SELECTOR_SCOPED_CALLS } : r,
  );
  const msg = abstractaccount.updateSpendingRules({
    owner: operator.cosmos,
    accountAddress: operator.cosmos,
    rules: patched.map((r: any) => ({
      ...r,
      perTxLimit: String(r.perTxLimit ?? r.per_tx_limit ?? "0"),
      dailyLimit: String(r.dailyLimit ?? r.daily_limit ?? "0"),
      allowedDenoms: r.allowedDenoms ?? r.allowed_denoms ?? [],
      allowedEvmCalls: r.allowedEvmCalls ?? r.allowed_evm_calls ?? [],
      denomLimits: r.denomLimits ?? r.denom_limits ?? [],
    })),
  });
  console.log(`scoping rule sentinel-agent-evm to: ${SELECTOR_SCOPED_CALLS.join(", ")}`);
  console.log(`updated: ${await broadcast(operator, [msg])}`);
}

/** Kill-switch path: instantly disable the agent's linked key. */
async function revoke() {
  const msg = abstractaccount.revokeAuthenticator({
    owner: operator.cosmos,
    accountAddress: operator.cosmos,
    scheme: "secp256k1",
    pubkey: agentAddrBytes,
  });
  console.log(`revoking ${agentEth.address} from ${operator.cosmos}`);
  console.log(`revoked: ${await broadcast(operator, [msg])}`);
}

const PAY_ABI = parseAbi(["function pay(uint256 invoiceId, bytes32 decisionRef)"]);

async function pay(invoiceId: string, decisionRefHex: string) {
  const data = hexToBytes(
    encodeFunctionData({
      abi: PAY_ABI,
      functionName: "pay",
      args: [BigInt(invoiceId), decisionRefHex as `0x${string}`],
    }),
  );
  const gasLimit = 500_000n;
  let nonce = 0n;
  try {
    const n = await fetchAuthNonce({ rest: REST, address: operator.cosmos, pubkey: agentAddrBytes });
    nonce = n.nonce;
  } catch {
    console.log("auth nonce query failed; assuming 0");
  }

  const digest = evmAuthSignBytesV2({
    chainId: net.chainId,
    account: operator.cosmos,
    pubkey: agentAddrBytes,
    to: VAULT,
    value: "0",
    data,
    gasLimit,
    nonce,
  });
  // The secp256k1 lane expects an EIP-191 personal_sign over the 32-byte digest.
  const sigHex = await agentEth.signMessage({ message: { raw: digest } });
  const signature = hexToBytes(sigHex);

  const msg = executeEvmMsg({
    relayer: operator.cosmos,
    account: operator.cosmos,
    scheme: "secp256k1",
    pubkey: agentAddrBytes,
    signature,
    to: VAULT,
    value: "0",
    data,
    gasLimit,
    nonce,
  });
  console.log(`relaying agent-authorized pay(${invoiceId}) for ${operator.cosmos}`);
  console.log(`executed: ${await broadcast(operator, [msg])}`);
}

/** Relay an arbitrary agent-signed call — used to probe rule boundaries
 *  (e.g. a call to a contract outside allowedEvmCalls should be refused). */
async function exec(to: string, dataHex: string, value = "0") {
  const data = hexToBytes((dataHex.startsWith("0x") ? dataHex : `0x${dataHex}`) as `0x${string}`);
  const gasLimit = 300_000n;
  const n = await fetchAuthNonce({ rest: REST, address: operator.cosmos, pubkey: agentAddrBytes });
  const digest = evmAuthSignBytesV2({
    chainId: net.chainId,
    account: operator.cosmos,
    pubkey: agentAddrBytes,
    to,
    value,
    data,
    gasLimit,
    nonce: n.nonce,
  });
  const signature = hexToBytes(await agentEth.signMessage({ message: { raw: digest } }));
  const msg = executeEvmMsg({
    relayer: operator.cosmos,
    account: operator.cosmos,
    scheme: "secp256k1",
    pubkey: agentAddrBytes,
    signature,
    to,
    value,
    data,
    gasLimit,
    nonce: n.nonce,
  });
  console.log(`relaying agent-authorized call to ${to} (nonce ${n.nonce})`);
  const res = await broadcast(operator, [msg]);
  console.log(`broadcast: ${res}`);
}

const commands: Record<string, () => Promise<void>> = {
  status,
  link,
  scope,
  revoke,
  pay: () => {
    const [id, ref] = process.argv.slice(3);
    if (!id) throw new Error("usage: aa.ts pay <invoiceId> <decisionRefHex>");
    return pay(id, ref ?? `0x${"00".repeat(32)}`);
  },
  exec: () => {
    const [to, dataHex, value] = process.argv.slice(3);
    if (!to || !dataHex) throw new Error("usage: aa.ts exec <to> <calldataHex> [valueWei]");
    return exec(to, dataHex, value);
  },
};
const run = commands[process.argv[2] ?? "status"];
if (!run) {
  console.error("Use: status | link | scope | revoke | pay <invoiceId> [ref] | exec <to> <calldata>");
  process.exit(1);
}
run().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
