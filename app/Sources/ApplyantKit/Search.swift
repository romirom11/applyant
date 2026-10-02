// Search as the app shows it: strategies and sources with what they found, and runs with what
// each source gave. Plain values, tested without SwiftUI.
import ApplyantAPI
import Foundation

/// What the Search section's detail pane shows.
public enum SearchSelection: Hashable, Sendable {
    case strategy(Int64)
    case source(String)
}

public struct SearchRow: Identifiable, Equatable, Sendable {
    public let selection: SearchSelection
    public let title: String
    public let subtitle: String
    public let chips: [Chip]
    /// Switched on (a strategy: active; a source: it and its kind are on).
    public let on: Bool
    public var id: SearchSelection { selection }
}

public enum SearchText {
    public static let kindTitles: [String: String] = [
        "greenhouse": "Greenhouse", "ashby": "Ashby", "lever": "Lever", "workable": "Workable",
        "page": "Career pages and feeds", "board": "Job boards",
        "linkedin": "LinkedIn", "xing": "Xing", "telegram": "Telegram channels",
    ]

    /// "6 h" · "90 min" · "1 day".
    public static func every(_ minutes: Int32) -> String {
        if minutes % 1440 == 0 { return minutes == 1440 ? "1 day" : "\(minutes / 1440) days" }
        if minutes % 60 == 0 { return "\(minutes / 60) h" }
        return "\(minutes) min"
    }

    /// "38 found · 29 verified · 12 interested (41%)", as the PRD's table reads.
    public static func stats(_ s: Applyant_V1_SearchStats) -> String {
        var parts = ["\(s.found) found", "\(s.verified) verified"]
        if s.interested > 0 {
            let share = s.verified > 0 ? " (\(Int((100 * Double(s.interested) / Double(s.verified)).rounded()))%)" : ""
            parts.append("\(s.interested) interested\(share)")
        } else {
            parts.append("0 interested")
        }
        return parts.joined(separator: " · ")
    }

    public static func strategyRows(_ list: SearchList) -> [SearchRow] {
        list.strategies.map { s in
            var chips: [Chip] = []
            if s.running { chips.append(Chip(text: "Running…", tone: .accent)) }
            chips.append(s.state == "paused" ? Chip(text: "Paused", tone: .neutral) : Chip(text: "Every \(every(effectiveEvery(s)))", tone: .good))
            if s.hasCadenceNote { chips.append(Chip(text: "Runs less often", tone: .warning)) }
            if s.origin == "agent" { chips.append(Chip(text: "Agent-generated", tone: .accent)) }
            if s.sourceKeys.isEmpty { chips.append(Chip(text: "No source on", tone: .warning)) }
            if s.hasLastRun, s.lastRun.status == "failed" { chips.append(Chip(text: "Last run failed", tone: .warning)) }
            return SearchRow(
                selection: .strategy(s.id),
                title: s.name,
                subtitle: stats(s.stats),
                chips: chips,
                on: s.state != "paused"
            )
        }
    }

    /// How often a strategy actually runs (a weak one runs less often than it's set to).
    public static func effectiveEvery(_ s: SearchStrategy) -> Int32 {
        s.effectiveEveryMinutes > 0 ? s.effectiveEveryMinutes : s.everyMinutes
    }

    /// "Plan 3 · by you · 2 new strategies · 5 new boards watched · …", or that it's running.
    public static func planSummary(_ p: SearchPlan) -> String {
        let who = p.trigger == "schedule" ? "weekly" : "by you"
        switch p.status {
        case "queued": return "Planning searches (\(who))…"
        case "failed": return "The last plan failed: \(p.hasNote ? p.note : "no reason given")"
        default: return p.hasNote ? p.note : "Planned \(who)"
        }
    }

    /// A career page's listing recipe as a chip.
    public static func recipeChip(_ r: Applyant_V1_ListingRecipe) -> Chip {
        switch r.status {
        case "ok": Chip(text: "Reads this page", tone: .good)
        case "building": Chip(text: "Learning to read it…", tone: .accent)
        default: Chip(text: "Can't read it yet", tone: .warning)
        }
    }

    /// Sources grouped by kind, in the daemon's order, each kind with its own switch.
    public static func sourceGroups(_ list: SearchList) -> [(kind: Applyant_V1_SearchSourceKind, rows: [SearchRow])] {
        list.kinds.compactMap { kind in
            let rows = list.sources.filter { $0.kind == kind.kind }.map { sourceRow($0) }
            // Telegram channels stay listed with none followed yet: that's where one is followed.
            return rows.isEmpty && kind.kind != "telegram" ? nil : (kind, rows)
        }
    }

