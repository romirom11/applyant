// Home, the screen the window opens on: a greeting, a compact grid of tiles (what's ready to
// send, what needs you, the new good matches, questions, what was sent, the searches, and on a
// wide window how it's going), the one tile that lights up while Applyant works on it with a
// strip saying what it's working through, and the next few jobs ready to send. Plain values
// from the store's data, tested without SwiftUI; Overview.swift in the app draws them.
import ApplyantAPI
import Foundation

public enum HomeTile: String, CaseIterable, Identifiable, Sendable {
    case ready, needsYou, new, questions, applied, search

    public var id: String { rawValue }

    /// The tile's label, top left ("Ready to send").
    public var title: String {
        switch self {
        case .ready: "Ready to send"
        case .needsYou: "Needs you"
        case .new: "New"
        case .questions: "Questions for you"
        case .applied: "Applied"
        case .search: "Search"
        }
    }

    /// The section a click opens.
    public var section: Section {
        switch self {
        case .ready, .needsYou: .toReview
        case .new: .new
        case .questions: .interview
        case .applied: .applied
        case .search: .search
        }
    }
}

/// One line of the live tile's list: a source being read, an application being written.
public struct HomeLiveItem: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public var detail: String?
    /// Finished: a check mark. The first unfinished one is the one under way.
    public var done = false

    public init(id: String, title: String, detail: String? = nil, done: Bool = false) {
        self.id = id
        self.title = title
        self.detail = detail
        self.done = done
    }
}

/// The tile that's working now: its title in the middle ("Sending to Kalepa…"), a line under
/// it, how far it is (when that's known) and the list it works through.
public struct HomeLive: Equatable, Sendable {
    public let tile: HomeTile
    public let title: String
    public var note: String?
    public var fraction: Double?
    public var items: [HomeLiveItem] = []
}

/// A tile at rest: its big number and the caption under it that says what it counts ("19" ·
/// "applications to send", "14" · "searches · paused").
public struct HomeFigure: Equatable, Sendable {
    public let value: Int
    public let caption: String
    /// Nothing left to do there: a green dot and this word instead of the caption ("All sent").
    public var done: String?
    /// Who's in it: "Nuitée, Kalepa, DEMV Systems +16".
    public var names: String?
}

/// What Home is showing: the counts and work it's built from.
public struct HomeInput: Equatable, Sendable {
    public var ready = 0
    public var needsYou = 0
    public var newMatches = 0
    public var questions = 0
    public var applied = 0
    public var interviews = 0
    public var offers = 0
    public var searches = 0
    /// Deliveries under way: the company, and what the delivery is doing.
    public var deliveries: [(company: String, progress: DeliveryProgress)] = []
    /// Applications being prepared: company and title.
    public var preparing: [(company: String, title: String)] = []
    /// Searches running now: the name, and each source with what it gave when it's done.
    public var searching: [(name: String, sources: [(label: String, done: String?)])] = []
    /// The kinds of the tasks running now (TaskText's "score_posting").
    public var running: [String] = []
    /// The first few names in a tile's list, top first (companies; for questions, what asks).
    public var names: [HomeTile: [String]] = [:]
    /// Background work paused by the candidate, and since when.
    public var pausedAt: Date?
    /// A limit's pause: "Waiting for claude limit · resumes 15:45".
    public var waiting: String?
    /// To review's jobs ready to send, in its order: Up next shows the first few.
    public var upNext: [ListItem] = []

    public init() {}

    public static func == (a: HomeInput, b: HomeInput) -> Bool {
        a.ready == b.ready && a.needsYou == b.needsYou && a.newMatches == b.newMatches && a.questions == b.questions
            && a.applied == b.applied && a.interviews == b.interviews && a.offers == b.offers && a.searches == b.searches
            && a.deliveries.map(\.company) == b.deliveries.map(\.company) && a.deliveries.map(\.progress) == b.deliveries.map(\.progress)
            && a.preparing.map(\.company) == b.preparing.map(\.company) && a.preparing.map(\.title) == b.preparing.map(\.title)
            && a.searching.map(\.name) == b.searching.map(\.name)
            && a.searching.map { $0.sources.map { "\($0.label)|\($0.done ?? "")" } } == b.searching.map { $0.sources.map { "\($0.label)|\($0.done ?? "")" } }
            && a.running.sorted() == b.running.sorted() && a.pausedAt == b.pausedAt && a.waiting == b.waiting
            && a.names == b.names && a.upNext == b.upNext
    }
}

