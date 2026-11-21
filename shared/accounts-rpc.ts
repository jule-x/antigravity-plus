import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const window = z.object({
  id: z.string(), label: z.string(),
  usedPct: z.number().nullish(), remainingPct: z.number().nullish(), resetsAt: z.string().nullish(),
});
const report = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), windows: z.array(window), planLabel: z.string().optional() }),
  z.object({ status: z.literal("error"), error: z.string() }),
  z.object({ status: z.literal("unavailable"), problem: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("no_quota"), detail: z.string() }),
    z.object({ kind: z.literal("expired"), expiresAt: z.string() }),
    z.object({ kind: z.literal("rejected"), status: z.number() }),
  ]) }),
]);
const account = z.object({
  id: z.string(), email: z.string(), nickname: z.string().nullish(), addedAt: z.string(),
  snapshot: z.object({ readAt: z.string(), report }).nullish(),
});
const notice = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("active"), email: z.string() }),
  z.object({ kind: z.literal("signed-out") }),
]);
const state = z.object({
  accounts: z.array(account), activeAccountId: z.string().nullable(),
  notice: notice.nullable(), quotaError: z.boolean(), busy: z.boolean(),
});
export type AccountView = z.output<typeof account>;
export type AccountsView = z.output<typeof state>;
export type WindowView = z.output<typeof window>;
export type AccountNotice = z.output<typeof notice>;

const empty = z.object({});
const target = z.object({ id: z.string().min(1) });
const ok = z.object({ ok: z.literal(true) });
const loginStatus = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("starting") }),
  z.object({ phase: z.literal("input"), url: z.string() }),
  z.object({ phase: z.literal("submitted") }),
  z.object({ phase: z.literal("finishing") }),
  z.object({ phase: z.literal("done") }),
  z.object({ phase: z.literal("failed"), message: z.string() }),
]);
export type LoginStatus = z.output<typeof loginStatus>;
export const accountsRpc = {
  list: defineRpc({ name: "list", input: empty, output: state }),
  status: defineRpc({ name: "status", input: empty, output: state }),
  switch: defineRpc({ name: "switch", input: target, output: ok }),
  add: defineRpc({ name: "add", input: z.object({ makeActive: z.boolean() }), output: target }),
  loginStatus: defineRpc({ name: "login-status", input: target, output: loginStatus }),
  loginSubmit: defineRpc({ name: "login-submit", input: target.extend({ value: z.string() }), output: ok }),
  loginCancel: defineRpc({ name: "login-cancel", input: target, output: ok }),
  remove: defineRpc({ name: "remove", input: target, output: ok }),
  rename: defineRpc({ name: "rename", input: target.extend({ nickname: z.string().trim().max(100) }), output: ok }),
};
