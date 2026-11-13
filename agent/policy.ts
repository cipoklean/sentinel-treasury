/**
 * policy.ts — the agent's decision engine.
 *
 * The verdict mirrors the on-chain policy so receipts can say *why* the agent
 * acted, but the vault is the real arbiter: whatever the agent concludes, the
 * chain enforces caps, the allowlist and the mandate threshold.
 */
export interface Invoice {
  id: bigint;
  vendor: `0x${string}`;
  amount: bigint;
  ref: `0x${string}`;
  status: number; // 0 pending, 1 paid, 2 rejected, 3 cancelled
  createdAt: bigint;
}

export interface PolicyState {
  paused: boolean;
  vendorAllowed: boolean;
  perTxCap: bigint;
  dailyCap: bigint;
  mandateThreshold: bigint;
  spentToday: bigint;
  spentDay: bigint;
  mandateAvailable: boolean;
}

export type Action = "pay" | "payWithMandate" | "refuse";

export interface Verdict {
  action: Action;
  reason: string;
}

export function decide(inv: Invoice, s: PolicyState, nowDay: bigint): Verdict {
  if (inv.status !== 0) return { action: "refuse", reason: "not pending" };
  if (s.paused) return { action: "refuse", reason: "paused" };
  if (!s.vendorAllowed) return { action: "refuse", reason: "vendor not allowed" };
  if (inv.amount > s.perTxCap) return { action: "refuse", reason: "over per-tx cap" };
  const spent = s.spentDay === nowDay ? s.spentToday : 0n;
  if (spent + inv.amount > s.dailyCap) return { action: "refuse", reason: "over daily cap" };
  if (inv.amount > s.mandateThreshold) {
    return s.mandateAvailable
      ? { action: "payWithMandate", reason: "over threshold; operator mandate present" }
      : { action: "refuse", reason: "mandate required" };
  }
  return { action: "pay", reason: "within policy" };
}
