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

    func run(_ arguments: [String], timeout: TimeInterval) -> CommandResult {
        guard let place = locate() else { return CommandResult(status: 127, stdout: "", stderr: "Keyln is not installed. Run npm run service:install", timedOut: false) }
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
