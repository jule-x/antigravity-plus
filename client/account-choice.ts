import type { AccountView, AccountsView, WindowView } from "../shared/accounts-rpc.ts";

export const accountLabel = (account: AccountView) => account.nickname || account.email;

export function remaining(window: WindowView) {
  const value = window.remainingPct ?? (window.usedPct == null ? null : 100 - window.usedPct);
  return value !== null && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
}

export function windows(account: AccountView) {
  return account.snapshot?.report.status === "available" ? account.snapshot.report.windows : [];
}

function minimumRemaining(account: AccountView) {
  const values = windows(account).map(remaining).filter(value => value !== null);
  return values.length ? Math.min(...values) : null;
}

export function quotaSummary(account: AccountView, active: boolean, quotaError: boolean) {
  const minimum = minimumRemaining(account);
  const depleted = minimum === 0 || (active && quotaError);
  return { minimum, depleted };
}

/** The least remaining window limits how much of a standby account's measured quota is usable. */
export function bestStandby(accounts: AccountView[], activeId: string) {
  let best: AccountView | undefined;
  let bestScore = -1;
  for (const account of accounts) {
    if (account.id === activeId) continue;
    const score = minimumRemaining(account);
    if (score !== null && score > bestScore) {
      best = account;
      bestScore = score;
    }
  }
  return best;
}

// With no measured candidate, opening the accounts page leaves every standby card selectable.
export function composerChoice(view: AccountsView, active: AccountView) {
  const depleted = view.quotaError || minimumRemaining(active) === 0;
  const target = depleted ? bestStandby(view.accounts, active.id) : undefined;
  return { depleted, confirmId: target?.id };
}
