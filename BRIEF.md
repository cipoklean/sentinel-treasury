# BRIEF — Sentinel Dashboard

## Subject
A live operations dashboard for Sentinel: an autonomous, post-quantum-bounded
treasury agent on QoreChain testnet. It surfaces what the agent is doing right
now — signed decision receipts with their on-chain tx anchors, the scoped EVM
window's remaining budget, vault policy state, and DeepSeek's veto review —
with every number resolving to a chain artifact a judge can click.

## Audience
Build Before Q-Day judges (watching the demo video and optionally loading the
live URL), and the user narrating the demo.

## Emotional goal
It should feel like a tamper-evident audit instrument: the reader trusts the
numbers because each one is a chain artifact, not because the UI is pretty.

## Anti-vibes (must NOT feel like)
1. Neon web3 casino
2. Generic SaaS analytics dashboard
3. "AI magic" mystery box

## Evidence artifacts (domain-native)
No photography exists for this domain. Per TASTE, live data and drawn diagrams
fill subject slots:
- Live chain reads: window status, policy state, vault balance (viem)
- decisions.jsonl rendered as the evidence ledger (receipt hash ↔ tx link)
- Drawn SVG: the three concentric enforcement bounds around the agent key
- Explorer links for every cited transaction
