import { parseSubscriptionReply, type SubscriptionProvider, type SubscriptionSnapshot } from "../../packages/contracts/subscription.js";

// Separate from action/configuration transport: a failed quota lookup never disconnects the touch console or saves a draft.
export function createSubscriptionClient(changed: (rows: Partial<Record<SubscriptionProvider, SubscriptionSnapshot>>) => void, transport: typeof fetch = fetch) {
  let providers: SubscriptionProvider[] = [], online = false, key = "", epoch = 0, stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
  let rows: Partial<Record<SubscriptionProvider, SubscriptionSnapshot>> = {};
  function cancel() { epoch++; clearTimeout(timer); timer = undefined; controller?.abort(); controller = undefined; }
  async function poll() {
    if (stopped || !online || !providers.length || document.hidden || controller) return;
    const ticket = epoch, wanted = [...providers], abort = new AbortController(); controller = abort;
    const timeout = setTimeout(() => abort.abort(), 5000);
    try {
      const response = await transport("/api/subscriptions", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", "X-Keyln-Client": "1" }, body: JSON.stringify({ providers: wanted }), signal: abort.signal });
      if (stopped || ticket !== epoch || abort.signal.aborted || !online) return;
      if (response.status === 401) { rows = {}; online = false; changed(rows); return; }
      if (!response.ok) throw new Error("Quota unavailable.");
      const parsed = parseSubscriptionReply(await response.json());
      if (stopped || ticket !== epoch || abort.signal.aborted || !online) return;
      if (parsed.length !== wanted.length || parsed.some(row => !wanted.includes(row.provider))) throw new Error("Unexpected quota reply.");
      rows = Object.fromEntries(parsed.map(row => [row.provider, row])); changed(rows);
    } catch {
      if (!stopped && ticket === epoch && online) {
        const next: typeof rows = {};
        for (const provider of wanted) {
          const previous = rows[provider];
          next[provider] = previous?.windows.length ? { ...previous, status: "stale" } : { provider, status: "unavailable", source: null, windows: [], updatedAt: null, checkedAt: null, reason: "read-failed" };
        }
        rows = next; changed(rows);
      }
    } finally {
      clearTimeout(timeout);
      if (controller === abort) controller = undefined;
      if (!stopped && ticket === epoch && online && !document.hidden) timer = setTimeout(() => { timer = undefined; void poll(); }, 10000);
    }
  }
  const visible = () => { cancel(); if (!document.hidden) void poll(); };
  document.addEventListener("visibilitychange", visible);
  return {
    sync(next: SubscriptionProvider[], connected: boolean) {
      const distinct = [...new Set(next)].sort(), signature = `${connected}/${distinct.join(",")}`;
      if (signature === key) return;
      key = signature; cancel(); online = connected; providers = distinct;
      // Removed widgets release their data. Authentication loss removes all values; ordinary offline rendering keeps them marked disconnected.
      rows = Object.fromEntries(Object.entries(rows).filter(([provider]) => providers.includes(provider as SubscriptionProvider)));
      changed(rows);
      if (online) void poll();
    },
    stop() { stopped = true; cancel(); document.removeEventListener("visibilitychange", visible); },
  };
}
