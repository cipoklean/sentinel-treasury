# Sentinel

**An AI agent that pays invoices autonomously — cryptographically incapable of
exceeding its mandate.**

Built for **Build Before Q-Day**, Advanced Track A: Post-Quantum AI Agents.
Everything below runs on `qorechain-diana` (EVM chain id `9800`).

```
┌─ OPERATOR (cold, ML-DSA-87) ───────────────────────────────────────┐
│  opens/closes windows · links authenticators · signs mandates       │
└──────────┬───────────────────────────────┬──────────────────────────┘
   hybrid-signed native tx                 │ ML-DSA-87 mandate
┌─ L0  CHAIN WINDOW ▼             ┌─ L1  ABSTRACT ACCOUNT ▼───────────┐
│ agent EOA window:               │ agent key linked to operator      │
│ allowed_targets = [vault,       │ account, evm permission + rule:   │
│ registry], blocks, max_txs,     │ per_tx/daily limits,              │
│ max_value                       │ allowed_evm_calls = [vault]       │
└──────────┬──────────────────────┴──────────┬─────────────────────────┘
           ▼                                 ▼
┌─ L2  POLICY VAULT (Solidity) ───────────────────────────────────────┐
│ per-tx cap · rolling daily cap · vendor allowlist · pause ·          │
│ > threshold: operator ML-DSA-87 mandate via pqcVerify (0x0A01),      │
│ key status via pqcKeyStatus (0x0A02) · refusals emitted on-chain     │
└─────────────────────────────┬────────────────────────────────────────┘
                              ▼
┌─ L3  SERVICES ──────────────────────────────────────────────────────┐
│ agent/:  scan registry → decide → EIP-712 receipt → pay(*)           │
│ guardian/: window renewal · mandate issuance · kill switch           │
│ (* the agent's classical key only — it cannot open its own window)   │
└─────────────────────────────────────────────────────────────────────┘
```

## Why this only works on QoreChain

On any other EVM chain, "agent spending limits" live in application code —
one compromised key or one contract bug and they're gone. Here each bound is
enforced by a different layer, two of them inside the consensus protocol
itself:

- **Scoped EVM window** — the agent's transactions are *rejected at
  broadcast* unless they target the two allowlisted contracts. No contract
  code involved.
- **Abstract-account spending rules** — a second, independent protocol-level
  allowlist plus per-tx/daily limits on the operator account the agent's
  key is linked to.
- **`pqcVerify` / `pqcKeyStatus` precompiles** — the vault verifies
  post-quantum (ML-DSA-87) operator mandates *inside Solidity*, and admin
  calls re-check that the operator still holds a proven PQ key.
- **Custody split** — the agent process never sees the recovery code that
  derives its PQ key, so it cannot open or widen its own window.

## Rubric → on-chain evidence

Every claim is a real transaction on `qorechain-diana`. Hashes also live in
[`deployments.testnet.json`](deployments.testnet.json).

| Requirement | Mechanism | Proof |
|---|---|---|
| Autonomous agent | `agent/` loop: scans registry, signs EIP-712 receipt, pays | paid invoice 1: `7bdd0aad…` |
| Scoped EVM window | `allowed_targets` = vault + registry | open tx `A6293E8A…` |
| Target limits | out-of-scope transfer rejected at broadcast | "window does not list recipient" |
| Smart-account spending rules | `x/abstractaccount` rule `sentinel-agent-evm` | link tx `14FE8A99…` |
| Tx/value/duration limits | per-tx 1 QOR, daily 5 QOR, 17,280-block window, 7-day authenticator expiry | rule + window above |
| Contract-level policy | `PolicyVault`: per-tx/daily caps, allowlist, pause | refused on-chain: `7ac3b262…` ("over per-tx cap") |
| Authenticated messaging | operator ML-DSA-87 mandate verified by `pqcVerify` in-contract | refused without mandate `baee26ec…` → paid with mandate `f8b9e372…` |
| Protocol refusal evidence | `abstractaccount_execution_failed` for a call outside `allowed_evm_calls` | `34B98142…` |
| PQ key registration | both accounts, proof of possession | `6092B826…`, `B78ACBBC…` |

Accounts: operator `0x9488BAD7…77e6C` · agent `0xBBCDb4F2…31a8`
Contracts: PolicyVault `0x18221b4d…D1C9` · InvoiceRegistry `0x7CC17981…B78D`

## The Q-Day Drill

The agent account itself is the drill target: on 18 Nov the attack bot gets
its classical ECDSA key. It cannot open a window (needs the PQ key, held by
the guardian), cannot call outside the two scoped contracts, and cannot
satisfy the vault's policy. After the drill the key is rotated:
`setAgent` → new scoped window → re-linked authenticator.

## Repo layout

```
src/              PolicyVault.sol · InvoiceRegistry.sol · interfaces/IQorePQC.sol
test/             19 Foundry tests incl. vm.etch PQC precompile mocks
agent/            the autonomous agent (decision engine, EIP-712 receipts)
guardian/         window renewal, ML-DSA mandate issuance, kill switch
scripts/          window.ts (register/status/open), aa.ts (AA rail), send.ts
deployments.testnet.json   every address + tx hash
AI_USAGE.md       AI-Native award documentation
```

## Quickstart

```bash
pnpm install
forge test                       # 19 tests, mocked PQC precompiles

# operator window ops           (needs .env: PRIVATE_KEY + QORE_PQC_RECOVERY_CODE)
pnpm window status|register|open

# agent ops                     (needs .env.agent + .env.agent.hot)
pnpm window:agent status
pnpm agent                       # the loop: scan → decide → receipt → pay

# guardian                      (needs both .env and .env.agent)
npx tsx guardian/index.ts        # renews window, issues mandates, kill switch

# abstract account rail
npx tsx scripts/aa.ts status|link|pay <id>|exec <to> <data>
```

Window scoping is set via `QORE_WINDOW_TARGETS=0x..,0x..` before
`pnpm window open`; `QORE_WINDOW_NATIVE_ONLY=1` narrows to plain transfers.

Deploy note: `forge script` cannot simulate these contracts locally — its
in-memory EVM lacks QoreChain's native precompiles. Deploy with
`forge create` / `cast send` so the constructor executes on the real node
(where `pqcKeyStatus` genuinely runs).

## Status

- [x] contracts deployed + seeded, all enforcement layers proven on-chain
- [x] agent + guardian loops running end-to-end incl. PQ mandate arc
- [x] drill account registered (agent key + both contracts)
- [ ] LLM decision reasoning, dashboard, drill-day replay, video

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