/// Home's one big round button.
public enum HomeAction: Equatable, Sendable {
    /// To review has something: it opens on its first job.
    case review
    /// Nothing to review, but New has good matches.
    case browse
    /// Nothing at all yet: the searches.
    case search

    public var title: String {
        switch self {
        case .review: "Review"
        case .browse: "Browse"
        case .search: "Search"
        }
    }

    public var section: Section {
        switch self {
        case .review: .toReview
        case .browse: .new
        case .search: .search
        }
    }
}

public enum HomeText {
    /// "Good evening, Roman": the time of day, and the first name when the profile has one.
    public static func greeting(name: String?, at date: Date, calendar: Calendar = .current) -> String {
        let hour = calendar.component(.hour, from: date)
        let part = switch hour {
        case 5..<12: "Good morning"
        case 12..<18: "Good afternoon"
        case 18..<23: "Good evening"
        default: "Good night"
        }
        let first = name?.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: " ").first.map(String.init)
        return first.map { "\(part), \($0)" } ?? part
    }

    /// The line under the greeting: a pause first, else what waits for the candidate.
    public static func state(_ input: HomeInput) -> String {
        if let since = input.pausedAt {
            return "Paused since \(time(since)). Nothing is searched or scored until you resume."
        }
        if let waiting = input.waiting { return waiting + "." }
        let (needs, ready) = (input.needsYou, input.ready)
        switch (needs > 0, ready > 0) {
        case (true, true):
            return "\(needs) application\(needs == 1 ? " needs" : "s need") you and \(ready) \(ready == 1 ? "is" : "are") ready to send."
        case (true, false):
            return "\(needs) application\(needs == 1 ? " needs" : "s need") you."
        case (false, true):
            return "\(ready) application\(ready == 1 ? " is" : "s are") ready to send."
        case (false, false):
            return input.newMatches > 0
                ? "Nothing waits for you. \(input.newMatches) new good match\(input.newMatches == 1 ? "" : "es") to look at."
                : "You're all caught up. Your searches run on their schedule."
        }
    }

    /// The tile that lights up: a delivery first (it goes through even while paused), then,
    /// unless background work is paused, the searches, the applications being written, scoring,
    /// the interview and the mailbox. Nil when nothing runs.
    public static func live(_ input: HomeInput) -> HomeLive? {
        if let first = input.deliveries.first {
            let others = input.deliveries.dropFirst().map { HomeLiveItem(id: "deliver-\($0.company)", title: $0.company, detail: "waiting…") }
            return HomeLive(
                tile: .applied,
                title: "Sending to \(first.company)…",
                note: first.progress.line,
                fraction: first.progress.fraction,
                items: others
            )
        }
        guard input.pausedAt == nil, input.waiting == nil else { return nil }
        if let search = input.searching.first {
            let current = search.sources.first { $0.done == nil }
            let items = search.sources.enumerated().map { i, s in
                HomeLiveItem(id: "source-\(i)-\(s.label)", title: s.label, detail: s.done, done: s.done != nil)
            }
            return HomeLive(
                tile: .search,
                title: current.map { "Reading \($0.label)…" } ?? "Searching \(search.name)…",
                note: current == nil ? nil : search.name,
                items: items
            )
        }
        if let first = input.preparing.first {
            let items = input.preparing.enumerated().map { i, p in
                HomeLiveItem(id: "prepare-\(i)-\(p.company)", title: p.company, detail: i == 0 ? p.title : "waiting…")
            }
            return HomeLive(tile: .ready, title: "Writing answers for \(first.company)…", note: first.title, items: items.count > 1 ? items : [])
        }
        let kinds = Dictionary(grouping: input.running, by: { $0 }).mapValues(\.count)
        func phrase(_ kind: String) -> String { TaskText.phrase(kind, count: kinds[kind] ?? 1).capitalizedFirst + "…" }
        if let kind = ["score_posting", "verify_posting", "rematch_postings"].first(where: { kinds[$0] != nil }) {
            return HomeLive(tile: .new, title: phrase(kind))
        }
        if let kind = ["plan_search", "search", "build_recipe"].first(where: { kinds[$0] != nil }) {
            return HomeLive(tile: .search, title: phrase(kind))
        }
        if let kind = ["prepare_application", "read_form", "research_company"].first(where: { kinds[$0] != nil }) {
            return HomeLive(tile: .ready, title: phrase(kind))
        }
        if let kind = ["interview_open", "interview_turn", "sync_source", "embed_facts"].first(where: { kinds[$0] != nil }) {
            return HomeLive(tile: .questions, title: phrase(kind))
        }
        if let kind = ["sync_mail", "interview_event"].first(where: { kinds[$0] != nil }) {
            return HomeLive(tile: .applied, title: phrase(kind))
        }
        return nil
    }

    /// A tile's number and caption at rest.
    public static func figure(_ tile: HomeTile, _ input: HomeInput) -> HomeFigure {
        var figure = bare(tile, input)
        figure.names = names(input.names[tile] ?? [], of: figure.value)
        return figure
    }

    /// "Nuitée, Kalepa, DEMV Systems +16": the first three different names, and how many more.
    public static func names(_ names: [String], of total: Int) -> String? {
        var seen = Set<String>()
        let unique = names.filter { !$0.isEmpty && seen.insert($0).inserted }
        guard !unique.isEmpty, total > 0 else { return nil }
        let shown = unique.prefix(3)
        let more = total - shown.count
        return shown.joined(separator: ", ") + (more > 0 ? " +\(more)" : "")
    }

    private static func bare(_ tile: HomeTile, _ input: HomeInput) -> HomeFigure {
        switch tile {
        case .ready:
            return HomeFigure(value: input.ready, caption: input.ready == 1 ? "application to send" : "applications to send",
                              done: input.ready == 0 && input.preparing.isEmpty ? "All sent" : nil)
        case .needsYou:
            return HomeFigure(value: input.needsYou, caption: input.needsYou == 1 ? "application needs you" : "applications need you",
                              done: input.needsYou == 0 ? "Nothing waits" : nil)
        case .new:
            return HomeFigure(value: input.newMatches, caption: input.newMatches == 1 ? "good match" : "good matches",
                              done: input.newMatches == 0 ? "All looked at" : nil)
        case .questions:
            return HomeFigure(value: input.questions, caption: input.questions == 1 ? "question waits" : "questions wait",
                              done: input.questions == 0 ? "All answered" : nil)
        case .applied:
            return HomeFigure(value: input.applied, caption: input.applied == 1 ? "application sent" : "applications sent")
        case .search:
            let searches = input.searches == 1 ? "search" : "searches"
            return HomeFigure(value: input.searches, caption: input.pausedAt != nil ? "\(searches) · paused" : input.searches == 1 ? "search on its schedule" : "searches on their schedule")
        }
    }

    /// Up next's jobs: the first few ready to send, in To review's order (a click opens one
    /// there, and sending moves on to the next as it does in the list).
    public static func upNext(_ input: HomeInput, limit: Int = 4) -> [ListItem] {
        Array(input.upNext.prefix(max(limit, 0)))
    }

    /// The line beside Up next's title: "4 of 80 ready to send", "All 3 ready to send"; nil
    /// when nothing is.
    public static func upNextLine(shown: Int, total: Int) -> String? {
        guard shown > 0, total > 0 else { return nil }
        return shown < total ? "\(shown) of \(total) ready to send" : total == 1 ? "The one ready to send" : "All \(total) ready to send"
    }

    /// Up next with nothing ready: what comes first instead.
    public static func upNextEmpty(_ input: HomeInput) -> String {
        if input.needsYou > 0 {
            return "Nothing is ready to send: \(input.needsYou) application\(input.needsYou == 1 ? " needs" : "s need") you first."
        }
        if !input.preparing.isEmpty { return "Nothing is ready to send yet: answers are being written." }
        return "Nothing is ready to send."
    }

    /// The funnel's tile on Home: the first step and the last ones (found → applied →
    /// interview → offer), so a few numbers say how far the postings got; every step when
    /// there are only a few.
    public static func funnelSummary(_ rows: [FunnelRow], limit: Int = 4) -> [FunnelRow] {
        guard rows.count > limit, let first = rows.first else { return rows }
        return [first] + rows.suffix(limit - 1)
    }

    public static func action(_ input: HomeInput) -> HomeAction {
        if input.ready + input.needsYou > 0 { return .review }
        if input.newMatches > 0 { return .browse }
        return .search
    }

    private static func time(_ date: Date) -> String {
        Calendar.current.isDateInToday(date)
            ? date.formatted(date: .omitted, time: .shortened)
            : date.formatted(.dateTime.day().month(.abbreviated).hour().minute())
    }
}

