# Sentinel

**An AI agent that pays invoices autonomously — cryptographically incapable of
exceeding its mandate.**

Built for **Build Before Q-Day**, Advanced Track A: Post-Quantum AI Agents.
Everything below runs on `qorechain-diana` (EVM chain id `9800`).

**Live site:** <https://sentinel-liart-kappa.vercel.app> — landing + live
decision board (`/dashboard`), rebuilt from on-chain events.

```
┌─ OPERATOR (guardian-held, ML-DSA-87) ──────────────────────────────┐
│  opens/closes windows · links authenticators · signs mandates       │
└──────────┬───────────────────────────────┬──────────────────────────┘
   hybrid-signed native tx                 │ ML-DSA-87 mandate
┌─ L0  CHAIN WINDOW ▼             ┌─ L1  ABSTRACT ACCOUNT ▼───────────┐
│ agent EOA window:               │ agent key linked to operator      │
│ allowed_targets = [vault,       │ account — calls execute AS the    │
│ registry], blocks, max_txs,     │ operator, so the rule scopes to   │
│ max_value (key's own value+gas) │ vault/pay + payWithMandate only   │
└──────────┬──────────────────────┴──────────┬─────────────────────────┘
           ▼                                 ▼
           two parallel doors into the same vault — not nested layers
┌─ L2  POLICY VAULT (Solidity) ───────────────────────────────────────┐
│ per-tx cap · UTC-day cap · vendor allowlist · pause ·                │
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
  broadcast* unless they target the two allowlisted contracts. Its value
  budget covers the key's own tx value and gas — it bounds *reach*, not
  payout amounts.
- **Abstract-account spending rules** — a second, independent protocol-level
  rail where the agent's key can call the vault *as the operator*, limited
  by the rule to `pay` / `payWithMandate` selectors, 1 QOR per tx and
  5 QOR per day of account outflow.
- **Contract policy** — the vault is the only layer that bounds payout
  amounts: per-tx cap, UTC-day cap, vendor allowlist, pause.
- **`pqcVerify` / `pqcKeyStatus` precompiles** — the vault verifies
  post-quantum (ML-DSA-87) operator mandates *inside Solidity*, and admin
  calls re-check that the operator still holds a proven PQ key.
- **Custody split** — the agent process never sees the recovery code that
  derives its PQ key, so it cannot open or widen its own window.

## Rubric → on-chain evidence

Every claim is a real transaction on `qorechain-diana`. Hashes also live in
[`deployments.testnet.json`](deployments.testnet.json).

| Requirement | Mechanism | Proof (native tx hashes; explorer is Cosmos-native) |
|---|---|---|
| Autonomous agent | `agent/` loop: scans registry, LLM-reviews, signs EIP-712 receipt, pays a *third-party* vendor | paid invoice 6: `1F6E1182…` |
| Third-party vendor | vendor submits invoice as itself — needs its own ML-DSA-87 key + registry-scoped window | `2F5F853C…` (pqc) → `E41CEB72…` (submit) |
| Scoped EVM window | `allowed_targets` = vault + registry | open tx `A6293E8A…` |
| Target limits | out-of-scope transfer rejected at broadcast | "window does not list recipient" |
| Smart-account spending rules | `x/abstractaccount` rule `sentinel-agent-evm`, selector-scoped | link `14FE8A99…` → re-scoped `F1F3F4A3…` |
| Out-of-selector refusal | agent-signed `withdraw(attacker, 2 QOR)` via the operator account — protocol refused | `AC46FFC7…` |
| Tx/value/duration limits | per-tx 1 QOR, daily 5 QOR, 17,280-block window, 7-day authenticator expiry | rule + window above |
| Contract-level policy | `PolicyVault`: per-tx/UTC-day caps, allowlist, pause — the layer that bounds payouts | refused on-chain: `5CE9CEC0…` ("over per-tx cap") |
| Authenticated messaging | operator ML-DSA-87 mandate verified by `pqcVerify` in-contract | refused `A99BED8A…` → paid with mandate `A0FC7964…` |
| Out-of-target refusal | `abstractaccount_execution_failed` outside `allowed_evm_calls` | `34B98142…` |
| PQ key registration | operator, agent and vendor, proof of possession | `6092B826…`, `B78ACBBC…`, `2F5F853C…` |

Accounts: operator `0x9488BAD7…77e6C` · agent `0xBBCDb4F2…31a8` · vendor `0x7E9826b3…524e`
Contracts: PolicyVault `0x18221b4d…D1C9` · InvoiceRegistry `0x7CC17981…B78D`

## The Q-Day Drill

The agent account itself is the drill target: on 18 Nov the attack bot gets
its classical ECDSA key. It cannot open a window (needs the PQ key, held by
the guardian), cannot call outside the two scoped contracts through its own
EOA, and through the abstract-account rail it executes as the operator only
inside `pay` / `payWithMandate` — a `withdraw` to the attacker's address is
protocol-refused (`AC46FFC7…`). Payout amounts are bounded by the vault's
own caps regardless. After the drill the key is rotated:
`setAgent` → new scoped window → re-linked authenticator.

## Known limits

Honest edges a reviewer should know:

- The daily cap is a fixed UTC-day bucket — it can be spent twice across a
  midnight boundary, not a rolling window.
- `InvoiceRegistry.settle` is operator-callable directly; the vault never
  rejects an invoice, so `Rejected` is registry-level only.
- `decisionRef` is stored, not validated — any 32 bytes pass. `PaymentRefused`
  carries no `decisionRef`.
- Invoice spam: submissions are permissionless; each refusal costs the
  window a tx from its 20-tx budget.
- Contract tests use `vm.etch` mocks for the PQC precompiles — they verify
  control flow, not ML-DSA-87 interop. Interop is proven by the live
  `pqcVerify` calls above.
- The operator key lives in the guardian process (warm, not cold). A
  compromise of the guardian = compromise of the treasury owner.

## Repo layout

```
src/              PolicyVault.sol · InvoiceRegistry.sol · interfaces/IQorePQC.sol
test/             16 Foundry tests incl. vm.etch PQC precompile mocks
agent/            the autonomous agent (decision engine, EIP-712 receipts)
guardian/         window renewal, ML-DSA mandate issuance, kill switch
scripts/          window.ts (register/status/open), aa.ts (AA rail), send.ts,
                  ops.ts (generic env-keyed contract ops), snapshot.ts
