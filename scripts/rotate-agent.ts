/**
 * rotate-agent.ts — replace the drill-exposed agent key with a fresh key.
 *
 *   npx tsx scripts/rotate-agent.ts create-env [path]   write a fresh .env.agent.next (0600)
 *   npx tsx scripts/rotate-agent.ts plan                print the operator runbook
 *   npx tsx scripts/rotate-agent.ts status              read-only chain/vault rotation status
 *   npx tsx scripts/rotate-agent.ts execute --yes       run the rotation end to end
 *
 * execute expects three local env files, none of which are committed:
 *   .env              operator PRIVATE_KEY + QORE_PQC_RECOVERY_CODE
 *   .env.agent        old/compromised agent PRIVATE_KEY + QORE_PQC_RECOVERY_CODE
 *   .env.agent.next   fresh agent PRIVATE_KEY + QORE_PQC_RECOVERY_CODE
 *
 * The script is conservative: it preserves existing spending rules when linking
 * the replacement authenticator and it writes every rotation transaction into
 * deployments.testnet.json only after the corresponding chain state is visible.
 */
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  abstractaccount,
  authenticatorLinkMessage,
  buildRegisterPqcKeyMsg,
  closeEvmWindowMsg,
  deriveUnifiedAccount,
  fetchAuthenticators,
  fetchPqcStatus,
  fetchSpendingRules,
  generatePqcRecoveryCode,
  getNetwork,
  isRegisteredPqcKey,
  isValidRecoveryCode,
  linkAuthenticatorMsgs,
  openEvmWindowMsg,
  signProofOfPossession,
  unifiedAccountFromSeed,
  type SpendingRuleInput,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { evmWindowCost, evmWindowStatus } from "@qorechain/evm";
