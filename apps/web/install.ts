// Installation only: this module never fetches, saves, executes or reloads the desk.
interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function createInstallExperience() {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const panel = get("install-panel"), status = get("install-status");
  const install = get<HTMLButtonElement>("install-confirm");
  const openers = [get<HTMLButtonElement>("install-open"), get<HTMLButtonElement>("pair-install-open")];
  const display = window.matchMedia("(display-mode: standalone)");
  const secure = location.protocol === "https:" && window.isSecureContext !== false;
  let prompt: InstallPrompt | undefined, requesting = false, installed = false, message = "";
  const standalone = () => display.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

  function render() {
    const inApp = standalone();
    for (const opener of openers) opener.hidden = inApp || installed;
    install.hidden = !secure || inApp || installed || !prompt;
    install.disabled = requesting;
    status.textContent = !secure ? "Open the trusted HTTPS address from your Mac before installing Keyln." :
      inApp ? "Keyln is running in its app window." :
      installed ? "Keyln was installed. Open it from your device's apps." : message ||
      (prompt ? "Your browser can install Keyln on this device." : "Use your browser's installation menu below if no Install button is offered.");
  }
  for (const opener of openers) opener.addEventListener("click", () => {
    get<HTMLDetailsElement>("connection-settings").open = false;
    panel.hidden = false; render(); get<HTMLButtonElement>("install-close").focus();
    panel.scrollIntoView({ block: "nearest" });
  });
  get("install-close").addEventListener("click", () => {
    panel.hidden = true;
    const opener = openers.find(button => !button.hidden && button.getClientRects().length > 0);
    opener?.focus();
  });
  window.addEventListener("beforeinstallprompt", event => {
    const candidate = event as InstallPrompt;
    if (!secure || standalone() || installed || typeof candidate.prompt !== "function" || !candidate.userChoice) return;
    event.preventDefault(); prompt = candidate; message = ""; render();
  });
  install.addEventListener("click", async () => {
    if (!prompt || requesting || !secure || standalone() || installed) return;
    const current = prompt;
    requesting = true; render();
    try {
      // Called synchronously in the user's gesture; a prompt object is used once only.
      const prompted = current.prompt();
      prompt = undefined;
      await prompted;
      const choice = await current.userChoice;
      message = choice.outcome === "accepted" ? "Installation requested. Look for Keyln in your device's apps." :
        "Installation cancelled. You can install later from your browser menu.";
    } catch {
      prompt = undefined;
      message = "The browser could not start installation. Use its installation menu instead.";
    } finally { requesting = false; render(); }
  });
  window.addEventListener("appinstalled", () => { installed = true; prompt = undefined; render(); });
  display.addEventListener?.("change", render);
  render();
}
