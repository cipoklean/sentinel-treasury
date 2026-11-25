# Q-Day Drill Replay and Evidence Log

This file separates three things that are easy to blur together:

1. what Sentinel proved before the drill;
2. what can and cannot be claimed about 18 November itself;
3. what the post-drill response must prove.

The tone is deliberately conservative. A security project should not turn
missing evidence into a marketing claim.

## Drill setup

The drill target was the agent identity itself:

- agent EVM: `0xBBCDb4F24461E7b73a344d2ff365Fb32080331a8`
- agent cosmos: `qor1h0xmfujyv8nmww35f5hlxe0mxgyqxvdgd9cvrk`
- PolicyVault: `0x18221b4d802b4Efc9B1B4099bab93c803ec2D1C9`
- InvoiceRegistry: `0x7CC179815f429E6cA53B0f56f2E0dF44b192B78D`

The attack position modelled by the drill is possession of the agent's
classical ECDSA key. That is the key the hot agent uses to sign payment
transactions. It is not the operator key and it is not the agent's ML-DSA-87
recovery material.

## Pre-drill evidence

These facts were established before the drill and remain relevant:

| Claim | Evidence |
| --- | --- |
| The agent EOA window was target-scoped to the vault and registry. | window open `A6293E8A882E295054A751E7E21C3A3475FFBA6C3FD2FDDEEF026D4D3753655F` |
| An out-of-target EOA transfer was rejected at broadcast. | broadcast error recorded in `deployments.testnet.json`: `window does not list recipient as allowed target` |
| The abstract-account rule was selector-scoped to `pay` and `payWithMandate`. | rule update `F1F3F4A3B15AE4917EE5AE9792780D0183B62CCBE856A4F2A8F7C4A11EF6E9AA` |
| An agent-signed `withdraw` through the operator account was protocol-refused. | `AC46FFC76F7CE897E29BB111DC78EC71E9ED8CCF700400BD437C6AF30FCBE75C` |
| A call outside `allowed_evm_calls` was protocol-refused. | `34B98142040121032A9AF63EFE15109731BC01E4B881880306FCB3AE53552DB9` |
| An over-cap payment was refused by the vault. | `5CE9CEC057D7D87E4AC0D5EFFF02570A88EDB3D1A3C79F5846315788F7EB1819` |
| A mandate-required payment was refused without a mandate and later paid with an ML-DSA-87 mandate. | refusal `A99BED8A64CFCB536250F0FDF50E3B5875410A152A6E4FE39471898BE5F3846A`; payment `A0FC79640C5D7C4A950C8EFBBB054BBDD12A5F488C4280E178530F1EB546378F` |

These transactions prove the enforcement mechanisms worked when exercised.
They do not, by themselves, prove that the system was live during the drill.

## 18 November evidence review

The important negative finding is operational, not cryptographic:

- The original scoped window opened at height `10071340`
  (`2026-11-14T11:43:03Z`).
- It expired at height `10088620` (`2026-11-14T18:33:38Z`).
- The UTC drill day of 18 November spans approximately blocks `10284029` to
  `10344547`.
- Therefore the EOA window was already expired before the drill began.
- A scan of the vault and registry contract logs for the 18 November UTC block
  range found zero contract events. Reproduce this read-only scan with
  `pnpm drill-evidence`.
- No drill-day proof-of-life transaction hash is recorded in this repository.

The abstract-account authenticator was still within its seven-day validity
period during the drill: it was created on 13 November and was set to expire on
20 November. The account-rail protection was therefore still relevant even
though the EOA window was inactive. However, the recorded successful attack
probes are pre-drill demonstrations, not drill-day attack transcripts.

### What can be claimed

- The old agent's direct-EOA rail was not live on 18 November because its
  window had expired.
- The selector-scoped account rail was configured and had already refused both
  an out-of-target call and an out-of-selector `withdraw` in real transactions.
- The vault's payout caps and ML-DSA-87 mandate path had already been exercised
  in real transactions.
- No unauthorized withdrawal or treasury drainage is visible in the recorded
  evidence.

### What must not be claimed

- Do not claim the scoped EOA window blocked a live drill-day attack. It was
  expired before the drill.
- Do not claim a drill-day proof-of-life payment happened unless a real
  transaction hash is produced.
- Do not treat absence of contract logs as proof that no attack was attempted;
  protocol-level rejections can occur before contract execution.
- Do not describe Sentinel as “safe because it was live under attack” on the
  current evidence. The accurate statement is narrower: the enforcement layers
  were demonstrated, while drill-day liveness evidence was incomplete.

## Post-drill compromise response

Regardless of whether the drill bot used the key, the old agent classical key
is permanently compromised after registration for the drill. The correct
response is rotation, not renewal.

The repository now includes `scripts/rotate-agent.ts` and `docs/ROTATION.md`.
A correct post-drill rotation must produce fresh evidence for each row:

| Required post-drill evidence | Status |
| --- | --- |
| Fresh agent classical key generated locally | pending operator execution |
| Fresh agent ML-DSA-87 key registered with possession proof | pending operator execution |
| Old agent window closed or confirmed expired | pending operator execution |
| Old abstract-account authenticator revoked or confirmed expired | pending operator execution |
| `PolicyVault.setAgent(newAgent)` executed by operator | pending operator execution |
| Fresh scoped window opened for the new agent | pending operator execution |
| Fresh authenticator linked and selector-scoped | pending operator execution |
| Fresh ordinary payment after rotation | pending operator execution |
| Fresh over-cap refusal after rotation | pending operator execution |
| Fresh mandate-required refusal and `payWithMandate` payment after rotation | pending operator execution |

After execution, replace the `pending operator execution` entries with real
hashes and update `deployments.testnet.json` (the rotation script does this for
rotation transactions automatically).

## Lessons

1. **A mechanism must be live to count as drill evidence.** The scoped
   window was correctly configured, but its duration ended before drill day.
2. **Renewal is part of the security story.** Window expiry failed closed,
   which is safe for funds but weak as a demonstration of live autonomy.
3. **Rotation evidence matters as much as prevention evidence.** Post-quantum
   security is operational: key lifetime, revocation and replacement are part
   of the design.
4. **Separate prevention layers.** The expired EOA window did not erase the
   value of the independent abstract-account rail or the vault payout policy.
5. **Record negative evidence carefully.** “No contract events” is useful, but
   it is not the same as “the attacker was blocked at the protocol boundary.”

## Replay procedure for a future drill

For a future drill or judge-facing replay, use this sequence:

1. Rotate to a fresh agent key before the drill window.
2. Open the scoped EOA window close enough to the drill that it remains live
   throughout the drill.
3. Record the exact opening and expiry heights and timestamps.
4. Produce one ordinary pre-drill payment to prove liveness.
5. During the drill window, preserve every attacker transaction hash or
   broadcast rejection.
6. After the drill, rotate the key again and record revocation/rotation.
7. Publish a table that distinguishes:
   - attacker attempts;
   - protocol rejections;
   - contract refusals;
   - successful policy-valid payments;
   - operator rotations and kill-switch actions.

That procedure produces evidence for “safe while live”, not merely “safe
because inactive.”
