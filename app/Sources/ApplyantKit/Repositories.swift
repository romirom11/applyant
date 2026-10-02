// The candidate's own GitHub repositories, offered as a project's sources (SuggestRepositories):
// the ones that look like the project first, with why, then the rest. Nothing is pasted: a
// repository is picked, and added like any other source.
import ApplyantAPI
import Foundation

public struct RepoSuggestion: Identifiable, Equatable, Sendable {
    public var id: String { url }
    public let url: String
    /// "romirom11/soloveim"
    public let fullName: String
    public let description: String?
    public let pushedAt: Date?
    public let isPrivate: Bool
    /// Why it looks like the project; empty for the rest of the list.
    public let reason: String

    public init(url: String, fullName: String, description: String? = nil, pushedAt: Date? = nil, isPrivate: Bool = false, reason: String = "") {
        self.url = url
        self.fullName = fullName
        self.description = description
        self.pushedAt = pushedAt
        self.isPrivate = isPrivate
        self.reason = reason
    }

    public init(_ r: Applyant_V1_RepositorySuggestion) {
        self.init(
            url: r.url,
            fullName: r.fullName,
            description: r.hasDescription_p && !r.description_p.isEmpty ? r.description_p : nil,
            pushedAt: r.hasPushedAt ? r.pushedAt.date : nil,
            isPrivate: r.private,
            reason: r.reason
        )
    }

    /// "soloveim" from "romirom11/soloveim".
    public var name: String { fullName.split(separator: "/").last.map(String.init) ?? fullName }
}

/// What the daemon found: matches, the rest, or why it couldn't look.
public struct RepoSuggestions: Equatable, Sendable {
    public var matches: [RepoSuggestion] = []
    public var others: [RepoSuggestion] = []
    public var accounts: [String] = []
    /// Why nothing could be listed (`gh` not installed or signed in); nil when it could.
    public var problem: String?

    public init(matches: [RepoSuggestion] = [], others: [RepoSuggestion] = [], accounts: [String] = [], problem: String? = nil) {
        self.matches = matches
        self.others = others
        self.accounts = accounts
        self.problem = problem
    }

    public var all: [RepoSuggestion] { matches + others }
    public var isEmpty: Bool { matches.isEmpty && others.isEmpty }
}

public enum RepoText {
    /// "pushed 2 months ago" (relative; nil without a date).
    public static func pushed(_ r: RepoSuggestion, now: Date = Date()) -> String? {
        guard let at = r.pushedAt else { return nil }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .full
        return "pushed \(f.localizedString(for: at, relativeTo: now))"
    }

    /// The suggestion card's line: "romirom11/soloveim · pushed 2 months ago — its name is close to Solovei".
    public static func cardLine(_ r: RepoSuggestion, now: Date = Date()) -> String {
        var line = r.fullName
        if let when = pushed(r, now: now) { line += " · \(when)" }
        if !r.reason.isEmpty { line += " — \(r.reason)" }
        return line
    }

    /// The picker's second line: description, when pushed.
    public static func detailLine(_ r: RepoSuggestion, now: Date = Date()) -> String {
        [r.description, pushed(r, now: now)].compactMap { $0 }.joined(separator: " · ")
    }

    /// Repositories whose name or description contains every word typed, case-insensitively.
    public static func search(_ query: String, in repos: [RepoSuggestion]) -> [RepoSuggestion] {
        let words = query.lowercased().split(whereSeparator: { $0 == " " }).map(String.init)
        if words.isEmpty { return repos }
        return repos.filter { r in
            let hay = (r.fullName + " " + (r.description ?? "")).lowercased()
            return words.allSatisfy { hay.contains($0) }
        }
    }

    /// The daemon's "FailedPrecondition: gh isn't signed in" as the quiet line the pane shows,
    /// and the command that fixes it.
    public static func problem(_ message: String) -> (text: String, command: String?) {
        let m = message.lowercased()
        if m.isEmpty { return ("Repository suggestions need a newer Applyant background service.", nil) }
        if m.contains("not found") || m.contains("install") {
            return ("The GitHub CLI isn't installed, so your repositories can't be listed.", "brew install gh && gh auth login")
        }
        if m.contains("sign") || m.contains("logged") || m.contains("auth") {
            return ("The GitHub CLI isn't signed in, so your repositories can't be listed.", "gh auth login")
        }
        if m.contains("unimplemented") || m.contains("newer applyant") || m.contains("not implemented") {
            return ("Repository suggestions need a newer Applyant background service.", nil)
        }
        return (message, nil)
    }
}
