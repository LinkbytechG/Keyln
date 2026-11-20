import AppKit
import ApplicationServices
import Carbon

// Physical ANSI key positions. The underlying keyboard layout must be ABC/US.
let shortcutKeyCodes: [String: CGKeyCode] = Dictionary(uniqueKeysWithValues: [
    ("KeyA", kVK_ANSI_A), ("KeyB", kVK_ANSI_B), ("KeyC", kVK_ANSI_C), ("KeyD", kVK_ANSI_D),
    ("KeyE", kVK_ANSI_E), ("KeyF", kVK_ANSI_F), ("KeyG", kVK_ANSI_G), ("KeyH", kVK_ANSI_H),
    ("KeyI", kVK_ANSI_I), ("KeyJ", kVK_ANSI_J), ("KeyK", kVK_ANSI_K), ("KeyL", kVK_ANSI_L),
    ("KeyM", kVK_ANSI_M), ("KeyN", kVK_ANSI_N), ("KeyO", kVK_ANSI_O), ("KeyP", kVK_ANSI_P),
    ("KeyQ", kVK_ANSI_Q), ("KeyR", kVK_ANSI_R), ("KeyS", kVK_ANSI_S), ("KeyT", kVK_ANSI_T),
    ("KeyU", kVK_ANSI_U), ("KeyV", kVK_ANSI_V), ("KeyW", kVK_ANSI_W), ("KeyX", kVK_ANSI_X),
    ("KeyY", kVK_ANSI_Y), ("KeyZ", kVK_ANSI_Z),
    ("Digit0", kVK_ANSI_0), ("Digit1", kVK_ANSI_1), ("Digit2", kVK_ANSI_2), ("Digit3", kVK_ANSI_3),
    ("Digit4", kVK_ANSI_4), ("Digit5", kVK_ANSI_5), ("Digit6", kVK_ANSI_6), ("Digit7", kVK_ANSI_7),
    ("Digit8", kVK_ANSI_8), ("Digit9", kVK_ANSI_9),
    ("Enter", kVK_Return), ("Tab", kVK_Tab), ("Space", kVK_Space), ("Backspace", kVK_Delete),
    ("Escape", kVK_Escape), ("Delete", kVK_ForwardDelete), ("Home", kVK_Home), ("End", kVK_End),
    ("PageUp", kVK_PageUp), ("PageDown", kVK_PageDown),
    ("ArrowLeft", kVK_LeftArrow), ("ArrowRight", kVK_RightArrow), ("ArrowUp", kVK_UpArrow), ("ArrowDown", kVK_DownArrow),
    ("Minus", kVK_ANSI_Minus), ("Equal", kVK_ANSI_Equal), ("BracketLeft", kVK_ANSI_LeftBracket),
    ("BracketRight", kVK_ANSI_RightBracket), ("Backslash", kVK_ANSI_Backslash), ("Semicolon", kVK_ANSI_Semicolon),
    ("Quote", kVK_ANSI_Quote), ("Backquote", kVK_ANSI_Grave), ("Comma", kVK_ANSI_Comma),
    ("Period", kVK_ANSI_Period), ("Slash", kVK_ANSI_Slash),
    ("F1", kVK_F1), ("F2", kVK_F2), ("F3", kVK_F3), ("F4", kVK_F4), ("F5", kVK_F5), ("F6", kVK_F6),
    ("F7", kVK_F7), ("F8", kVK_F8), ("F9", kVK_F9), ("F10", kVK_F10), ("F11", kVK_F11), ("F12", kVK_F12)
].map { ($0.0, CGKeyCode($0.1)) })

let shortcutFlags: [String: CGEventFlags] = ["command": .maskCommand, "option": .maskAlternate, "control": .maskControl, "shift": .maskShift]
let shortcutModifierMask: CGEventFlags = [.maskCommand, .maskAlternate, .maskControl, .maskShift]
let keylnEventTag: Int64 = 0x4b45594c4e
struct KeyboardProblem: Error { let code: String; let message: String }

