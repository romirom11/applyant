// What the menu bar shows for a daemon state: a symbol and a few lines.
import Foundation

public struct StatusView: Equatable, Sendable {
    public enum Health: Equatable, Sendable { case ok, warning, down }

    public let health: Health
    public let title: String
    public let lines: [String]

    /// SF Symbol for the menu bar.
    public var symbol: String {
        switch health {
        case .ok: "briefcase.fill"
        case .warning: "exclamationmark.triangle"
        case .down: "briefcase"
        }
    }

    public init(_ state: DaemonState) {
        switch state {
        case .stopped:
            health = .down
            title = "Daemon not running"
            lines = ["launchd starts it at login and after a crash."]
        case let .unreachable(reason):
            health = .down
            title = "Daemon not answering"
            lines = [reason]
        case let .running(s):
            let claude = StatusView.tool("claude", s.claude)
            let codex = StatusView.tool("codex", s.codex)
            // claude is required (every role defaults to it); codex is optional.
            health = s.claude.ready ? .ok : .warning
            title = "Daemon running" + (s.pid.isEmpty ? "" : " (pid \(s.pid))")
            lines = [
                claude,
                codex,
                "Secrets: \(s.secretsBackend.isEmpty ? "?" : s.secretsBackend)"
                    + (s.nativeHelper ? " · native helper ✓" : " · native helper ✗"),
            ]
        }
    }

    static func tool(_ name: String, _ t: ToolStatus) -> String {
        guard t.found else { return "\(name): ✗ not found" }
        let version = t.version.split(separator: " ").first.map(String.init) ?? ""
        let state = t.ready ? "✓" : (t.signedIn ? "!" : "✗ not signed in")
        return "\(name): \(state) \(version) · \(t.path)"
    }
}
