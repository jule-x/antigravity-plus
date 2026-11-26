import {
  toneFromUsedPct,
  windowFromReportedDuration,
  windowFromUsedPct,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";

/** Grouped limits with named windows, filled from `agy -p /usage` by `parseAgyUsage`. */
export const quotaSummarySchema = z.object({
  groups: z
    .array(
      z.object({
        displayName: z.string().default(""),
        description: z.string().optional(),
        buckets: z
          .array(
            z.object({
              bucketId: z.string(),
              displayName: z.string().optional(),
              window: z.string().optional(),
              resetTime: z.string().optional(),
              remainingFraction: z.number().optional(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

export type QuotaSummary = z.infer<typeof quotaSummarySchema>;

/** `agy -p /usage --output-format json`, the official CLI reading its own login's quota. */
const agyUsageSchema = z.object({
  status: z.string(),
  error: z.string().optional().catch(undefined),
  command: z
    .object({
      data: z.object({
        groups: z
          .array(
            z.object({
              name: z.string().default(""),
              description: z.string().optional(),
              buckets: z
                .array(
                  z.object({
                    id: z.string(),
                    name: z.string().optional(),
                    window: z.string().optional(),
                    reset_time: z.string().optional(),
                    remaining_fraction: z.number().optional(),
                    disabled: z.boolean().optional(),
                  }),
                )
                .default([]),
            }),
          )
          .default([]),
      }),
    })
    .optional(),
});

/**
 * Reads quota only through agy itself. Google told third-party clients that calling its
 * internal `cloudcode-pa` quota APIs directly can get an account flagged, so this plugin no longer does.
 */
export function parseAgyUsage(stdout: string): QuotaSummary {
  const parsed = agyUsageSchema.parse(JSON.parse(stdout));
  if (parsed.status !== "SUCCESS" || !parsed.command) {
    throw new Error(parsed.error ?? `agy /usage returned ${parsed.status}`);
  }
  return quotaSummarySchema.parse({
    groups: parsed.command.data.groups.map((group) => ({
      displayName: group.name,
      description: group.description,
      buckets: group.buckets
        .filter((bucket) => !bucket.disabled)
        .map((bucket) => ({
          bucketId: bucket.id,
          displayName: bucket.name,
          window: bucket.window,
          resetTime: bucket.reset_time,
          remainingFraction: bucket.remaining_fraction,
        })),
    })),
  });
}

function usedPct(remainingFraction: number | undefined): number | null {
  if (typeof remainingFraction !== "number" || !Number.isFinite(remainingFraction)) return null;
  // One decimal: the API's six-digit fractions print as float noise in the CLI and app.
  return Math.round(Math.min(100, Math.max(0, (1 - remainingFraction) * 100)) * 10) / 10;
}

/** "Claude and GPT models" -> "Claude and GPT"; a shorter scope keeps sidebar labels readable. */
function scopeLabel(displayName: string): string {
  const trimmed = displayName.replace(/\s+models?$/i, "").trim();
  return trimmed || displayName || "Antigravity";
}

/** "3p-weekly" and "3p-5h" share the stable scope "3p". */
function scopeId(bucketIds: string[], displayName: string): string {
  const prefixes = new Set(bucketIds.map((id) => id.replace(/-[^-]+$/, "")));
  if (prefixes.size === 1) return `group-${[...prefixes][0]}`;
  return `group-${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "unknown"}`;
}

/** Durations the API spells as "5h", "30m", "1d". Named periods return null. */
function parseDuration(window: string | undefined): number | null {
  const match = /^(\d+)\s*([smhd])$/i.exec(window ?? "");
  if (!match) return null;
  const size = { s: 1, m: 60, h: 3600, d: 86400 }[match[2].toLowerCase() as "s" | "m" | "h" | "d"];
  return Number(match[1]) * size;
}

export function summaryWindows(summary: QuotaSummary): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const group of summary.groups) {
    const id = scopeId(
      group.buckets.map((bucket) => bucket.bucketId),
      group.displayName,
    );
    const label = scopeLabel(group.displayName);
    for (const bucket of group.buckets) {
      const used = usedPct(bucket.remainingFraction);
      const common = {
        utilizationPct: used,
        resetsAt: bucket.resetTime ?? null,
        summary: true,
        tone: toneFromUsedPct(used),
      };
      const period = bucket.window?.toLowerCase();
      if (period === "weekly" || period === "daily" || period === "monthly") {
        const names = {
          weekly: ["Weekly", "wk"],
          daily: ["Daily", "day"],
          monthly: ["Monthly", "mo"],
        }[period];
        windows.push(
          windowFromUsedPct({
            id: `${id}:${period}`,
            label: `${label} · ${names[0]}`,
            shortLabel: `${label} ${names[1]}`,
            ...common,
          }),
        );
        continue;
      }
      windows.push(
        windowFromReportedDuration({
          durationSeconds: parseDuration(bucket.window),
          scope: { id, label },
          // The bucket's own name is the only provider vocabulary when no length is reported.
          unknown: {
            id: bucket.bucketId,
            label: bucket.displayName ?? "Limit",
            shortLabel: "",
          },
          ...common,
        }),
      );
    }
  }
  return windows;
}
