interface RefreshState {
  dirty: boolean;
  blocked: boolean;
  pending: boolean;
  online: boolean;
}
interface Options {
  state: () => RefreshState;
  discardDraft: () => void;
  reload?: () => void;
  // Called when the button's state changes outside render() (a reload has begun).
  changed?: () => void;
}

// Navigation only: keep pending request IDs for the existing read-only result recovery.
// The Refresh button is a widget (T44): it calls request() and draws disabled from this module's state.
export function createPageRefresh(options: Options) {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = get<HTMLDialogElement>("refresh-dialog");
  const confirm = get<HTMLButtonElement>("refresh-confirm");
  const cancel = get<HTMLButtonElement>("refresh-cancel");
  let reloading = false;

  function render() {
    const state = options.state();
    confirm.disabled = state.blocked || reloading;
    get("refresh-draft-warning").hidden = !state.dirty;
    get("refresh-action-warning").hidden = !state.pending;
    get("refresh-offline-warning").hidden = state.online;
    dialog.setAttribute("aria-describedby", ["refresh-description", ...(state.dirty ? ["refresh-draft-warning"] : []),
      ...(state.pending ? ["refresh-action-warning"] : []), ...(!state.online ? ["refresh-offline-warning"] : [])].join(" "));
    confirm.textContent = state.dirty ? "Discard draft & refresh" : "Refresh now";
    cancel.textContent = state.dirty ? "Keep editing" : "Cancel";
  }
  function reload() {
    if (options.state().blocked || reloading) return;
    reloading = true;
    dialog.close();
    // The explicit discard also avoids a second browser beforeunload prompt.
    if (options.state().dirty) options.discardDraft();
    render(); options.changed?.();
    (options.reload ?? (() => location.reload()))();
  }
  function request() {
    if (options.state().blocked || reloading) return;
    render();
    const state = options.state();
    if (!state.dirty && !state.pending && state.online) { reload(); return; }
    if (!dialog.open) dialog.showModal();
    cancel.focus();
  }
  cancel.addEventListener("click", () => dialog.close());
  confirm.addEventListener("click", reload);
  render();
  return { render, request, get disabled() { return options.state().blocked || reloading; } };
}
