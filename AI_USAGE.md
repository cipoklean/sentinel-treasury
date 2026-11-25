# AI usage

Sentinel was built by one person working with an AI coding assistant (Devin,
SWE-2 by Cognition) throughout the fest window. This file documents what the
AI did, what the human did, and the tooling involved — per the AI-Native award
requirement.

## Division of labour

**AI (Devin):**

- Architecture: designed the enforcement model (scoped EVM window +
  abstract-account spending rule + PolicyVault + guardian-issued
  ML-DSA-87 mandates) from the Track A rubric and the QoreChain protocol
  surface — two parallel protocol doors into one contract-enforced vault.
- Contracts: wrote `src/PolicyVault.sol`, `src/InvoiceRegistry.sol`,
  `src/interfaces/IQorePQC.sol`, and the Foundry test suite including the
  `vm.etch` PQC precompile mocks.
- Services: wrote the agent loop (`agent/`: scan -> decide -> LLM review ->
  EIP-712 receipt -> pay), the veto-only DeepSeek reviewer (`agent/llm.ts`),
  and the guardian (`guardian/`: window renewal, ML-DSA mandate issuance,
  kill switch with authenticator revocation).
- Tooling: `scripts/window.ts` scoped-window extension, `scripts/send.ts`
  native-lane funding helper, `scripts/aa.ts` abstract-account rail
  (link / selector-scope / revoke), `scripts/ops.ts` env-keyed contract ops,
  deployment via `forge create` (chosen after discovering Foundry's local
  simulation lacks QoreChain's native precompiles).
- Site: `web/` landing + `/dashboard` live board rebuilt from on-chain
  event logs, explorer-native tx/address link resolution (`0x` →
  `MsgEthereumTx` wrapper hashes, `0x` → `qor1` bech32), snapshot fallback
  so the API stays up when the RPC is slow.
- On-chain operations: account generation, PQ key registration, scoped
  window opens, contract deployment, seed invoices, a third-party vendor
  flow (own PQ key + registry-scoped window + invoice submitted as itself),
  the selector-scope hardening with an out-of-selector `withdraw` refusal,
  and the end-to-end payment/refusal/mandate proof transactions recorded
  in `deployments.testnet.json`.
- Post-drill hardening and submission support: `scripts/rotate-agent.ts`
  rotation tooling, operator `set-agent` support, env reproducibility fixes,
  the drill evidence review, threat model, video script, rotation runbook and
  submission checklist under `docs/`.

**Human:**

- Product direction and track choice (Advanced / Post-Quantum AI Agents).
- Funded the operator account from their personal testnet wallet.
- Hackathon registration, project-page setup, Q-Day Drill registration, and
  all acceptance of terms.
- Reviewed and approved each architectural decision and every on-chain
  action before funds or keys moved.
- Prior art: earlier multi-agent treasury project (swarm-treasury) informed
  the simplified single-agent design; contracts were rewritten, not copied.

## Tooling

- Devin (SWE-2, Cognition) — interactive CLI agent: code generation, chain
  interaction, testing, debugging.
- `@qorechain/sdk`, `@qorechain/evm` — account derivation, hybrid signing,
  window messages, ML-DSA-87 operations.
- Foundry — contract compilation, tests, deployment.
- viem — EVM reads/writes in the agent and guardian services.

## Verification hooks

Every claim in this project is checkable on qorechain-diana: the deploys,
the scoped window, the paid invoice, the on-chain refusals, and the
ML-DSA-87 mandate verified by the `0x0A01` precompile are listed with tx
hashes in `deployments.testnet.json`.
