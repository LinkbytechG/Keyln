interface Press { kind: string; trusted: boolean; at: number; frameMs?: number }
interface Sample { slot: number; input: string; trusted: boolean; timestamp: string; rttMs: number; ok: boolean; error?: string; press?: Press }
const find = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const grid = find("check-grid"), status = find("check-status"), start = find<HTMLButtonElement>("check-start");
const reconnect = find<HTMLButtonElement>("check-reconnect"), download = find<HTMLButtonElement>("check-export");
let connected = false, recording = false, busy = false, instanceId = "", samples: Sample[] = [];
let controller: AbortController | undefined, startedAt = "";
const buttons: HTMLButtonElement[] = [], presses = new Map<number, Press>();
class CheckError extends Error { constructor(readonly code: string, message: string) { super(message); } }
function say(text: string, error = false): void { status.textContent = text; status.classList.toggle("error", error); }
function update(): void {
  for (const button of buttons) button.disabled = !connected || !recording || busy || samples.length >= 30;
  start.disabled = !connected || busy; start.textContent = samples.length ? "Clear and record 30 again" : "Record 30 touches";
  reconnect.hidden = connected; reconnect.disabled = busy || !navigator.onLine;
  download.disabled = !samples.length || busy;
  find("check-count").textContent = `${samples.length} / 30`;
  find("check-touch").textContent = String(samples.filter(sample => sample.trusted && sample.input === "touch").length);
  find("check-failed").textContent = String(samples.filter(sample => !sample.ok).length);
  find("check-rtt").textContent = metric(samples.filter(sample => sample.ok).map(sample => sample.rttMs));
  find("check-frame").textContent = metric(samples.flatMap(sample => sample.press?.frameMs === undefined ? [] : [sample.press.frameMs]));
}
function percentile(values: number[]): number | null {
  return values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]! : null;
}
function metric(values: number[]): string { const p95 = percentile(values); return p95 === null ? "—" : `${p95.toFixed(1)} ms`; }
async function echo(): Promise<void> {
  const sampleId = crypto.randomUUID(); controller = new AbortController();
  const timer = setTimeout(() => controller?.abort(), 8000);
  try {
    const response = await fetch("/api/echo", { method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
      headers: { "Content-Type": "application/json", "X-Keyln-Client": "1" }, body: JSON.stringify({ sampleId }) });
    const value = await response.json();
    if (!response.ok) throw new CheckError(value.error?.code || "HOST_ERROR", response.status === 401 ? "This browser is not paired or was revoked. Pair it in the control desk." : value.error?.message || "Network echo failed.");
    if (value.sampleId !== sampleId || typeof value.instanceId !== "string") throw new CheckError("INVALID_RESPONSE", "Host echo did not match. Restart this check.");
    if (instanceId && instanceId !== value.instanceId) throw new CheckError("HOST_RESTARTED", "Host restarted. Clear the samples and start again to avoid mixing runs.");
    instanceId = value.instanceId;
  } finally { clearTimeout(timer); controller = undefined; }
}
async function connect(): Promise<void> {
  if (busy) return;
  busy = true; recording = false; update();
  try { instanceId = ""; await echo(); connected = true; say(samples.length ? "Connection restored. Download existing samples, or clear and start a new run." : "Connected and authorized. Choose Record, then touch 30 times."); }
  catch (error) { connected = false; say(error instanceof CheckError ? error.message : "Connection failed. Check Wi-Fi and Mac Host, then check the connection again.", true); }
  finally { busy = false; update(); }
}
for (let slot = 0; slot < 12; slot++) {
  const button = document.createElement("button"), index = document.createElement("strong"), label = document.createElement("small");
  button.type = "button"; button.disabled = true; button.dataset.slot = String(slot);
  index.textContent = String(slot + 1).padStart(2, "0"); label.textContent = "Network echo"; button.append(index, label);
  button.onpointerdown = event => {
    if (button.disabled) return;
    const press: Press = { kind: event.pointerType || "unknown", trusted: event.isTrusted, at: performance.now() };
    presses.set(slot, press); button.classList.add("pressed");
    requestAnimationFrame(() => { press.frameMs = performance.now() - press.at; update(); });
  };
  button.onpointercancel = () => { presses.delete(slot); button.classList.remove("pressed"); };
  button.onpointerup = () => { button.classList.remove("pressed"); };
  button.onclick = event => {
    if (busy || !recording || !connected || samples.length >= 30) return;
    const press = presses.get(slot); presses.delete(slot);
    const recent = press && performance.now() - press.at < 2000 ? press : undefined;
    const sample: Sample = { slot, input: recent?.kind ?? (event.isTrusted ? "keyboard" : "synthetic"), trusted: event.isTrusted && !!recent?.trusted,
      timestamp: new Date().toISOString(), rttMs: 0, ok: false, press: recent };
    busy = true; update(); const began = performance.now();
    void echo().then(() => { sample.ok = true; }).catch(error => {
      connected = false; sample.error = error instanceof CheckError ? error.code : "NETWORK_ERROR";
      say(error instanceof CheckError ? error.message : "Disconnected. This failure was recorded. Nothing will be resent; check the connection again.", true);
    }).finally(() => {
      sample.rttMs = performance.now() - began; samples.push(sample); busy = false; button.classList.remove("pressed"); update();
      if (connected) say(samples.length >= 30 ? "30 samples collected. Enter the device environment and download. This does not complete all M1 acceptance." : `Echo ${samples.length} complete. Continue touching.`);
    });
  };
  buttons.push(button); grid.append(button);
}
start.onclick = () => { if (busy || !connected) return; samples = []; presses.clear(); for (const button of buttons) button.classList.remove("pressed"); recording = true; startedAt = new Date().toISOString(); update(); say("Recording. Touch any test key and wait for its echo before the next touch."); };
reconnect.onclick = () => void connect();
addEventListener("offline", () => { connected = false; controller?.abort(); say("Surface is offline; test keys are disabled. Check the connection again after Wi-Fi returns.", true); update(); });
addEventListener("online", () => { say("Network restored. Choose Check connection again. Old requests are not resent."); update(); });
function environment() {
  return { userAgent: navigator.userAgent, edgeVersion: navigator.userAgent.match(/Edg\/(\S+)/)?.[1] ?? null,
    screen: { width: screen.width, height: screen.height, availableWidth: screen.availWidth, availableHeight: screen.availHeight },
    viewport: { width: innerWidth, height: innerHeight }, devicePixelRatio, secureContext: isSecureContext,
    windowsBuild: find<HTMLInputElement>("check-windows").value.trim() || null,
    windowsDisplayScale: find<HTMLInputElement>("check-scale").value.trim() || null,
    controlDeskMemoryMB: find<HTMLInputElement>("check-memory").valueAsNumber || null,
    noCertificateWarningConfirmedByUser: find<HTMLInputElement>("check-certificate").checked };
}
find("check-environment").textContent = `${navigator.userAgent} · Screen ${screen.width}×${screen.height} · DPR ${devicePixelRatio} · Secure context ${isSecureContext ? "yes" : "no"}`;
download.onclick = () => {
  if (busy || !samples.length) return;
  const report = { schemaVersion: 1, kind: "keyln.m1.echo-check", startedAt, exportedAt: new Date().toISOString(), environment: environment(),
    summary: { attempted: samples.length, succeeded: samples.filter(sample => sample.ok).length,
      trustedTouchEvents: samples.filter(sample => sample.trusted && sample.input === "touch").length,
      echoRttP95Ms: percentile(samples.filter(sample => sample.ok).map(sample => sample.rttMs)),
      nextAnimationFrameP95Ms: percentile(samples.flatMap(sample => sample.press?.frameMs === undefined ? [] : [sample.press.frameMs])) },
    limitations: ["Browser-trusted touch events do not prove the physical device model.", "Next animation frame timing is a scheduling estimate, not physical display latency.", "Echo RTT excludes native action duration. Memory is manually entered for the control desk, not this check page."], samples };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" })), link = document.createElement("a");
  link.href = url; link.download = `Keyln-M1-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
void connect();
