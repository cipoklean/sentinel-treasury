# Sentinel Demo Video Script

Target length: **2 minutes 45 seconds**. Hard maximum: **3 minutes**.

Goal: prove one coherent story — Sentinel is a live autonomous treasury agent
whose classical key can be exposed without giving the attacker unlimited
treasury authority.

Do not show private keys, recovery codes, mnemonics or API keys. Use a clean
terminal profile, large font, and prepare every command before recording.

## Preconditions before recording

Complete these first; otherwise the video will show history rather than a live
system:

1. Run the rotation in `docs/ROTATION.md`.
2. Copy the fresh key material into `.env.agent` and `.env.agent.hot` correctly.
3. Start `pnpm guardian` in one terminal.
4. Start `pnpm agent` in another terminal.
5. Confirm `pnpm rotate-agent status` shows the fresh agent, a live scoped
   window, a linked authenticator and the correct vault agent.
6. Have the live dashboard open: `/dashboard`.
7. Have the landing page open at the architecture diagram.
8. Prepare three terminal tabs but do not type commands live if avoidable.

Recommended invoice sequence:

```bash
# ordinary small payment
npx tsx --env-file=.env.vendor scripts/ops.ts submit 0.25 INV-VIDEO-001

# over-cap refusal
npx tsx --env-file=.env.vendor scripts/ops.ts submit 6 INV-VIDEO-CAP-002

# mandate path: above threshold, below per-tx cap
npx tsx --env-file=.env.vendor scripts/ops.ts submit 3 INV-VIDEO-MANDATE-003
```

## Shot list and narration

### 0:00–0:18 — Problem

**Visual:** landing page hero, then the enforcement diagram.

**Narration:**

> “AI agents can already sign transactions. The hard part is not making them
> act — it is making sure a stolen key or a bad model output cannot turn that
> autonomy into unlimited spending authority. Sentinel is a treasury agent on
> QoreChain whose limits are enforced outside the agent.”

**On-screen emphasis:** “limits enforced outside the agent”.

### 0:18–0:43 — Architecture

**Visual:** architecture diagram; highlight the two rails.

**Narration:**

> “There are two independent protocol rails into the same policy vault. First,
> the agent’s own EVM window is restricted to the vault and invoice registry,
> with block, transaction and value budgets. Second, the same key is linked to
> the operator’s abstract account, but only for the vault’s pay and
> payWithMandate selectors. The vault then re-checks every payment: vendor,
> pause, per-transaction cap, UTC-day cap, and post-quantum mandates over the
> threshold.”

**Do not say:** “nested layers”. They are parallel rails into one contract
layer.

### 0:43–0:58 — Live status

**Visual:** terminal output of:

```bash
pnpm rotate-agent status
```

Crop or scroll to the important lines: fresh vault agent, live window,
authenticator, selector-scoped rule.

**Narration:**

> “This is the post-rotation state. The vault points at the fresh agent, the
> old drill key is revoked, the new window is live only for the two contracts,
> and the account rule is selector-scoped.”

Only say “old drill key is revoked” if the status output visibly shows it.

### 0:58–1:25 — Ordinary autonomous payment

**Visual:** submit the 0.25 QOR invoice, switch to agent terminal, then
dashboard update.

**Narration:**

> “A third-party vendor submits a small invoice as itself. The agent scans the
> registry, applies deterministic policy, optionally lets the model veto,
> signs an EIP-712 decision receipt, and pays. The dashboard is not the source
> of truth — it is rebuilt from chain events, with the signed receipt attached
> as evidence.”

**Show clearly:**

- vendor command;
- agent detection;
- payment transaction hash;
- dashboard row or live statistics.

### 1:25–1:47 — Refusal evidence

**Visual:** submit the 6 QOR invoice; agent output; dashboard refusal row.

**Narration:**

> “Now the invoice is above the vault’s five-QOR per-transaction cap. Even if
> the agent tries to pay it, the vault is the final arbiter. It emits a
> PaymentRefused event — over the per-transaction cap — and no money moves.”

**On-screen emphasis:** `PaymentRefused` and the reason string.

### 1:47–2:25 — ML-DSA-87 mandate arc

**Visual:** submit the 3 QOR invoice; show initial mandate-required state,
guardian issuing mandate, then successful `payWithMandate` transaction.

**Narration:**

> “Three QOR is below the per-transaction cap but above the two-QOR mandate
> threshold. A normal pay call is refused because it needs operator approval.
> The guardian signs a mandate with the operator’s ML-DSA-87 key. The vault
> verifies that signature inside Solidity through QoreChain’s pqcVerify
> precompile, then the payment executes. The agent never has to be trusted
> with the operator’s post-quantum authority.”

**Show clearly:** `mandate required` followed by successful `withMandate`
payment. This is the cryptographic center of the video.

### 2:25–2:45 — Q-Day security story

**Visual:** drill section of the landing page or `docs/QDAY_DRILL.md` evidence
table.

**Narration:**

> “For the Q-Day drill, the honest story matters. The original scoped window
> had expired before drill day, so Sentinel cannot claim a live window blocked
> an attack that day. What was proven is stronger than a demo claim: target
> scoping, selector-scoped account execution, payout refusals and ML-DSA-87
> mandates all work in real transactions — and the compromised key has a
> defined rotation path.”

If rotation has completed, add:

> “That rotation has now been executed: the old authenticator is revoked and
> the fresh key is operating under the same bounds.”

### 2:45–2:55 — Close

**Visual:** README evidence table or `deployments.testnet.json` hashes.

**Narration:**

> “Every important claim resolves to a transaction, a contract event or a
> protocol rule. Sentinel is not AI trusted with money — it is AI operating
> inside post-quantum spending boundaries.”

End on the live dashboard.

## Editing notes

- Cut waiting time aggressively; use jump cuts while preserving causality.
- Never obscure transaction hashes completely; at least one payment and one
  mandate hash should be readable long enough to pause.
- Do not use background music loud enough to compete with narration.
- Use terminal captions rather than reading every command character by
  character.
- If a step fails during recording, stop and re-record that segment. Do not
  narrate around a failure as though it succeeded.

## Accuracy checklist before upload

- [ ] Video is under 3 minutes.
- [ ] No secret material is visible.
- [ ] The video does not call the LLM an approver.
- [ ] It says “UTC-day cap”, not “rolling daily cap”.
- [ ] It does not claim a drill-day live-window defense unless real evidence is
      shown.
- [ ] It shows a fresh post-rotation payment.
- [ ] It shows a fresh refusal.
- [ ] It shows the mandate-required → ML-DSA-87 mandate → paid arc.
- [ ] The repo link, live site and contract addresses in the final frame match
      the hackathon project page.
