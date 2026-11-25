# Sentinel Threat Model

This document states what Sentinel is designed to survive, what it is not
designed to survive, and which layer is expected to stop each attack. It is
written against the deployed `qorechain-diana` system recorded in
`deployments.testnet.json`.

## Security claim

Sentinel does not claim that the AI agent is trustworthy or that its classical
key cannot be stolen. The claim is narrower and stronger:

> A stolen classical agent key, or a manipulated model output, cannot exceed
> the payment authority encoded outside the agent: protocol-level target and
> account rules, plus contract-level payout policy.

The important consequence is that the AI is not the security boundary. It is a
decision component inside several independent enforcement boundaries.

## Assets

| Asset | Why it matters |
| --- | --- |
| Vault treasury balance | The main value at risk. |
| Operator classical key | Controls the vault, authenticators, mandates and withdrawals. |
| Operator PQC recovery material | Required for hybrid native transactions and proof of post-quantum control. |
| Agent classical key | The hot key the agent uses to sign payment transactions. |
| Agent PQC recovery material | Required to open or modify the agent EVM window. Held by the guardian, not the hot agent. |
| Vault policy integrity | Caps, vendor allowlist, pause state and agent identity determine what can be paid. |
| Mandate integrity | High-value payments depend on operator ML-DSA-87 approval. |
| Evidence integrity | Judges and operators need chain-backed events, not UI claims. |
| Availability | The system should fail closed and remain operable enough to rotate or pause. |

## Trust boundaries

1. **Hot agent boundary** — `agent/` holds only the agent classical key. It
   scans invoices, applies local policy, optionally asks an LLM for a veto,
   signs a receipt and submits `pay` or `payWithMandate`.
2. **Guardian/operator boundary** — `guardian/` holds the operator credentials
   and the agent PQC recovery material. It renews or closes windows, issues
   mandates and revokes authenticators.
3. **Protocol boundary** — QoreChain enforces the EVM window and the
   abstract-account spending rules outside the contracts and outside the agent.
4. **Contract boundary** — `PolicyVault` re-checks every payment and is the
   only layer that bounds payout amounts.
5. **Registry boundary** — `InvoiceRegistry` stores invoice state. It is not a
   payment-policy engine.
6. **AI boundary** — the LLM can only veto. It cannot authorize a payment that
   deterministic policy or the vault refused.
7. **Interface boundary** — the dashboard and landing page present evidence;
   they are not enforcement components.

## Controls

| Control | Enforced by | What it bounds |
| --- | --- | --- |
| Scoped EVM window | QoreChain protocol | Where the agent EOA may send transactions, how long it may act, transaction count, and the key's own value+gas budget. |
| Abstract-account authenticator rule | QoreChain `x/abstractaccount` | What the linked agent key may execute as the operator account: only selector-scoped vault payment calls, with account-outflow limits and expiry. |
| Payout policy | `PolicyVault` | Vendor allowlist, pause, per-transaction cap, UTC-day cap, mandate threshold. |
| Mandate verification | `PolicyVault` + `pqcVerify` | Payments above threshold require an operator ML-DSA-87 signature over a domain-separated message. |
| Operator key-status check | `PolicyVault` + `pqcKeyStatus` | Admin functions require the operator account to retain a registered, possession-proven PQC key. |
| Custody split | Key management | The hot agent cannot open or widen its own window because it does not hold PQC recovery material. |
| LLM veto-only design | `agent/policy.ts` + `agent/llm.ts` | Model output can block but never create authority. |
| Kill switch | `guardian/` | Operator can pause the vault, close the agent window and revoke the authenticator. |

## Attack scenarios

### 1. Stolen agent classical key

**Attacker capability:** sign normal secp256k1 transactions as the agent and
sign abstract-account authorization digests as the linked authenticator.

**Expected result:**

- Direct EOA transactions are admitted only inside the scoped window. The
  deployed window targets only `PolicyVault` and `InvoiceRegistry`.
- Abstract-account executions are admitted only when they match the
  `sentinel-agent-evm` rule. The rule is selector-scoped to vault `pay` and
  `payWithMandate`; an out-of-selector `withdraw` is protocol-refused.
- Even a valid payment call is re-checked by the vault. Vendor, pause, per-tx
  cap, UTC-day cap and mandate requirements still apply.
- The attacker cannot open or widen the window with only the classical key
  because window operations are hybrid-signed native transactions.

**Residual risk:** before revocation, the attacker may attempt policy-valid
payments or grief the window transaction budget. This is intentionally bounded;
it is not equivalent to treasury drainage.

**Response:** run the rotation runbook in `docs/ROTATION.md`; use the guardian
kill switch if immediate shutdown is needed.

### 2. Manipulated or malicious LLM output

**Attacker capability:** prompt-inject invoice content or compromise the model
provider so the model returns attacker-friendly reviews.

**Expected result:** limited. The model is a veto-only reviewer. A model
approval is not authority: deterministic local policy, the chain rails and the
vault still decide. A malicious “yes” cannot create a payment path. A malicious
“no” can only delay or block payment.