    public static func sourceRow(_ s: SearchSource) -> SearchRow {
        var chips: [Chip] = []
        if !s.enabled { chips.append(Chip(text: "Off", tone: .neutral)) }
        else if !s.kindEnabled { chips.append(Chip(text: "Off (\(kindTitles[s.kind] ?? s.kind))", tone: .neutral)) }
        chips.append(s.completeList ? Chip(text: "Complete list", tone: .good) : Chip(text: "Latest jobs", tone: .neutral))
        if s.hasRecipe { chips.append(recipeChip(s.recipe)) }
        if s.origin == "agent" { chips.append(Chip(text: "Found by the agent", tone: .accent)) }
        if s.hasLastNote, s.lastNote.hasPrefix("failed") { chips.append(Chip(text: "Last read failed", tone: .warning)) }
        return SearchRow(
            selection: .source(s.key),
            title: s.label,
            subtitle: s.found > 0 || s.hasLastRunAt ? stats(s.stats) : s.key,
            chips: chips,
            on: s.enabled && s.kindEnabled
        )
    }

    /// "12 listed · 3 matched · 1 new · complete list · 1 closed", or why it failed.
    public static func runSource(_ r: Applyant_V1_SearchRunSource) -> String {
        if r.hasError { return "Failed: \(r.error)" }
        var parts = ["\(r.listed) listed", "\(r.matched) matched", "\(r.added) new"]
        if r.attached > 0 { parts.append("\(r.attached) already known") }
        parts.append(r.complete ? "complete list" : "partial list")
        if r.closed > 0 { parts.append("\(r.closed) closed") }
        if r.reopened > 0 { parts.append("\(r.reopened) reopened") }
        if r.reverify > 0 { parts.append("\(r.reverify) to re-verify") }
        return parts.joined(separator: " · ")
    }

    public static func trigger(_ t: String) -> String {
        switch t {
        case "wake": "missed while the Mac slept"
        case "manual": "run by hand"
        default: "on schedule"
        }
    }

    public static func runTitle(_ r: SearchRun) -> String {
        "\(r.strategyName) · run \(r.id)"
    }

    public static func runChips(_ r: SearchRun) -> [Chip] {
        var chips: [Chip] = []
        switch r.status {
        case "queued": chips.append(Chip(text: "Running…", tone: .accent))
        case "failed": chips.append(Chip(text: "Failed", tone: .warning))
        default: chips.append(Chip(text: "\(r.added) new", tone: r.added > 0 ? .good : .neutral))
        }
        if r.trigger == "wake" { chips.append(Chip(text: "After wake", tone: .neutral)) }
        return chips
    }

    /// One event of a run, as a log line ("verify_posting(12) done").
    public static func eventLine(_ e: DaemonEvent) -> String {
        let message = e.message.isEmpty ? "" : " — \(e.message)"
        switch e.payload {
        case let .task(t)?:
            return "\(t.taskKind)(\(t.entityID)) \(taskWord(t.type))\(message)"
        case let .posting(p)?:
            return "posting \(p.postingID) → \(stageWord(p.stage))\(message)"
        case let .search(s)?:
            return "search \(s.status)\(message)"
        case let .application(a)?:
            return "application \(a.applicationID) → \(a.stage)\(message)"
        default:
            return e.message
        }
    }

    static func taskWord(_ t: Applyant_V1_TaskEventType) -> String {
        switch t {
        case .queued: "queued"
        case .started: "started"
        case .progress: "…"
        case .done: "done"
        case .retry: "retry"
        case .failed: "failed"
        case .providerPaused: "waiting for a limit"
        case .needsCandidate: "needs you"
        case .leaseLost: "lease lost"
        case .requeued: "requeued"
        default: "\(t)"
        }
    }

    static func stageWord(_ s: PostingStage) -> String {
        switch s {
        case .found: "found"
        case .verified: "verified"
        case .failedVerification: "failed verification"
        case .scored: "scored"
        case .skipped: "skipped"
        case .closed: "closed"
        default: "\(s)"
        }
    }
}

extension SearchSource {
    /// Postings this source listed.
    var found: Int32 { hasStats ? stats.found : 0 }
}
