import AppKit
import Foundation

func emit(_ value: Any, exitCode: Int32 = 0) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(exitCode)
}
func fail(_ code: String, _ message: String) -> Never {
    emit(["ok": false, "code": code, "message": message], exitCode: 1)
}
func listApps() -> Never {
    // Safari's /Applications link can be hidden; enumerate its system app root too.
    emit(installedApplicationCatalog(roots: installedApplicationRoots()))
}
let args = CommandLine.arguments
if args.count == 2 && args[1] == "observe-app-activation" { observeAppActivations() }
if args.count == 2 && args[1] == "observe-running-apps" { observeRunningApps() }
if args.count == 2 && args[1] == "running-apps" { printRunningApps() }
if args.count >= 2 && args[1] == "icons" {
    do { emit(["icons": try applicationIcons(appIDs: Array(args.dropFirst(2)))]) }
    catch let problem as AppIconProblem { fail(problem.code, problem.message) }
    catch { fail("ICON_UNAVAILABLE", "The Mac could not prepare these icons.") }
}
if args.count == 3 && args[1] == "icon" {
    do { emit(["png": try applicationIcon(appID: args[2]).base64EncodedString()]) }
    catch let problem as AppIconProblem { fail(problem.code, problem.message) }
    catch { fail("ICON_UNAVAILABLE", "The Mac could not prepare this icon.") }
}
if args.count >= 2 && ["windows", "window-activate", "shortcut-window"].contains(args[1]) {
    do {
        if args.count == 3 && args[1] == "windows" { emit(try openWindows(appID: args[2])) }
        if (args.count == 5 || args.count == 6) && args[1] == "window-activate" {
            emit(try activateWindow(appID: args[2], title: args[4], match: args[3], path: args.count == 6 ? args[5] : nil))
        }
        if (args.count == 7 || args.count == 8) && args[1] == "shortcut-window" {
            let keyIndex = args.count - 2, path = args.count == 8 ? args[5] : nil
            try sendShortcut(key: args[keyIndex], modifiers: args[keyIndex + 1].isEmpty ? [] : args[keyIndex + 1].components(separatedBy: ","), expectedAppID: args[2],
                validateWindow: { try requireFocusedWindow(appID: args[2], title: args[4], match: args[3], path: path) })
            emit(["ok": true, "message": "Shortcut sent after verifying the selected foreground window. This does not verify the application's result."])
        }
        fail("INVALID_ACTION", "Invalid window command.")
    } catch let problem as WindowProblem { fail(problem.code, problem.message) }
    catch let problem as KeyboardProblem { fail(problem.code, problem.message) }
    catch { fail("WINDOW_FAILED", "The Mac could not complete the window action.") }
}
if args.count == 2 && args[1] == "list" { listApps() }
if args.count == 2 && args[1] == "doctor" { emit(keyboardDiagnostics()) }
if args.count == 2 && args[1] == "probe-shortcuts" {
    do { emit(try probeShortcuts()) }
    catch let problem as KeyboardProblem { fail(problem.code, problem.message) }
    catch { fail("PROBE_FAILED", "Keyboard probe failed. Delivery is not verified.") }
}
if args.count == 4 && args[1] == "shortcut" || args.count == 5 && args[1] == "shortcut-target" {
    let targeted = args[1] == "shortcut-target"
    let offset = targeted ? 1 : 0
    if targeted && args[2].range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$", options: .regularExpression) == nil { fail("INVALID_APP", "Invalid workflow keyboard target.") }
    let modifiers = args[3 + offset].isEmpty ? [] : args[3 + offset].components(separatedBy: ",")
    do {
        try sendShortcut(key: args[2 + offset], modifiers: modifiers, expectedAppID: targeted ? args[2] : nil)
        emit(["ok": true, "message": "Shortcut key-down and key-up were posted to the current foreground application. This does not confirm its internal action succeeded."])
    } catch let problem as KeyboardProblem { fail(problem.code, problem.message) }
    catch { fail("SHORTCUT_FAILED", "The shortcut could not be sent.") }
}
guard args.count == 3 && args[1] == "open" else { fail("INVALID_ACTION", "Expected list, doctor, probe-shortcuts, open <app>, or shortcut <key> <modifiers>.") }
let id = args[2]
guard id.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$", options: .regularExpression) != nil else {
    fail("INVALID_APP", "Invalid application identifier.")
}
guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) else {
    fail("APP_UNAVAILABLE", "The application is no longer installed. Choose another app and save.")
}
let configuration = NSWorkspace.OpenConfiguration()
configuration.activates = true
var completed = false
var launchFailed = false
NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
    launchFailed = error != nil || app == nil
    completed = true
}
let launchDeadline = Date().addingTimeInterval(6)
while !completed && Date() < launchDeadline { RunLoop.current.run(until: Date().addingTimeInterval(0.025)) }
guard completed else { fail("LAUNCH_UNCONFIRMED", "The application did not confirm opening in time. Check the Mac.") }
guard !launchFailed else { fail("APP_OPEN_FAILED", "macOS could not open the application. Check the app and the signed-in desktop session.") }
let focusDeadline = Date().addingTimeInterval(2)
while NSWorkspace.shared.frontmostApplication?.bundleIdentifier != id && Date() < focusDeadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.025))
}
guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == id else {
    fail("FOCUS_UNCONFIRMED", "The application opened, but foreground activation was not confirmed. Check the Mac desktop.")
}
emit(["ok": true, "message": "Application opened and foreground activation confirmed. This does not verify its window contents."])
