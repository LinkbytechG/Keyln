# Keyln

**Turn a tablet or phone into a touch console for your Mac.**

Keyln runs a small server on your Mac. Open it in the browser of a tablet, phone or any device on the same local network, pair the device once, and every key you place on its screen runs a saved Mac action: open an app, bring a specific window forward, send a keyboard shortcut, run a macOS Shortcut, run a Shell script you approved on the Mac, or a sequence of steps.

Nothing leaves your network. There is no cloud service, account or database: the Mac keeps everything in a private folder, and devices talk to it over HTTPS on your LAN.

## Features

- **Keys and components**: keys, App groups, Action groups, a Pages component with swipeable pages, a clock, text, the latest result and recent activity. Place and size them freely on a canvas.
- **Actions**: open an app, activate a named window, keyboard shortcuts (ABC / U.S. layout), macOS Shortcuts, approved Shell scripts with bounded run time and output, and sequential workflows.
- **Clear results**: each run shows whether the Mac received it, finished it, failed, or the result is unknown. Unknown results are never retried automatically.
- **Look**: built-in themes, custom themes, key colours, real Mac app icons, a built-in icon set, your own PNG/WebP images, and an optional Iconify icon search through the Mac.
- **Layouts**: export and import layout files; the Mac keeps a backup of the last valid layout and can restore it.
- **Mac Dock strip**: an optional bar of the apps currently running on the Mac.
- **Installable web app**: install it as a PWA on the device. It is online-first; there is no offline mode.
- **Runs at login**: a per-user background service, plus a menu bar app for status, start/stop, management login and a QR code of the address.

## Install as an app

If you have a self-contained `Keyln.app` (built with `npm run app:build`, or downloaded), you do not need npm or a terminal:

1. Drag `Keyln.app` into `/Applications` or `~/Applications`. Keep the name `Keyln.app`, and do not run it from a disk image.
2. Double-click it. A first copy downloaded from the internet may be blocked once: open System Settings → Privacy & Security and choose **Open Anyway**.
3. Follow the setup window. Choose your Mac's address, and Keyln creates its own certificates, installs its background service from this app (starts at login) and starts it.
4. The last step lists what is left: **Export Device Certificate…** (a public `keyln-root.cer` plus its SHA-256 fingerprint to compare on the device), pairing (**Mac Management**, **Show QR Code…**) and Accessibility (open the settings page, then drag `node` into the list and turn it on; the window can show the file in Finder).

The same actions stay in the menu bar: **Setup Guide…**, **Export Device Certificate…** and **Change Address…** (devices keep trusting the certificate but must open the new address and pair again). If you later move `Keyln.app`, the menu offers **Repair Service Location…** to point the background service at the new place. The app only ever installs the copy it is running from.

### Moving to another Mac

1. On the old Mac, export your layout from the management page.
2. On the new Mac, install the app as above, finish setup and pair your devices again.
3. Import the layout. Apps are matched by bundle ID, and the import preview lists anything that is missing. Scripts must be approved again.

Pairings, certificate keys and script approvals are never exported.

## Requirements (developer install)

- A Mac with macOS 13 or later, signed in as a normal user (no `sudo`).
- Node.js 24 LTS (see `.node-version`) or 26, installed with Homebrew or another installer.
- Apple's Swift compiler: install the Xcode Command Line Tools (`xcode-select --install`). Check with `xcrun swiftc --version`.
- OpenSSL (`openssl version`).
- A control device with a modern browser (Edge, Chrome or Safari) on the **same private network** as the Mac.

## Developer install

### 1. Build

```sh
git clone <this repository> Keyln
cd Keyln
npm ci --ignore-scripts
npm run build
npm test
```

`npm test` uses fake adapters and temporary folders. It never opens apps, sends real keystrokes or runs your scripts.

### 2. Choose the address and create certificates

Keyln keeps its private data outside the repository. The default folder is `~/Library/Application Support/Keyln`. Find your Mac's private IPv4 address (System Settings → Network) and run:

```sh
npm run setup -- --address 192.168.1.20
```

