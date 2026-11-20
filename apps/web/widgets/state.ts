import type { Execution, ThemeName } from "../../../packages/contracts/index.js";
import type { SubscriptionProvider, SubscriptionSnapshot } from "../../../packages/contracts/subscription.js";

// T44: the read-only snapshot of the desk that every widget draws from. app.ts builds it in render() and hands it to the runtime;
// a widget never reads app.ts variables or the page, and acts only through the intents of the WidgetContext (registry.ts).
export type ConnectionPhase = "loading" | "offline" | "connecting" | "online" | "idle";
export interface ConnectionState {
  // One of: Mac connected, Connecting…, Disconnected, Pairing required, Mac layout needs recovery, Browser update needed.
  readonly text: string; readonly phase: ConnectionPhase; readonly online: boolean;
  // True while a sync runs (or the browser is too old), so Reconnect cannot be pressed twice.
  readonly reconnectDisabled: boolean;
}
export interface ModeState { readonly editing: boolean; readonly useDisabled: boolean; readonly editDisabled: boolean }
export interface RefreshState { readonly disabled: boolean; readonly blocked: boolean }
export interface ResultState {
  readonly status: string; readonly title: string; readonly line: string; readonly detail: string;
  // A result that needs the person (the Mac could not say whether the action ran).
  readonly unknown: boolean;
  readonly output?: Execution["output"]; readonly workflow?: Execution["workflow"];
}
export interface DeskState {
  readonly paired: boolean; readonly editing: boolean; readonly theme: ThemeName;
  readonly connection: ConnectionState;
  // mode is absent until the Mac configuration is known; the widgets then keep what they were created with.
  readonly mode?: ModeState;
  readonly refresh: RefreshState;
  readonly settings: { readonly themeNote: string };
  readonly subscriptions?: Readonly<Partial<Record<SubscriptionProvider, SubscriptionSnapshot>>>;
}
export const READY_LINE = "Choose a configured button to send one action.";
// What the widgets are created showing, before the first render: the same as the markup the page had before T44.
export function initialDeskState(theme: ThemeName): DeskState {
  return {
    paired: false, editing: false, theme,
    connection: { text: "Loading…", phase: "loading", online: false, reconnectDisabled: false },
    refresh: { disabled: false, blocked: false },
    settings: { themeNote: "" },
  };
}
