import AppKit
import Foundation

// Read-only foreground application observation. No windows, names, input events or launch-history inference.
func observeAppActivations() -> Never {
    let parent = getppid()
    guard parent > 1 else { exit(0) }
    let workspace = NSWorkspace.shared
    func write(_ value: [String: String]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
    func activated(_ app: NSRunningApplication?) {
        guard let id = app?.bundleIdentifier,
              id.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$", options: .regularExpression) != nil else { return }
        write(["type": "activated", "appId": id])
    }
    let token = workspace.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { notification in
        activated(notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
    }
    // Exit even if the Host disappears while no activation notifications arrive.
    let parentWatch = Timer(timeInterval: 1, repeats: true) { _ in
        if getppid() != parent || kill(parent, 0) != 0 { exit(0) }
    }
    RunLoop.main.add(parentWatch, forMode: .common)
    write(["type": "ready"])
    activated(workspace.frontmostApplication)
    withExtendedLifetime(token) { RunLoop.main.run() }
    exit(0)
}
