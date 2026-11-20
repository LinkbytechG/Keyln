import AppKit

// Explicit fixture: mutations and event observations are restricted to this app's own windows.
@MainActor final class WindowProbeDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let root: URL
    let nonce: String
    var windows: [String: NSWindow] = [:], fields: [String: NSTextView] = [:]
    var serial = 0, keyEvents = 0
    var fullScreenTransitions = Set<ObjectIdentifier>()
    var timer: Timer?, monitor: Any?
    init(bundle: Bundle) throws {
        guard let directory = bundle.object(forInfoDictionaryKey: "KeylnProbeDirectory") as? String,
              let nonce = bundle.object(forInfoDictionaryKey: "KeylnProbeNonce") as? String,
              (try FileManager.default.attributesOfItem(atPath: directory)[.ownerAccountID] as? NSNumber)?.uint32Value == getuid() else {
            throw NSError(domain: "KeylnWindowProbe", code: 1)
        }
        root = URL(fileURLWithPath: directory); self.nonce = nonce; super.init()
    }
    func makeWindow(_ id: String, _ title: String) {
        let window = NSWindow(contentRect: NSRect(x: id == "b" ? 220 : 120, y: 240, width: 520, height: 240), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.title = title; window.delegate = self
        window.collectionBehavior.insert(.fullScreenPrimary)
        let text = NSTextView(frame: NSRect(x: 20, y: 20, width: 480, height: 190)); text.string = "Keyln owned window test"; text.font = NSFont.systemFont(ofSize: 22)
        window.contentView?.addSubview(text); windows[id] = window; fields[id] = text
        window.makeKeyAndOrderFront(nil); window.makeFirstResponder(text)
    }
    func record() {
        var result: [String: Any] = ["nonce": nonce, "pid": ProcessInfo.processInfo.processIdentifier, "serial": serial, "keyEvents": keyEvents,
            "front": NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier, "focused": NSApp.keyWindow?.title ?? ""]
        result["windows"] = windows.mapValues { ["title": $0.title, "visible": $0.isVisible, "minimized": $0.isMiniaturized,
            "fullScreen": $0.styleMask.contains(.fullScreen), "onActiveSpace": $0.isOnActiveSpace,
            "transitioning": fullScreenTransitions.contains(ObjectIdentifier($0))] }
        result["selected"] = fields.mapValues { $0.selectedRange().length == $0.string.utf16.count }
        if let bytes = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) { try? bytes.write(to: root.appendingPathComponent("state.json"), options: .atomic) }
    }
    func frontOwnWindow(_ id: String) {
        windows[id]?.makeKeyAndOrderFront(nil)
        // The fixture lives in a temporary directory, outside application-ID lookup roots.
        let configuration = NSWorkspace.OpenConfiguration(); configuration.activates = true
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration) { _, _ in }
    }
    func tick() {
        if let bytes = try? Data(contentsOf: root.appendingPathComponent("command.json")),
           let command = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any], command["nonce"] as? String == nonce,
           let next = command["serial"] as? Int, next > serial {
            switch command["action"] as? String {
            case "front-a": frontOwnWindow("a")
            case "front-b": frontOwnWindow("b")
            case "fullscreen-a", "fullscreen-b":
                let id = command["action"] as? String == "fullscreen-a" ? "a" : "b"
                if let window = windows[id], !window.styleMask.contains(.fullScreen) { window.makeKeyAndOrderFront(nil); NSApp.activate(); window.toggleFullScreen(nil) }
            case "unfullscreen-a", "unfullscreen-b":
                let id = command["action"] as? String == "unfullscreen-a" ? "a" : "b"
                if let window = windows[id], window.styleMask.contains(.fullScreen) { window.toggleFullScreen(nil) }
            case "minimize-a": windows["a"]?.miniaturize(nil)
            case "duplicate-a": if windows["duplicate"] == nil { makeWindow("duplicate", "Keyln Window A \(nonce)") }
            case "close-duplicate": windows.removeValue(forKey: "duplicate")?.close(); fields.removeValue(forKey: "duplicate")
            case "rename-a": windows["a"]?.title = "Renamed \(nonce)"
            case "close-a": windows["a"]?.close(); windows.removeValue(forKey: "a"); fields.removeValue(forKey: "a")
            case "reset-selection": for field in fields.values { field.setSelectedRange(NSRange(location: 0, length: 0)) }
            case "quit": serial = next; record(); NSApp.terminate(nil)
            default: break
            }
            serial = next
        }
        record()
    }
    func windowWillEnterFullScreen(_ notification: Notification) { if let window = notification.object as? NSWindow { fullScreenTransitions.insert(ObjectIdentifier(window)) } }
    func windowWillExitFullScreen(_ notification: Notification) { windowWillEnterFullScreen(notification) }
    func windowDidEnterFullScreen(_ notification: Notification) { if let window = notification.object as? NSWindow { fullScreenTransitions.remove(ObjectIdentifier(window)) }; record() }
    func windowDidExitFullScreen(_ notification: Notification) { windowDidEnterFullScreen(notification) }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu(), edit = NSMenuItem(), editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        edit.submenu = editMenu; menu.addItem(NSMenuItem()); menu.addItem(edit); NSApp.mainMenu = menu
        makeWindow("a", "Keyln Window A \(nonce)"); makeWindow("b", "Keyln Window B \(nonce)"); NSApp.activate()
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in MainActor.assumeIsolated { self?.keyEvents += 1 }; return event }
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.tick() } }
        Timer.scheduledTimer(withTimeInterval: 300, repeats: false) { _ in MainActor.assumeIsolated { NSApp.terminate(nil) } }
        record()
    }
}
MainActor.assumeIsolated {
    do {
        let delegate = try WindowProbeDelegate(bundle: .main), app = NSApplication.shared
        app.setActivationPolicy(.regular); app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    } catch { exit(2) }
}
