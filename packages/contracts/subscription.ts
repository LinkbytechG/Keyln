// Subscription quota is runtime data. It never belongs to a layout or its revision.
export const SUBSCRIPTION_PROVIDERS = ["codex", "claude"] as const;
export type SubscriptionProvider = typeof SUBSCRIPTION_PROVIDERS[number];
export const subscriptionKinds = ["codex-usage", "claude-usage"] as const;
export type SubscriptionKind = typeof subscriptionKinds[number];
export const isSubscriptionKind = (kind: string): kind is SubscriptionKind => (subscriptionKinds as readonly string[]).includes(kind);
export const subscriptionProvider = (kind: SubscriptionKind): SubscriptionProvider => kind === "codex-usage" ? "codex" : "claude";
export type SubscriptionStatus = "loading" | "ready" | "not-installed" | "sign-in" | "not-subscribed" | "unavailable" | "stale";
export interface QuotaWindow { id: string; label: string; usedPercent: number; windowMinutes: number | null; resetsAt: number | null }
export interface SubscriptionSnapshot {
  provider: SubscriptionProvider; status: SubscriptionStatus; windows: QuotaWindow[];
  updatedAt: number | null; checkedAt: number | null;
  source: "codex-app-server" | "claude-code-usage" | "claude-statusline" | null;
  reason?: "setup-required" | "no-quota" | "read-failed";
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid subscription data.");
  return value as Record<string, unknown>;
};
const timestamp = (value: unknown): number | null => {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 8.64e15) throw new Error("Invalid quota timestamp.");
  return value;
};
export function parseSubscriptionProviders(value: unknown): SubscriptionProvider[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2 || new Set(value).size !== value.length || value.some(v => !(SUBSCRIPTION_PROVIDERS as readonly unknown[]).includes(v))) throw new Error("Choose Codex or Claude Code.");
  return value as SubscriptionProvider[];
}
export function parseQuotaWindows(value: unknown): QuotaWindow[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error("Invalid quota windows.");
  const ids = new Set<string>();
  return value.map(raw => {
    const w = object(raw);
    if (typeof w.id !== "string" || !/^[a-zA-Z0-9_.:-]{1,80}$/.test(w.id) || ids.has(w.id) || typeof w.label !== "string" || w.label.length < 1 || w.label.length > 60 || /[\x00-\x1f\x7f]/.test(w.label)) throw new Error("Invalid quota window.");
    ids.add(w.id);
    if (typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100) throw new Error("Invalid quota percentage.");
    if (w.windowMinutes !== null && (typeof w.windowMinutes !== "number" || !Number.isSafeInteger(w.windowMinutes) || w.windowMinutes < 1 || w.windowMinutes > 525600)) throw new Error("Invalid quota duration.");
    return { id: w.id, label: w.label, usedPercent: w.usedPercent, windowMinutes: w.windowMinutes as number | null, resetsAt: timestamp(w.resetsAt) };
  });
}
export function parseSubscriptionSnapshot(value: unknown): SubscriptionSnapshot {
  const s = object(value);
  const provider = parseSubscriptionProviders([s.provider])[0]!;
  if (!["loading", "ready", "not-installed", "sign-in", "not-subscribed", "unavailable", "stale"].includes(s.status as string)) throw new Error("Invalid subscription status.");
  if (s.source !== null && s.source !== "codex-app-server" && s.source !== "claude-code-usage" && s.source !== "claude-statusline") throw new Error("Invalid quota source.");
  if (s.reason !== undefined && !["setup-required", "no-quota", "read-failed"].includes(s.reason as string)) throw new Error("Invalid quota reason.");
  const windows = parseQuotaWindows(s.windows), updatedAt = timestamp(s.updatedAt), checkedAt = timestamp(s.checkedAt);
  if (["ready", "stale"].includes(s.status as string) && (!windows.length || updatedAt === null || s.source === null)) throw new Error("Missing measured quota.");
  if (!["ready", "stale"].includes(s.status as string) && windows.length) throw new Error("Unexpected quota data.");
  return { provider, status: s.status as SubscriptionStatus, windows, updatedAt, checkedAt, source: s.source,
    ...(s.reason === undefined ? {} : { reason: s.reason as SubscriptionSnapshot["reason"] }) };
}
export function parseSubscriptionReply(value: unknown): SubscriptionSnapshot[] {
  const rows = object(value).subscriptions;
  if (!Array.isArray(rows) || rows.length > 2) throw new Error("Invalid subscription reply.");
  const result = rows.map(parseSubscriptionSnapshot);
  if (new Set(result.map(s => s.provider)).size !== result.length) throw new Error("Duplicate subscription provider.");
  return result;
}