/// The grid's shape: the six tiles in three columns, or, from `wideWidth` on, in four with the
/// funnel's tile taking the last two places, every tile the same height (no tile grows: the
/// live one says what it does in the strip under the grid).
public enum HomeGrid {
    public enum Slot: Hashable, Sendable {
        case tile(HomeTile)
        /// How it's going: the funnel in a few numbers.
        case funnel
    }

    /// From this width on, four columns.
    public static let wideWidth: Double = 1060

    public static func columns(width: Double) -> Int { width >= wideWidth ? 4 : 3 }

    /// The slots in their rows, top to bottom.
    public static func rows(columns: Int) -> [[Slot]] {
        let tiles = HomeTile.allCases.map(Slot.tile)
        guard columns >= 4 else { return [Array(tiles[0..<3]), Array(tiles[3...])] }
        return [Array(tiles[0..<4]), Array(tiles[4...]) + [.funnel]]
    }

    /// How many columns a slot takes: the funnel two, a tile one.
    public static func span(_ slot: Slot) -> Int { slot == .funnel ? 2 : 1 }

    /// A slot's width in a row `total` wide: its columns and the gaps between them.
    public static func width(_ slot: Slot, columns: Int, total: Double, spacing: Double) -> Double {
        let column = max(total - spacing * Double(columns - 1), 0) / Double(max(columns, 1))
        let span = Double(span(slot))
        return column * span + spacing * (span - 1)
    }

