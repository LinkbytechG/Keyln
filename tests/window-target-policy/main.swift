// Pure production selection policy; no window/menu mutations or desktop permission required.
import AppKit
import ApplicationServices

var checks: [String: Bool] = [:]
func item(_ identifier: String? = "activateSession:", role: String? = kAXMenuItemRole, command: String? = nil, children: Int = 0, title: String? = "Session A") -> Bool {
    isSessionWindowItem(identifier: identifier, role: role, command: command, childCount: children, title: title)
}
func rejects(_ code: String, _ operation: () throws -> Void) -> Bool {
    do { try operation(); return false } catch let problem as WindowProblem { return problem.code == code } catch { return false }
}
checks["nilShortcutIsNotACommand"] = item() && item(command: "")
checks["connectionAndOrdinaryCommandsExcluded"] = !item("connectSession:") && !item("activateSession:", command: "k") && !item(nil)
checks["submenusAndWrongRolesExcluded"] = !item(children: 1) && !item(role: kAXButtonRole)
checks["invalidTitlesExcluded"] = !item(title: "") && !item(title: "bad\nname") && !item(title: String(repeating: "a", count: 257))
// T99: the Connection Center command is the one ⇧⌘K leaf; Quick Connect (⌘K), sessions, submenus and disabled items are not.
func center(identifier: String? = "_NS:279", role: String? = kAXMenuItemRole, command: String? = "K", modifiers: Int? = 1, children: Int = 0, enabled: Bool? = true) -> Bool {
    isConnectionCenterItem(identifier: identifier, role: role, command: command, modifiers: modifiers, childCount: children, enabled: enabled)
}
checks["connectionCenterMatchedByShortcut"] = center() && center(identifier: nil)
checks["quickConnectAndOtherKeysExcluded"] = !center(modifiers: 0) && !center(command: "k") && !center(command: "J") && !center(modifiers: nil)
checks["connectionCenterNeverASessionSubmenuOrDisabled"] = !center(identifier: "activateSession:") && !center(children: 1) && !center(role: kAXButtonRole) && !center(enabled: false) && !center(enabled: nil)
checks["ruleCheckedBeforeLaunch"] = rejects("INVALID_WINDOW_RULE") { try requireWindowRule(title: " padded", match: "exact") } && (try? requireWindowRule(title: "Session A", match: "contains")) != nil
// T100: Finder tabs are chosen by folder when the key has one, else by title; different folders with one title are ambiguous.
let tabs = [FinderTab(index: 1, title: "Docs", path: "/a/Docs/", minimized: false), FinderTab(index: 2, title: "Keyln", path: "/b/Keyln/", minimized: false),
            FinderTab(index: 3, title: "Docs", path: "/c/Docs/", minimized: false), FinderTab(index: 4, title: "Keyln", path: "/b/Keyln/", minimized: false)]
