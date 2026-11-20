import AppKit
import ApplicationServices

// T100 (ADR-090): Finder through its scripting interface. There every Finder tab is a "Finder window" with the folder it shows, so background
// tabs and folder paths are visible; Accessibility only sees the front tab of each window and no paths. The script below is fixed: titles,
// paths and indexes are passed as Apple Event parameters, never spliced into its source.
let finderAppID = "com.apple.finder"
struct FinderTab { let index: Int; let title: String; let path: String; let minimized: Bool }

private let finderScriptSource = """
on findertabs()
	set out to {}
	with timeout of 3 seconds
		tell application "Finder"
			repeat with i from 1 to (count of Finder windows)
				set t to ""
				set p to ""
				set c to false
				try
					set t to name of Finder window i
				end try
				try
					set p to POSIX path of (target of Finder window i as alias)
				end try
				try
					set c to collapsed of Finder window i
				end try
				set end of out to {t, p, c}
			end repeat
		end tell
	end timeout
	return out
end findertabs
on selecttab(i, t, p)
	considering case
		with timeout of 3 seconds
			tell application "Finder"
				set w to Finder window (i as integer)
				if name of w is not t then return false
				if p is not "" and POSIX path of (target of w as alias) is not p then return false
				try
					if collapsed of w then set collapsed of w to false
				end try
				set index of w to 1
				activate
			end tell
		end timeout
	end considering
	return true
end selecttab
on openfolder(p)
	with timeout of 3 seconds
		tell application "Finder"
			open (POSIX file p as alias)
			activate
		end tell
	end timeout
	return true
end openfolder
"""
private func fourCharCode(_ text: String) -> UInt32 { text.utf8.reduce(0) { $0 << 8 | UInt32($1) } }
private var finderScript: NSAppleScript?
func finderProblem(_ number: Int) -> WindowProblem {
    switch number {
    case -1743: return WindowProblem(code: "FINDER_AUTOMATION_REQUIRED", message: "Allow Keyln to control Finder on the Mac (System Settings › Privacy & Security › Automation), then try again. Nothing was switched or opened.")
    case -1712: return WindowProblem(code: "FINDER_UNRESPONSIVE", message: "Finder did not answer in time, or a permission prompt is waiting on the Mac. Check the Mac, then try again.")
    default: return WindowProblem(code: "FINDER_UNAVAILABLE", message: "Finder could not be read (Apple Event error \(number)). Nothing was switched or opened.")
    }
}
private func callFinder(_ handler: String, _ arguments: [NSAppleEventDescriptor]) throws -> NSAppleEventDescriptor {
    if finderScript == nil {
        guard let script = NSAppleScript(source: finderScriptSource) else { throw finderProblem(0) }
        var error: NSDictionary?
        guard script.compileAndReturnError(&error) else { throw finderProblem((error?[NSAppleScript.errorNumber] as? Int) ?? 0) }
        finderScript = script
    }
    let event = NSAppleEventDescriptor.appleEvent(withEventClass: fourCharCode("ascr"), eventID: fourCharCode("psbr"),
        targetDescriptor: NSAppleEventDescriptor.currentProcess(), returnID: -1, transactionID: 0)
    event.setParam(NSAppleEventDescriptor(string: handler), forKeyword: fourCharCode("snam"))
    let list = NSAppleEventDescriptor.list()
    for (offset, argument) in arguments.enumerated() { list.insert(argument, at: offset + 1) }
    event.setParam(list, forKeyword: fourCharCode("----"))
    var error: NSDictionary?
    let result = finderScript!.executeAppleEvent(event, error: &error)
    if let error { throw finderProblem((error[NSAppleScript.errorNumber] as? Int) ?? 0) }
    return result
}
func finderTabs() throws -> [FinderTab] {
    let list = try callFinder("findertabs", [])
    guard list.numberOfItems <= maximumWindowCount else { throw WindowProblem(code: "WINDOW_LIMIT", message: "Finder has more than 64 windows and tabs. Close some before using this action.") }
    var tabs: [FinderTab] = []
    if list.numberOfItems > 0 {
        for index in 1...list.numberOfItems {
            guard let row = list.atIndex(index), row.numberOfItems == 3 else { continue }
            tabs.append(FinderTab(index: index, title: (row.atIndex(1)?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
                path: row.atIndex(2)?.stringValue ?? "", minimized: row.atIndex(3)?.booleanValue ?? false))
        }
    }
    return tabs
}
// Finder reports folders with a trailing slash; keys store them without one. Two paths name the same folder when they agree after this and symlinks.
func trimmedFolderPath(_ path: String) -> String {
    var value = path
    while value.count > 1 && value.hasSuffix("/") { value.removeLast() }
    return value
}
func folderKey(_ path: String) -> String { path.isEmpty ? "" : URL(fileURLWithPath: trimmedFolderPath(path)).resolvingSymlinksInPath().path }
func isFolderPathRule(_ path: String) -> Bool {
    path.hasPrefix("/") && path.utf16.count <= 1024 && !path.unicodeScalars.contains { $0.value < 32 || $0.value == 127 } &&
        (path == "/" || !path.hasSuffix("/") && !path.contains("//") && !path.split(separator: "/").contains { $0 == "." || $0 == ".." })
}
// The tab a rule means, front-most first. With a folder, the tabs that show it (the same folder open twice is still that folder).
// Without one, the title rule as before; tabs of different folders with a matching title are ambiguous. Nil: no tab shows it.
func selectFinderTab(_ tabs: [FinderTab], title: String, match: String, path: String?, key: (String) -> String = folderKey) throws -> FinderTab? {
    if let path {
        let wanted = key(path)
        return tabs.first { !$0.path.isEmpty && key($0.path) == wanted }
    }
    let matches = tabs.filter { plainWindowTitle($0.title) && (match == "exact" ? $0.title == title : $0.title.contains(title)) }
    guard let first = matches.first else { return nil }
    let folders = Set(matches.map { key($0.path) })
    guard folders.count == 1, !folders.contains("") || matches.count == 1 else {
        throw WindowProblem(code: "WINDOW_AMBIGUOUS", message: "More than one Finder tab matches. Use a more specific title or read Finder windows again to save the folder; no tab was selected.")
    }
    return first
}
private func confirmFinderFront(folder: String?, title: String, success: String) throws -> [String: Any] {
    let deadline = Date().addingTimeInterval(3)
    while Date() < deadline {
        if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == finderAppID, let front = try? finderTabs().first,
           folder.map({ !front.path.isEmpty && folderKey(front.path) == $0 }) ?? (front.title == title) {
            return ["ok": true, "message": success]
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    throw WindowProblem(code: "WINDOW_FOCUS_UNCONFIRMED", message: "Finder was asked to show the folder, but it could not be confirmed in front. Check the Mac; nothing will be retried automatically.")
}
// A workflow checks the same folder again immediately before sending a key, without selecting a tab or changing focus.
func finderFolderIsFocused(frontmost: Bool, focusedTitle: String?, tab: FinderTab?, path: String, key: (String) -> String = folderKey) -> Bool {
    guard frontmost, let tab, !tab.minimized, !tab.path.isEmpty, let focusedTitle,
          focusedTitle.trimmingCharacters(in: .whitespacesAndNewlines) == tab.title else { return false }
    return key(tab.path) == key(path)
}
func requireFocusedFinderFolder(_ context: WindowContext, path: String) throws {
    let focused = accessibilityElement(try windowAttribute(context.element, kAXFocusedWindowAttribute))
    let title = try focused.flatMap { try windowAttribute($0, kAXTitleAttribute) as? String }
    let frontmost = try focused.map { try windowIsFocused(context, $0) } ?? false
    let front = try finderTabs().first
    guard finderFolderIsFocused(frontmost: frontmost, focusedTitle: title, tab: front, path: path) else {
        throw WindowProblem(code: "WINDOW_FOCUS_CHANGED", message: "The selected Finder folder is no longer focused. No shortcut was sent.")
    }
}
// Switch to the Finder tab of the key, or open its folder when no tab shows it. Nil: Finder cannot be scripted and the key has no folder,
// so the caller keeps the Accessibility path of every other app (front tabs only).
func activateFinder(title: String, match: String, path: String?) throws -> [String: Any]? {
    try requireWindowRule(title: title, match: match)
    if let path, !isFolderPathRule(path) { throw WindowProblem(code: "INVALID_WINDOW_RULE", message: "Use a full folder path for this Finder key.") }
    try windowPreflight()
    let tabs: [FinderTab]
    do { tabs = try finderTabs() }
    catch let problem as WindowProblem where path == nil && ["FINDER_AUTOMATION_REQUIRED", "FINDER_UNAVAILABLE"].contains(problem.code) { return nil }
    if let tab = try selectFinderTab(tabs, title: title, match: match, path: path) {
        let selected = try callFinder("selecttab", [NSAppleEventDescriptor(int32: Int32(tab.index)), NSAppleEventDescriptor(string: tab.title), NSAppleEventDescriptor(string: tab.path)])
        guard selected.booleanValue else { throw WindowProblem(code: "WINDOW_FOCUS_CHANGED", message: "Finder's windows changed while switching. No tab was selected; try again.") }
        return try confirmFinderFront(folder: tab.path.isEmpty ? nil : folderKey(tab.path), title: tab.title, success: "The Finder tab is active and its foreground focus was confirmed.")
    }
    guard let path else {
        throw WindowProblem(code: "WINDOW_NOT_FOUND", message: "No Finder tab matches this title. Read Finder windows in the key's settings to save its folder, so Keyln can open it next time. Nothing was opened.")
    }
    // Only an existing plain folder is opened, never an app, a package or a file.
    let url = URL(fileURLWithPath: path).resolvingSymlinksInPath()
    var directory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: url.path, isDirectory: &directory), directory.boolValue,
          (try? url.resourceValues(forKeys: [.isPackageKey]).isPackage) != true else {
        throw WindowProblem(code: "FOLDER_UNAVAILABLE", message: "The saved folder no longer exists or is not a folder. Read Finder windows again or edit the folder. Nothing was opened.")
    }
    _ = try callFinder("openfolder", [NSAppleEventDescriptor(string: url.path)])
    return try confirmFinderFront(folder: url.path, title: title, success: "The folder was opened in Finder and its foreground focus was confirmed.")
}
// Finder windows and tabs with their folders for the window picker. Nil: Finder cannot be scripted; the picker gets the Accessibility list.
func finderWindowList() -> [[String: Any]]? {
    guard let tabs = try? finderTabs() else { return nil }
    return tabs.filter { plainWindowTitle($0.title) }.map { tab in
        var row: [String: Any] = ["title": tab.title, "minimized": tab.minimized]
        let folder = trimmedFolderPath(tab.path)
        if !tab.path.isEmpty && isFolderPathRule(folder) { row["path"] = folder }
        return row
    }
}
