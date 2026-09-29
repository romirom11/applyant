// The first-launch setup (phase 16): Connections → Import → Preferences → Interview. The daemon
// keeps each step's state (GetSetupStatus · SetSetupStep); `OnboardingFlow` is the state machine
// the window runs on, so it's tested without SwiftUI. Connections and Import can be skipped,
// the Interview left for later; Preferences can only be finished, because search starts from it.
import ApplyantAPI
import Foundation

public typealias OnboardingStatus = Applyant_V1_SetupStatus
public typealias SetupConnection = Applyant_V1_Connection
public typealias PreferenceSuggestion = Applyant_V1_PreferenceSuggestion

public enum OnboardingStep: String, CaseIterable, Identifiable, Sendable {
    case connections
    case importing = "import"
    case preferences
    case interview

    public var id: String { rawValue }

    public var number: Int { (Self.allCases.firstIndex(of: self) ?? 0) + 1 }

    public var title: String {
        switch self {
        case .connections: "Connections"
        case .importing: "Import"
        case .preferences: "Preferences"
        case .interview: "Interview"
        }
    }

    public var summary: String {
        switch self {
        case .connections: "Claude Code and Codex, the Jev key, GitHub, your mailbox and Calendar. Any of them can wait; each says what won't work without it."
        case .importing: "Your CV or LinkedIn PDF, your GitHub account and any links or Google Docs. The profile and projects are drafted in the background while you go on."
        case .preferences: "Roles, where and how you work, salary and dealbreakers, pre-filled from your CV. Search starts when you finish this step."
        case .interview: "A few questions about your projects: what you built yourself, the team, the results. Answer now or later."
        }
    }

    /// The state the daemon records for "Skip" on this step; nil when it can't be skipped.
    public var skipState: String? {
        switch self {
        case .connections, .importing: "skipped"
        case .interview: "later"
        case .preferences: nil
        }
    }

    public var next: OnboardingStep? {
        let all = Self.allCases
        guard let i = all.firstIndex(of: self), i + 1 < all.count else { return nil }
        return all[i + 1]
    }
}

public struct OnboardingFlow: Equatable, Sendable {
    /// pending | done | skipped | later, per step.
    public private(set) var states: [OnboardingStep: String]
    public private(set) var current: OnboardingStep
    public private(set) var searchStarted: Bool

    public init(states: [OnboardingStep: String] = [:], searchStarted: Bool = false) {
        var all: [OnboardingStep: String] = [:]
        for step in OnboardingStep.allCases { all[step] = states[step] ?? "pending" }
        self.states = all
        self.searchStarted = searchStarted
        current = OnboardingStep.allCases.first { all[$0] == "pending" } ?? .interview
    }

    public init(status: OnboardingStatus) {
        var states: [OnboardingStep: String] = [:]
        for s in status.steps {
            if let step = OnboardingStep(rawValue: s.step) { states[step] = s.state }
        }
        self.init(states: states, searchStarted: status.searchStarted)
    }

    public func state(_ step: OnboardingStep) -> String { states[step] ?? "pending" }

    public func isSettled(_ step: OnboardingStep) -> Bool { state(step) != "pending" }

    /// Every step is done, skipped or left for later.
    public var isFinished: Bool { OnboardingStep.allCases.allSatisfy(isSettled) }

    /// The first step nobody has settled yet.
    public var firstPending: OnboardingStep? { OnboardingStep.allCases.first { !isSettled($0) } }

    /// Back to anything, forward only as far as the first unsettled step.
    public func canOpen(_ step: OnboardingStep) -> Bool {
        guard let first = firstPending else { return true }
        return step.number <= first.number
    }

    public mutating func open(_ step: OnboardingStep) {
        if canOpen(step) { current = step }
    }

    /// The step's outcome: "done", or its skip state. Moves on to the next unsettled step
    /// after it (or the next one); returns false for a transition the step doesn't allow.
    @discardableResult
    public mutating func settle(_ step: OnboardingStep, as state: String) -> Bool {
        guard state == "done" || state == step.skipState else { return false }
        states[step] = state
        if step == .preferences { searchStarted = true }
        let after = OnboardingStep.allCases.filter { $0.number > step.number }
        current = after.first { !isSettled($0) } ?? step.next ?? step
        return true
    }

    /// The daemon's answer wins (another client may have settled a step), keeping the open step.
    public mutating func merge(_ status: OnboardingStatus) {
        let fresh = OnboardingFlow(status: status)
        states = fresh.states
        searchStarted = fresh.searchStarted
        if !canOpen(current) { current = fresh.current }
    }
}

public enum OnboardingText {
    /// "✓ me@gmail.com (Gmail)" or "Not connected: <what it's for>".
    public static func connection(_ c: SetupConnection) -> String {
        c.connected ? c.detail : "Not connected · \(c.detail)"
    }

    public static func tool(_ name: String, _ t: Applyant_V1_ToolStatus) -> String {
        if !t.found { return "\(name) not found" + (t.error.isEmpty ? "" : ": \(t.error)") }
        let version = t.version.isEmpty ? "" : " · \(t.version)"
        return t.signedIn
            ? "\(name) · \(t.path)\(version) · signed in"
            : "\(name) · \(t.path)\(version) · not signed in: run `\(name == "Codex" ? "codex login" : "claude")` in Terminal and sign in"
    }

    /// "2 sources · 1 syncing · 14 facts in 3 projects".
    public static func importProgress(_ status: OnboardingStatus?) -> String {
        guard let p = status?.import, p.sources > 0 else { return "Nothing imported yet" }
        var parts = ["\(p.sources) source\(p.sources == 1 ? "" : "s")"]
        if p.syncing > 0 { parts.append("\(p.syncing) reading") }
        if p.failed > 0 { parts.append("\(p.failed) failed") }
        parts.append("\(p.facts) fact\(p.facts == 1 ? "" : "s") in \(p.projects) project\(p.projects == 1 ? "" : "s")")
        return parts.joined(separator: " · ")
    }

    public static func search(_ flow: OnboardingFlow) -> String {
        flow.searchStarted
            ? "Search has started: the planner proposes strategies from your profile, and postings arrive in the Inbox."
            : "Search starts when you finish Preferences."
    }

    /// A Drive or Docs link (a Google account must be connected), else a web page.
    public static func sourceKind(for link: String) -> Applyant_V1_SourceKind {
        let s = link.lowercased()
        return s.contains("docs.google.com") || s.contains("drive.google.com") ? .drive : .url
    }
}