func currentInputSourceID(layoutOnly: Bool = false) -> String {
    let copied = layoutOnly ? TISCopyCurrentKeyboardLayoutInputSource() : TISCopyCurrentKeyboardInputSource()
    guard let source = copied?.takeRetainedValue(),
          let property = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else { return "unknown" }
    return Unmanaged<CFString>.fromOpaque(property).takeUnretainedValue() as String
}
func keyboardDiagnostics() -> [String: Any] {
    let source = currentInputSourceID()
    let layout = currentInputSourceID(layoutOnly: true)
    let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
    return [
        "helperPath": URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.path,
        "accessibilityTrusted": AXIsProcessTrusted(),
        "eventPostingAllowed": CGPreflightPostEventAccess(),
        "inputSourceID": source,
        "keyboardLayoutID": layout,
        "layoutSupported": ["com.apple.keylayout.ABC", "com.apple.keylayout.US"].contains(layout),
        "secureInputEnabled": IsSecureEventInputEnabled(),
        "sessionOnConsole": session[kCGSessionOnConsoleKey as String] as? Bool ?? false,
        "sessionLoggedIn": session[kCGSessionLoginDoneKey as String] as? Bool ?? false,
        "supportedKeys": shortcutKeyCodes.keys.sorted()
    ]
}
func shortcutPreflight() throws {
    let diagnostics = keyboardDiagnostics()
    guard diagnostics["accessibilityTrusted"] as? Bool == true,
          diagnostics["eventPostingAllowed"] as? Bool == true else {
        throw KeyboardProblem(code: "ACCESSIBILITY_REQUIRED", message: "Enable Accessibility for the Keyln helper or its responsible Mac launcher, then restart Host and run npm run doctor. No keys were sent.")
    }
    guard diagnostics["sessionOnConsole"] as? Bool == true, diagnostics["sessionLoggedIn"] as? Bool == true else {
        throw KeyboardProblem(code: "SESSION_UNAVAILABLE", message: "Use the unlocked, signed-in Mac desktop. No keys were sent.")
    }
    guard diagnostics["secureInputEnabled"] as? Bool == false else {
        throw KeyboardProblem(code: "SECURE_INPUT", message: "Secure keyboard input is active. Leave password fields or secure-input mode before using this shortcut. No keys were sent.")
    }
    guard diagnostics["layoutSupported"] as? Bool == true else {
        throw KeyboardProblem(code: "LAYOUT_UNSUPPORTED", message: "This prototype supports an ABC or U.S. underlying keyboard layout. Other layouts are not yet verified. No keys were sent.")
    }
}
func sendShortcut(key: String, modifiers: [String], expectedPID: pid_t? = nil, expectedAppID: String? = nil, validateWindow: (() throws -> Void)? = nil) throws {
    guard let keyCode = shortcutKeyCodes[key], modifiers.count <= 4,
          Set(modifiers).count == modifiers.count, modifiers.allSatisfy({ shortcutFlags[$0] != nil }) else {
        throw KeyboardProblem(code: "INVALID_SHORTCUT", message: "Choose one supported key and unique Command/Option/Control/Shift modifiers.")
    }
    try shortcutPreflight()
    guard let target = NSWorkspace.shared.frontmostApplication,
          target.bundleIdentifier != "com.apple.loginwindow",
          (expectedPID == nil || target.processIdentifier == expectedPID),
          (expectedAppID == nil || target.bundleIdentifier == expectedAppID) else {
        throw KeyboardProblem(code: "FOCUS_UNAVAILABLE", message: "The expected Mac foreground application is unavailable. No keys were sent.")
    }
    guard CGEventSource.flagsState(.hidSystemState).intersection(shortcutModifierMask).isEmpty,
          !CGEventSource.keyState(.hidSystemState, key: keyCode) else {
        throw KeyboardProblem(code: "KEYBOARD_BUSY", message: "Release the physical modifier keys and target key on the Mac before using this button. No keys were sent.")
    }
    guard let source = CGEventSource(stateID: .privateState),
          let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) else {
        throw KeyboardProblem(code: "EVENT_CREATION_FAILED", message: "macOS could not create the keyboard events. No keys were sent.")
    }
    down.flags = modifiers.reduce(CGEventFlags()) { $0.union(shortcutFlags[$1]!) }
    up.flags = []
    down.setIntegerValueField(.eventSourceUserData, value: keylnEventTag)
    up.setIntegerValueField(.eventSourceUserData, value: keylnEventTag)
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == target.processIdentifier else {
        throw KeyboardProblem(code: "FOCUS_CHANGED", message: "The Mac foreground application changed before sending. No keys were sent.")
    }
    try validateWindow?()
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == target.processIdentifier else {
        throw KeyboardProblem(code: "FOCUS_CHANGED", message: "The Mac foreground application changed during the final focus check. No keys were sent.")
    }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    // Short-lived senders must survive the queued post; this is not an application acknowledgment.
    withExtendedLifetime((source, down, up)) {
        Thread.sleep(forTimeInterval: 0.05)
    }
}

