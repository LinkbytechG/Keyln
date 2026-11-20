import Foundation

// Test-only injection counts the production batch's catalog calls; no CLI roots in production.
var scans = 0
let ids = (0..<16).map { "test.batch\($0)" }
let missing = try applicationIcons(appIDs: ids, discover: { scans += 1; return [:] })
precondition(scans == 1 && missing.count == 16 && missing.allSatisfy { $0["code"] == "APP_UNAVAILABLE" })
var invalid = 0
for values in [[], ids + ["test.extra"], ["test.same", "test.same"], ["../etc/passwd"], ["file:///Applications/Safari.app"]] {
    do { _ = try applicationIcons(appIDs: values, discover: { scans += 1; return [:] }); fatalError("Expected rejection") }
    catch { invalid += 1 }
}
precondition(scans == 1 && invalid == 5)
let wrongBundle = try applicationIcons(appIDs: ["test.mismatch"], discover: {
    scans += 1; return ["test.mismatch": (name: "Mismatch", url: URL(fileURLWithPath: "/System/Library/CoreServices/Finder.app"))]
})
precondition(scans == 2 && wrongBundle[0]["code"] == "ICON_UNAVAILABLE")
let output = try JSONSerialization.data(withJSONObject: ["ok": true, "validBatchScans": 1, "invalidBeforeScan": invalid, "bundleMismatchRejected": true])
FileHandle.standardOutput.write(output)
