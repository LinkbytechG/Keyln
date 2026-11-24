import Foundation

struct CommandResult {
    let status: Int32
    let stdout: String
    let stderr: String
    let timedOut: Bool
}

struct ServiceStatus {
    var installed = false
    var running = false
    var origin: String?
    var logs: String?
    var hostVersion: String?       // T125: nil when not running, "unknown" for a Host that predates version reporting
    var accessibilityTrusted: Bool?
    var eventPostingAllowed: Bool?
    var permissionsKnown = false   // doctor ran and answered
    var doctorFailed = false
    var failure: String?           // status command itself failed
}

/// Runs `<node> <runtime>/dist/apps/host/service-entry.js <command>` with a minimal environment.
final class ServiceClient {
    let dataDir: String
    let label: String?

    init() {
        let env = ProcessInfo.processInfo.environment
        if let custom = env["KEYLN_DATA_DIR"], !custom.isEmpty {
            dataDir = custom
        } else {
            dataDir = NSHomeDirectory() + "/Library/Application Support/Keyln"
        }
        if let value = env["KEYLN_SERVICE_LABEL"], !value.isEmpty { label = value } else { label = nil }
    }

    /// Returns node and entry paths, or nil when the service has not been installed with this build.
    func locate() -> (node: String, entry: String)? {
        guard let data = FileManager.default.contents(atPath: dataDir + "/service.json"),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let node = object["node"] as? String, let runtime = object["runtime"] as? String else { return nil }
        let entry = runtime + "/dist/apps/host/service-entry.js"
        guard FileManager.default.fileExists(atPath: entry) else { return nil }
        return (node, entry)
    }

    var logsPath: String { dataDir + "/logs" }

    /// T124: the Node and runtime inside this very app, or nil in a development build without a bundled runtime.
    func bundled() -> (node: String, entry: String)? {
        let root = Bundle.main.bundlePath
        let node = root + "/Contents/Helpers/node"
        let entry = root + "/Contents/Resources/runtime/dist/apps/host/service-entry.js"
        let manager = FileManager.default
        guard manager.isExecutableFile(atPath: node), manager.fileExists(atPath: entry) else { return nil }
        return (node, entry)
    }

    var hasBundledRuntime: Bool { bundled() != nil }
    /// True when some runtime can answer the first-run commands.
    var canRunSetupCommands: Bool { bundled() != nil || locate() != nil }

    func run(_ arguments: [String], timeout: TimeInterval) -> CommandResult {
        guard let place = locate() else { return CommandResult(status: 127, stdout: "", stderr: "Keyln is not installed. Run npm run service:install", timedOut: false) }
        return execute(place, arguments, timeout: timeout)
    }

    /// Runs with the runtime bundled in this app; falls back to the installed service's runtime in a development build.
    func runSelf(_ arguments: [String], timeout: TimeInterval) -> CommandResult {
        guard let place = bundled() ?? locate() else { return CommandResult(status: 127, stdout: "", stderr: "This build has no bundled runtime.", timedOut: false) }
        return execute(place, arguments, timeout: timeout)
    }

