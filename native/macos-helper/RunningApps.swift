import AppKit
import Foundation

// T115 (ADR-099): the apps the macOS Dock shows as running, for the Keyln Dock bar. Read-only: no windows, titles, accessibility, input events or new permissions.
// Source: NSWorkspace running applications with a regular activation policy. Order is the Dock's: Finder, then the apps pinned in the Dock (in pinned order),
// then the other running apps by launch time (oldest first). Several instances of one bundle ID are merged into one entry.
private let bundleIDPattern = "^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$"
private let maxDockApps = 64
private let finderID = "com.apple.finder"

// com.apple.dock "persistent-apps": each item's tile-data bundle-identifier. Read again on every snapshot (cheap); an unexpected shape reads as no pinned apps.
func dockPinnedBundleIDs() -> [String] {
    let domain = "com.apple.dock" as CFString
    CFPreferencesAppSynchronize(domain)
    guard let items = CFPreferencesCopyAppValue("persistent-apps" as CFString, domain) as? [[String: Any]] else { return [] }
    var ids: [String] = []
    for item in items {
        guard let tile = item["tile-data"] as? [String: Any], let id = tile["bundle-identifier"] as? String else { continue }
        ids.append(id)
    }
    return ids
}

private func displayName(_ app: NSRunningApplication, id: String) -> String {
    let raw = app.localizedName ?? id
    let cleaned = String(String.UnicodeScalarView(raw.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) && !CharacterSet.newlines.contains($0) }))
        .trimmingCharacters(in: .whitespaces)
    let name = String(cleaned.prefix(80)).trimmingCharacters(in: .whitespaces)
    return name.isEmpty ? id : name
}

func runningAppsSnapshot() -> [[String: Any]] {
    struct Entry { var name: String; var active: Bool; var hidden: Bool; var launch: Date; var named: Date }
    var merged: [String: Entry] = [:]
    // isActive is cached per process and can lag before a run loop has turned; the workspace's frontmost application is the second source.
    let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier
    for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular && !app.isTerminated {
        guard let id = app.bundleIdentifier, id.range(of: bundleIDPattern, options: .regularExpression) != nil else { continue }
        let launch = app.launchDate ?? Date.distantFuture
        if var entry = merged[id] {
            // Active if any instance is active; hidden only if every instance is hidden. The oldest instance names the entry.
            entry.active = entry.active || app.isActive || app.processIdentifier == frontmost
            entry.hidden = entry.hidden && app.isHidden
            if launch < entry.named { entry.name = displayName(app, id: id); entry.named = launch }
            if launch < entry.launch { entry.launch = launch }
            merged[id] = entry
        } else {
            merged[id] = Entry(name: displayName(app, id: id), active: app.isActive || app.processIdentifier == frontmost, hidden: app.isHidden, launch: launch, named: launch)
        }
    }
    var order: [String] = []
    if merged[finderID] != nil { order.append(finderID) }
    for id in dockPinnedBundleIDs() where merged[id] != nil && !order.contains(id) { order.append(id) }
    let rest = merged.keys.filter { !order.contains($0) }.sorted {
        let a = merged[$0]!.launch, b = merged[$1]!.launch
        return a == b ? $0 < $1 : a < b
    }
    order.append(contentsOf: rest)
    return order.prefix(maxDockApps).map { id in
        let entry = merged[id]!
        return ["appId": id, "name": entry.name, "active": entry.active, "hidden": entry.hidden] as [String: Any]
    }
}

// One-shot: prints one snapshot and exits (for manual checks).
func printRunningApps() -> Never {
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    emit(["type": "apps", "apps": runningAppsSnapshot()])
}

// Long-running: `{"type":"ready"}`, then a full `{"type":"apps","apps":[...]}` snapshot at start and after every change (debounced, identical snapshots skipped).
func observeRunningApps() -> Never {
    let parent = getppid()
    guard parent > 1 else { exit(0) }
    let center = NSWorkspace.shared.notificationCenter
    func write(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
    var last = ""
    func publish() {
        let apps = runningAppsSnapshot()
        guard let data = try? JSONSerialization.data(withJSONObject: apps, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8), text != last else { return }
        last = text
        write(["type": "apps", "apps": apps])
    }
    var pending: Timer?
    func schedule() {
        pending?.invalidate()
        pending = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: false) { _ in pending = nil; publish() }
    }
    let names: [Notification.Name] = [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification,
        NSWorkspace.didActivateApplicationNotification, NSWorkspace.didHideApplicationNotification, NSWorkspace.didUnhideApplicationNotification]
    let tokens = names.map { name in center.addObserver(forName: name, object: nil, queue: .main) { _ in schedule() } }
    // Exit even if the Host disappears while no notifications arrive.
    let parentWatch = Timer(timeInterval: 1, repeats: true) { _ in
        if getppid() != parent || kill(parent, 0) != 0 { exit(0) }
    }
    RunLoop.main.add(parentWatch, forMode: .common)
    write(["type": "ready"])
    publish()
    withExtendedLifetime(tokens) { RunLoop.main.run() }
    exit(0)
}
