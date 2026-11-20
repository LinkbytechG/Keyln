import AppKit
import Foundation

// Explicit M2 target. Observes only its own temporary text view and writes its own log.
final class M2Delegate: NSObject, NSApplicationDelegate, NSTextViewDelegate {
    var window: NSWindow!
    var view: NSTextView!
    var timer: Timer?
    var keyMonitor: Any?
    let directory: URL
    let nonce: String
    var observed = 0
    init(ownedBundle: Bundle) throws {
        let info = ownedBundle.infoDictionary ?? [:]
        guard let path = info["KeylnAcceptanceDirectory"] as? String,
              let nonce = info["KeylnAcceptanceNonce"] as? String,
              let owner = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath:path).appendingPathComponent("owner.json"))) as? [String:Any],
              owner["nonce"] as? String == nonce,
              owner["bundleId"] as? String == Bundle.main.bundleIdentifier else { throw NSError(domain:"KeylnM2",code:1) }
        directory=URL(fileURLWithPath:path);self.nonce=nonce;super.init()
    }
    func record() {
        guard view != nil else { return }
        let range=view.selectedRange()
        let state:[String:Any] = ["nonce":nonce,"pid":ProcessInfo.processInfo.processIdentifier,
            "eventsReceived":observed,"selectedAll":range.location==0 && range.length==view.string.utf16.count,
            "selectionLength":range.length,"active":NSApp.isActive]
        if let data=try? JSONSerialization.data(withJSONObject:state,options:[.sortedKeys]) { try? data.write(to:directory.appendingPathComponent("target.json"),options:.atomic) }
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu=NSMenu(),edit=NSMenuItem(),editMenu=NSMenu(title:"Edit")
        editMenu.addItem(NSMenuItem(title:"Select All",action:#selector(NSText.selectAll(_:)),keyEquivalent:"a"))
        edit.submenu=editMenu;menu.addItem(NSMenuItem());menu.addItem(edit);NSApp.mainMenu=menu
        window=NSWindow(contentRect:NSRect(x:0,y:0,width:600,height:300),styleMask:[.titled,.closable],backing:.buffered,defer:false)
        window.title="Keyln M2 Owned Test";window.isReleasedWhenClosed=false
        view=NSTextView(frame:NSRect(x:24,y:24,width:552,height:252));view.string="Keyln M2 Test";view.font = .systemFont(ofSize:24);view.delegate=self
        window.contentView?.addSubview(view);window.center();window.makeKeyAndOrderFront(nil);window.makeFirstResponder(view);view.setSelectedRange(NSRange(location:0,length:0))
        keyMonitor=NSEvent.addLocalMonitorForEvents(matching:.keyDown) { [weak self] event in
            if event.keyCode==0 && event.modifierFlags.contains(.command) { self?.observed += 1 }
            return event
        }
        NSApp.activate();record()
        timer=Timer.scheduledTimer(withTimeInterval:0.05,repeats:true) { [weak self] _ in self?.record() }
    }
    func applicationDidBecomeActive(_ notification:Notification) { if view != nil {view.setSelectedRange(NSRange(location:0,length:0));record()} }
    func textViewDidChangeSelection(_ notification:Notification) { record() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool { true }
}
do {
    let delegate=try M2Delegate(ownedBundle: .main),app=NSApplication.shared
    app.setActivationPolicy(.regular);app.delegate=delegate
    withExtendedLifetime(delegate){app.run()}
} catch { exit(1) }
