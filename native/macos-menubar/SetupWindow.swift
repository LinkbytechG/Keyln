import AppKit

// T124 (ADR-108): first run. Plain AppKit, no new dependencies. The window only asks the bundled Node to run the whitelisted commands
// (setup, install-self, export-certificate, change-address); it never writes configuration, certificates or system settings itself.

private func text(_ string: String, bold: Bool = false, secondary: Bool = false, width: CGFloat = 420) -> NSTextField {
    let field = NSTextField(wrappingLabelWithString: string)
    field.font = bold ? NSFont.boldSystemFont(ofSize: NSFont.systemFontSize) : NSFont.systemFont(ofSize: NSFont.systemFontSize)
    if secondary { field.textColor = .secondaryLabelColor }
    field.preferredMaxLayoutWidth = width
    field.isSelectable = true
    return field
}

private func stack(_ views: [NSView], spacing: CGFloat = 8) -> NSStackView {
    let box = NSStackView(views: views)
    box.orientation = .vertical
    box.alignment = .leading
    box.spacing = spacing
    return box
}

private func row(_ views: [NSView]) -> NSStackView {
    let box = NSStackView(views: views)
    box.orientation = .horizontal
    box.alignment = .centerY
    box.spacing = 8
    return box
}

private func addressPopup(_ candidates: [AddressCandidate], selecting current: String?) -> NSPopUpButton {
    let popup = NSPopUpButton(frame: .zero, pullsDown: false)
    for candidate in candidates { popup.addItem(withTitle: candidate.title) }
    if let current = current, let index = candidates.firstIndex(where: { $0.address == current }) { popup.selectItem(at: index) }
    return popup
}

private func portField(_ port: Int) -> NSTextField {
    let field = NSTextField(string: String(port))
    field.alignment = .right
    field.widthAnchor.constraint(equalToConstant: 72).isActive = true
    return field
}

private final class PanelWindow: NSWindow {
    override func cancelOperation(_ sender: Any?) { close() }
}

private func makeWindow(title: String) -> NSWindow {
    let window = PanelWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 300), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = title
    window.isReleasedWhenClosed = false
    return window
}

private func present(_ window: NSWindow, content: NSView) {
    let wasVisible = window.isVisible
    content.translatesAutoresizingMaskIntoConstraints = false
    let holder = NSView()
    holder.addSubview(content)
    NSLayoutConstraint.activate([
        content.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: 24),
        content.trailingAnchor.constraint(equalTo: holder.trailingAnchor, constant: -24),
        content.topAnchor.constraint(equalTo: holder.topAnchor, constant: 22),
        content.bottomAnchor.constraint(equalTo: holder.bottomAnchor, constant: -22),
        content.widthAnchor.constraint(equalToConstant: 432),
    ])
    window.contentView = holder
    holder.layoutSubtreeIfNeeded()
    window.setContentSize(holder.fittingSize)
    if !wasVisible { window.center() }
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
}

/// What the setup window needs from the menu bar app.
struct SetupActions {
    let client: ServiceClient
    let macManagement: () -> Void
    let showQRCode: () -> Void
    let exportCertificate: (@escaping (String?) -> Void) -> Void   // calls back with the fingerprint, nil when cancelled or failed
    let accessibilityText: () -> String
    let refreshPermissions: () -> Void
    let changed: () -> Void                                        // setup or install changed something; refresh the menu
}

enum SetupStep { case address, service, next }