**Residual risk:** availability degradation and false confidence if operators
misread the LLM as an approval oracle. The UI and documentation therefore call
it a reviewer, not an authorizer.

### 3. Malicious or spam invoice submitter

**Attacker capability:** permissionlessly submit many invoices, including
invoices to attacker-controlled vendors.

**Expected result:**

- Non-allowlisted vendors are refused by the vault.
- Oversized invoices are refused by the vault.
- Spam can consume agent attention and, if the agent attempts payment, window
  transaction budget.

**Residual risk:** invoice spam is not fully solved. The current agent has a
one-attempt state file, but a stronger production version should add rate
limits, vendor reputation, minimum invoice age and operator review queues.

### 4. Compromised hot agent host

**Attacker capability:** modify the agent process, exfiltrate the hot key and
control local decision logs.

**Expected result:** equivalent to a stolen classical agent key plus local
evidence tampering. Chain enforcement still bounds payment authority. The
dashboard mitigates evidence tampering by rebuilding state from chain events;
signed receipts annotate but do not override chain history.

**Residual risk:** local logs and mandate files can be deleted or altered.
Receipt export is therefore an audit convenience, not the root of truth.

### 5. Stolen agent classical key plus agent PQC recovery material

**Attacker capability:** sign hybrid native transactions as the agent,
including window-management transactions.

**Expected result:** this breaks the custody-split assumption and is a severe
operational compromise. Vault payout policy still bounds treasury payments, and
the attacker still cannot call operator-only vault functions as the agent.
However, the attacker may control the agent account's own funds and window
posture until the operator rotates and revokes it.

**Response:** treat as an incident: pause the vault, revoke the authenticator,
rotate the agent identity, investigate custody failure. Never store the agent
PQC recovery code in `.env.agent.hot`.

### 6. Compromised guardian or operator key

**Attacker capability:** act as the treasury owner.

**Expected result:** not protected. The operator can change policy, rotate the
agent, allow vendors, withdraw and pause. This is outside the system's stated
security claim.

**Mitigation:** operational key hygiene, separate machine, minimum balance,
hardware-backed key storage where possible, and future migration to multisig
or policy-constrained administration. The current project honestly treats the
guardian as warm infrastructure, not cold custody.

### 7. Mandate replay or substitution

**Attacker capability:** reuse or alter an operator mandate.

**Controls:**

- The mandate message includes a domain string, chain id, vault address,
  invoice id, vendor, amount and expiry.
- The vault verifies the signature against the operator's chain-registered
  ML-DSA-87 key using `pqcVerify`; it does not accept a caller-supplied key.
- Expired mandates are refused.
- Invoice state prevents ordinary reuse after settlement.

**Residual risk:** mandate issuance is operational. If the guardian signs a
mandate for a malicious invoice, the vault correctly treats it as authorized.
Mandate policy is therefore part of operator security.

### 8. Protocol or precompile failure

**Attacker capability/condition:** a bug in QoreChain window enforcement,
abstract-account execution or the PQC precompiles.

**Expected result:** outside the threat model. Sentinel deliberately uses these
protocol features as root enforcement mechanisms. Contract tests mock the
precompiles for control flow; live testnet transactions demonstrate interop,
but they are not a substitute for a protocol audit.

### 9. Contract implementation failure

**Attacker capability/condition:** exploit a bug in `PolicyVault` or
`InvoiceRegistry`.

**Controls:** small contract surface, reentrancy lock on value-moving paths,
16 Foundry tests including PQC precompile mocks, refusal events and live
testnet evidence.

**Residual risk:** no independent security audit has been performed. The
contracts should be treated as hackathon/testnet artifacts, not production
treasury infrastructure.

### 10. RPC, dashboard or evidence-availability failure

**Expected result:** enforcement does not depend on the dashboard. If RPC or
the web interface fails, the vault and protocol rails still enforce policy.
The operator can use scripts directly against chain endpoints.

**Residual risk:** operational visibility degrades. Snapshot fallback in the
dashboard is useful for availability but must be labeled as a snapshot, not
live state.

## Kill-switch ordering

For an active compromise, the safest order is:

1. Pause the vault as operator.
2. Revoke the agent authenticator.
3. Close the agent window if it is still live.
4. Rotate the agent key and update `PolicyVault.agent`.
5. Resume only after fresh payment/refusal evidence is produced.

`guardian/` implements the operational kill-switch path;
`docs/ROTATION.md` implements the replacement path.

## Non-goals

Sentinel does not attempt to prove:

- that the operator cannot be malicious or compromised;
- that invoice amounts correspond to real-world services;
- that the LLM is correct, unbiased or reliable;
- that permissionless invoice spam is impossible;
- that testnet enforcement is sufficient for production custody.

The project demonstrates bounded autonomy and post-quantum enforcement
primitives. Production use would require independent audits, stronger key
custody, rate limiting, vendor due diligence and a clearer incident-response
process.
