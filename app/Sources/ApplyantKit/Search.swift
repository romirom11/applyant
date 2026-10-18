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
        "smartrecruiters": "SmartRecruiters", "personio": "Personio", "recruitee": "Recruitee",
        "teamtailor": "Teamtailor", "join": "JOIN", "breezy": "Breezy HR",
        "page": "Career pages and feeds", "board": "Job boards",
        "linkedin": "LinkedIn", "xing": "Xing", "telegram": "Telegram channels",
    ]

    /// "6 h" · "90 min" · "1 day".
    public static func every(_ minutes: Int32) -> String {
        if minutes % 1440 == 0 { return minutes == 1440 ? "1 day" : "\(minutes / 1440) days" }
        if minutes % 60 == 0 { return "\(minutes / 60) h" }
        return "\(minutes) min"
    }

    /// "38 found · 29 verified · 12 interested (41%)", as the PRD's table reads; a count of
    /// nothing is left out ("38 found · 29 verified"), and "Nothing found yet" before anything.
    public static func stats(_ s: Applyant_V1_SearchStats) -> String {
        guard s.found > 0 else { return "Nothing found yet" }
        var parts = ["\(s.found) found"]
        if s.verified > 0 { parts.append("\(s.verified) verified") }
        if s.interested > 0 {
            let share = s.verified > 0 ? " (\(Int((100 * Double(s.interested) / Double(s.verified)).rounded()))%)" : ""
            parts.append("\(s.interested) interested\(share)")
        }
        return parts.joined(separator: " · ")
    }

    /// Who made most of the searches, said once over the list ("Planned by Applyant"); nil when
    /// most are the candidate's own.
    public static func origin(_ list: SearchList) -> String? {
        let agent = list.strategies.filter { $0.origin == "agent" }.count
        return agent * 2 > list.strategies.count ? "Planned by Applyant" : nil
    }

    /// How often most searches are set to run ("every 6 h" on most of them goes without saying).
    static func usualEvery(_ list: SearchList) -> Int32? {
        let counts = Dictionary(grouping: list.strategies, by: \.everyMinutes).mapValues(\.count)
        return counts.max { ($0.value, $1.key) < ($1.value, $0.key) }?.key
    }

    /// Each search's row: what it found, and a chip only where it differs from the others
    /// (paused, a cadence of its own, made by the other hand, a problem).
    public static func strategyRows(_ list: SearchList) -> [SearchRow] {
        let usual = usualEvery(list)
        let agentLed = origin(list) != nil
        return list.strategies.map { s in
            var chips: [Chip] = []
            if s.running { chips.append(Chip(text: "Running…", tone: .accent)) }
            if s.state == "paused" {
                chips.append(Chip(text: "Paused", tone: .neutral))
            } else if effectiveEvery(s) != usual {
                chips.append(Chip(text: "Every \(every(effectiveEvery(s)))", tone: .neutral))
            }
            if s.hasCadenceNote { chips.append(Chip(text: "Runs less often", tone: .warning)) }
            if agentLed, s.origin != "agent" { chips.append(Chip(text: "Yours", tone: .neutral)) }
            if !agentLed, s.origin == "agent" { chips.append(Chip(text: "Planned by Applyant", tone: .accent)) }
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

    /// The planner's last run in one line: "Last plan · 4 new searches, 14 boards"; its note is
    /// behind Details….
    public static func planLine(_ p: SearchPlan) -> String {
        switch p.status {
        case "queued": return "Planning searches…"
        case "failed": return "The last plan failed"
        default:
            let searches = p.strategyIds.count, boards = p.boardKeys.count
            guard searches + boards > 0 else { return "Last plan · nothing new" }
            var parts: [String] = []
            if searches > 0 { parts.append("\(searches) new search\(searches == 1 ? "" : "es")") }
            if boards > 0 { parts.append("\(boards) board\(boards == 1 ? "" : "s")") }
            return "Last plan · " + parts.joined(separator: ", ")
        }
    }

    /// The detail pane with nothing picked: how the searching stands, as label and value.
    public static func summary(_ list: SearchList, runs: [SearchRun]) -> [(label: String, value: String)] {
        let on = list.strategies.filter { $0.state != "paused" }.count
        let sources = list.sources.filter { $0.enabled && $0.kindEnabled }.count
        var items = [
            (label: "Searches", value: "\(on) of \(list.strategies.count) on"),
            (label: "Sources", value: "\(sources) of \(list.sources.count) on"),
        ]
        let finished = runs.filter { $0.status != "queued" }
        if !finished.isEmpty {
            let added = finished.map(\.added).reduce(0, +)
            items.append((label: "Recent runs", value: "\(finished.count) · \(added) new"))
            let failed = finished.filter { $0.status == "failed" }.count
            if failed > 0 { items.append((label: "Failed", value: "\(failed)")) }
        }
        return items
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

    /// Runs started together (the same minute, the same trigger) under one header, newest
    /// first: the schedule starts every search at once.
    public static func runBatches(_ runs: [SearchRun], calendar: Calendar = .current) -> [RunBatch] {
        var batches: [RunBatch] = []
        for run in runs {
            let minute = calendar.dateInterval(of: .minute, for: run.startedAt.date)?.start ?? run.startedAt.date
            if let last = batches.last, last.minute == minute, last.trigger == run.trigger {
                batches[batches.count - 1].runs.append(run)
            } else {
                batches.append(RunBatch(minute: minute, trigger: run.trigger, runs: [run]))
            }
        }
        return batches
    }

    /// A run's row in its batch: a chip only for what sets it apart (running, failed, new
    /// postings); the batch's header says when and why.
    public static func runRowChips(_ r: SearchRun) -> [Chip] {
        switch r.status {
        case "queued": [Chip(text: "Running…", tone: .accent)]
        case "failed": [Chip(text: "Failed", tone: .warning)]
        default: r.added > 0 ? [Chip(text: "\(r.added) new", tone: .good)] : []
        }
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

/// Search runs started together: "Oct 17, 21:00 · on schedule" over its runs.
public struct RunBatch: Identifiable, Equatable, Sendable {
    public let minute: Date
    public let trigger: String
    public internal(set) var runs: [SearchRun]
    public var id: String { "\(minute.timeIntervalSince1970)-\(trigger)" }

    public var title: String {
        minute.formatted(.dateTime.month(.abbreviated).day().hour().minute()) + " · " + SearchText.trigger(trigger)
    }
}

extension SearchSource {
    /// Postings this source listed.
    var found: Int32 { hasStats ? stats.found : 0 }
}