// Explicit manual probe: a local event monitor observes only this test window.
// Production shortcut execution never opens this window or changes app focus.
func probeShortcuts() throws -> [String: Any] {
    try shortcutPreflight()
    let previousApp = NSWorkspace.shared.frontmostApplication
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    app.finishLaunching()
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 160),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "Keyln Keyboard Test"
    window.isReleasedWhenClosed = false
    let label = NSTextField(wrappingLabelWithString: "Testing six safe K-key combinations inside this window.\nKeep this window in front; no text, documents or clipboard are changed.")
    label.stringValue = "Click this window if it is not foreground. Testing starts only here.\nSix safe K-key combinations; no documents or clipboard are changed."
    label.frame = NSRect(x: 24, y: 30, width: 472, height: 90)
    window.contentView?.addSubview(label)
    var observations: [(NSEvent.EventType, UInt64)] = []
    let monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp]) { event in
        if event.keyCode == shortcutKeyCodes["KeyK"], event.cgEvent?.getIntegerValueField(.eventSourceUserData) == keylnEventTag {
            observations.append((event.type, UInt64(event.modifierFlags.rawValue) & shortcutModifierMask.rawValue))
        }
        return nil
    }
    defer {
        if let monitor { NSEvent.removeMonitor(monitor) }
        let stillInProbe = NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier
        window.close()
        if stillInProbe { previousApp?.activate(options: []) }
    }
    func pump() {
        if let event = app.nextEvent(matching: .any, until: Date().addingTimeInterval(0.01), inMode: .default, dequeue: true) { app.sendEvent(event) }
        app.updateWindows()
    }
    window.center(); window.makeKeyAndOrderFront(nil); app.activate()
    FileHandle.standardError.write(Data("Bring Keyln Keyboard Test to foreground if needed; waiting up to 8 seconds.\n".utf8))
    let pid = ProcessInfo.processInfo.processIdentifier
    let focusDeadline = Date().addingTimeInterval(8)
    while NSWorkspace.shared.frontmostApplication?.processIdentifier != pid && Date() < focusDeadline { pump() }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
        throw KeyboardProblem(code: "PROBE_FOCUS", message: "The test window did not become foreground. No test keys were sent.")
    }
    let combinations = [[], ["command"], ["option"], ["control"], ["shift"], ["command", "option", "control", "shift"]]
    var inputSources = Set<String>(), layouts = Set<String>()
    for modifiers in combinations {
        observations.removeAll()
        inputSources.insert(currentInputSourceID()); layouts.insert(currentInputSourceID(layoutOnly: true))
        try sendShortcut(key: "KeyK", modifiers: modifiers, expectedPID: pid)
        let deadline = Date().addingTimeInterval(0.8)
        while observations.count < 2 && Date() < deadline { pump() }
        let expected = modifiers.reduce(CGEventFlags()) { $0.union(shortcutFlags[$1]!) }.rawValue
        guard observations.count == 2, observations[0].0 == .keyDown, observations[0].1 == expected,
              observations[1].0 == .keyUp, observations[1].1 == 0 else {
            throw KeyboardProblem(code: "PROBE_NOT_OBSERVED", message: "The test window did not observe the expected key-down, modifiers and key-up. Delivery is not verified.")
        }
    }
    return ["ok": true, "combinationsObserved": combinations.count,
            "inputSourcesObserved": inputSources.sorted(), "keyboardLayoutsObserved": layouts.sorted(),
            "message": "Six K-key combinations, including all four modifiers, were observed only in the Keyln test window."]
}
