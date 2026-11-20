import AppKit
import Foundation

func output(_ value: [String: Any], status: Int32 = 0) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(status)
}

let arguments = CommandLine.arguments
if arguments.count == 3 && arguments[1] == "--child" {
    guard let targetPID = Int32(arguments[2]), targetPID > 1, targetPID == getppid() else {
        output(["ok": false, "code": "INVALID_PROBE_TARGET", "message": "Only the probe's own parent window may receive test keys. No keys were sent."], status: 1)
    }
    do {
        try sendShortcut(key: "KeyA", modifiers: ["command"], expectedPID: targetPID)
        // Match the production helper's short-lived posting path, including immediate exit.
        output(["ok": true])
    } catch let problem as KeyboardProblem {
        output(["ok": false, "code": problem.code, "message": problem.message], status: 1)
    } catch {
        output(["ok": false, "code": "PROBE_CHILD_FAILED"], status: 1)
    }
}
guard arguments.count == 1 else {
    output(["ok": false, "code": "INVALID_PROBE_ARGUMENTS", "message": "Run without arguments for the explicit local delivery test. No keys were sent."], status: 1)
}

func runDeliveryProbe() throws -> [String: Any] {
    try shortcutPreflight()
    let previousApp = NSWorkspace.shared.frontmostApplication
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    app.finishLaunching()
    let pid = ProcessInfo.processInfo.processIdentifier
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 240), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "Keyln Delivery Test"
    window.isReleasedWhenClosed = false
    let label = NSTextField(wrappingLabelWithString: "Click this window if needed. Keep it in front.\nTesting 20 Command+A deliveries only in this temporary window.")
    label.frame = NSRect(x: 24, y: 150, width: 512, height: 68)
    let textView = NSTextView(frame: NSRect(x: 24, y: 30, width: 512, height: 100))
    let testText = "Keyln delivery test. No documents are opened or changed."
    textView.string = testText
    textView.isEditable = false
    textView.isSelectable = true
    window.contentView?.addSubview(label)
    window.contentView?.addSubview(textView)
    let menu = NSMenu(), editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: ""), editMenu = NSMenu(title: "Edit")
    let selectAll = NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    selectAll.keyEquivalentModifierMask = .command
    selectAll.target = textView
    editMenu.addItem(selectAll); editItem.submenu = editMenu; menu.addItem(editItem); app.mainMenu = menu
    var sampleStart: TimeInterval = 0
    var downs: [UInt64] = [], ups: [UInt64] = []
    let monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp]) { event in
        if event.timestamp >= sampleStart && event.keyCode == shortcutKeyCodes["KeyA"],
           event.cgEvent?.getIntegerValueField(.eventSourceUserData) == keylnEventTag {
            let flags = UInt64(event.modifierFlags.rawValue) & shortcutModifierMask.rawValue
            if event.type == .keyDown { downs.append(flags) } else { ups.append(flags) }
        }
        return event
    }
    defer {
        if let monitor { NSEvent.removeMonitor(monitor) }
        let stillInProbe = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
        window.close()
        if stillInProbe { previousApp?.activate(options: []) }
    }
    func pump() {
        if let event = app.nextEvent(matching: .any, until: Date().addingTimeInterval(0.01), inMode: .default, dequeue: true) { app.sendEvent(event) }
        app.updateWindows()
    }
    window.center(); window.makeKeyAndOrderFront(nil); app.activate()
    FileHandle.standardError.write(Data("Bring Keyln Delivery Test to foreground if needed; waiting up to 8 seconds.\n".utf8))
    let focusDeadline = Date().addingTimeInterval(8)
    while NSWorkspace.shared.frontmostApplication?.processIdentifier != pid && Date() < focusDeadline { pump() }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
        throw KeyboardProblem(code: "PROBE_FOCUS", message: "The test window did not become foreground. No test keys were sent.")
    }
    var results: [[String: Any]] = []
    for index in 1...20 {
        guard window.isVisible, NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
              window.makeFirstResponder(textView) else {
            throw KeyboardProblem(code: "PROBE_FOCUS", message: "Stopped because the probe no longer owns the foreground window. No further test keys were sent.")
        }
        textView.setSelectedRange(NSRange(location: (testText as NSString).length, length: 0))
        downs.removeAll(); ups.removeAll(); sampleStart = ProcessInfo.processInfo.systemUptime
        let child = Process(), pipe = Pipe()
        child.executableURL = URL(fileURLWithPath: arguments[0]).standardizedFileURL
        child.arguments = ["--child", String(pid)]
        child.standardOutput = pipe; child.standardError = FileHandle.standardError
        try child.run()
        let childDeadline = Date().addingTimeInterval(2)
        while child.isRunning && Date() < childDeadline { pump() }
        if child.isRunning {
            child.terminate(); child.waitUntilExit()
            throw KeyboardProblem(code: "PROBE_CHILD_TIMEOUT", message: "The owned delivery child did not finish. No further samples were sent.")
        }
        let childResult = (try? JSONSerialization.jsonObject(with: pipe.fileHandleForReading.readDataToEndOfFile())) as? [String: Any] ?? [:]
        guard childResult["ok"] as? Bool == true else {
            throw KeyboardProblem(code: childResult["code"] as? String ?? "PROBE_CHILD_FAILED", message: childResult["message"] as? String ?? "The delivery child failed. No further samples were sent.")
        }
        let observationDeadline = Date().addingTimeInterval(0.6)
        while (downs.isEmpty || ups.isEmpty || textView.selectedRange().length != (testText as NSString).length) && Date() < observationDeadline { pump() }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
            throw KeyboardProblem(code: "PROBE_FOCUS", message: "The foreground changed during delivery. Results are inconclusive; no further samples were sent.")
        }
        let eventsReceived = downs == [CGEventFlags.maskCommand.rawValue] && ups == [0]
        let selectedAll = textView.selectedRange().length == (testText as NSString).length
        results.append(["sample": index, "posted": true, "eventsReceived": eventsReceived, "selectedAll": selectedAll,
                        "downFlags": downs, "upFlags": ups])
        label.stringValue = "Observed \(index) / 20. Keep this test window in front.\nNo external documents are read or changed."
        let quietDeadline = Date().addingTimeInterval(0.2)
        while Date() < quietDeadline { pump() }
    }
    let received = results.filter { $0["eventsReceived"] as? Bool == true }.count
    let selected = results.filter { $0["selectedAll"] as? Bool == true }.count
    return ["ok": received == 20 && selected == 20, "samples": results.count, "postingReported": results.count,
            "eventsReceived": received, "selectionSucceeded": selected, "results": results,
            "message": "Separate short-lived senders called the production sendShortcut function; only the probe parent window was an allowed target."]
}

do {
    let result = try runDeliveryProbe()
    output(result, status: result["ok"] as? Bool == true ? 0 : 1)
} catch let problem as KeyboardProblem {
    output(["ok": false, "code": problem.code, "message": problem.message], status: 1)
} catch {
    output(["ok": false, "code": "DELIVERY_PROBE_FAILED", "message": "Delivery test could not complete."], status: 1)
}