deployments.testnet.json   every address + tx hash
AI_USAGE.md       AI-Native award documentation
```

## Quickstart

```bash
pnpm install
forge test                       # 16 tests, mocked PQC precompiles

# operator window ops           (needs .env: PRIVATE_KEY + QORE_PQC_RECOVERY_CODE)
pnpm window status|register|open

# agent ops                     (needs .env.agent + .env.agent.hot)
pnpm window:agent status
pnpm agent                       # the loop: scan → decide → receipt → pay

# guardian                      (needs both .env and .env.agent)
npx tsx guardian/index.ts        # renews window, issues mandates, kill switch

# abstract account rail
npx tsx scripts/aa.ts status|link|pay <id>|exec <to> <data>

# website: landing page + live board   (read-only, needs no keys)
pnpm dashboard                   # http://localhost:8787  (board: /dashboard)
pnpm receipts:export             # logs/decisions.jsonl -> dashboard/receipts.json
```

The site lives in `web/`: a landing page (`/`) explaining the bounds, the
custody split, the payment lifecycle, the Q-Day drill and the rubric→tx
evidence table, plus the live decision board (`/dashboard`).

Both read `/api/state` (`api/state.ts` → `dashboard/state.ts`). It rebuilds the
decision history from PolicyVault and InvoiceRegistry event logs
(`eth_getLogs`), so it needs no local runtime log and runs unchanged as a
Vercel serverless function. The agent's signed EIP-712 receipts are exported
to `dashboard/receipts.json` and re-verified on every request (signature →
agent address, `keccak256(sig) == decisionRef`). They annotate the chain
record and never override it.

Deploy to Vercel: import the repo with no framework preset. `vercel.json`
serves `web/` statically and runs `api/state.ts`. No environment variables
are needed (`QORE_EVM_RPC` / `QORE_REST_URL` optionally override the endpoints).

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
- [x] LLM veto layer (DeepSeek via Sandbase) + live dashboard
- [ ] drill-day replay, QCAI hardening, video

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