    /// The tiles' height: 150 to 170 points, a little taller on a taller window.
    public static func tileHeight(window: Double) -> Double { min(max(window * 0.18, 150), 170) }
}

extension AppStore {
    /// Home's input from what the store holds now.
    public var homeInput: HomeInput {
        var input = HomeInput()
        input.ready = review(.ready).count
        input.needsYou = review(.needsYou).count
        input.newMatches = count(.new)
        input.questions = openInterviewCount
        input.applied = items(.applied).count
        input.interviews = items(.interviews).count
        input.offers = items(.offers).count
        input.searches = search.strategies.filter { $0.state != "paused" }.count
        func company(_ app: Application?) -> String { app.map { $0.hasCompany ? $0.company : ($0.hasTitle ? $0.title : "an application") } ?? "an application" }
        input.deliveries = deliveries.sorted { $0.key < $1.key }.map { (company(applications[$0.key]), $0.value) }
        input.preparing = applications.values.filter { $0.stage == .preparing }.sorted { $0.id < $1.id }
            .map { (company($0), $0.hasTitle ? $0.title : "") }
        input.searching = search.strategies.filter(\.running).map { s in
            // The run under way says which of its sources are read already.
            let run = searchRuns.first { $0.strategyID == s.id && $0.status == "queued" }
            let done = Dictionary(run?.sources.map { ($0.sourceKey, $0) } ?? [], uniquingKeysWith: { a, _ in a })
            let sources = s.sourceKeys.map { key -> (label: String, done: String?) in
                let label = source(key)?.label ?? key
                return (label, done[key].map { HomeText.sourceResult($0) })
            }
            return (s.name, sources)
        }
        input.running = Array(activity.running.values)
        func companies(_ items: [ListItem]) -> [String] {
            items.prefix(12).compactMap { item in
                item.applicationId.flatMap { applications[$0] }.flatMap { $0.hasCompany ? $0.company : nil }
                    ?? postings[item.postingId].flatMap { $0.hasCompany ? $0.company : nil }
            }
        }
        input.names = [
            .ready: companies(review(.ready)),
            .needsYou: companies(review(.needsYou)),
            .new: companies(items(.new)),
            .applied: companies(items(.applied)),
            .questions: interviewQuestions.filter { $0.status == "open" }.prefix(12).compactMap { q in
                q.hasApplication ? q.application.components(separatedBy: " · ").first : nil
            },
        ]
        input.pausedAt = backgroundPausedAt
        input.waiting = activity.paused
        input.upNext = Array(review(.ready).prefix(8))
        return input
    }
}

extension HomeText {
    /// "38 listed · 3 new" for a source a running search has read.
    static func sourceResult(_ s: Applyant_V1_SearchRunSource) -> String {
        if s.hasError { return "failed" }
        var parts = ["\(s.listed) listed"]
        if s.added > 0 { parts.append("\(s.added) new") }
        return parts.joined(separator: " · ")
    }
}

extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}
