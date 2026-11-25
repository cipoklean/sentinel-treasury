# Hackathon Submission Checklist

Hackathon: **Build Before Q-Day — The QoreChain Developer Fest**  
Category: **Post-Quantum AI Agents**  
Deadline: **2 December 2026, 23:59 UTC**

Use UTC, not local time, for the deadline.

## Required submission items

| Item | Current repo support | Owner action |
| --- | --- | --- |
| Public repository | `github.com/cipoklean/sentinel-treasury` | keep public through judging |
| License | Apache-2.0 `LICENSE` + `NOTICE` | none |
| README | present; evidence-oriented | update status after rotation/demo |
| Featured image | `web/assets/og.png` | upload/select on hackathon page if not already set |
| Testnet addresses | `deployments.testnet.json`, README, live site | update project page after rotation |
| Video, max 3 minutes | script in `docs/VIDEO_SCRIPT.md` | record/upload/link |
| Live demo / dashboard | `https://sentinel-liart-kappa.vercel.app` | redeploy after rotation/evidence updates |
| QoreChain usage evidence | `deployments.testnet.json` | refresh with post-rotation transactions |

## Critical path before submission

1. **Rotate the agent key**
   - Follow `docs/ROTATION.md`.
   - Do not merely renew the old drill key's window.

2. **Restore live operation**
   - Copy credentials into `.env.agent` and `.env.agent.hot` correctly.
   - Run `pnpm guardian` and `pnpm agent`.

3. **Produce fresh post-rotation evidence**
   - one ordinary small payment;
   - one over-cap refusal;
   - one mandate-required refusal followed by a successful `payWithMandate`;
   - export receipts and snapshot.

4. **Update evidence**
   - `deployments.testnet.json` should contain rotation hashes;
   - `docs/QDAY_DRILL.md` should replace pending entries with real hashes;
   - README evidence table should link the fresh post-rotation proof;
   - dashboard snapshot/receipts should be current.

5. **Record the video**
   - Follow `docs/VIDEO_SCRIPT.md`.
   - Keep it under three minutes.
   - Show the live post-rotation sequence rather than only static diagrams.

6. **Update the hackathon project page**
   - upload/link the video;
   - update addresses if the agent address changed;
   - correct copy inconsistencies;
   - confirm the featured image and live URL.

## Project-page copy corrections

Make the public copy match the implementation exactly:

- Use **“fixed UTC-day cap”**, not “rolling daily cap”.
- Describe the LLM as **veto-only**, never as an approver.
- Do not claim the original scoped window was live throughout drill day; it
  expired before 18 November. The accurate claim is that the enforcement
  mechanisms were proven in real transactions and that post-drill rotation is
  part of the security lifecycle.
- Emphasize the actual differentiator: **two independent protocol-level rails
  plus in-contract ML-DSA-87 mandate verification plus a chain-rebuilt evidence
  board**.

Suggested concise description:

> Sentinel is an autonomous invoice-paying treasury agent on QoreChain whose
> authority is bounded outside the agent. Its EOA is restricted by a scoped EVM
> window, its abstract-account authenticator is selector-scoped to vault
> payment functions, and PolicyVault re-checks vendor, pause, per-transaction
> and fixed UTC-day caps. Payments above threshold require operator ML-DSA-87
> mandates verified inside Solidity through pqcVerify. The LLM reviewer can
> veto but never approve. Every claim is backed by testnet transactions and a
> live chain-rebuilt evidence board.

## Judging-rubric self-check

### Works as described — 25%

- [ ] fresh payment visible on chain and dashboard
- [ ] fresh refusal visible on chain and dashboard
- [ ] fresh mandate payment visible on chain and dashboard
- [ ] live API/dashboard loads without errors
- [ ] README quickstart matches real commands

### QoreChain technology usage — 25%

- [ ] scoped EVM window evidence current
- [ ] abstract-account authenticator evidence current
- [ ] selector-scoped spending rule evidence current
- [ ] hybrid ML-DSA-87 registration evidence current
- [ ] `pqcVerify` / `pqcKeyStatus` usage clear in contract and live evidence

### Post-quantum correctness/security — 20%

- [ ] custody split explained accurately
- [ ] old drill key rotated and revoked
- [ ] mandate message domain separation explained
- [ ] limits of test coverage disclosed
- [ ] drill evidence is honest, including missing drill-day liveness
- [ ] `pnpm drill-evidence` output matches `docs/QDAY_DRILL.md`

### Originality — 15%

- [ ] positioning is not “AI pays invoices”
- [ ] positioning centers parallel protocol rails and post-quantum mandate verification
- [ ] chain-rebuilt evidence board is shown as a verification surface

### Clarity / UX / documentation — 15%

- [ ] video is understandable without sound-on-terminal reading
- [ ] README links rotation, drill, threat model and AI usage docs
- [ ] dashboard is readable and not overloaded
- [ ] known limitations remain visible

## Final freeze rules

After 1 December:

- no new features;
- no contract redesign;
- only fix broken links, incorrect copy, missing evidence and video issues;
- do not rotate keys or redeploy contracts on submission day unless there is
  an emergency;
- leave enough time to upload the video and verify it plays from a logged-out
  browser.

## User-account-only actions

These cannot be completed from the repository alone:

- fill real `.env`, `.env.agent`, `.env.vendor` and `.env.agent.hot` files;
- execute key rotation and broadcast transactions;
- restart guardian and agent with real credentials;
- record/upload the video;
- edit hackathon project-page fields;
- accept hackathon terms or submit the final form;
- deploy the updated site to the Vercel account.