import {
  createPublicClient,
  createWalletClient,
  hexToBytes,
  http,
  parseAbi,
  toFunctionSelector,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const net = getNetwork("testnet");
const REST = net.endpoints.rest;
const RPC = net.endpoints.rpc;
const FEE = { amount: [{ denom: "uqor", amount: "150000" }], gas: "1500000" };
const ROOT = join(import.meta.dirname, "..");
const DEPLOYMENTS_PATH = join(ROOT, "deployments.testnet.json");

const deployments = JSON.parse(readFileSync(DEPLOYMENTS_PATH, "utf8"));
const VAULT = deployments.contracts.PolicyVault.address as `0x${string}`;
const REGISTRY = deployments.contracts.InvoiceRegistry.address as `0x${string}`;
const WINDOW_TARGETS = [VAULT, REGISTRY];

const WINDOW_BLOCKS = BigInt(process.env.ROTATE_WINDOW_BLOCKS ?? "17280");
const WINDOW_MAX_TXS = BigInt(process.env.ROTATE_WINDOW_MAX_TXS ?? "20");
const WINDOW_MAX_UQOR = BigInt(process.env.ROTATE_WINDOW_MAX_UQOR ?? "4000000");
const FUND_TARGET_UQOR = BigInt(process.env.ROTATE_FUND_UQOR ?? "2000000");
const AUTHENTICATOR_EXPIRY_DAYS = BigInt(process.env.ROTATE_AUTHENTICATOR_EXPIRY_DAYS ?? "7");

const SELECTOR_SCOPED_CALLS = [
  `${VAULT}/${toFunctionSelector("pay(uint256,bytes32)")}`,
  `${VAULT}/${toFunctionSelector("payWithMandate(uint256,bytes32,uint64,bytes)")}`,
];

const VAULT_AGENT_ABI = parseAbi([
  "function agent() view returns (address)",
  "function setAgent(address newAgent)",
]);

const EVM_CHAIN = {
  id: 9800,
  name: "QoreChain Testnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [net.endpoints.evmRpc] } },
} as const;

const publicClient = createPublicClient({ chain: EVM_CHAIN, transport: http(net.endpoints.evmRpc) });

function parseEnv(path: string): Record<string, string> {
  if (!existsSync(path)) throw new Error(`missing env file: ${path}`);
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function unified(env: Record<string, string>, label: string): Promise<UnifiedAccount> {
  if (env.QORE_MNEMONIC) return deriveUnifiedAccount(env.QORE_MNEMONIC, 0);
  if (!env.PRIVATE_KEY?.startsWith("0x")) throw new Error(`${label}: PRIVATE_KEY missing or malformed`);
  if (!isValidRecoveryCode(env.QORE_PQC_RECOVERY_CODE ?? "")) {
    throw new Error(`${label}: QORE_PQC_RECOVERY_CODE missing or malformed`);
  }
  return unifiedAccountFromSeed(Uint8Array.from(Buffer.from(env.PRIVATE_KEY.slice(2), "hex")), {
    recoveryCode: env.QORE_PQC_RECOVERY_CODE,
  });
}

function requirePrivateKey(env: Record<string, string>, label: string): `0x${string}` {
  if (!env.PRIVATE_KEY?.startsWith("0x")) throw new Error(`${label}: raw PRIVATE_KEY is required for EVM operations`);
  return env.PRIVATE_KEY as `0x${string}`;
}

function assertKeyMatches(account: UnifiedAccount, privateKey: `0x${string}`, label: string) {
  const evm = privateKeyToAccount(privateKey).address;
  if (evm.toLowerCase() !== account.evm.toLowerCase()) {
    throw new Error(`${label}: PRIVATE_KEY derives ${evm}, but the unified account is ${account.evm}`);
  }
}

async function accountSequence(address: string) {
  const res = await fetch(`${REST}/cosmos/auth/v1beta1/accounts/${address}`);
  if (!res.ok) throw new Error(`account query failed for ${address}: HTTP ${res.status}`);
  const body = (await res.json()) as any;
  const acc = body.account?.base_account ?? body.account ?? {};
  return { accountNumber: BigInt(acc.account_number ?? "0"), sequence: BigInt(acc.sequence ?? "0") };
}

async function broadcast(acc: UnifiedAccount, messages: any[], mode: "hybrid" | "classical" = "hybrid"): Promise<string> {
  const { accountNumber, sequence } = await accountSequence(acc.cosmos);
  const signer = new EthNativeSigner(acc, { signMode: mode, rest: REST });
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

async function bankBalanceUqor(address: string): Promise<bigint> {
  const res = await fetch(`${REST}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=uqor`);
  if (res.status === 404) return 0n;
  if (!res.ok) throw new Error(`balance query failed for ${address}: HTTP ${res.status}`);
  const body = (await res.json()) as any;
  return BigInt(body.balance?.amount ?? "0");
}

function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitFor<T>(label: string, fn: () => Promise<T | false>, attempts = 30): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    const value = await fn();
    if (value) return value;
    await sleep(2_000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function pubkeyHex(evmAddress: string): string {
  return Buffer.from(hexToBytes(evmAddress as `0x${string}`)).toString("hex");
}

function sameTargets(actual: readonly string[], expected: readonly string[]): boolean {
  const norm = (xs: readonly string[]) => xs.map((x) => x.toLowerCase()).sort().join(",");
  return norm(actual) === norm(expected);
}

function admitsTarget(actual: readonly string[], target: string): boolean {
  return actual.length === 0 || actual.some((candidate) => candidate.toLowerCase() === target.toLowerCase());
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n";
}

function createEnv(pathArg?: string) {
  const path = resolve(ROOT, pathArg ?? ".env.agent.next");
  if (existsSync(path)) throw new Error(`${path} already exists; refusing to overwrite it`);
  mkdirSync(dirname(path), { recursive: true });
  const content = [
    `PRIVATE_KEY=${generatePrivateKey()}`,
    `QORE_PQC_RECOVERY_CODE=${generatePqcRecoveryCode()}`,
    "",
  ].join("\n");
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  console.log(`wrote ${path} with mode 0600`);
  console.log("Do not print, paste, commit, or upload this file. It is already covered by .gitignore (.env.*).");
}

function plan() {
  console.log(`Sentinel agent-key rotation runbook

1. Create fresh credentials:
     npx tsx scripts/rotate-agent.ts create-env .env.agent.next

2. Confirm the local files exist and are not committed:
     .env              operator credentials
     .env.agent        drill-exposed old agent credentials
     .env.agent.next   fresh agent credentials

3. Optional read-only preflight:
     npx tsx scripts/rotate-agent.ts status

4. Execute on qorechain-diana:
     npx tsx scripts/rotate-agent.ts execute --yes

   The execution will:
   - fund the fresh agent up to ${FUND_TARGET_UQOR} uqor
   - register its ML-DSA-87 key with a possession proof
   - close the old agent EVM window if still live
   - revoke the old abstract-account authenticator if still linked
   - open/verify an operator admin window scoped to PolicyVault
   - call PolicyVault.setAgent(newAgent)
   - open a fresh agent window scoped only to PolicyVault + InvoiceRegistry
   - link the fresh authenticator while preserving existing spending rules
   - selector-scope the replacement rule to pay/payWithMandate only
   - update deployments.testnet.json with transaction evidence

5. Copy the fresh values into the local runtime files only after verifying
   status output:
   - .env.agent      fresh PRIVATE_KEY + QORE_PQC_RECOVERY_CODE (guardian custody)
   - .env.agent.hot  fresh PRIVATE_KEY only, plus the agent-loop extras
   Keep .env.agent.compromised or delete the old copy according to your local
   key-handling policy. Do not reuse the old key.

6. Restart the services with the fresh agent credentials:
     pnpm guardian
     pnpm agent

Useful overrides:
  ROTATE_FUND_UQOR=2000000
  ROTATE_WINDOW_BLOCKS=17280
  ROTATE_WINDOW_MAX_TXS=20
  ROTATE_WINDOW_MAX_UQOR=4000000
  ROTATE_AUTHENTICATOR_EXPIRY_DAYS=7
`);
}

async function readVaultAgent(): Promise<`0x${string}`> {
  return (await publicClient.readContract({
    address: VAULT,
    abi: VAULT_AGENT_ABI,
    functionName: "agent",
  })) as `0x${string}`;
}

async function status() {
  const agentEvm = deployments.agent.evm as `0x${string}`;
  const agentCosmos = deployments.agent.cosmos as string;
  const operatorCosmos = deployments.operator.cosmos as string;
  const [vaultAgent, window, pqc, auths, rules] = await Promise.all([
    readVaultAgent(),
    evmWindowStatus({ rest: REST, address: agentCosmos }),
    fetchPqcStatus({ rest: REST, address: agentCosmos }).catch((e) => ({ error: e instanceof Error ? e.message : String(e) })),
    fetchAuthenticators({ rest: REST, address: operatorCosmos }),
    fetchSpendingRules({ rest: REST, address: operatorCosmos }),
  ]);
  const agentKey = pubkeyHex(agentEvm);
  const auth = auths.find((a) => a.scheme === "secp256k1" && a.pubkeyHex.toLowerCase() === agentKey);
  console.log(stringifyJson({
    recordedAgent: deployments.agent,
    vaultAgent,
    vaultPointsAtRecordedAgent: vaultAgent.toLowerCase() === agentEvm.toLowerCase(),
    agentWindow: window,
    agentPqc: pqc,
    authenticator: auth ?? null,
    accountRules: rules.rules,
    authenticatorRules: rules.authenticatorRules,
    selectorScopedCallsExpected: SELECTOR_SCOPED_CALLS,
  }));
}

function ruleInput(rule: any): SpendingRuleInput {
  return {
    id: String(rule.id),
    perTxLimit: String(rule.perTxLimit ?? rule.per_tx_limit ?? "0"),
    dailyLimit: String(rule.dailyLimit ?? rule.daily_limit ?? "0"),
    allowedDenoms: rule.allowedDenoms ?? rule.allowed_denoms ?? [],
    enabled: Boolean(rule.enabled),
    allowedEvmCalls: rule.allowedEvmCalls ?? rule.allowed_evm_calls ?? [],
    denomLimits: rule.denomLimits ?? rule.denom_limits ?? [],
  };
}

function replacementAgentRule(): SpendingRuleInput {
  return {
    id: "sentinel-agent-evm",
    perTxLimit: "1000000",
    dailyLimit: "5000000",
    allowedDenoms: [],
    enabled: true,
    allowedEvmCalls: SELECTOR_SCOPED_CALLS,
    denomLimits: [],
  };
}

function ruleForMsg(rule: SpendingRuleInput) {
  return {
    ...rule,
    perTxLimit: rule.perTxLimit === undefined ? undefined : String(rule.perTxLimit),
    dailyLimit: rule.dailyLimit === undefined ? undefined : String(rule.dailyLimit),
  };
}

function agentRuleMatches(rule: any): boolean {
  if (!rule) return false;
  const calls = rule.allowedEvmCalls ?? rule.allowed_evm_calls ?? [];
  return String(rule.perTxLimit ?? rule.per_tx_limit) === "1000000"
    && String(rule.dailyLimit ?? rule.daily_limit) === "5000000"
    && Boolean(rule.enabled)
    && sameTargets(calls, SELECTOR_SCOPED_CALLS);
}

function updateDeploymentsEvidence(evidence: Record<string, unknown>, oldAgent: UnifiedAccount, newAgent: UnifiedAccount) {
  const next = JSON.parse(readFileSync(DEPLOYMENTS_PATH, "utf8"));
  const recordedAgent = next.agent ?? {};
  const recordedIsNew = recordedAgent.evm && String(recordedAgent.evm).toLowerCase() === newAgent.evm.toLowerCase();
  const alreadyPrevious = Array.isArray(next.previousAgents)
    && next.previousAgents.some((a: any) => String(a.evm).toLowerCase() === oldAgent.evm.toLowerCase());

  if (!alreadyPrevious && recordedAgent.evm && String(recordedAgent.evm).toLowerCase() !== newAgent.evm.toLowerCase()) {
    next.previousAgents = [
      ...(Array.isArray(next.previousAgents) ? next.previousAgents : []),
      {
        ...recordedAgent,
        retiredAt: new Date().toISOString(),
        retirementReason: "Q-Day drill exposure: classical key treated as permanently compromised",
      },
    ];
  }

  next.agent = {
    ...recordedAgent,
    evm: newAgent.evm,
    cosmos: newAgent.cosmos,
    pqcRegisterTx: evidence.newAgentPqcRegisterTx ?? (recordedIsNew ? recordedAgent.pqcRegisterTx : null),
    fundTx: evidence.fundNewAgentTx ?? (recordedIsNew ? recordedAgent.fundTx : null),
    scopedWindowTx: evidence.newAgentWindowTx ?? (recordedIsNew ? recordedAgent.scopedWindowTx : null),
    scopedWindow: {
      blocks: Number(WINDOW_BLOCKS),
      maxTxs: Number(WINDOW_MAX_TXS),
      maxValueUqor: WINDOW_MAX_UQOR.toString(),
      allowedTargets: WINDOW_TARGETS,
    },
  };

  next.abstractAccount = {
    ...(next.abstractAccount ?? {}),
    account: deployments.operator.cosmos,
    authenticator: newAgent.evm,
    permissions: ["evm"],
    spendingRule: {
      id: "sentinel-agent-evm",
      perTxLimitUqor: 1000000,
      dailyLimitUqor: 5000000,
      allowedEvmCalls: SELECTOR_SCOPED_CALLS,
    },
    expiryDays: Number(AUTHENTICATOR_EXPIRY_DAYS),
  };

  next.spendingRule = {
    id: "sentinel-agent-evm",
    perTxLimit: "1000000",
    dailyLimit: "5000000",
    allowedEvmCalls: SELECTOR_SCOPED_CALLS,
    note: "selector-scoped to vault pay/payWithMandate only; re-applied during post-drill agent-key rotation",
  };

  const rotationRecord = {
    rotatedAt: new Date().toISOString(),
    reason: "post-Q-Day-drill compromise response",
    oldAgent: { evm: oldAgent.evm, cosmos: oldAgent.cosmos },
    newAgent: { evm: newAgent.evm, cosmos: newAgent.cosmos },
    evidence,
  };
  const rotations = Array.isArray(next.agentRotations) ? [...next.agentRotations] : [];
  const existingRotation = rotations.findIndex((r: any) =>
    String(r.oldAgent?.evm).toLowerCase() === oldAgent.evm.toLowerCase()
    && String(r.newAgent?.evm).toLowerCase() === newAgent.evm.toLowerCase(),
  );
  if (existingRotation >= 0) {
    rotations[existingRotation] = {
      ...rotations[existingRotation],
      ...rotationRecord,
      evidence: { ...(rotations[existingRotation].evidence ?? {}), ...evidence },
    };
  } else {
    rotations.push(rotationRecord);
  }
  next.agentRotations = rotations;

  writeFileSync(DEPLOYMENTS_PATH, stringifyJson(next));
  console.log(`updated ${DEPLOYMENTS_PATH}`);
}

async function executeRotation() {
  if (!process.argv.includes("--yes")) {
    throw new Error("execute broadcasts real testnet transactions; re-run with --yes after reading scripts/rotate-agent.ts plan");
  }

  const opEnv = parseEnv(join(ROOT, ".env"));
  const oldEnv = parseEnv(join(ROOT, ".env.agent"));
  const newEnv = parseEnv(join(ROOT, ".env.agent.next"));
  const operator = await unified(opEnv, ".env");
  const oldAgent = await unified(oldEnv, ".env.agent");
  const newAgent = await unified(newEnv, ".env.agent.next");
  const operatorKey = requirePrivateKey(opEnv, ".env");
  const newAgentKey = requirePrivateKey(newEnv, ".env.agent.next");
  assertKeyMatches(operator, operatorKey, ".env");
  assertKeyMatches(newAgent, newAgentKey, ".env.agent.next");

  if (oldAgent.evm.toLowerCase() === newAgent.evm.toLowerCase()) {
    throw new Error("new agent key is identical to the old key; generate a fresh .env.agent.next");
  }
  if (operator.evm.toLowerCase() !== String(deployments.operator.evm).toLowerCase()) {
    throw new Error(`.env operator ${operator.evm} does not match deployments operator ${deployments.operator.evm}`);
  }
  if (String(deployments.agent.evm).toLowerCase() !== oldAgent.evm.toLowerCase()) {
    console.log(`note: deployments.agent is ${deployments.agent.evm}, not ${oldAgent.evm}; continuing with the supplied old/new key pair`);
  }

  const evidence: Record<string, unknown> = {};
  console.log(`operator:  ${operator.evm} / ${operator.cosmos}`);
  console.log(`old agent: ${oldAgent.evm} / ${oldAgent.cosmos}`);
  console.log(`new agent: ${newAgent.evm} / ${newAgent.cosmos}`);

  const startingBalance = await bankBalanceUqor(newAgent.cosmos);
  if (startingBalance < FUND_TARGET_UQOR) {
    const topUp = FUND_TARGET_UQOR - startingBalance;
    console.log(`funding new agent with ${topUp} uqor`);
    evidence.fundNewAgentTx = await broadcast(operator, [{
      typeUrl: "/cosmos.bank.v1beta1.MsgSend",
      value: {
        fromAddress: operator.cosmos,
        toAddress: newAgent.cosmos,
        amount: [{ denom: "uqor", amount: topUp.toString() }],
      },
    }]);
    await waitFor("new agent funding", async () => (await bankBalanceUqor(newAgent.cosmos)) >= FUND_TARGET_UQOR);
  } else {
    console.log(`new agent already has ${startingBalance} uqor; funding skipped`);
  }

  let pqc = await fetchPqcStatus({ rest: REST, address: newAgent.cosmos });
  if (!pqc.registered) {
    console.log("registering new agent ML-DSA-87 key");
    const possessionProof = signProofOfPossession({
      chainId: net.chainId,
      account: newAgent.cosmos,
      keypair: newAgent.pqc,
    });
    const msg = buildRegisterPqcKeyMsg(newAgent.cosmos, {
      pqcKeypair: newAgent.pqc,
      proofOfPossession: possessionProof,
    });
    evidence.newAgentPqcRegisterTx = await broadcast(newAgent, [msg], "classical");
    pqc = await waitFor("new agent PQC registration", async () => {
      const next = await fetchPqcStatus({ rest: REST, address: newAgent.cosmos }).catch(() => undefined);
      return next?.registered ? next : false;
    });
  } else {
    console.log("new agent ML-DSA-87 key already registered");
  }
  if (!isRegisteredPqcKey(pqc, newAgent.pqc.publicKey)) {
    throw new Error("the registered ML-DSA-87 key on chain does not match .env.agent.next");
  }

  const oldWindow = await evmWindowStatus({ rest: REST, address: oldAgent.cosmos });
  if (oldWindow.live) {
    console.log("closing old agent EVM window");
    evidence.closeOldWindowTx = await broadcast(oldAgent, [closeEvmWindowMsg(oldAgent.cosmos)]);
    await waitFor("old window closure", async () => !(await evmWindowStatus({ rest: REST, address: oldAgent.cosmos })).live);
  } else {
    console.log("old agent EVM window is not live; close skipped");
  }

  const oldKeyHex = pubkeyHex(oldAgent.evm);
  const oldAuth = (await fetchAuthenticators({ rest: REST, address: operator.cosmos }))
    .find((a) => a.scheme === "secp256k1" && a.pubkeyHex.toLowerCase() === oldKeyHex && !a.revoked);
  if (oldAuth) {
    console.log("revoking old abstract-account authenticator");
    try {
      evidence.revokeOldAuthenticatorTx = await broadcast(operator, [abstractaccount.revokeAuthenticator({
        owner: operator.cosmos,
        accountAddress: operator.cosmos,
        scheme: "secp256k1",
        pubkey: hexToBytes(oldAgent.evm as `0x${string}`),
      })]);
      await waitFor("old authenticator revocation", async () => {
        const auths = await fetchAuthenticators({ rest: REST, address: operator.cosmos }).catch(() => []);
        const found = auths.find((a) => a.scheme === "secp256k1" && a.pubkeyHex.toLowerCase() === oldKeyHex);
        return !found || found.revoked;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/expired|expiry/i.test(message)) throw error;
      evidence.revokeOldAuthenticatorSkipped = `old authenticator already expired; revocation refused by chain: ${message}`;
      console.log("old authenticator is already expired; continuing without an explicit revocation transaction");
    }
  } else {
    console.log("old abstract-account authenticator is absent or already revoked; revoke skipped");
  }

  let operatorWindow = await evmWindowStatus({ rest: REST, address: operator.cosmos });
  if (!operatorWindow.live || !admitsTarget(operatorWindow.allowedTargets, VAULT)) {
    if (operatorWindow.live) {
      console.log("operator has a live window that does not admit PolicyVault; closing it before opening the admin scope");
      evidence.closeOperatorWindowTx = await broadcast(operator, [closeEvmWindowMsg(operator.cosmos)]);
      await waitFor("operator window closure", async () => !(await evmWindowStatus({ rest: REST, address: operator.cosmos })).live);
    }
    console.log("opening operator admin window scoped to PolicyVault");
    const cost = evmWindowCost({ gas: 3_000_000n, maxFeePerGas: 250_000_000_000n });
    evidence.operatorAdminWindowTx = await broadcast(operator, [openEvmWindowMsg({
      sender: operator.cosmos,
      blocks: 600n,
      maxTxs: 4n,
      maxValue: cost * 4n,
      allowedTargets: [VAULT],
    })]);
    operatorWindow = await waitFor("operator admin window", async () => {
      const next = await evmWindowStatus({ rest: REST, address: operator.cosmos });
      return next.live && admitsTarget(next.allowedTargets, VAULT) ? next : false;
    });
  }

  const currentVaultAgent = await readVaultAgent();
  if (currentVaultAgent.toLowerCase() !== newAgent.evm.toLowerCase()) {
    console.log(`setting PolicyVault agent ${currentVaultAgent} -> ${newAgent.evm}`);
    const wallet = createWalletClient({
      account: privateKeyToAccount(operatorKey),
      chain: EVM_CHAIN,
      transport: http(net.endpoints.evmRpc),
    });
    const hash = await wallet.writeContract({
      address: VAULT,
      abi: VAULT_AGENT_ABI,
      functionName: "setAgent",
      args: [newAgent.evm as `0x${string}`],
    });
    evidence.setAgentTx = hash;
    await publicClient.waitForTransactionReceipt({ hash });
    await waitFor("PolicyVault agent update", async () => (await readVaultAgent()).toLowerCase() === newAgent.evm.toLowerCase());
  } else {
    console.log("PolicyVault already points at the new agent");
  }

  let newWindow = await evmWindowStatus({ rest: REST, address: newAgent.cosmos });
  if (newWindow.live && !sameTargets(newWindow.allowedTargets, WINDOW_TARGETS)) {
    console.log("new agent has a live window with unexpected targets; closing it before opening the Sentinel scope");
    evidence.closeUnexpectedNewWindowTx = await broadcast(newAgent, [closeEvmWindowMsg(newAgent.cosmos)]);
    await waitFor("unexpected new window closure", async () => !(await evmWindowStatus({ rest: REST, address: newAgent.cosmos })).live);
    newWindow = await evmWindowStatus({ rest: REST, address: newAgent.cosmos });
  }
  if (!newWindow.live) {
    console.log("opening scoped EVM window for the new agent");
    evidence.newAgentWindowTx = await broadcast(newAgent, [openEvmWindowMsg({
      sender: newAgent.cosmos,
      blocks: WINDOW_BLOCKS,
      maxTxs: WINDOW_MAX_TXS,
      maxValue: WINDOW_MAX_UQOR,
      allowedTargets: WINDOW_TARGETS,
    })]);
    newWindow = await waitFor("new agent scoped window", async () => {
      const next = await evmWindowStatus({ rest: REST, address: newAgent.cosmos });
      return next.live && sameTargets(next.allowedTargets, WINDOW_TARGETS) ? next : false;
    });
  } else {
    console.log("new agent scoped window is already live");
  }

  const newAgentEth = privateKeyToAccount(newAgentKey);
  const newPubkey = hexToBytes(newAgentEth.address);
  const newKeyHex = Buffer.from(newPubkey).toString("hex");
  const existingAuth = (await fetchAuthenticators({ rest: REST, address: operator.cosmos }))
    .find((a) => a.scheme === "secp256k1" && a.pubkeyHex.toLowerCase() === newKeyHex && !a.revoked);
  if (!existingAuth) {
    console.log("linking new abstract-account authenticator and preserving existing spending rules");
    const linkMessage = authenticatorLinkMessage(net.chainId, operator.cosmos, "secp256k1", newPubkey);
    const proofHex = await newAgentEth.signMessage({ message: linkMessage });
    const existingRules = (await fetchSpendingRules({ rest: REST, address: operator.cosmos })).rules;
    const preservedRules = existingRules
      .filter((rule) => rule.id !== "sentinel-agent-evm")
      .map(ruleInput);
    const msgs = linkAuthenticatorMsgs({
      owner: operator.cosmos,
      account: operator.cosmos,
      chainId: net.chainId,
      scheme: "secp256k1",
      pubkey: newPubkey,
      permissions: ["evm"],
      expiryUnix: Math.floor(Date.now() / 1000) + Number(AUTHENTICATOR_EXPIRY_DAYS) * 86_400,
      label: "sentinel-agent-post-drill",
      possessionProof: hexToBytes(proofHex),
      spendingRules: [replacementAgentRule(), ...preservedRules],
    });
    evidence.linkNewAuthenticatorTx = await broadcast(operator, msgs);
    await waitFor("new authenticator link", async () => {
      const auths = await fetchAuthenticators({ rest: REST, address: operator.cosmos }).catch(() => []);
      const found = auths.find((a) => a.scheme === "secp256k1" && a.pubkeyHex.toLowerCase() === newKeyHex);
      return found && !found.revoked ? true : false;
    });
  } else {
    console.log("new abstract-account authenticator is already linked");
  }

  const rulesAfterLink = (await fetchSpendingRules({ rest: REST, address: operator.cosmos })).rules;
  const sentinelRule = rulesAfterLink.find((rule) => rule.id === "sentinel-agent-evm");
  if (!agentRuleMatches(sentinelRule)) {
    console.log("repairing sentinel-agent-evm spending rule scope");
    const preservedRules = rulesAfterLink
      .filter((rule) => rule.id !== "sentinel-agent-evm")
      .map(ruleInput);
    evidence.scopeNewAuthenticatorTx = await broadcast(operator, [abstractaccount.updateSpendingRules({
      owner: operator.cosmos,
      accountAddress: operator.cosmos,
      rules: [replacementAgentRule(), ...preservedRules].map(ruleForMsg),
    })]);
    await waitFor("selector-scoped spending rule", async () => {
      const rules = (await fetchSpendingRules({ rest: REST, address: operator.cosmos }).catch(() => ({ rules: [], authenticatorRules: [] }))).rules;
      return agentRuleMatches(rules.find((rule) => rule.id === "sentinel-agent-evm"));
    });
  }

  evidence.newAgentWindowState = {
    live: newWindow.live,
    remainingBlocks: newWindow.remainingBlocks.toString(),
    remainingTxs: newWindow.remainingTxs.toString(),
    remainingValueUqor: newWindow.remainingValue.toString(),
    allowedTargets: newWindow.allowedTargets,
  };

  updateDeploymentsEvidence(evidence, oldAgent, newAgent);

  console.log("rotation complete");
  console.log(stringifyJson({
    newAgent: { evm: newAgent.evm, cosmos: newAgent.cosmos },
    vaultAgent: await readVaultAgent(),
    evidence,
  }));
  console.log("Next: put the fresh full credentials in .env.agent, put only the fresh PRIVATE_KEY in .env.agent.hot, then restart `pnpm guardian` and `pnpm agent`.");
}

const command = process.argv[2] ?? "plan";
const commands: Record<string, () => void | Promise<void>> = {
  "create-env": () => createEnv(process.argv[3]),
  plan,
  status,
  execute: executeRotation,
};

const run = commands[command];
if (!run) {
  console.error("Use: create-env [path] | plan | status | execute --yes");
  process.exit(1);
}

Promise.resolve(run()).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