Replace `192.168.1.20` with your Mac's address. Only loopback or a private address assigned to this Mac is accepted. Setup creates a **Keyln-only certificate authority (CA)** and a server certificate for that address. It does not change system trust or the firewall. A DHCP reservation for the Mac keeps the address stable; if it changes, run setup again and re-pair your devices.

Keep the port off public networks and never forward it through your router.

### 3. Trust the certificate on your devices

Export the **public** CA certificate and note its fingerprint:

```sh
openssl x509 -in "$HOME/Library/Application Support/Keyln/tls/rootCA.pem" -outform DER -out keyln-root.cer
openssl x509 -in "$HOME/Library/Application Support/Keyln/tls/rootCA.pem" -noout -fingerprint -sha256
```

Copy `keyln-root.cer` to the device and install it as a trusted root after comparing the fingerprint:

- **Windows**: in PowerShell, `Import-Certificate -FilePath .\keyln-root.cer -CertStoreLocation Cert:\CurrentUser\Root`, then restart the browser.
- **iOS / iPadOS**: open the file to install the profile, then turn it on under Settings → General → About → Certificate Trust Settings.
- **Android**: Settings → Security → Encryption & credentials → Install a certificate → CA certificate.
- **Mac browser preview**: import it into the login keychain with Keychain Access and set it to Always Trust for SSL.

Only ever copy `keyln-root.cer`. Never copy `rootCA.key`, `server.key`, `devices.json` or the whole data folder.

### 4. Install the background service and menu bar app

```sh
npm run service:install
npm run app:install
```

`service:install` copies the built runtime into the data folder and registers a per-user LaunchAgent (`local.keyln.host`) that starts at login. `app:install` puts a menu bar app in `~/Applications/Keyln.app`.

**Self-contained app (no Homebrew Node needed at run time):** `Keyln.app` can carry its own official Node, the Host runtime and the native helper, so macOS permissions stay attached to one stable, signed Node binary.

```sh
npm run node:fetch     # download the pinned official Node (SHA-256 checked) into .cache/node; add -- --from <tarball> to use a local copy
npm run app:build      # assemble dist/Keyln.app with Node, helper and runtime inside, then verify the signatures
npm run app:install    # build, install to ~/Applications and point the login service at the app
```

`app:install` replaces the previous app (kept as a hidden backup) and rewrites the LaunchAgent to run the Node inside the app; the old runtime in the data folder is left in place. To go back to the Homebrew-style service, run `npm run service:install -- --node /opt/homebrew/bin/node`. Node security updates now arrive by bumping the pinned version and rebuilding.

If you prefer to run Keyln by hand instead, use `npm start` (or double-click `Start-Keyln.command`) and keep that terminal open.

### 5. Grant keyboard permission

Opening apps needs no extra permission. Keyboard shortcuts and window control need **Accessibility**:

1. Run `npm run service:doctor`. It shows whether `accessibilityTrusted` and `eventPostingAllowed` are true for the background service.
2. If not, open System Settings → Privacy & Security → Accessibility and add the **Node binary the service uses** (shown as `node` by `npm run service:status`), then turn it on:
   - **Self-contained app** (`layout: "app"`): add `~/Applications/Keyln.app/Contents/Helpers/node`. The file picker may add the whole app instead, so the reliable way is Finder → right-click `Keyln.app` → **Show Package Contents** → `Contents/Helpers`, and drag `node` into the list.
   - **Homebrew-style service** (`layout: "legacy"`): click **+**, press ⌘⇧G and add the Node under `/opt/homebrew/Cellar/node/<version>/bin/node` and `~/Library/Application Support/Keyln/runtime/dist/keyln-helper`. Turn both on.
3. Run `npm run service:doctor` again (if it is still false, run `npm run service:restart` first).

The bundled Node is signed by the Node.js Foundation, and macOS keeps the permission across app rebuilds and pinned Node updates. Homebrew's Node is not, so **after a Homebrew Node upgrade** remove the old entry and add the new path again.

### 6. Pair a device

