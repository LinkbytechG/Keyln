import Foundation

// Test-only entry point. Production never accepts arbitrary catalog roots from clients or CLI arguments.
guard CommandLine.arguments.count == 2 else { exit(2) }
let result = installedApplicationCatalog(roots: [CommandLine.arguments[1]])
let bytes = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
FileHandle.standardOutput.write(bytes)
