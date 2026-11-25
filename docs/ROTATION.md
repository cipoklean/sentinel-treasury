# Post-Drill Agent Key Rotation

This runbook replaces the drill-exposed agent key with a fresh agent key and
rebuilds the two protocol-level rails around it. It is written for
`qorechain-diana` testnet operations.

The old agent classical key must be treated as permanently compromised. Do not
renew its window, relink it, or reuse its PQC recovery code.

## What rotation must achieve

At the end of a correct rotation:

1. `PolicyVault.agent()` is the fresh agent EVM address.
2. The old agent EVM window is closed or expired.
3. The old abstract-account authenticator is revoked or already expired.
4. The fresh agent has a registered ML-DSA-87 key.
5. The fresh agent window is live and scoped only to:
   - `PolicyVault`
   - `InvoiceRegistry`
6. The fresh agent key is linked to the operator abstract account with only
   the `evm` permission.
7. The `sentinel-agent-evm` spending rule is selector-scoped to:
   - `pay(uint256,bytes32)`
   - `payWithMandate(uint256,bytes32,uint64,bytes)`
8. `deployments.testnet.json` records the rotation transaction hashes while
   preserving the old agent as compromise evidence.

## Credential files

Keep all of these files local. They are covered by `.gitignore` and must never
be pasted into chat, committed, or uploaded.

| File | Contents | Used by |
| --- | --- | --- |
| `.env` | operator `PRIVATE_KEY` + operator `QORE_PQC_RECOVERY_CODE` | guardian, rotation, operator ops |
| `.env.agent` | agent `PRIVATE_KEY` + agent `QORE_PQC_RECOVERY_CODE` | guardian custody / window renewal |
| `.env.agent.hot` | agent `PRIVATE_KEY` only, plus optional LLM settings | hot agent loop |
| `.env.agent.next` | freshly generated replacement credentials | rotation only |

The separation is deliberate: the hot agent process must not hold the PQC
recovery code. A stolen classical key can attempt payments inside the rails,
but it cannot open or widen an EVM window.

## Procedure

From the repository root:

```bash
# 1. Generate fresh credentials locally. This prints no secret material.
pnpm rotate-agent create-env .env.agent.next

# 2. Read the exact execution plan.
pnpm rotate-agent plan

# 3. Optional read-only preflight: current vault agent, window, PQC status,
#    authenticator and spending-rule state.
pnpm rotate-agent status

# 4. Ensure the three credential files exist locally:
#    .env              operator credentials
#    .env.agent       old drill-exposed agent credentials
#    .env.agent.next  fresh agent credentials

# 5. Execute. This broadcasts real testnet transactions.
pnpm rotate-agent execute --yes
```

The script is idempotent where practical. If it stops partway, inspect the
error, fix the local cause, and rerun `pnpm rotate-agent execute --yes`. Steps
that already succeeded are skipped when their resulting chain state is visible.

## What the script broadcasts

Depending on the current chain state, execution may include:

1. operator → fresh agent test-QOR funding transfer;
2. fresh agent ML-DSA-87 registration with proof of possession;
3. old agent window close;
4. old authenticator revocation;
5. operator admin window open, scoped to `PolicyVault`;
6. `PolicyVault.setAgent(newAgent)`;
7. fresh agent scoped window open;
8. fresh authenticator link with possession proof;
9. spending-rule repair/rewrite preserving unrelated existing rules.

`MsgUpdateSpendingRules` replaces the operator account's rule set wholesale.
The rotation script therefore reads the existing rules first and preserves
unrelated rules instead of accidentally dropping them.

## Local credential handoff after rotation

Only after `pnpm rotate-agent status` shows the expected new state:

1. Put the fresh `PRIVATE_KEY` and `QORE_PQC_RECOVERY_CODE` in `.env.agent`.
2. Put only the fresh `PRIVATE_KEY` in `.env.agent.hot`.
3. Keep or delete the old key material according to your local key-handling
   policy. If you retain it for evidence, name it clearly, for example
   `.env.agent.compromised`, and never use it for operations.
4. Restart services:

```bash
pnpm guardian
pnpm agent
```

## Verification checklist

Run:

```bash
pnpm rotate-agent status
pnpm aa status
```

Confirm manually:

- `vaultPointsAtRecordedAgent` is `true`;
- `agentWindow.live` is `true`;
- `agentWindow.allowedTargets` contains only the vault and registry;
- the new authenticator is present and not revoked;
- the old authenticator is absent, revoked or expired;
- the rule's `allowedEvmCalls` are the two selector-scoped vault calls;
- `deployments.testnet.json` has an `agentRotations` entry and a
  `previousAgents` entry.

Then produce fresh evidence. Run the services first:

```bash
# terminal 1
pnpm guardian

# terminal 2
pnpm agent
```

In a third terminal, create the three demo invoices from the vendor account:

```bash
# 1. ordinary small payment: should execute autonomously
npx tsx --env-file=.env.vendor scripts/ops.ts submit 0.25 INV-POSTROT-001

# 2. over-cap payment: should produce PaymentRefused "over per-tx cap"
npx tsx --env-file=.env.vendor scripts/ops.ts submit 6 INV-POSTROT-CAP-002

# 3. mandate path: first refused as "mandate required"; after the guardian
#    writes logs/mandates/mandate-<id>.json, the agent pays with ML-DSA-87
npx tsx --env-file=.env.vendor scripts/ops.ts submit 3 INV-POSTROT-MANDATE-003
```

Wait for the agent/guardian output after each step. Once all three outcomes are
visible on the dashboard:

```bash
pnpm receipts:export
pnpm snapshot
```

Record the resulting transaction hashes in `deployments.testnet.json` and in
`docs/QDAY_DRILL.md`'s post-drill evidence table.

## Troubleshooting

- **`missing env file`** — create the file locally; do not commit it.
- **`PRIVATE_KEY derives ... but the unified account is ...`** — the private
  key and recovery-code-derived account do not match. Use the correct pair.
- **`operator ... does not match deployments operator`** — the wrong operator
  `.env` is present. Only the vault operator can rotate the vault agent.
- **timeout waiting for chain state** — inspect the printed transaction hash;
  public RPC/REST indexing can lag. Rerun the script after the transaction is
  visible.
- **insufficient funds** — top up the operator test account, then rerun.
- **authenticator proof failure** — regenerate `.env.agent.next` with
  `create-env`; do not edit key material by hand.
- **old window cannot be closed** — if the old window is already expired this
  step is skipped. If it is live and the old PQC recovery code is unavailable,
  stop and reassess before continuing; the old key must not be reactivated.
