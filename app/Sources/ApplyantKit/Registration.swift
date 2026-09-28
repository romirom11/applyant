// Starting the daemon at login, and again after a crash: a launchd agent with KeepAlive,
// written to ~/Library/LaunchAgents and bootstrapped with launchctl.
//
// Not SMAppService: it takes the ad-hoc signed bundle, but trusts the launcher by its hash
// (launchd's launch constraint), and after a rebuild launchd refuses to spawn the new one
// ("spawn failed", EX_CONFIG, "needs LWCR update"), even after unregister + register. A plain
// agent file has no such constraint. The agent still shows in System Settings → Login Items,
// grouped under Applyant (AssociatedBundleIdentifiers).
import Foundation
import ServiceManagement

public enum RegistrationOutcome: Equatable, Sendable {
    case launchAgentFile
    case failed(String)
}

/// The agent: the launcher inside the installed bundle, kept alive by launchd.
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
    public let agent: LaunchctlAgent

    public init(agent: LaunchctlAgent) {
        self.agent = agent
    }

    public func ensure() async -> RegistrationOutcome {
        // 8a's first builds registered the agent through SMAppService under the same label:
        // take that one down first, so launchd has a single com.applyant.daemon.
        let legacy = SMAppService.agent(plistName: Identity.daemonPlist)
        if legacy.status == .enabled || legacy.status == .requiresApproval {
            do {
                try await legacy.unregister()
            } catch {
                NSLog("Applyant: could not unregister the SMAppService agent: %@", "\(error)")
            }
        }
        return agent.install()
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
}
