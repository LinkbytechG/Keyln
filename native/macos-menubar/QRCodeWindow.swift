import AppKit

// T121: one reusable window showing the QR code for the Keyln origin. The app stays an accessory app (no Dock icon).
final class QRCodeWindowController: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    private let imageView = NSImageView()
    private let originLabel = NSTextField(labelWithString: "")
    private var origin: String?

    private final class EscapeWindow: NSWindow {
        override func cancelOperation(_ sender: Any?) { close() }
    }

    func show(origin: String) {
        let window = self.window ?? makeWindow()
        let first = !window.isVisible && self.window == nil
        self.window = window
        apply(origin)
        if first { window.center() }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    /// Called when the status changes. Only a different non-nil origin updates an open window; a stopped service leaves it as is.
    func update(origin: String?) {
        guard let origin = origin, let window = window, window.isVisible, origin != self.origin else { return }
        apply(origin)
    }

    private func apply(_ origin: String) {
        self.origin = origin
        let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        // Draw 1:1 with the screen: a whole number of pixels per module, as large as fits in 260 pt,
        // so AppKit never resamples the modules (resampling blurs their edges).
        if let probe = QRCode.cgImage(for: origin, modulePixels: 1),
           let cg = QRCode.cgImage(for: origin, modulePixels: max(1, Int(260 * scale) / probe.width)) {
            imageView.image = NSImage(cgImage: cg, size: NSSize(width: CGFloat(cg.width) / scale, height: CGFloat(cg.height) / scale))
        } else {
            imageView.image = nil
        }
        imageView.setAccessibilityLabel("QR code for " + origin)
        originLabel.stringValue = origin
    }

    private func makeWindow() -> NSWindow {
        let window = EscapeWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 400),
                                  styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Scan to Open Keyln"
        window.isReleasedWhenClosed = false
        window.level = .floating
        window.delegate = self

        imageView.imageScaling = .scaleNone
        imageView.imageAlignment = .alignCenter
        imageView.setAccessibilityRole(.image)
        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.wantsLayer = true
        imageView.layer?.backgroundColor = NSColor.white.cgColor

        originLabel.isSelectable = true
        originLabel.alignment = .center
        originLabel.lineBreakMode = .byCharWrapping
        originLabel.maximumNumberOfLines = 0
        originLabel.font = NSFont.systemFont(ofSize: 13)
        originLabel.preferredMaxLayoutWidth = 280

        let note = NSTextField(wrappingLabelWithString: "First time on a device? It must trust Keyln's certificate, then pair.")
        note.font = NSFont.systemFont(ofSize: 11)
        note.textColor = .secondaryLabelColor
        note.alignment = .center
        note.preferredMaxLayoutWidth = 280

        let stack = NSStackView(views: [imageView, originLabel, note])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        NSLayoutConstraint.activate([
            imageView.widthAnchor.constraint(equalToConstant: 260),
            imageView.heightAnchor.constraint(equalToConstant: 260),
            originLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 280),
            note.widthAnchor.constraint(lessThanOrEqualToConstant: 280),
        ])
        window.contentView = stack
        window.setContentSize(stack.fittingSize)
        return window
    }
}