let plain: (String) -> String = trimmedFolderPath
let frontFolder = FinderTab(index: 1, title: "Reports", path: "/a/Reports/", minimized: false)
checks["finderShortcutKeepsFolderIdentity"] = finderFolderIsFocused(frontmost: true, focusedTitle: "Reports", tab: frontFolder, path: "/a/Reports", key: plain)
checks["finderShortcutRejectsSameTitleOtherFolder"] = !finderFolderIsFocused(frontmost: true, focusedTitle: "Reports", tab: frontFolder, path: "/b/Reports", key: plain)
checks["finderShortcutRejectsOtherFrontApp"] = !finderFolderIsFocused(frontmost: false, focusedTitle: "Reports", tab: frontFolder, path: "/a/Reports", key: plain)
checks["finderShortcutRejectsOtherFocusedWindow"] = !finderFolderIsFocused(frontmost: true, focusedTitle: "Reports Info", tab: frontFolder, path: "/a/Reports", key: plain)
checks["finderShortcutRejectsMissingTab"] = !finderFolderIsFocused(frontmost: true, focusedTitle: "Reports", tab: nil, path: "/a/Reports", key: plain)
checks["finderShortcutRejectsMinimizedTab"] = !finderFolderIsFocused(frontmost: true, focusedTitle: "Reports", tab: FinderTab(index: 1, title: "Reports", path: "/a/Reports", minimized: true), path: "/a/Reports", key: plain)
checks["finderFolderWinsOverTitle"] = (try? selectFinderTab(tabs, title: "Docs", match: "exact", path: "/c/Docs", key: plain))??.index == 3
checks["finderFolderNotOpenIsNil"] = { do { return try selectFinderTab(tabs, title: "Keyln", match: "exact", path: "/z/Keyln", key: plain) == nil } catch { return false } }()
checks["finderSameFolderTwiceTakesFrontTab"] = (try? selectFinderTab(tabs, title: "Keyln", match: "exact", path: nil, key: plain))??.index == 2
checks["finderTitleOfTwoFoldersAmbiguous"] = rejects("WINDOW_AMBIGUOUS") { _ = try selectFinderTab(tabs, title: "Docs", match: "exact", path: nil, key: plain) }
checks["finderFolderRulesStrict"] = isFolderPathRule("/Users/me/功課") && isFolderPathRule("/") && !isFolderPathRule("Users/me") && !isFolderPathRule("/a/") &&
    !isFolderPathRule("/a//b") && !isFolderPathRule("/a/../b") && !isFolderPathRule("/a/./b") && !isFolderPathRule("/a\nb") && trimmedFolderPath("/a/b/") == "/a/b" && trimmedFolderPath("/") == "/"
let object = AXUIElementCreateApplication(getpid())
let a = WindowTarget(title: "Session A", window: object, sessionItem: nil)
let am = WindowTarget(title: "Session A", window: nil, sessionItem: object)
let bm = WindowTarget(title: "Session B", window: nil, sessionItem: object)
do {
    let merged = try mergeWindowTargets([a], [am, bm])
    checks["hiddenSessionIncludedCurrentDeduplicated"] = merged.count == 2 && Set(merged.map { $0.title }) == ["Session A", "Session B"]
    let current = try selectedWindowTarget(merged, title: "Session A", match: "exact")
    checks["currentRetainsBothSources"] = current.window != nil && current.sessionItem != nil
    let hidden = try selectedWindowTarget(merged, title: "Session B", match: "exact")
    checks["hiddenIsExplicitSessionTarget"] = hidden.window == nil && hidden.sessionItem != nil
    checks["broadContainsRejected"] = rejects("WINDOW_AMBIGUOUS") { _ = try selectedWindowTarget(merged, title: "Session", match: "contains") }
    checks["missingRejected"] = rejects("WINDOW_NOT_FOUND") { _ = try selectedWindowTarget(merged, title: "Missing", match: "exact") }
    checks["duplicateMenuTitlesNotCollapsed"] = rejects("WINDOW_AMBIGUOUS") { _ = try selectedWindowTarget(mergeWindowTargets([a], [am, am]), title: "Session A", match: "exact") }
    checks["duplicateAXTitlesNotCollapsed"] = rejects("WINDOW_AMBIGUOUS") { _ = try selectedWindowTarget(mergeWindowTargets([a, a], [am]), title: "Session A", match: "exact") }
    checks["limitEnforced"] = rejects("WINDOW_LIMIT") { _ = try mergeWindowTargets([], (0...64).map { WindowTarget(title: "Session \($0)", window: nil, sessionItem: object) }) }
    checks["invalidRulesRejected"] = rejects("INVALID_WINDOW_RULE") { _ = try selectedWindowTarget(merged, title: "Session", match: "regex") }
} catch { checks["unexpectedError"] = false }
let passed = checks.values.allSatisfy { $0 }
print(String(data: try JSONSerialization.data(withJSONObject: ["ok": passed, "checks": checks], options: [.sortedKeys]), encoding: .utf8)!)
exit(passed ? 0 : 1)
