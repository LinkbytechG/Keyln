import AppKit

struct AppIconProblem: Error { let code: String; let message: String }
func validateIconIDs(_ ids: [String]) throws {
    guard !ids.isEmpty, ids.count <= 16, Set(ids).count == ids.count,
          ids.allSatisfy({ $0.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$", options: .regularExpression) != nil }) else {
        throw AppIconProblem(code: "INVALID_APP", message: "Use one to sixteen distinct application identifiers.")
    }
}
private func renderApplicationIcon(appID: String, item: (name: String, url: URL)) throws -> Data {
    guard FileManager.default.fileExists(atPath: item.url.path), Bundle(url: item.url)?.bundleIdentifier == appID else {
        throw AppIconProblem(code: "APP_UNAVAILABLE", message: "Choose an installed Mac application.")
    }
    let size = 128
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
        let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        throw AppIconProblem(code: "ICON_UNAVAILABLE", message: "The Mac could not prepare this icon.")
    }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    NSWorkspace.shared.icon(forFile: item.url.path).draw(in: NSRect(x: 0, y: 0, width: size, height: size),
        from: .zero, operation: .copy, fraction: 1)
    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    // A process without desktop rendering access can receive an empty representation.
    // Report unavailable so the client keeps its built-in fallback instead of a blank icon.
    guard stride(from: 0, to: size, by: 8).contains(where: { y in
        stride(from: 0, to: size, by: 8).contains { x in (bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.01 }
    }) else { throw AppIconProblem(code: "ICON_UNAVAILABLE", message: "The Mac desktop could not render this icon.") }
    guard let data = bitmap.representation(using: .png, properties: [:]), data.count <= 65_536 else {
        throw AppIconProblem(code: "ICON_UNAVAILABLE", message: "The app icon is unavailable or too large.")
    }
    return data
}
// T115 (ADR-099): a running app outside the catalog folders (for example a helper app inside another app's bundle, which the Mac Dock bar can show) is found through its
// running process. Only regular (Dock) apps; the bundle identifier check in renderApplicationIcon still applies.
private func runningApplicationRecord(_ id: String) -> (name: String, url: URL)? {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: id).first(where: { $0.activationPolicy == .regular && !$0.isTerminated }),
          let url = app.bundleURL else { return nil }
    return (name: app.localizedName ?? id, url: url)
}
func applicationIcon(appID: String) throws -> Data {
    try validateIconIDs([appID])
    guard let item = installedApplicationRecords(roots: installedApplicationRoots())[appID] else {
        throw AppIconProblem(code: "APP_UNAVAILABLE", message: "Choose an installed Mac application.")
    }
    return try renderApplicationIcon(appID: appID, item: item)
}
func applicationIcons(appIDs: [String], discover: () -> [String: (name: String, url: URL)] = {
    installedApplicationRecords(roots: installedApplicationRoots())
}) throws -> [[String: String]] {
    try validateIconIDs(appIDs)
    let records = discover() // Exactly one catalog scan per bounded batch, never per image.
    return appIDs.map { id in
        guard let item = records[id] ?? runningApplicationRecord(id) else { return ["appId": id, "code": "APP_UNAVAILABLE"] }
        do { return ["appId": id, "png": try renderApplicationIcon(appID: id, item: item).base64EncodedString()] }
        catch { return ["appId": id, "code": "ICON_UNAVAILABLE"] }
    }
}
