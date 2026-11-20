import AppKit

// T120: agent app (LSUIElement). It only drives the installed Keyln login service through service-entry.js.
let application = NSApplication.shared
let appDelegate = AppDelegate()
application.delegate = appDelegate
application.setActivationPolicy(.accessory)
application.run()
