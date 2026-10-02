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
            title = "Applyant's background service isn't running"
            lines = ["macOS starts it at login and again after a crash."]
        case let .unreachable(reason):
            health = .down
            title = "Applyant's background service isn't answering"
            lines = [reason]
        case let .running(s):
            let claude = StatusView.tool("claude", s.claude)
            let codex = StatusView.tool("codex", s.codex)
            // claude is required (every role defaults to it); codex is optional.
            health = s.claude.ready ? .ok : .warning
            title = "Applyant is running"
            lines = [
                claude,
                codex,
                "Keys are kept in " + (s.secretsBackend == "keychain" ? "the Keychain" : s.secretsBackend == "file" ? "a private file (the Keychain isn't available)" : "?"),
            ]
        }
    }

    static func tool(_ name: String, _ t: ToolStatus) -> String {
        guard t.found else { return "\(name): ✗ not found" }
        // "2.1.283 (Claude Code)" · "codex-cli 0.157.1": the word with the number.
        let version = t.version.split(separator: " ").first { $0.contains(where: \.isNumber) }.map(String.init) ?? ""
        let state = t.ready ? "✓" : (t.signedIn ? "!" : "✗ not signed in")
        return "\(name): \(state) \(version) · \(t.path)"
    }
}
