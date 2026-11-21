import test from "node:test";
import assert from "node:assert/strict";
import { composerChoice, quotaSummary, remaining } from "../client/account-choice.ts";
import type { AccountsView, AccountView } from "../shared/accounts-rpc.ts";

const a: AccountView = { id: "a", email: "a@example.com", addedAt: "2026-01-01" };
const b: AccountView = { ...a, id: "b", email: "b@example.com" };
const c: AccountView = { ...a, id: "c", email: "c@example.com" };

function measured(account: AccountView, ...percentages: number[]): AccountView {
  return {
    ...account, snapshot: { readAt: "2026-01-01", report: {
      status: "available", windows: percentages.map((remainingPct, i) => ({ id: String(i), label: String(i), remainingPct })),
    } },
  };
}
function state(accounts: AccountView[], quotaError = false): AccountsView {
  return { accounts, activeAccountId: a.id, quotaError, busy: false, notice: null };
}

test("exhausted quota with unmeasured standby opens accounts for a manual selection", () => {
  const active = measured(a, 0);
  assert.deepEqual(composerChoice(state([active, b]), active), { depleted: true, confirmId: undefined });
});

test("agy quota errors suggest the standby with the largest measured minimum for confirmation", () => {
  const view = state([a, measured(b, 10, 90), measured(c, 50, 60)], true);
  assert.deepEqual(composerChoice(view, a), { depleted: true, confirmId: c.id });
});

test("available quota opens the ordinary accounts screen", () => {
  const active = measured(a, 80);
  assert.deepEqual(composerChoice(state([active, measured(b, 100)]), active), { depleted: false, confirmId: undefined });
});

test("positive quota below display precision is not treated as exhausted", () => {
  const active = measured(a, 0.001);
  assert.deepEqual(quotaSummary(active, true, false), { minimum: 0.001, depleted: false });
  assert.deepEqual(composerChoice(state([active, measured(b, 100)]), active), { depleted: false, confirmId: undefined });
});

test("quota summaries use the lowest known remaining percentage and distinguish standby readings", () => {
  const account: AccountView = { ...b, snapshot: { readAt: "2026-01-01", report: { status: "available", windows: [
    { id: "unknown", label: "Unknown" }, { id: "weekly", label: "Weekly", remainingPct: 65 },
    { id: "short", label: "Short", usedPct: 80 },
  ] } } };
  assert.deepEqual(quotaSummary(account, false, true), { minimum: 20, depleted: false });
  assert.deepEqual(quotaSummary(b, false, false), { minimum: null, depleted: false });
});

test("reported zero and live quota errors are distinct from missing measurements", () => {
  assert.deepEqual(quotaSummary(measured(a, 75, 0), true, false), { minimum: 0, depleted: true });
  assert.deepEqual(quotaSummary(a, true, true), { minimum: null, depleted: true });
  assert.deepEqual(quotaSummary(measured(b, 0), false, false), { minimum: 0, depleted: true });
  const window = { id: "window", label: "Window" };
  assert.equal(remaining({ ...window, usedPct: 110 }), 0);
  assert.equal(remaining({ ...window, remainingPct: 120 }), 100);
});
