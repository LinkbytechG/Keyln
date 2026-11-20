import Foundation

func installedApplicationRoots() -> [String] {
    ["/Applications", "/System/Applications", "/System/Cryptexes/App/System/Applications", "/System/Library/CoreServices",
     FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path]
}

// Both discovery and icon export use these exact roots, filters and duplicate-ID policy.
func installedApplicationRecords(roots: [String]) -> [String: (name: String, url: URL)] {
    var apps: [String: (name: String, url: URL)] = [:]
    for root in roots {
        guard let files = FileManager.default.enumerator(at: URL(fileURLWithPath: root),
            includingPropertiesForKeys: nil, options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { continue }
        for case let url as URL in files where url.pathExtension == "app" {
            guard let bundle = Bundle(url: url), let id = bundle.bundleIdentifier,
                  id.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$", options: .regularExpression) != nil,
                  bundle.object(forInfoDictionaryKey: "LSBackgroundOnly") as? Bool != true else { continue }
            // LSUIElement hides an agent from the Dock; it does not mean the app has no windows.
            // Windows App and other UI-capable agents must remain selectable, even before launch.
            let name = (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                ?? (bundle.object(forInfoDictionaryKey: "CFBundleName") as? String)
                ?? url.deletingPathExtension().lastPathComponent
            apps[id] = (name: name, url: url)
        }
    }
    return apps
}
func installedApplicationCatalog(roots: [String]) -> [[String: String]] {
    installedApplicationRecords(roots: roots).map { ["id": $0.key, "name": $0.value.name] }.sorted { $0["name"]! < $1["name"]! }
}