final class SetupWindowController: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    private var actions: SetupActions?
    private var info = SetupInfo()
    private var step = SetupStep.address
    private var popup: NSPopUpButton?
    private var port: NSTextField?
    private var status: NSTextField?
    private var spinner: NSProgressIndicator?
    private var primary: NSButton?
    private var accessibilityLabel: NSTextField?
    private var certificateLabel: NSTextField?
    private let queue = DispatchQueue(label: "local.keyln.menubar.setup")

    var isVisible: Bool { window?.isVisible ?? false }

    func show(_ step: SetupStep, info: SetupInfo, actions: SetupActions) {
        self.step = step
        self.info = info
        self.actions = actions
        let window = self.window ?? makeWindow(title: "Set Up Keyln")
        window.delegate = self
        self.window = window
        switch step {
        case .address: present(window, content: addressContent())
        case .service: present(window, content: serviceContent())
        case .next: present(window, content: nextContent())
        }
    }

    func permissionChanged() { accessibilityLabel?.stringValue = actions?.accessibilityText() ?? "" }

    func windowDidBecomeKey(_ notification: Notification) {
        if step == .next { actions?.refreshPermissions() }
    }

    // MARK: Address

    private func addressContent() -> NSView {
        let popup = addressPopup(info.candidates, selecting: info.address)
        let port = portField(info.port ?? 8940)
        let status = text("", secondary: true)
        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        let button = NSButton(title: "Set Up", target: self, action: #selector(setUp))
        button.keyEquivalent = "\r"
        self.popup = popup; self.port = port; self.status = status; self.spinner = spinner; self.primary = button
        return stack([
            text("Set up Keyln", bold: true),
            text("Choose the address your Mac uses on your home network. Keyln creates its own certificate for it, keeps running in the background and starts at login. It adds a login item for itself and does not change system settings or trust."),
            row([text("Address"), popup]),
            row([text("Port"), port]),
            row([button, spinner]),
            status,
        ], spacing: 12)
    }

    @objc private func setUp() {
        guard let actions = actions, let popup = popup, let port = port else { return }
        let index = popup.indexOfSelectedItem
        guard info.candidates.indices.contains(index) else { fail("Choose an address."); return }
        let address = info.candidates[index].address
        let number = port.stringValue.trimmingCharacters(in: .whitespaces)
        guard let value = Int(number), value >= 1024, value <= 65535 else { fail("Port must be 1024–65535."); return }
        working("Creating certificates…")
        queue.async { [weak self] in
            let made = actions.client.runSelf(["setup", "--address", address, "--port", String(value)], timeout: 90)
            guard made.status == 0 else { DispatchQueue.main.async { self?.fail(Self.reason(made)) }; return }
            DispatchQueue.main.async { self?.working("Installing the background service…") }
            let installed = actions.client.runSelf(["install-self"], timeout: 150)
            DispatchQueue.main.async {
                guard installed.status == 0 else { self?.fail(Self.reason(installed)); return }
                actions.changed()
                self?.refreshInfoThenShowNext()
            }
        }
    }

    // MARK: Service

    private func serviceContent() -> NSView {
        let status = text("", secondary: true)
        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        let button = NSButton(title: "Use This App", target: self, action: #selector(useThisApp))
        button.keyEquivalent = "\r"
        self.status = status; self.spinner = spinner; self.primary = button
        return stack([
            text("Use this copy of Keyln", bold: true),
            text("Keyln’s background service will run from this app, at " + (info.selfApp ?? "its current place") + ". Your data, layouts and pairings are kept."),
            row([button, spinner]),
            status,
        ], spacing: 12)
    }

    @objc private func useThisApp() {
        guard let actions = actions else { return }
        working("Installing the background service…")
        queue.async { [weak self] in
            let installed = actions.client.runSelf(["install-self"], timeout: 150)
            DispatchQueue.main.async {
                guard installed.status == 0 else { self?.fail(Self.reason(installed)); return }
                actions.changed()
                self?.refreshInfoThenShowNext()
            }
        }
    }

    private func refreshInfoThenShowNext() {
        guard let actions = actions else { return }
        queue.async { [weak self] in
            let fresh = actions.client.setupInfo().info
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let fresh = fresh { self.info = fresh }
                self.show(.next, info: self.info, actions: actions)
            }
        }
    }

    // MARK: Next steps

    private func nextContent() -> NSView {
        guard let actions = actions else { return NSView() }
        let certificate = text(info.caFingerprint.map { "Fingerprint (SHA-256): " + $0 } ?? "", secondary: true)
        let accessibility = text(actions.accessibilityText(), secondary: true)
        certificateLabel = certificate
        accessibilityLabel = accessibility
        let export = NSButton(title: "Export Device Certificate…", target: self, action: #selector(exportCertificate))
        let admin = NSButton(title: "Mac Management", target: self, action: #selector(openAdmin))
        let qr = NSButton(title: "Show QR Code…", target: self, action: #selector(openQR))
        let settings = NSButton(title: "Open Accessibility Settings", target: self, action: #selector(openAccessibility))
        let finder = NSButton(title: "Show Keyln’s node in Finder", target: self, action: #selector(showNode))
        let done = NSButton(title: "Done", target: self, action: #selector(close))
        done.keyEquivalent = "\r"
        return stack([
            text(info.origin.map { "Keyln is running at " + $0 } ?? "Keyln is set up", bold: true),
            text("1. Trust Keyln on your device", bold: true),
            text("Save the certificate, send it to your device (AirDrop or a USB drive), install it and turn on trust. Compare the fingerprint before you trust it."),
            row([export]),
            certificate,
            text("2. Pair your device", bold: true),
            text("Open Mac Management for a one-time login code, or show the QR code to open Keyln on your device."),
            row([admin, qr]),
            text("3. Allow Keyln to send keys", bold: true),
            accessibility,
            row([settings, finder]),
            text("Drag node into the list and turn it on.", secondary: true),
            row([done]),
        ], spacing: 10)
    }

    @objc private func exportCertificate() {
        actions?.exportCertificate { [weak self] fingerprint in
            guard let fingerprint = fingerprint else { return }
            self?.certificateLabel?.stringValue = "Saved. Fingerprint (SHA-256): " + fingerprint + "\nInstall the file on your device and trust it only if its fingerprint matches."
            self?.window?.contentView?.layoutSubtreeIfNeeded()
            if let window = self?.window, let holder = window.contentView { window.setContentSize(holder.fittingSize) }
        }
    }
    @objc private func openAdmin() { actions?.macManagement() }
    @objc private func openQR() { actions?.showQRCode() }
    @objc private func openAccessibility() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") { NSWorkspace.shared.open(url) }
    }
    @objc private func showNode() {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: Bundle.main.bundlePath + "/Contents/Helpers/node")])
    }
    @objc private func close() { window?.close() }

    // MARK: progress

    private func working(_ message: String) {
        primary?.isEnabled = false
        popup?.isEnabled = false
        port?.isEnabled = false
        status?.textColor = .secondaryLabelColor
        status?.stringValue = message
        spinner?.startAnimation(nil)
        resize()
    }

    private func fail(_ message: String) {
        primary?.isEnabled = true
        popup?.isEnabled = true
        port?.isEnabled = true
        spinner?.stopAnimation(nil)
        status?.textColor = .systemRed
        status?.stringValue = message
        resize()
    }

    private func resize() {
        guard let window = window, let holder = window.contentView else { return }
        holder.layoutSubtreeIfNeeded()
        window.setContentSize(holder.fittingSize)
    }

    static func reason(_ result: CommandResult) -> String {
        if result.timedOut { return "The command did not finish in time." }
        return result.stderr.isEmpty ? "Failed (exit status \(result.status))." : result.stderr
    }
}

/// "Change Address…": stop, set up again at another address, start. The certificate authority stays, devices must re-pair.
final class ChangeAddressWindowController: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    private var client: ServiceClient?
    private var info = SetupInfo()
    private var changed: (() -> Void)?
    private var popup: NSPopUpButton?
    private var port: NSTextField?
    private var status: NSTextField?
    private var spinner: NSProgressIndicator?
    private var primary: NSButton?
    private let queue = DispatchQueue(label: "local.keyln.menubar.change-address")

    func show(info: SetupInfo, client: ServiceClient, changed: @escaping () -> Void) {
        self.info = info
        self.client = client
        self.changed = changed
        let window = self.window ?? makeWindow(title: "Change Address")
        self.window = window
        let popup = addressPopup(info.candidates, selecting: info.address)
        let port = portField(info.port ?? 8940)
        let status = text("", secondary: true)
        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        let change = NSButton(title: "Change Address", target: self, action: #selector(apply))
        change.keyEquivalent = "\r"
        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelWindow))
        self.popup = popup; self.port = port; self.status = status; self.spinner = spinner; self.primary = change
        present(window, content: stack([
            text("Change address", bold: true),
            text("Keyln restarts at the new address. Your devices keep trusting Keyln’s certificate authority, but they must open the new address and be paired again."),
            row([text("Address"), popup]),
            row([text("Port"), port]),
            row([change, cancel, spinner]),
            status,
        ], spacing: 12))
    }

    @objc private func cancelWindow() { window?.close() }

    @objc private func apply() {
        guard let client = client, let popup = popup, let port = port else { return }
        let index = popup.indexOfSelectedItem
        guard info.candidates.indices.contains(index) else { return }
        guard let value = Int(port.stringValue.trimmingCharacters(in: .whitespaces)), value >= 1024, value <= 65535 else { fail("Port must be 1024–65535."); return }
        let address = info.candidates[index].address
        primary?.isEnabled = false; popup.isEnabled = false; port.isEnabled = false
        status?.textColor = .secondaryLabelColor
        status?.stringValue = "Restarting Keyln at the new address…"
        spinner?.startAnimation(nil)
        queue.async { [weak self] in
            let result = client.runSelf(["change-address", "--address", address, "--port", String(value)], timeout: 150)
            DispatchQueue.main.async {
                guard let self = self else { return }
                guard result.status == 0 else { self.fail(SetupWindowController.reason(result)); return }
                self.changed?()
                self.spinner?.stopAnimation(nil)
                self.window?.close()
                var origin = ""
                if let object = try? JSONSerialization.jsonObject(with: Data(result.stdout.utf8)) as? [String: Any] { origin = object["origin"] as? String ?? "" }
                NSApp.activate(ignoringOtherApps: true)
                let alert = NSAlert()
                alert.messageText = "Keyln now uses " + origin
                alert.informativeText = "On each device, open the new address and pair again. The certificate does not need to be installed again."
                alert.addButton(withTitle: "OK")
                alert.runModal()
            }
        }
    }

    private func fail(_ message: String) {
        primary?.isEnabled = true; popup?.isEnabled = true; port?.isEnabled = true
        spinner?.stopAnimation(nil)
        status?.textColor = .systemRed
        status?.stringValue = message
        if let window = window, let holder = window.contentView { holder.layoutSubtreeIfNeeded(); window.setContentSize(holder.fittingSize) }
    }
}
