import AppKit
import ApplicationServices

struct WindowProblem: Error { let code: String; let message: String }
let maximumWindowCount = 64
let maximumWindowTitleLength = 256

func windowPreflight() throws {
    guard AXIsProcessTrusted() else {
        throw WindowProblem(code: "ACCESSIBILITY_REQUIRED", message: "Enable Accessibility for the Keyln helper or its Mac launcher before controlling windows.")
    }
    let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
    guard session[kCGSessionOnConsoleKey as String] as? Bool == true,
          session[kCGSessionLoginDoneKey as String] as? Bool == true,
          session["CGSSessionScreenIsLocked"] as? Bool != true,
          NSWorkspace.shared.frontmostApplication?.bundleIdentifier != "com.apple.loginwindow" else {
        throw WindowProblem(code: "SESSION_UNAVAILABLE", message: "Use the unlocked, signed-in Mac desktop before controlling windows.")
    }
}
func windowAttribute(_ element: AXUIElement, _ name: String) throws -> CFTypeRef? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    if result == .attributeUnsupported || result == .noValue { return nil }
    guard result == .success else {
        throw WindowProblem(code: "WINDOW_UNAVAILABLE", message: "The Mac application did not expose its windows reliably (\(name), macOS \(result.rawValue)). Check that it is responding and try again.")
    }
    return value
}
func plainWindowTitle(_ title: String) -> Bool {
    !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && title.utf16.count <= maximumWindowTitleLength &&
        !title.unicodeScalars.contains { $0.value < 32 || $0.value == 127 }
}
struct WindowContext {
    let app: NSRunningApplication
    let element: AXUIElement
    let windows: [AXUIElement]
}
struct WindowTarget {
    let title: String
    let window: AXUIElement?
    let sessionItem: AXUIElement?
}
func accessibilityElement(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
}
func isSessionWindowItem(identifier: String?, role: String?, command: String?, childCount: Int, title: String?) -> Bool {
    identifier == "activateSession:" && role == kAXMenuItemRole && (command ?? "").isEmpty && childCount == 0 &&
        title.map { plainWindowTitle($0) } == true
}
// Windows App exposes its existing remote sessions as these exact menu actions, even when
// AXWindows omits every full-screen window except the last main/focused one. Never search
// arbitrary menu titles or invoke connection commands. This reader itself is read-only.
func readSessionMenuItems(_ application: AXUIElement) throws -> [WindowTarget] {
    guard let bar = accessibilityElement(try windowAttribute(application, kAXMenuBarAttribute)),
          let tops = try windowAttribute(bar, kAXChildrenAttribute) as? [AXUIElement] else { return [] }
    guard tops.count <= 16 else { throw WindowProblem(code: "WINDOW_LIMIT", message: "The application's window menu exceeds the supported limit.") }
    var result: [WindowTarget] = [], menusFound = 0
    for top in tops {
        guard try windowAttribute(top, kAXRoleAttribute) as? String == kAXMenuBarItemRole,
              let menus = try windowAttribute(top, kAXChildrenAttribute) as? [AXUIElement], menus.count == 1,
              let menu = menus.first, try windowAttribute(menu, kAXRoleAttribute) as? String == kAXMenuRole,
              let rows = try windowAttribute(menu, kAXChildrenAttribute) as? [AXUIElement] else { continue }
        guard rows.count <= 128 else { throw WindowProblem(code: "WINDOW_LIMIT", message: "The application's window menu exceeds the supported limit.") }
        var entries: [WindowTarget] = []
        for row in rows {
            guard let identifier = try windowAttribute(row, kAXIdentifierAttribute) as? String, identifier == "activateSession:" else { continue }
            let title = try windowAttribute(row, kAXTitleAttribute) as? String
            guard try isSessionWindowItem(identifier: identifier,
                    role: windowAttribute(row, kAXRoleAttribute) as? String,
                    command: windowAttribute(row, kAXMenuItemCmdCharAttribute) as? String,
                    childCount: (windowAttribute(row, kAXChildrenAttribute) as? [AXUIElement] ?? []).count, title: title),
                  let title else { continue }
            var applicationPID: pid_t = 0, itemPID: pid_t = 0
            guard AXUIElementGetPid(application, &applicationPID) == .success,
                  AXUIElementGetPid(row, &itemPID) == .success, applicationPID == itemPID else { continue }
            AXUIElementSetMessagingTimeout(row, 0.5)
            entries.append(WindowTarget(title: title.trimmingCharacters(in: .whitespacesAndNewlines), window: nil, sessionItem: row))
        }
        if !entries.isEmpty { menusFound += 1; result.append(contentsOf: entries) }
    }
    guard menusFound <= 1 else { throw WindowProblem(code: "WINDOWS_UNSUPPORTED", message: "More than one session window menu was exposed. No menu item was selected.") }
    guard result.count <= maximumWindowCount else { throw WindowProblem(code: "WINDOW_LIMIT", message: "This application has more than 64 session windows.") }
    return result
}
func mergeWindowTargets(_ windows: [WindowTarget], _ sessions: [WindowTarget]) throws -> [WindowTarget] {
    var result = windows
    // A menu entry and an AX window with the same complete title represent one candidate.
    // Keep the larger multiplicity, so two actual same-title windows are never collapsed.
    for title in Set(sessions.map { $0.title }) {
        let indices = result.indices.filter { result[$0].title == title }
        let items = sessions.filter { $0.title == title }
        if indices.count == 1 && items.count == 1 {
            let index = indices[0]
            result[index] = WindowTarget(title: title, window: result[index].window, sessionItem: items[0].sessionItem)
        } else if items.count > indices.count { result.append(contentsOf: items.dropFirst(indices.count)) }
    }
    guard result.count <= maximumWindowCount else { throw WindowProblem(code: "WINDOW_LIMIT", message: "This application has more than 64 windows.") }
    return result
}
func windowTargets(_ context: WindowContext) throws -> [WindowTarget] {
    var windows: [WindowTarget] = []
    for window in context.windows {
        if let title = try windowAttribute(window, kAXTitleAttribute) as? String {
            windows.append(WindowTarget(title: title.trimmingCharacters(in: .whitespacesAndNewlines), window: window, sessionItem: nil))
        }
    }
    // This selector is an explicitly verified Windows App compatibility path, not a generic
    // assumption about all applications' menus. No client-supplied app/menu command exists.
    let sessions = context.app.bundleIdentifier == "com.microsoft.rdc.macos" ? try readSessionMenuItems(context.element) : []
    return try mergeWindowTargets(windows, sessions)
}
func requireWindowRule(title: String, match: String) throws {
    guard plainWindowTitle(title), title == title.trimmingCharacters(in: .whitespacesAndNewlines), ["exact", "contains"].contains(match) else {
        throw WindowProblem(code: "INVALID_WINDOW_RULE", message: "Use a window title of 1–256 characters and an exact or contains match.")
    }
}
func selectedWindowTarget(_ targets: [WindowTarget], title: String, match: String) throws -> WindowTarget {
    try requireWindowRule(title: title, match: match)
    let matches = targets.filter { match == "exact" ? $0.title == title : $0.title.contains(title) }
    guard !matches.isEmpty else { throw WindowProblem(code: "WINDOW_NOT_FOUND", message: "No open window matches this title. Open the target window or edit the saved title. Nothing was launched or reconnected.") }
    guard matches.count == 1 else { throw WindowProblem(code: "WINDOW_AMBIGUOUS", message: "More than one window matches. Use a more specific title or close the duplicate; no window was selected.") }
    return matches[0]
}
func windowContext(appID: String) throws -> WindowContext {
    try windowPreflight()
    guard appID.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$", options: .regularExpression) != nil else {
        throw WindowProblem(code: "INVALID_APP", message: "Choose a valid Mac application.")
    }
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: appID).filter { !$0.isTerminated }
    guard !apps.isEmpty else {
        throw WindowProblem(code: "APP_NOT_RUNNING", message: "Open the target application and its window on the Mac first. No application was launched.")
    }
    guard apps.count == 1 else {
        throw WindowProblem(code: "APP_AMBIGUOUS", message: "More than one process has this application identifier. Close the duplicate instance before selecting a window.")
    }
    let element = AXUIElementCreateApplication(apps[0].processIdentifier)
    AXUIElementSetMessagingTimeout(element, 1.0)
    let value = try windowAttribute(element, kAXWindowsAttribute)
    var windows: [AXUIElement] = []
    if let value {
        guard CFGetTypeID(value) == CFArrayGetTypeID(), let listed = value as? [AXUIElement] else {
            throw WindowProblem(code: "WINDOWS_UNSUPPORTED", message: "This application does not expose a usable window list to macOS Accessibility.")
        }
        guard listed.count <= maximumWindowCount else {
            throw WindowProblem(code: "WINDOW_LIMIT", message: "This application has more than 64 windows. Close some windows before using this action.")
        }
        for window in listed where !windows.contains(where: { CFEqual($0, window) }) { windows.append(window) }
    }
    // Some apps omit full-screen windows in other Spaces from AXWindows, but still expose
    // them as their main/focused window. These are candidates, not proof of foreground focus.
    for name in [kAXMainWindowAttribute, kAXFocusedWindowAttribute] {
        guard let extra = try windowAttribute(element, name), CFGetTypeID(extra) == AXUIElementGetTypeID() else { continue }
        let window = unsafeBitCast(extra, to: AXUIElement.self)
        var pid: pid_t = 0
        guard AXUIElementGetPid(window, &pid) == .success, pid == apps[0].processIdentifier,
              !windows.contains(where: { CFEqual($0, window) }) else { continue }
        AXUIElementSetMessagingTimeout(window, 0.5)
        guard try windowAttribute(window, kAXRoleAttribute) as? String == kAXWindowRole else { continue }
        windows.append(window)
    }
    if value == nil && windows.isEmpty {
        throw WindowProblem(code: "WINDOWS_UNSUPPORTED", message: "This application does not expose a usable window list to macOS Accessibility.")
    }
    guard windows.count <= maximumWindowCount else {
        throw WindowProblem(code: "WINDOW_LIMIT", message: "This application has more than 64 windows. Close some windows before using this action.")
    }
    for window in windows { AXUIElementSetMessagingTimeout(window, 0.5) }
    return WindowContext(app: apps[0], element: element, windows: windows)
}
func openWindows(appID: String) throws -> [[String: Any]] {
    let context = try windowContext(appID: appID)
    if appID == finderAppID, let tabs = finderWindowList() { return tabs }
    var result: [[String: Any]] = []
    for target in try windowTargets(context) {
        guard plainWindowTitle(target.title) else { continue }
        result.append(["title": target.title, "minimized": try target.window.map { try windowAttribute($0, kAXMinimizedAttribute) as? Bool ?? false } ?? false])
    }
    return result
}
func matchingWindow(_ context: WindowContext, title: String, match: String) throws -> AXUIElement {
    guard plainWindowTitle(title), title == title.trimmingCharacters(in: .whitespacesAndNewlines), ["exact", "contains"].contains(match) else {
        throw WindowProblem(code: "INVALID_WINDOW_RULE", message: "Use a window title of 1–256 characters and an exact or contains match.")
    }
    var matches: [AXUIElement] = []
    for window in context.windows {
        guard let actual = try windowAttribute(window, kAXTitleAttribute) as? String else { continue }
        let normalized = actual.trimmingCharacters(in: .whitespacesAndNewlines)
        if match == "exact" ? normalized == title : normalized.contains(title) { matches.append(window) }
    }
    guard !matches.isEmpty else {
        throw WindowProblem(code: "WINDOW_NOT_FOUND", message: "No open window matches this title. Open the target window or edit the saved title. Nothing was launched or reconnected.")
    }
    guard matches.count == 1 else {
        throw WindowProblem(code: "WINDOW_AMBIGUOUS", message: "More than one window matches. Use a more specific title or close the duplicate; no window was selected.")
    }
    return matches[0]
}
func windowIsFocused(_ context: WindowContext, _ window: AXUIElement) throws -> Bool {
    guard try windowAttribute(window, kAXMinimizedAttribute) as? Bool != true,
          let focused = try windowAttribute(context.element, kAXFocusedWindowAttribute),
          CFGetTypeID(focused) == AXUIElementGetTypeID() else { return false }
    return CFEqual(focused, window) && NSWorkspace.shared.frontmostApplication?.processIdentifier == context.app.processIdentifier
}
func requireFocusedWindow(appID: String, title: String, match: String, path: String? = nil) throws {
    try requireWindowRule(title: title, match: match)
    if let path, appID != finderAppID || !isFolderPathRule(path) {
        throw WindowProblem(code: "INVALID_WINDOW_RULE", message: "Only Finder window keys may use a full folder path.")
    }
    let context = try windowContext(appID: appID)
    if let path { try requireFocusedFinderFolder(context, path: path); return }
    let target = try selectedWindowTarget(windowTargets(context), title: title, match: match)
    guard let window = target.window, try windowIsFocused(context, window) else {
        throw WindowProblem(code: "WINDOW_FOCUS_CHANGED", message: "The selected window is no longer focused. No shortcut was sent.")
    }
}
// T99 (ADR-089): Windows App's Window menu command that shows its Connection Center. It is matched by its fixed ⇧⌘K shortcut
// (modifier mask 1 = Shift with the implied Command), never by its localized title; Quick Connect is ⌘K and is excluded.
let windowsAppID = "com.microsoft.rdc.macos"
func isConnectionCenterItem(identifier: String?, role: String?, command: String?, modifiers: Int?, childCount: Int, enabled: Bool?) -> Bool {
    identifier != "activateSession:" && role == kAXMenuItemRole && command == "K" && modifiers == 1 && childCount == 0 && enabled == true
}
func connectionCenterItem(_ application: AXUIElement) throws -> AXUIElement? {
    guard let bar = accessibilityElement(try windowAttribute(application, kAXMenuBarAttribute)),
          let tops = try windowAttribute(bar, kAXChildrenAttribute) as? [AXUIElement] else { return nil }
    guard tops.count <= 16 else { throw WindowProblem(code: "WINDOW_LIMIT", message: "The application's window menu exceeds the supported limit.") }
    var found: [AXUIElement] = []
    for top in tops {
        guard try windowAttribute(top, kAXRoleAttribute) as? String == kAXMenuBarItemRole,
              let menus = try windowAttribute(top, kAXChildrenAttribute) as? [AXUIElement], menus.count == 1,
              let menu = menus.first, try windowAttribute(menu, kAXRoleAttribute) as? String == kAXMenuRole,
              let rows = try windowAttribute(menu, kAXChildrenAttribute) as? [AXUIElement] else { continue }
        guard rows.count <= 128 else { throw WindowProblem(code: "WINDOW_LIMIT", message: "The application's window menu exceeds the supported limit.") }
        for row in rows where try windowAttribute(row, kAXMenuItemCmdCharAttribute) as? String == "K" {
            guard try isConnectionCenterItem(identifier: windowAttribute(row, kAXIdentifierAttribute) as? String,
                    role: windowAttribute(row, kAXRoleAttribute) as? String, command: "K",
                    modifiers: windowAttribute(row, kAXMenuItemCmdModifiersAttribute) as? Int,
                    childCount: (windowAttribute(row, kAXChildrenAttribute) as? [AXUIElement] ?? []).count,
                    enabled: windowAttribute(row, kAXEnabledAttribute) as? Bool) else { continue }
            var applicationPID: pid_t = 0, itemPID: pid_t = 0
            guard AXUIElementGetPid(application, &applicationPID) == .success,
                  AXUIElementGetPid(row, &itemPID) == .success, applicationPID == itemPID else { continue }
            found.append(row)
        }
    }
    // Zero or several candidates: press nothing.
    return found.count == 1 ? found[0] : nil
}
let sessionNotConnected = "This session is not connected in Windows App. Its Connection Center is open on the Mac; connect the session there. No connection was started."
// The session is not open: show the Connection Center so the user connects it by hand. Never press a connection command.
func showConnectionCenter(_ context: WindowContext, missing: WindowProblem) throws -> [String: Any] {
    guard let item = try connectionCenterItem(context.element) else { throw missing }
    if context.app.isHidden { _ = context.app.unhide() }
    let requested = AXUIElementPerformAction(item, kAXPressAction as CFString)
    _ = AXUIElementSetAttributeValue(context.element, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    let deadline = Date().addingTimeInterval(3)
    while Date() < deadline {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == context.app.processIdentifier,
           let focused = accessibilityElement(try? windowAttribute(context.element, kAXFocusedWindowAttribute)),
           let title = (try? windowAttribute(focused, kAXTitleAttribute)) as? String,
           !((try? readSessionMenuItems(context.element)) ?? []).contains(where: { $0.title == title.trimmingCharacters(in: .whitespacesAndNewlines) }) {
            return ["ok": false, "code": "SESSION_NOT_CONNECTED", "message": sessionNotConnected]
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    throw WindowProblem(code: "WINDOW_FOCUS_UNCONFIRMED", message: "The session is not connected. Windows App's Connection Center was requested (request: \(requested.rawValue)), but it could not be confirmed in front. Check the Mac; nothing will be retried automatically.")
}
// Windows App is not running: open it (it starts on its Connection Center) and leave the session to the user.
func launchWindowsApp() throws -> [String: Any] {
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: windowsAppID) else {
        throw WindowProblem(code: "APP_UNAVAILABLE", message: "Windows App is no longer installed.")
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    var completed = false, launchFailed = false
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in launchFailed = error != nil || app == nil; completed = true }
    let deadline = Date().addingTimeInterval(6)
    while !completed && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.025)) }
    guard !launchFailed else { throw WindowProblem(code: "APP_OPEN_FAILED", message: "macOS could not open Windows App. Check the app and the signed-in desktop session.") }
    let focusDeadline = Date().addingTimeInterval(2)
    while completed && NSWorkspace.shared.frontmostApplication?.bundleIdentifier != windowsAppID && Date() < focusDeadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.025))
    }
    guard completed, NSWorkspace.shared.frontmostApplication?.bundleIdentifier == windowsAppID else {
        throw WindowProblem(code: "WINDOW_FOCUS_UNCONFIRMED", message: "The session is not connected. Opening Windows App was requested but could not be confirmed. Check the Mac; nothing will be retried automatically.")
    }
    return ["ok": false, "code": "SESSION_NOT_CONNECTED", "message": "Windows App was not running and is now open. Connect the session from its Connection Center. No connection was started."]
}
func activateWindow(appID: String, title: String, match: String, path: String? = nil) throws -> [String: Any] {
    if appID == finderAppID, let result = try activateFinder(title: title, match: match, path: path) { return result }
    if path != nil { throw WindowProblem(code: "INVALID_WINDOW_RULE", message: "Only Finder window keys have a folder path.") }
    let context: WindowContext, target: WindowTarget
    do { context = try windowContext(appID: appID) }
    catch let problem as WindowProblem where problem.code == "APP_NOT_RUNNING" && appID == windowsAppID {
        try requireWindowRule(title: title, match: match)
        return try launchWindowsApp()
    }
    do { target = try selectedWindowTarget(windowTargets(context), title: title, match: match) }
    catch let problem as WindowProblem where problem.code == "WINDOW_NOT_FOUND" && context.app.bundleIdentifier == windowsAppID {
        return try showConnectionCenter(context, missing: problem)
    }
    var needsSessionActivation = false, requested: AXError = .success
    if let window = target.window, target.sessionItem == nil {
        if try windowAttribute(window, kAXMinimizedAttribute) as? Bool == true {
            let restore = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
            guard restore == .success || restore == .cannotComplete else {
                throw WindowProblem(code: "WINDOW_RESTORE_FAILED", message: "macOS could not restore the selected minimized window.")
            }
            let restoreDeadline = Date().addingTimeInterval(2)
            var restored = false
            while Date() < restoreDeadline {
                RunLoop.current.run(until: Date().addingTimeInterval(0.025))
                // AXWindows may temporarily lose the restored window while macOS changes Spaces.
                if (try? windowAttribute(window, kAXMinimizedAttribute) as? Bool) == false { restored = true; break }
            }
            if !restored {
                throw WindowProblem(code: "WINDOW_FOCUS_UNCONFIRMED", message: "Restoring the selected window was requested but could not be confirmed. Check the Mac; nothing will be retried automatically.")
            }
        }
        // Apps vary in which attributes they allow setting. Success is based on observed focus.
        _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        _ = AXUIElementSetAttributeValue(context.element, kAXFocusedWindowAttribute as CFString, window)
        if context.app.isHidden { _ = context.app.unhide() }
        _ = AXUIElementSetAttributeValue(context.element, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        requested = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    } else if let item = target.sessionItem {
        try windowPreflight()
        guard try isSessionWindowItem(identifier: windowAttribute(item, kAXIdentifierAttribute) as? String,
                role: windowAttribute(item, kAXRoleAttribute) as? String,
                command: windowAttribute(item, kAXMenuItemCmdCharAttribute) as? String,
                childCount: (windowAttribute(item, kAXChildrenAttribute) as? [AXUIElement] ?? []).count,
                title: windowAttribute(item, kAXTitleAttribute) as? String),
              (try windowAttribute(item, kAXTitleAttribute) as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) == target.title,
              try windowAttribute(item, kAXEnabledAttribute) as? Bool == true,
              context.app.bundleIdentifier == "com.microsoft.rdc.macos" else {
            throw WindowProblem(code: "WINDOW_UNAVAILABLE", message: "The existing session window menu changed or is disabled. No menu action was sent.")
        }
        requested = AXUIElementPerformAction(item, kAXPressAction as CFString)
        needsSessionActivation = true
    }
    let deadline = Date().addingTimeInterval(4)
    while Date() < deadline {
        do {
            let current = try windowContext(appID: appID)
            let selected = try matchingWindow(current, title: title, match: match)
            if needsSessionActivation {
                // Request application foreground only after the chosen session exposes its
                // actual window. Never activate the last unrelated remote window as a fallback.
                _ = AXUIElementSetAttributeValue(current.element, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
                needsSessionActivation = false
            }
            if try windowIsFocused(current, selected) {
                let unique = try selectedWindowTarget(windowTargets(current), title: title, match: match)
                if let actual = unique.window, CFEqual(actual, selected), try windowIsFocused(current, selected) {
                    return ["ok": true, "message": "The selected window is active and its foreground focus was confirmed."]
                }
            }
        } catch let problem as WindowProblem {
            // Only observe during transitions; never raise, restore or send the action again.
            if !["WINDOW_UNAVAILABLE", "WINDOW_NOT_FOUND"].contains(problem.code) { break }
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.025))
    }
    throw WindowProblem(code: "WINDOW_FOCUS_UNCONFIRMED", message: "Window activation was requested, but its foreground focus could not be confirmed (request: \(requested.rawValue)). Check the Mac desktop or full-screen Space; nothing will be retried automatically.")
}
