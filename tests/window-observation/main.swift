// Test-only read-only observation. No private window IDs, activation or input.
import AppKit
import ApplicationServices

func bounds(_ window: AXUIElement) throws -> CGRect? {
    guard let position = try windowAttribute(window, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
          let size = try windowAttribute(window, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, dimensions = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &point),
          AXValueGetValue(unsafeBitCast(size, to: AXValue.self), .cgSize, &dimensions) else { return nil }
    return CGRect(origin: point, size: dimensions)
}
do {
    guard CommandLine.arguments.count == 3 else { exit(2) }
    let context = try windowContext(appID: CommandLine.arguments[1])
    let selected = try matchingWindow(context, title: CommandLine.arguments[2], match: "exact")
    let visible = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [])
        .filter { ($0[kCGWindowOwnerPID as String] as? Int32) == context.app.processIdentifier && ($0[kCGWindowLayer as String] as? Int) == 0 }
    let frame = try bounds(selected)
    let boundsMatches = visible.filter { item in
        guard let frame, let raw = item[kCGWindowBounds as String] as? [String: Any],
              let cg = CGRect(dictionaryRepresentation: raw as CFDictionary) else { return false }
        return abs(frame.minX-cg.minX)<2 && abs(frame.minY-cg.minY)<2 && abs(frame.width-cg.width)<2 && abs(frame.height-cg.height)<2
    }.count
    let result: [String: Any] = ["focused": try windowIsFocused(context, selected),
        "fullScreen": try windowAttribute(selected, "AXFullScreen") as? Bool ?? false,
        "minimized": try windowAttribute(selected, kAXMinimizedAttribute) as? Bool ?? false,
        "visibleOwnerWindows": visible.count, "visibleBoundsMatches": boundsMatches]
    print(String(data: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
} catch let problem as WindowProblem {
    print(String(data: try! JSONSerialization.data(withJSONObject: ["code": problem.code]), encoding: .utf8)!)
    exit(1)
}
