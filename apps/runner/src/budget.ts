import { wrapLLM } from '@ourointelligence/sdk';
import type { LLM } from '@ourointelligence/sdk';

/** Thrown by the budget wrapper before a call when the lane's spend for the UTC day has reached its budget. */
export class BudgetExceeded extends Error {
  override readonly name = 'BudgetExceeded';
  constructor(
    readonly lane: string,
    readonly spentUsd: number,
    readonly budgetUsd: number,
  ) {
    super(`lane ${lane} has spent ${spentUsd.toFixed(4)} USD today, budget ${budgetUsd.toFixed(2)} USD`);
  }
}

export type BudgetDeps = {
  lane: string;
  /** Current budget (can change at runtime through the control socket). */
  budgetUsd: () => number;
  pricing: { inputPerMTok: number; outputPerMTok: number };
  /** Spend so far for the current UTC day. */
  spentToday: () => number;
  /** Persist one call's usage. */
  record: (usage: { inputTokens: number; outputTokens: number; usd: number; model: string }) => void;
  /** Called once when a call is refused because the budget is spent. */
  onExceeded: (err: BudgetExceeded) => void;
  now?: () => number;
};

/** Price one call in dollars. */
export function costUsd(usage: { inputTokens: number; outputTokens: number }, pricing: BudgetDeps['pricing']): number {
  return (usage.inputTokens * pricing.inputPerMTok + usage.outputTokens * pricing.outputPerMTok) / 1_000_000;
}

/** Milliseconds until the next 00:00 UTC. */
export function msUntilUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1000, next - now);
}

/**
 * Wrap the lane's model so every call is counted and priced, and refused once the daily budget is spent.
 * The refusal is a BudgetExceeded error, which the SDK does not retry; the runner pauses the loop on it.
 */
export function budgetLLM(inner: LLM, deps: BudgetDeps): LLM {
  let warned = false;
  return wrapLLM(inner, {
    name: inner.name,
    before: () => {
      const spent = deps.spentToday();
      const budget = deps.budgetUsd();
      if (budget > 0 && spent >= budget) {
        const err = new BudgetExceeded(deps.lane, spent, budget);
        if (!warned) {
          warned = true;
          deps.onExceeded(err);
        }
        throw err;
      }
      warned = false;
    },
    after: (res) => {
      deps.record({ ...res.usage, usd: costUsd(res.usage, deps.pricing), model: res.model });
    },
  });
}