1. On the Mac, choose **Mac Management** in the Keyln menu bar app (or run `npm run service:admin`). It gives a short-lived login code and opens `https://<address>:8940/admin`.
2. In the management page, choose **Generate pairing code**.
3. On the device, open `https://<address>:8940` (the menu bar app's **Show QR Code…** helps with phones), enter the pairing code and a device name.
4. Back on the Mac, compare the request ID, tick the box and choose **Approve this device**.

Knowing the pairing code alone does not grant access; approval happens on the Mac. Device sessions last 30 days.

## Using it

- **Edit** to add keys and components, set their action, label, icon and colour, and arrange pages. **Save** stores the layout on the Mac.
- **Use** to tap keys. A key shows its result for a moment; recent activity keeps the last few outcomes.
- **Install** the page as an app from the browser menu if you want it full-screen on the device.
- Keyboard actions go to whatever app is in front on the Mac. Use a workflow with **Open app** first if you need a specific target.

### Shell scripts

Scripts are registered and approved **on the Mac** in the management page. The device only ever sends a script ID and allowed parameter values. Scripts run as your user, without a sandbox, with a minimal `PATH` and a time limit of up to 60 seconds. Any change to a script requires approving it again. Only approve scripts you trust.

## Commands

| Command | What it does |
|---|---|
| `npm run service:status` | Service state, Node path, address and log folder |
| `npm run service:doctor` | Checks permissions in the real background context |
| `npm run service:start` / `stop` / `restart` | Control the background service (`stop` also disables start at login) |
| `npm run service:admin` | Print a short-lived Mac management login code |
| `npm run service:install` | Build and install or update the background service |
| `npm run service:uninstall` | Remove the service; keeps your data, certificates and pairings |
| `npm run node:fetch` | Download and verify the pinned official Node into `.cache/node` |
| `npm run app:build` | Assemble the self-contained `dist/Keyln.app` (run after `npm run build`) |
| `npm run app:install` | Build and install the self-contained app and switch the login service to it |
| `npm run restore` | Offline restore of the last valid layout (stop the Host first; revokes all devices) |

The `.command` files in the repository do the same from Finder: Start, Stop, Restart, Manage (login code) and Install-Keyln-Login.

## Security model

- The Mac listens only on the address you chose, over HTTPS/WSS with its own CA. Certificate warnings must never be bypassed.
- Devices are approved on the Mac, use `Secure`, `HttpOnly`, `SameSite=Strict` cookies, and the Mac stores only token hashes.
- A device can only trigger actions already saved on the Mac, by ID. There is no endpoint that accepts an arbitrary command.
- The management page (`/admin`) only accepts connections from the Mac itself and needs its own short-lived login code.
- One action runs at a time; busy requests are rejected, not queued.

If you find a security problem, please report it privately rather than in a public issue.

## Limitations

- macOS only on the Mac side. Keyboard actions support the ABC / U.S. key layout and are refused during secure input or on a locked screen.
- Helpers are ad-hoc signed, so macOS permissions may need to be granted again after rebuilding or after Node upgrades.
- The Codex and Claude Code quota components read local CLI status through experimental interfaces and may stop working after CLI updates.
- Window matching uses exact window titles; titles that change (such as web pages) may not match.

## Data and removal

All runtime data lives in `~/Library/Application Support/Keyln` (override with `KEYLN_DATA_DIR`, using the same value for every command): layout, backups, paired devices, approved scripts, certificates and logs. To remove Keyln, run `npm run service:uninstall`, delete `~/Applications/Keyln.app`, delete the data folder if you no longer need it, and remove the Keyln CA from each device's trusted roots.

## Development

```text
apps/web/              Browser client (TypeScript, no framework)
apps/host/             HTTPS/WSS server, pairing, persistence, actions, service
packages/contracts/    Shared types and runtime validation
native/macos-helper/   Swift helper: apps, windows, keyboard, icons
native/macos-menubar/  Swift menu bar app
scripts/               Build, setup, service and install scripts
tests/                 Automated tests and a fake-adapter browser fixture
```

- `npm run check` type-checks; `npm test` builds and runs the automated suite.
- `node tests/browser-fixture.mjs --grid-demo` starts a disposable UI preview on `127.0.0.1` with a fake adapter and sample pages; it never touches your real data.
- `npm run smoke:mac` is an explicit native check that opens Calculator once using a temporary data folder.

## License

MIT. See [LICENSE](LICENSE).