    private func execute(_ place: (node: String, entry: String), _ arguments: [String], timeout: TimeInterval) -> CommandResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: place.node)
        process.arguments = [place.entry] + arguments
        var environment = ["KEYLN_DATA_DIR": dataDir, "HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        if let label = label { environment["KEYLN_SERVICE_LABEL"] = label }
        process.environment = environment
        process.currentDirectoryURL = URL(fileURLWithPath: "/")
        let out = Pipe(), err = Pipe()
        process.standardOutput = out
        process.standardError = err
        process.standardInput = FileHandle.nullDevice
        do { try process.run() } catch {
            return CommandResult(status: 126, stdout: "", stderr: "Could not run Node: \(error.localizedDescription)", timedOut: false)
        }
        var outData = Data(), errData = Data()
        let group = DispatchGroup()
        for (pipe, isOut) in [(out, true), (err, false)] {
            group.enter()
            DispatchQueue.global().async {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                if isOut { outData = data } else { errData = data }
                group.leave()
            }
        }
        var timedOut = false
        let deadline = DispatchTime.now() + timeout
        let finished = DispatchSemaphore(value: 0)
        DispatchQueue.global().async { process.waitUntilExit(); finished.signal() }
        if finished.wait(timeout: deadline) == .timedOut {
            timedOut = true
            process.terminate()
            _ = finished.wait(timeout: .now() + 2)
        }
        _ = group.wait(timeout: .now() + 2)
        return CommandResult(status: process.isRunning ? -1 : process.terminationStatus,
                             stdout: String(decoding: outData, as: UTF8.self),
                             stderr: String(decoding: errData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines),
                             timedOut: timedOut)
    }

    func status(doctor: Bool) -> ServiceStatus {
        var result = ServiceStatus()
        guard locate() != nil else { return result }
        let command = run(doctor ? ["menu-status", "--doctor"] : ["menu-status"], timeout: 8)
        guard command.status == 0,
              let object = try? JSONSerialization.jsonObject(with: Data(command.stdout.utf8)) as? [String: Any] else {
            result.installed = true
            result.failure = command.timedOut ? "Status timed out" : (command.stderr.isEmpty ? "Status unavailable" : command.stderr)
            return result
        }
        result.installed = object["installed"] as? Bool ?? false
        result.running = object["running"] as? Bool ?? false
        result.origin = object["origin"] as? String
        result.logs = object["logs"] as? String
        result.hostVersion = object["hostVersion"] as? String
        if doctor && result.running {
            if let permissions = object["permissions"] as? [String: Any] {
                result.permissionsKnown = true
                result.accessibilityTrusted = permissions["accessibilityTrusted"] as? Bool
                result.eventPostingAllowed = permissions["eventPostingAllowed"] as? Bool
            } else {
                result.doctorFailed = true
            }
        }
        return result
    }
}

struct AddressCandidate {
    let interface: String
    let address: String
    var title: String { address == "127.0.0.1" ? "This Mac only (127.0.0.1)" : "\(interface) — \(address)" }
}

/// Answer of `setup-info` (T124).
struct SetupInfo {
    var configured = false
    var address: String?
    var port: Int?
    var origin: String?
    var candidates: [AddressCandidate] = []
    var caFingerprint: String?
    var selfApp: String?
    var selfAppProblem: String?
    var manifestApp: String?
    var manifestMatchesSelf = false
    var layout: String?
    var running = false
    var appVersion: String?
}

extension ServiceClient {
    func setupInfo() -> (info: SetupInfo?, error: String?) {
        let result = runSelf(["setup-info"], timeout: 20)
        guard result.status == 0, let object = try? JSONSerialization.jsonObject(with: Data(result.stdout.utf8)) as? [String: Any] else {
            return (nil, result.timedOut ? "The setup check timed out." : (result.stderr.isEmpty ? "The setup check failed." : result.stderr))
        }
        var info = SetupInfo()
        info.configured = object["configured"] as? Bool ?? false
        info.address = object["address"] as? String
        info.port = object["port"] as? Int
        info.origin = object["origin"] as? String
        info.caFingerprint = object["caFingerprint"] as? String
        info.selfApp = object["selfApp"] as? String
        info.selfAppProblem = object["selfAppProblem"] as? String
        info.manifestApp = object["manifestApp"] as? String
        info.manifestMatchesSelf = object["manifestMatchesSelf"] as? Bool ?? false
        info.layout = object["layout"] as? String
        info.running = object["running"] as? Bool ?? false
        info.appVersion = object["appVersion"] as? String
        for entry in object["candidates"] as? [[String: Any]] ?? [] {
            if let name = entry["interface"] as? String, let address = entry["address"] as? String { info.candidates.append(AddressCandidate(interface: name, address: address)) }
        }
        return (info, nil)
    }
}
