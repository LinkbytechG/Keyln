import AppKit
import ServiceManagement
import UniformTypeIdentifiers

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let client = ServiceClient()
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private let statusLine = NSMenuItem(title: "Keyln", action: nil, keyEquivalent: "")
    private let originLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let permissionLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let openItem = NSMenuItem(title: "Open Keyln", action: #selector(openKeyln), keyEquivalent: "")
    private let qrItem = NSMenuItem(title: "Show QR Code…", action: #selector(showQRCode), keyEquivalent: "")
    private let adminItem = NSMenuItem(title: "Mac Management", action: #selector(macManagement), keyEquivalent: "")
    private let guideItem = NSMenuItem(title: "Setup Guide…", action: #selector(showSetupGuide), keyEquivalent: "")
    private let exportItem = NSMenuItem(title: "Export Device Certificate…", action: #selector(exportCertificateFromMenu), keyEquivalent: "")
    private let changeItem = NSMenuItem(title: "Change Address…", action: #selector(changeAddress), keyEquivalent: "")
    private let repairItem = NSMenuItem(title: "Repair Service Location…", action: #selector(repairLocation), keyEquivalent: "")
    private let startItem = NSMenuItem(title: "Start", action: #selector(startService), keyEquivalent: "")
    private let restartItem = NSMenuItem(title: "Restart", action: #selector(restartService), keyEquivalent: "")
    private let stopItem = NSMenuItem(title: "Stop", action: #selector(stopService), keyEquivalent: "")
    private let logsItem = NSMenuItem(title: "Show Logs", action: #selector(showLogs), keyEquivalent: "")
    private let loginItem = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin), keyEquivalent: "")
    private let quitItem = NSMenuItem(title: "Quit Keyln Menu", action: #selector(quit), keyEquivalent: "")

    private let queue = DispatchQueue(label: "local.keyln.menubar.status")
    private var current = ServiceStatus()
    private var lastPermissions: (accessibility: Bool?, events: Bool?, failed: Bool)?
    private var busy = false
    private var generation = 0
    private var timer: Timer?
    private let qrWindow = QRCodeWindowController()
    private var codeNote: String?
    private var clearWork: DispatchWorkItem?
    private let setupWindow = SetupWindowController()
    private let changeWindow = ChangeAddressWindowController()
    private var setupInfo: SetupInfo?
    private var repairNeeded = false
    private var offeredRepair = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        menu.autoenablesItems = false
        menu.delegate = self
        for entry in [statusLine, originLine, permissionLine] { entry.isEnabled = false }
        for entry in [openItem, qrItem, adminItem, guideItem, exportItem, changeItem, repairItem, startItem, restartItem, stopItem, logsItem, loginItem, quitItem] { entry.target = self }
        for entry in [
            statusLine, originLine, permissionLine, openItem, qrItem, adminItem, NSMenuItem.separator(),
            startItem, restartItem, stopItem, NSMenuItem.separator(),
            guideItem, exportItem, changeItem, repairItem, NSMenuItem.separator(),
            logsItem, loginItem, NSMenuItem.separator(), quitItem,
        ] { menu.addItem(entry) }
        item.menu = menu
        registerLoginOnFirstLaunch()
        render()
        refresh(doctor: true)
        checkFirstRun()
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in self?.refresh(doctor: false) }
    }

    // MARK: status

    func menuWillOpen(_ menu: NSMenu) {
        updateLoginItem()
        refresh(doctor: true)
    }

    private func refresh(doctor: Bool) {
        generation += 1
        let mine = generation
        queue.async { [weak self] in
            guard let self = self else { return }
            let result = self.client.status(doctor: doctor)
            DispatchQueue.main.async {
                guard mine == self.generation else { return }
                self.apply(result, doctor: doctor)
            }
        }
    }

    private func apply(_ status: ServiceStatus, doctor: Bool) {
        var next = status
        if !next.running || next.failure != nil {
            lastPermissions = nil
        } else if doctor {
            lastPermissions = (next.accessibilityTrusted, next.eventPostingAllowed, next.doctorFailed)
        } else if let known = lastPermissions {
            next.permissionsKnown = !known.failed
            next.doctorFailed = known.failed
            next.accessibilityTrusted = known.accessibility
            next.eventPostingAllowed = known.events
        }
        current = next
        render()
    }

    private func permissionsMissing(_ status: ServiceStatus) -> Bool {
        status.doctorFailed || (status.permissionsKnown && (status.accessibilityTrusted != true || status.eventPostingAllowed != true))
    }

    private func render() {
        let status = current
        let symbol: String, words: String
        if status.failure != nil {
            symbol = "exclamationmark.triangle"; words = "status unavailable"
        } else if !status.installed {
            symbol = "pause.circle"; words = "not installed"
        } else if !status.running {
            symbol = "pause.circle"; words = "stopped"
        } else if permissionsMissing(status) {
            symbol = "exclamationmark.triangle"; words = "running, permission missing or unknown"
        } else {
            symbol = "keyboard.fill"; words = "running"
        }
        if let button = item.button {
            let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Keyln " + words)
            image?.isTemplate = true
            button.image = image
            if image == nil { button.title = "K" } else { button.title = "" }
            button.setAccessibilityLabel("Keyln: " + words)
            button.toolTip = "Keyln: " + words
        }

        originLine.isHidden = false
        permissionLine.isHidden = true
        if let failure = status.failure {
            statusLine.title = "Keyln status unavailable"
            originLine.title = failure.count > 80 ? String(failure.prefix(80)) + "…" : failure
        } else if !status.installed {
            statusLine.title = "Keyln is not installed"
            originLine.title = client.hasBundledRuntime ? "Choose Setup Guide… to set it up" : "Run npm run service:install"
        } else if !status.running {
            statusLine.title = "Keyln is stopped"
            originLine.title = status.origin ?? "No address yet"
        } else {
            statusLine.title = "Keyln is running"
            originLine.title = status.origin ?? "No address yet"
            if status.permissionsKnown {
                permissionLine.isHidden = false
                if permissionsMissing(status) {
                    permissionLine.title = "Permission missing — run npm run service:doctor"
                } else {
                    permissionLine.title = "Accessibility: allowed · Key events: allowed"
                }
            } else if status.doctorFailed {
                permissionLine.isHidden = false
                permissionLine.title = "Permissions unknown — run npm run service:doctor"
            }
        }

        let ready = status.installed && status.failure == nil
        openItem.isEnabled = status.running && status.origin != nil
        qrItem.isEnabled = status.running && status.origin != nil
        qrWindow.update(origin: status.origin)
        adminItem.isEnabled = status.running && status.origin != nil && !busy
        adminItem.title = codeNote ?? "Mac Management"
        startItem.isEnabled = ready && !status.running && !busy
        restartItem.isEnabled = ready && status.running && !busy
        stopItem.isEnabled = ready && status.running && !busy
        logsItem.isEnabled = true
        guideItem.isEnabled = client.canRunSetupCommands && !busy
        exportItem.isEnabled = client.canRunSetupCommands && !busy
        changeItem.isEnabled = client.canRunSetupCommands && status.installed && !busy
        repairItem.isHidden = !repairNeeded
        repairItem.isEnabled = !busy
        setupWindow.permissionChanged()
        updateLoginItem()
    }

    // MARK: first run (T124, ADR-108)

    private func setupActions() -> SetupActions {
        SetupActions(client: client,
                     macManagement: { [weak self] in self?.macManagement() },
                     showQRCode: { [weak self] in self?.showQRCode() },
                     exportCertificate: { [weak self] done in self?.exportCertificate(done) },
                     accessibilityText: { [weak self] in self?.accessibilityText() ?? "" },
                     refreshPermissions: { [weak self] in self?.refresh(doctor: true) },
                     changed: { [weak self] in self?.refresh(doctor: true); self?.updateRepairState() })
    }

    private func accessibilityText() -> String {
        if !current.running { return "Accessibility: the service is not running yet." }
        if current.permissionsKnown { return current.accessibilityTrusted == true ? "Accessibility: allowed" : "Accessibility: not allowed yet" }
        return "Accessibility: unknown"
    }

    /// Only the bundled runtime decides the state; a development build without one keeps the old behavior.
    private func checkFirstRun() {
        guard client.hasBundledRuntime else { return }
        queue.async { [weak self] in
            guard let self = self else { return }
            let answer = self.client.setupInfo()
            DispatchQueue.main.async {
                guard let info = answer.info else { return }
                self.setupInfo = info
                self.decideFirstRun(info)
            }
        }
    }

    private func decideFirstRun(_ info: SetupInfo) {
        switch info.selfAppProblem {
        case "translocated", "volume":
            alert("Move Keyln to your Applications folder, then open it again.", "Keyln cannot install its background service while it runs from a disk image or a temporary location.")
            return
        case "renamed":
            alert("Keyln must be named Keyln.app.", "Rename the app, then open it again.")
            return
        case .some:
            return
        case .none: break
        }
        if !info.configured {
            setupWindow.show(.address, info: info, actions: setupActions())
        } else if !info.manifestMatchesSelf {
            repairNeeded = true
            render()
            if !offeredRepair {
                offeredRepair = true
                setupWindow.show(.service, info: info, actions: setupActions())
            }
        } else {
            repairNeeded = false
        }
    }

    private func updateRepairState() {
        guard client.hasBundledRuntime else { return }
        withSetupInfo { [weak self] info in
            guard let self = self else { return }
            self.repairNeeded = info.configured && info.selfAppProblem == nil && !info.manifestMatchesSelf
            self.render()
        }
    }

    private func alert(_ title: String, _ detail: String) {
        NSApp.activate(ignoringOtherApps: true)
        let box = NSAlert()
        box.messageText = title
        box.informativeText = detail
        box.alertStyle = .warning
        box.addButton(withTitle: "OK")
        box.runModal()
    }

    private func withSetupInfo(_ then: @escaping (SetupInfo) -> Void) {
        queue.async { [weak self] in
            guard let self = self else { return }
            let answer = self.client.setupInfo()
            DispatchQueue.main.async {
                guard let info = answer.info else { self.fail("Could not read the setup state", answer.error ?? "The runtime did not answer."); return }
                self.setupInfo = info
                then(info)
            }
        }
    }

    @objc private func showSetupGuide() {
        withSetupInfo { [weak self] info in
            guard let self = self else { return }
            if info.selfAppProblem != nil && self.client.hasBundledRuntime { self.decideFirstRun(info); return }
            let step: SetupStep = !info.configured ? .address : (self.client.hasBundledRuntime && !info.manifestMatchesSelf ? .service : .next)
            self.setupWindow.show(step, info: info, actions: self.setupActions())
        }
    }

    @objc private func repairLocation() {
        withSetupInfo { [weak self] info in
            guard let self = self else { return }
            self.setupWindow.show(.service, info: info, actions: self.setupActions())
        }
    }

    @objc private func changeAddress() {
        withSetupInfo { [weak self] info in
            guard let self = self else { return }
            self.changeWindow.show(info: info, client: self.client) { [weak self] in self?.refresh(doctor: true); self?.updateRepairState() }
        }
    }

    @objc private func exportCertificateFromMenu() {
        exportCertificate { _ in }
    }

    private func exportCertificate(_ done: @escaping (String?) -> Void) {
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "keyln-root.cer"
        panel.prompt = "Export"
        panel.message = "This file contains only Keyln’s public certificate. It never contains a private key."
        if let type = UTType(filenameExtension: "cer") { panel.allowedContentTypes = [type] }
        guard panel.runModal() == .OK, let url = panel.url else { done(nil); return }
        busy = true
        render()
        queue.async { [weak self] in
            guard let self = self else { return }
            let result = self.client.runSelf(["export-certificate", "--out", url.path], timeout: 20)
            DispatchQueue.main.async {
                self.busy = false
                self.render()
                guard result.status == 0, let object = try? JSONSerialization.jsonObject(with: Data(result.stdout.utf8)) as? [String: Any], let fingerprint = object["fingerprint"] as? String else {
                    self.fail("Could not export the certificate", result.stderr.isEmpty ? "The command failed." : result.stderr)
                    done(nil)
                    return
                }
                done(fingerprint)
                NSApp.activate(ignoringOtherApps: true)
                let box = NSAlert()
                box.messageText = "Certificate saved"
                box.informativeText = "SHA-256 fingerprint:\n" + fingerprint + "\n\nInstall the file on your device and trust it only after checking that its fingerprint matches."
                box.addButton(withTitle: "OK")
                box.runModal()
            }
        }
    }

    // MARK: actions

    @objc private func openKeyln() {
        guard let origin = current.origin, let url = URL(string: origin) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func showQRCode() {
        guard let origin = current.origin else { return }
        qrWindow.show(origin: origin)
    }

    @objc private func macManagement() {
        guard let origin = current.origin, let page = URL(string: origin + "/admin") else { return }
        busy = true
        render()
        queue.async { [weak self] in
            guard let self = self else { return }
            let result = self.client.run(["admin-json"], timeout: 8)
            var code: String?
            if result.status == 0,
               let object = try? JSONSerialization.jsonObject(with: Data(result.stdout.utf8)) as? [String: Any] {
                code = object["code"] as? String
            }
            DispatchQueue.main.async {
                self.busy = false
                guard let code = code else {
                    self.render()
                    self.fail("Could not get a login code", result.stderr.isEmpty ? "The service did not answer." : result.stderr)
                    return
                }
                self.copySecretly(code)
                NSWorkspace.shared.open(page)
                self.codeNote = "Login code copied (2 min)"
                self.render()
            }
        }
    }

    private func copySecretly(_ code: String) {
        let board = NSPasteboard.general
        board.clearContents()
        let concealed = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")
        board.declareTypes([.string, concealed], owner: nil)
        board.setString(code, forType: .string)
        board.setString("", forType: concealed)
        let count = board.changeCount
        clearWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            if board.changeCount == count, board.string(forType: .string) == code { board.clearContents() }
            self?.codeNote = nil
            self?.render()
        }
        clearWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 120, execute: work)
    }

    @objc private func startService() { perform("start") }
    @objc private func restartService() { perform("restart") }
    @objc private func stopService() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Stop Keyln?"
        alert.informativeText = "Keyln will not start at login until you choose Start again. Saved data is kept."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Stop")
        alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { perform("stop") }
    }

    private func perform(_ command: String) {
        guard !busy else { return }
        busy = true
        render()
        queue.async { [weak self] in
            guard let self = self else { return }
            // stop waits up to 16 s for the Host, start up to 12 s for readiness, restart does both.
            // Leave room so a slow but healthy command is never killed halfway.
            let result = self.client.run([command], timeout: command == "restart" ? 60 : 40)
            DispatchQueue.main.async {
                self.busy = false
                self.render()
                if result.status != 0 {
                    let detail = result.timedOut ? "The command did not finish in time." : (result.stderr.isEmpty ? "Exit status \(result.status)." : result.stderr)
                    self.fail("Keyln could not \(command)", detail)
                }
                self.refresh(doctor: true)
            }
        }
    }

    private func fail(_ title: String, _ detail: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    @objc private func showLogs() {
        let path = current.logs ?? client.logsPath
        let fallback = client.dataDir
        let target = FileManager.default.fileExists(atPath: path) ? path : fallback
        NSWorkspace.shared.open(URL(fileURLWithPath: target, isDirectory: true))
    }

    @objc private func quit() { NSApp.terminate(nil) }

    // MARK: open at login

    private func registerLoginOnFirstLaunch() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: "didAutoRegisterLogin") else { return }
        defaults.set(true, forKey: "didAutoRegisterLogin")   // one attempt only, no retry loop
        do { try SMAppService.mainApp.register() }
        catch { defaults.set(String(describing: error), forKey: "autoRegisterLoginError") }
    }

    private func updateLoginItem() {
        switch SMAppService.mainApp.status {
        case .enabled:
            loginItem.title = "Open at Login"; loginItem.state = .on
        case .requiresApproval:
            loginItem.title = "Approve in System Settings…"; loginItem.state = .off
        default:
            loginItem.title = "Open at Login"; loginItem.state = .off
        }
    }

    @objc private func toggleLogin() {
        let service = SMAppService.mainApp
        switch service.status {
        case .requiresApproval:
            SMAppService.openSystemSettingsLoginItems()
        case .enabled:
            do { try service.unregister() } catch { fail("Could not turn off Open at Login", error.localizedDescription) }
        default:
            do { try service.register() } catch { fail("Could not turn on Open at Login", error.localizedDescription) }
        }
        updateLoginItem()
    }
}
