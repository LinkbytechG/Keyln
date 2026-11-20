import AppKit
import Foundation

// Explicit M1 acceptance target. It only writes its owned temporary launch log.
final class AcceptanceDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow?
    let directory: URL
    let nonce: String
    let bundleID: String
    let launchID = UUID().uuidString
    var launches: [[String: Any]] = []

    init(ownedBundle: Bundle) throws {
        let info = ownedBundle.infoDictionary ?? [:]
        guard let path = info["KeylnAcceptanceDirectory"] as? String,
              let nonce = info["KeylnAcceptanceNonce"] as? String,
              let bundleID = ownedBundle.bundleIdentifier else { throw NSError(domain: "KeylnTest", code: 1) }
        directory = URL(fileURLWithPath: path, isDirectory: true)
        self.nonce = nonce; self.bundleID = bundleID
        super.init()
        let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
        guard (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              let owner = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("owner.json"))) as? [String: Any],
              owner["nonce"] as? String == nonce, owner["bundleId"] as? String == bundleID,
              let log = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("launches.json"))) as? [String: Any],
              log["nonce"] as? String == nonce, let entries = log["launches"] as? [[String: Any]] else {
            throw NSError(domain: "KeylnTest", code: 2)
        }
        launches = entries
    }

    func writeLog() throws {
        let data = try JSONSerialization.data(withJSONObject: ["nonce": nonce, "launches": launches], options: [.sortedKeys])
        try data.write(to: directory.appendingPathComponent("launches.json"), options: [.atomic])
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        launches.append(["id": launchID, "pid": ProcessInfo.processInfo.processIdentifier,
                         "startedAt": ISO8601DateFormatter().string(from: Date()), "ready": false])
        do { try writeLog() } catch { exit(1) }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let index = launches.firstIndex(where: { $0["id"] as? String == launchID }) else { exit(1) }
        launches[index]["ready"] = true
        launches[index]["readyAt"] = ISO8601DateFormatter().string(from: Date())
        do { try writeLog() } catch { exit(1) }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 280),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Keyln M1 Acceptance"
        window.isReleasedWhenClosed = false
        let label = NSTextField(wrappingLabelWithString:
            "Keyln M1 acceptance\n\nLaunches this round: \(launches.count)\n\nThis temporary app only counts its own launches. It does not read or change documents.\nFor the offline test, click the red close button before reconnecting the network.")
        label.frame = NSRect(x: 28, y: 30, width: 504, height: 218)
        label.font = .systemFont(ofSize: 17)
        window.contentView?.addSubview(label)
        window.center(); window.makeKeyAndOrderFront(nil)
        self.window = window
        NSApplication.shared.activate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

do {
    let delegate = try AcceptanceDelegate(ownedBundle: .main)
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
} catch {
    FileHandle.standardError.write(Data("Keyln M1 test refused an invalid or unowned temporary state directory.\n".utf8))
    exit(1)
}
