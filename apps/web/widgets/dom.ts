// Small helpers for the widgets: build elements from code, and remember listeners so destroy() can remove them.
interface Props {
  id?: string; className?: string; text?: string; hidden?: boolean; disabled?: boolean;
  // In the order the attributes had in index.html before T44 (the tests read the assembled markup). "type" and "title" are set as
  // properties, "data-*" through dataset (as the rest of the client does), anything else as an attribute.
  attrs?: Record<string, string>;
}
export function make<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Node[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.id !== undefined) node.id = props.id;
  if (props.className !== undefined) node.className = props.className;
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (name === "type") (node as unknown as { type: string }).type = value;
    else if (name === "title") node.title = value;
    else if (name.startsWith("data-")) node.dataset[name.slice(5).replace(/-./g, part => part[1]!.toUpperCase())] = value;
    else node.setAttribute(name, value);
  }
  if (props.hidden) node.hidden = true;
  if (props.disabled) (node as unknown as HTMLButtonElement).disabled = true;
  if (props.text !== undefined) node.textContent = props.text;
  if (children.length) node.append(...children);
  return node;
}
export const words = (value: string): Node => document.createTextNode(value);
export function listeners() {
  const undo: Array<() => void> = [];
  return {
    on<E extends Event>(target: EventTarget, type: string, handler: (event: E) => void) {
      target.addEventListener(type, handler as EventListener); undo.push(() => target.removeEventListener(type, handler as EventListener));
    },
    // Removes every listener added so far.
    clear() { for (const fn of undo.splice(0)) fn(); },
  };
}
