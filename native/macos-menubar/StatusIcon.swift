import AppKit

// The menu bar mark: a one-colour template version of the Keyln icon. Keys spell a K on a 5-row grid,
// and the signal (two arcs) opens to the right from the K's mouth. macOS tints template
// images for light and dark menu bars, so everything is drawn in black with alpha only.
enum StatusIconState {
    case running    // K and signal
    case stopped    // K alone; the caller also dims the button
    case attention  // K and an exclamation mark in place of the signal
}

enum StatusIcon {
    static let size = NSSize(width: 18, height: 18)
    static let key: CGFloat = 2.75, gap: CGFloat = 0.6, origin: CGFloat = 1
    static let step = key + gap

    // (column, row) of each key in the K, top row first.
    static let keys: [(Int, Int)] = [(0, 0), (0, 1), (0, 2), (0, 3), (0, 4), (1, 2), (2, 1), (3, 0), (2, 3), (3, 4)]

    static func centre(_ column: CGFloat, _ row: CGFloat) -> NSPoint {
        NSPoint(x: origin + column * step + key / 2, y: origin + row * step + key / 2)
    }

    static func image(_ state: StatusIconState, description: String) -> NSImage {
        let image = NSImage(size: size, flipped: true) { _ in
            draw(state)
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = description
        return image
    }

    static func draw(_ state: StatusIconState) {
        NSColor.black.setFill()
        NSColor.black.setStroke()
        for (column, row) in keys {
            let rect = NSRect(x: origin + CGFloat(column) * step, y: origin + CGFloat(row) * step, width: key, height: key)
            NSBezierPath(roundedRect: rect, xRadius: 0.6, yRadius: 0.6).fill()
        }
        let source = centre(2, 2)
        switch state {
        case .running:
            // Two arcs open to the right from the K's mouth, the outer one past its arms, as in the app icon.
            // No dot: at this size it lines up with the keys above and below and reads as a column.
            for (radius, sweep) in [(CGFloat(3.0), CGFloat(38)), (CGFloat(6.2), CGFloat(34))] {
                let arc = NSBezierPath()
                // Flipped coordinates: -sweep...sweep opens to the right.
                arc.appendArc(withCenter: source, radius: radius, startAngle: -sweep, endAngle: sweep, clockwise: false)
                arc.lineWidth = 1.15
                arc.lineCapStyle = .round
                arc.stroke()
            }
        case .stopped:
            break
        case .attention:
            let x: CGFloat = 16.2  // right of the K, clear of its arms
            let bar = NSBezierPath()
            bar.move(to: NSPoint(x: x, y: origin + 2.2))
            bar.line(to: NSPoint(x: x, y: origin + 10.6))
            bar.lineWidth = 1.7
            bar.lineCapStyle = .round
            bar.stroke()
            NSBezierPath(ovalIn: NSRect(x: x - 1.05, y: origin + 12.6, width: 2.1, height: 2.1)).fill()
        }
    }
}
