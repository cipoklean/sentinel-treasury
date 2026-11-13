# AI usage

Sentinel was built by one person working with an AI coding assistant (Devin,
SWE-2 by Cognition) throughout the fest window. This file documents what the
AI did, what the human did, and the tooling involved — per the AI-Native award
requirement.

## Division of labour

**AI (Devin):**

- Architecture: designed the three-layer enforcement model (scoped EVM
  window + PolicyVault + guardian-issued ML-DSA-87 mandates) from the Track A
  rubric and the QoreChain protocol surface.
- Contracts: wrote `src/PolicyVault.sol`, `src/InvoiceRegistry.sol`,
  `src/interfaces/IQorePQC.sol`, and the Foundry test suite including the
  `vm.etch` PQC precompile mocks.
- Services: wrote the agent loop (`agent/`: scan -> decide -> EIP-712 receipt
  -> pay) and the guardian (`guardian/`: window renewal, ML-DSA mandate
  issuance, kill switch).
- Tooling: `scripts/window.ts` scoped-window extension, `scripts/send.ts`
  native-lane funding helper, deployment via `forge create` (chosen after
  discovering Foundry's local simulation lacks QoreChain's native
  precompiles).
- On-chain operations: account generation, PQ key registration, scoped
  window opens, contract deployment, seed invoices, and the end-to-end
  payment/refusal/mandate proof transactions recorded in
  `deployments.testnet.json`.

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
