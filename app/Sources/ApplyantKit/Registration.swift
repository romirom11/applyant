// Starting the daemon at login, and again after a crash: a launchd agent with KeepAlive.
//
// First choice is SMAppService with the plist inside the bundle (Contents/Library/
// LaunchAgents), which shows up in System Settings → Login Items under Applyant. The bundle
// is only ad-hoc signed, and if macOS refuses to register it that way, the app writes the
// same agent to ~/Library/LaunchAgents and bootstraps it with launchctl. Once it has fallen
// back, it stays on the file (so the two never both run a daemon).
import Foundation
import ServiceManagement

public enum RegistrationOutcome: Equatable, Sendable {
    case smAppService
    case launchAgentFile
    /// Registered, but the candidate has to allow it in System Settings → Login Items.
    case needsApproval
    case failed(String)
}

/// The fallback agent: the same keys as the bundled plist, with an absolute Program path.
public func launchAgentPlist(program: URL) throws -> Data {
    let plist: [String: Any] = [
        "Label": Identity.daemonLabel,
        "Program": program.path,
        "RunAtLoad": true,
        "KeepAlive": true,
        "ProcessType": "Interactive",
        "AssociatedBundleIdentifiers": [Identity.appBundleId],
    ]
    return try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
}

public typealias RunCommand = @Sendable (_ executable: String, _ arguments: [String]) -> (status: Int32, output: String)

public let runCommand: RunCommand = { executable, arguments in
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    do {
        try process.run()
    } catch {
        return (-1, error.localizedDescription)
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return (process.terminationStatus, String(decoding: data, as: UTF8.self))
}

public struct LaunchctlAgent: Sendable {
    public let user: UserPaths
    public let layout: BundleLayout
    let run: RunCommand
    let uid: uid_t

    public init(user: UserPaths, layout: BundleLayout, run: @escaping RunCommand = runCommand, uid: uid_t = getuid()) {
        self.user = user
        self.layout = layout
        self.run = run
        self.uid = uid
    }

    var domain: String { "gui/\(uid)" }
    var service: String { "\(domain)/\(Identity.daemonLabel)" }

    public var installed: Bool { FileManager.default.fileExists(atPath: user.userAgentPlist.path) }

    public var loaded: Bool { run("/bin/launchctl", ["print", service]).status == 0 }

    /// Writes (or rewrites, when the app moved) the plist and makes sure launchd has it.
    public func install() -> RegistrationOutcome {
        do {
            let data = try launchAgentPlist(program: layout.launcher)
            let fm = FileManager.default
            try fm.createDirectory(at: user.userAgentPlist.deletingLastPathComponent(), withIntermediateDirectories: true)
            let current = try? Data(contentsOf: user.userAgentPlist)
            if current != data {
                if loaded { _ = run("/bin/launchctl", ["bootout", service]) }
                try data.write(to: user.userAgentPlist, options: .atomic)
            }
        } catch {
            return .failed("could not write \(user.userAgentPlist.path): \(error.localizedDescription)")
        }
        if loaded { return .launchAgentFile }
        let boot = run("/bin/launchctl", ["bootstrap", domain, user.userAgentPlist.path])
        if boot.status == 0 || loaded { return .launchAgentFile }
        return .failed("launchctl bootstrap failed: \(boot.output.trimmingCharacters(in: .whitespacesAndNewlines))")
    }
}

public struct DaemonRegistration: Sendable {
    public let fallback: LaunchctlAgent

    public init(fallback: LaunchctlAgent) {
        self.fallback = fallback
    }

    public func ensure() -> RegistrationOutcome {
        if fallback.installed { return fallback.install() }
        let agent = SMAppService.agent(plistName: Identity.daemonPlist)
        switch agent.status {
        case .enabled:
            return .smAppService
        case .requiresApproval:
            return .needsApproval
        case .notRegistered, .notFound:
            break
        @unknown default:
            break
        }
        do {
            try agent.register()
        } catch {
            NSLog("Applyant: SMAppService refused the daemon agent (%@); using ~/Library/LaunchAgents", "\(error)")
            return fallback.install()
        }
        return agent.status == .requiresApproval ? .needsApproval : .smAppService
    }

    /// The app itself as a login item, for the menu bar. Failures only cost the menu bar icon.
    public func ensureLoginItem() {
        let app = SMAppService.mainApp
        guard app.status != .enabled else { return }
        do {
            try app.register()
        } catch {
            NSLog("Applyant: could not register as a login item: %@", "\(error)")
        }
    }

    public func openLoginItemsSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}
