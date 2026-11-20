import { sizingFor, designSizeU } from "../../../packages/contracts/sizing.js";
import type { SizeTier } from "../../../packages/contracts/sizing.js";
import type { DeskState } from "./state.js";

// T44: the widget registry. A widget type is declared once (its forms, whether it can be pressed, its size limits) and creates instances
// from a context. Shared sizing definitions own canvas presets and theme-slot policies. These per-renderer bounds describe content usability, not the smallest 1u measurement.
// Renderer content bounds in integer u; they do not grant custom resize permission.
export interface WidgetSize { readonly w: number; readonly h: number }
// What a widget may ask the app to do. Widgets call these and nothing else in app.ts.
export interface DeskIntents {
  refresh(): void; reconnect(): void; setMode(mode: "use" | "edit"): void;
}
export interface WidgetInstance {
  readonly element: HTMLElement;
  update(state: DeskState): void;
  destroy(): void;
  // T50: only the text widget takes this: the words the placement says (never markup).
  words?(value: string): void;
  preset?(value: SizeTier): void;
}
export interface WidgetContext {
  readonly form: string;
  readonly intents: DeskIntents;
  // T50: an instance placed on the canvas by itself (not nested inside another widget). It carries no element ids, so the ids that other
  readonly standalone: boolean;
  readonly preview?: boolean;
  create(type: string, form: string): WidgetInstance;
}
// T50: what one form says differently from its type (a dot only shows, a dot button is pressed; sizes differ per form).
export interface FormLimits { readonly interactive?: boolean; readonly minSize?: WidgetSize; readonly maxSize?: WidgetSize }
export interface WidgetType<I extends WidgetInstance = WidgetInstance> {
  readonly type: string;
  readonly forms: readonly string[];
  readonly interactive: boolean;
  readonly minSize: WidgetSize;
  readonly maxSize: WidgetSize;
  // T50: per-form overrides of interactive, minSize and maxSize; a form not named here has the type's values.
  readonly formLimits?: Readonly<Record<string, FormLimits>>;
  create(context: WidgetContext): I;
}
export function createRegistry(intents: DeskIntents) {
  const types = new Map<string, WidgetType>();
  function create(type: string, form: string, standalone = false): WidgetInstance {
    const found = types.get(type);
    if (!found) throw new Error(`Unknown widget type "${type}".`);
    if (!found.forms.includes(form)) throw new Error(`Widget type "${type}" has no form "${form}".`);
    return found.create({ form, intents, standalone, create: (nestedType, nestedForm) => create(nestedType, nestedForm) });
  }
  // The limits of one form: the type's, with the form's own overrides. A type or form that is not registered has none.
  function limits(type: string, form?: string) {
    const found = types.get(type);
    if (!found) return undefined;
    const own = form ? found.formLimits?.[form] : undefined;
    return { min: own?.minSize ?? found.minSize, max: own?.maxSize ?? found.maxSize, interactive: own?.interactive ?? found.interactive };
  }
  return {
    register(definition: WidgetType) {
      if (!definition.type || !definition.forms.length) throw new Error("A widget type needs a name and at least one form.");
      if (types.has(definition.type)) throw new Error(`Widget type "${definition.type}" is already registered.`);
      if (new Set(definition.forms).size !== definition.forms.length) throw new Error(`Widget type "${definition.type}" repeats a form.`);
      designSizeU(definition.minSize); designSizeU(definition.maxSize);
      for (const form of definition.forms) {
        sizingFor(definition.type, form);
        const bounds = definition.formLimits?.[form];
        if (bounds?.minSize) designSizeU(bounds.minSize);
        if (bounds?.maxSize) designSizeU(bounds.maxSize);
      }
      types.set(definition.type, definition);
    },
    has: (type: string) => types.has(type),
    get: (type: string) => types.get(type),
    types: (): readonly WidgetType[] => [...types.values()],
    create, limits, sizing: sizingFor,
  };
}
export type Registry = ReturnType<typeof createRegistry>;
