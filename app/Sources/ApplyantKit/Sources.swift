// Sources as the app shows them: every kind of place Applyant reads jobs from, grouped (the ATS
// index per ATS, the searches across companies, career pages and feeds, job boards, Telegram,
// LinkedIn and Xing), each with its switch. A company is one thing: it lives in the index, under
// its ATS, and one it watches as well (an ATS source) says so there, with one switch for both;
// the list never shows companies one by one. The index's discovery runs and its companies a page
// at a time. Plain values, tested without SwiftUI.
import ApplyantAPI
import Foundation

public typealias AtsIndex = Applyant_V1_GetAtsIndexResponse
public typealias AtsIndexAts = Applyant_V1_AtsIndexAts
public typealias AtsIndexDiscovery = Applyant_V1_AtsIndexDiscovery
public typealias IndexCompany = Applyant_V1_IndexCompany

/// What the Sources section's detail pane shows.
public indirect enum SourcesSelection: Hashable, Sendable {
    /// Every company on ATS: the index, its totals, discovery and companies.
    case index
    /// One ATS in the index ("greenhouse"), with its companies.
    case ats(String)
    /// One source by key (its detail, as Search had it).
    case source(String)
    /// One company of the index, opened from the list it's in (`.index` or `.ats`).
    case company(Int64, in: SourcesSelection)

    /// The row of the list it sits under: a company under the list it was opened from, a watched
    /// ATS board under its ATS, anything else its own row.
    public var listRow: SourcesSelection {
        switch self {
        case let .company(_, parent): return parent.listRow
        case let .source(key):
            let kind = String(key.prefix { $0 != ":" })
            return key.contains(":") && SourcesText.isAts(kind) ? .ats(kind) : self
        default: return self
        }
    }
}

/// A group of the Sources list, in the screen's order: kinds of sources, never single companies.
public enum SourceGroupID: String, CaseIterable, Sendable {
    case index, acrossCompanies, pages, boards, telegram, platforms

    public var title: String {
        switch self {
        case .index: "Every company on ATS"
        case .acrossCompanies: "Searches across companies"
        case .pages: "Career pages and feeds"
        case .boards: "Job boards"
        case .telegram: "Telegram"
        case .platforms: "LinkedIn and Xing"
        }
    }
}

/// A kind's sources inside a group, with the kind's switch (nil: the group has no kind switch,
/// as the cross-company searches, which are boards of their own).
public struct SourceBlock: Equatable, Sendable {
    public let kind: Applyant_V1_SearchSourceKind?
    public let rows: [SearchRow]
    public var title: String { kind.map { SourcesText.kindTitle($0.kind, label: $0.label) } ?? "" }
}

public struct SourceGroup: Identifiable, Equatable, Sendable {
    public let id: SourceGroupID
    public let blocks: [SourceBlock]
    public var title: String { id.title }
    public var rows: [SearchRow] { blocks.flatMap(\.rows) }
}

/// One ATS of the index as its row reads.
public struct IndexAtsRow: Identifiable, Equatable, Sendable {
    public let ats: String
    public let title: String
    public let subtitle: String
    public let chips: [Chip]
    public let on: Bool
    public let lastReadAt: Date?
    public var id: String { ats }
}

/// The companies browser's filter and page.
public struct IndexCompanyFilter: Equatable, Hashable, Sendable {
    public static let pageSize: Int32 = 100

    /// One ATS; nil: all.
    public var ats: String?
    public var query: String
    public var matchingOnly: Bool
    public var offset: Int32

    public init(ats: String? = nil, query: String = "", matchingOnly: Bool = false, offset: Int32 = 0) {
        self.ats = ats
        self.query = query
        self.matchingOnly = matchingOnly
        self.offset = offset
    }

    /// The same filter from its first page (a changed query or ATS starts over).
    public var firstPage: IndexCompanyFilter {
        var f = self
        f.offset = 0
        return f
    }

    public var request: Applyant_V1_ListIndexCompaniesRequest {
        .with {
            if let ats { $0.ats = ats }
            $0.query = query.trimmingCharacters(in: .whitespacesAndNewlines)
            $0.matchingOnly = matchingOnly
            $0.limit = Self.pageSize
            $0.offset = offset
        }
    }
}

/// A page of the index's companies, as ListIndexCompanies gave it.
public struct IndexCompanyPage: Equatable, Sendable {
    public let filter: IndexCompanyFilter
    public internal(set) var companies: [IndexCompany]
    public let total: Int32

    public init(filter: IndexCompanyFilter, companies: [IndexCompany], total: Int32) {
        self.filter = filter
        self.companies = companies
        self.total = total
    }

    /// "1–100 of 4,210" · "No companies".
    public var line: String {
        guard total > 0, !companies.isEmpty else { return "No companies" }
        let first = filter.offset + 1
        let last = filter.offset + Int32(companies.count)
        return "\(SourcesText.number(first))–\(SourcesText.number(last)) of \(SourcesText.number(total))"
    }

    public var previous: IndexCompanyFilter? {
        guard filter.offset > 0 else { return nil }
        var f = filter
        f.offset = max(0, filter.offset - IndexCompanyFilter.pageSize)
        return f
    }

    public var next: IndexCompanyFilter? {
        let end = filter.offset + Int32(companies.count)
        guard !companies.isEmpty, end < total else { return nil }
        var f = filter
        f.offset = end
        return f
    }

    mutating func replace(_ company: IndexCompany) {
        if let i = companies.firstIndex(where: { $0.id == company.id }) { companies[i] = company }
    }
}

public enum SourcesText {
    /// The index's own source: its switch is the index's master switch.
    public static let indexKey = "board:ats-index"
    /// Built-in boards that search every company on an ATS (or the web for ATS jobs).
    public static let acrossCompaniesKeys = ["board:workable-search", "board:smartrecruiters-search", "board:ats-web-search"]
    /// Kinds that aren't an ATS; every other kind is one (new ATSs need no change here).
    static let nonAts: Set<String> = ["page", "board", "telegram", "linkedin", "xing"]

    public static func isAts(_ kind: String) -> Bool { !nonAts.contains(kind) }

    /// A kind's title: the app's own name for it, else the daemon's label, else the kind.
    public static func kindTitle(_ kind: String, label: String = "") -> String {
        SearchText.kindTitles[kind] ?? (label.isEmpty ? kind.prefix(1).uppercased() + kind.dropFirst() : label)
    }

    /// "4,210": counts read with grouping, the same in every locale.
    public static func number<N: BinaryInteger>(_ n: N) -> String {
        Int(n).formatted(.number.locale(Locale(identifier: "en_US")))
    }

    static func plural(_ n: Int32, _ one: String, _ many: String? = nil) -> String {
        "\(number(n)) \(n == 1 ? one : many ?? one + "s")"
    }

    /// Sources a run would read now (it and its kind on), of all.
    public static func onCount(_ list: SearchList) -> (on: Int, all: Int) {
        (list.sources.filter { $0.enabled && $0.kindEnabled }.count, list.sources.count)
    }

    /// "23 of 31 sources on".
    public static func onLine(_ list: SearchList) -> String {
        let c = onCount(list)
        return "\(c.on) of \(c.all) source\(c.all == 1 ? "" : "s") on"
    }

    /// The Sources list's groups after the index: each group's sources under their kind's
    /// switch, in the screen's order. Watched ATS boards aren't among them: they're companies of
    /// the index, under their ATS. Empty groups are left out, except Telegram (that's where a
    /// channel is followed).
    public static func groups(_ list: SearchList) -> [SourceGroup] {
        let kinds = list.kinds
        func kind(_ k: String) -> Applyant_V1_SearchSourceKind {
            kinds.first { $0.kind == k } ?? .with { $0.kind = k; $0.label = kindTitle(k); $0.enabled = true }
        }
        func rows(_ keep: (SearchSource) -> Bool) -> [SearchRow] {
            list.sources.filter(keep).map { SearchText.sourceRow($0) }
        }
        let across = acrossCompaniesKeys.compactMap { key in list.sources.first { $0.key == key } }.map { SearchText.sourceRow($0) }
        let skip = Set(acrossCompaniesKeys + [indexKey])
        var groups: [SourceGroup] = []
        if !across.isEmpty { groups.append(SourceGroup(id: .acrossCompanies, blocks: [SourceBlock(kind: nil, rows: across)])) }
        let pages = rows { $0.kind == "page" }
        if !pages.isEmpty { groups.append(SourceGroup(id: .pages, blocks: [SourceBlock(kind: kind("page"), rows: pages)])) }
        let boards = rows { $0.kind == "board" && !skip.contains($0.key) }
        if !boards.isEmpty { groups.append(SourceGroup(id: .boards, blocks: [SourceBlock(kind: kind("board"), rows: boards)])) }
        groups.append(SourceGroup(id: .telegram, blocks: [SourceBlock(kind: kind("telegram"), rows: rows { $0.kind == "telegram" })]))
        let platforms = ["linkedin", "xing"].compactMap { k -> SourceBlock? in
            let r = rows { $0.kind == k }
            return r.isEmpty ? nil : SourceBlock(kind: kind(k), rows: r)
        }
        if !platforms.isEmpty { groups.append(SourceGroup(id: .platforms, blocks: platforms)) }
        return groups
    }

    /// The watched boards of one ATS (its sources): companies of the index you also watch.
    public static func watchedCount(_ list: SearchList, ats: String) -> Int {
        list.sources.filter { $0.kind == ats }.count
    }

    /// The list a company was opened from, as its back button says: "All companies", "Greenhouse".
    public static func listTitle(_ selection: SourcesSelection) -> String {
        switch selection.listRow {
        case .index: "All companies"
        case let .ats(ats): kindTitle(ats)
        default: "Sources"
        }
    }

    // MARK: Paused

    public static let pausedTitle = "Background work is paused"
    /// The index pane's callout, in full.
    public static let pausedDetail = "The index isn't read and no companies are looked for until you resume."
    /// The same in one sentence (the list header's tooltip, the menu).
    public static let pausedLine = "Background work is paused: the index isn't read and no companies are looked for until you resume."
    /// The list's header, short.
    public static let pausedNote = "Paused: nothing is read until you resume"

    /// Find More Companies' tooltip: what it does, or why it can't now.
    public static func findMoreHelp(paused: Bool, running: Bool) -> String {
        if paused { return "Background work is paused: no companies are looked for until you resume" }
        if running { return "A discovery is waiting or running" }
        return "Looks for more company boards now: in Common Crawl's index of the web, behind postings and in the job searches (it also runs weekly)"
    }

    // MARK: The index

    /// The index's master switch: what GetAtsIndex says, else its source's own switch (only its
    /// own: the index isn't a job board, and "Job boards" off leaves it on).
    public static func indexOn(_ index: AtsIndex?, list: SearchList) -> Bool {
        if let index { return index.enabled }
        return list.sources.first { $0.key == indexKey }?.enabled ?? false
    }

    /// "4,210 companies · 12,300 open jobs · 85 matching".
    public static func indexLine(_ index: AtsIndex) -> String {
        guard index.companies > 0 else { return "No companies yet" }
        return [
            plural(index.companies, "company", "companies"),
            plural(index.jobs, "open job"),
            "\(number(index.matching)) matching",
        ].joined(separator: " · ")
    }

    /// The index's totals, as label and value.
    public static func indexTotals(_ index: AtsIndex) -> [(label: String, value: String)] {
        var items = [
            (label: "Companies", value: number(index.companies)),
            (label: "Open jobs", value: number(index.jobs)),
            (label: "Matching your searches", value: number(index.matching)),
        ]
        let due = index.ats.map(\.due).reduce(0, +)
        let failing = index.ats.map(\.failing).reduce(0, +)
        if due > 0 { items.append((label: "Due to read", value: number(due))) }
        if failing > 0 { items.append((label: "Failing", value: number(failing))) }
        return items
    }

    /// One ATS's totals, as label and value.
    public static func atsTotals(_ a: AtsIndexAts) -> [(label: String, value: String)] {
        [
            (label: "Companies", value: number(a.companies)),
            (label: "Hiring", value: number(a.hiring)),
            (label: "Open jobs", value: number(a.jobs)),
            (label: "Matching", value: number(a.matching)),
            (label: "Due", value: number(a.due)),
            (label: "Failing", value: number(a.failing)),
        ]
    }

    public static func atsTitle(_ a: AtsIndexAts) -> String { kindTitle(a.ats, label: a.label) }

    /// An ATS's row: "1,204 companies · 312 hiring · 2,140 jobs · 14 matching", and a chip only
    /// for what needs a look (off, boards waiting, boards failing).
    public static func atsRow(_ a: AtsIndexAts) -> IndexAtsRow {
        var chips: [Chip] = []
        if !a.enabled { chips.append(Chip(text: "Off", tone: .neutral)) }
        if a.enabled, a.due > 0 { chips.append(Chip(text: "\(number(a.due)) due", tone: .neutral)) }
        if a.failing > 0 { chips.append(Chip(text: "\(number(a.failing)) failing", tone: .warning)) }
        let subtitle = a.companies == 0 ? "No companies yet" : [
            plural(a.companies, "company", "companies"),
            "\(number(a.hiring)) hiring",
            plural(a.jobs, "job"),
            "\(number(a.matching)) matching",
        ].joined(separator: " · ")
        return IndexAtsRow(
            ats: a.ats, title: atsTitle(a), subtitle: subtitle, chips: chips, on: a.enabled,
            lastReadAt: a.hasLastReadAt ? a.lastReadAt.date : nil
        )
    }

    /// The latest discovery in a line: "Looking for more companies…", "Last discovery (weekly) ·
    /// 120 boards found, 34 new", "The last discovery failed".
    public static func discoveryLine(_ d: AtsIndexDiscovery) -> String {
        switch d.status {
        case "queued": return "Looking for more companies…"
        case "failed": return "The last discovery failed"
        default:
            let who = switch d.trigger {
            case "schedule": " (weekly)"
            case "setup": " (at setup)"
            case "manual": " (by you)"
            default: ""
            }
            guard d.found > 0 else { return "Last discovery\(who) · nothing found" }
            return "Last discovery\(who) · \(plural(d.found, "board")) found, \(number(d.added)) new"
        }
    }

    /// Why Sources has no index, in a sentence: an older daemon, or what went wrong.
    public static func indexUnavailable(_ problem: String) -> String {
        problem.contains("newer Applyant") || problem.contains("unimplemented")
            ? "Applyant's background service is older than the app and doesn't keep the index yet. The sources on the left read as before."
            : "Applyant's background service couldn't give it: \(problem). The sources on the left read as before."
    }

    /// A discovery is waiting or running (Find More Companies waits for it). The daemon reads one
    /// whose task is gone as failed, so a lost run doesn't hold the button.
    public static func discovering(_ index: AtsIndex?) -> Bool { index?.discoveries.first?.status == "queued" }

    // MARK: The index's companies

    public static func companyTitle(_ c: IndexCompany) -> String {
        c.hasName && !c.name.isEmpty ? c.name : c.token
    }

    /// A company's status in words, as its chip.
    public static func statusChip(_ c: IndexCompany) -> Chip {
        switch c.status {
        case "new": Chip(text: "Not read yet", tone: .neutral)
        case "hiring": Chip(text: "Hiring", tone: .good)
        case "empty": Chip(text: "No open jobs", tone: .neutral)
        case "failing": Chip(text: "Failing", tone: .warning)
        case "gone": Chip(text: "Gone", tone: .neutral)
        default: Chip(text: c.status, tone: .neutral)
        }
    }

    /// "Greenhouse · 12 jobs · 3 matching" (the ATS left out where the list is one ATS's).
    public static func companyLine(_ c: IndexCompany, showsAts: Bool = true) -> String {
        var parts: [String] = []
        if showsAts { parts.append(kindTitle(c.ats)) }
        if c.jobs > 0 || c.status == "hiring" {
            parts.append(plural(c.jobs, "job"))
            if c.matching > 0 { parts.append("\(number(c.matching)) matching") }
        }
        if parts.isEmpty { parts.append(c.token) }
        return parts.joined(separator: " · ")
    }

    /// A company's chips: off, watched, then its status.
    public static func companyChips(_ c: IndexCompany) -> [Chip] {
        var chips: [Chip] = []
        if !c.enabled { chips.append(Chip(text: "Off", tone: .neutral)) }
        if c.watched { chips.append(Chip(text: "Watched", tone: .accent)) }
        chips.append(statusChip(c))
        return chips
    }

    /// A company's line in the list: its counts, when it was read, and, watched, what its own
    /// reads found ("Greenhouse · 12 jobs · 3 matching · read 2 hours ago · watched: 8 found").
    public static func companyMeta(_ c: IndexCompany, showsAts: Bool, source: SearchSource?, now: Date = Date()) -> String {
        var parts = [companyLine(c, showsAts: showsAts)]
        if c.hasLastReadAt { parts.append("read " + relative(c.lastReadAt.date, now: now)) }
        if c.watched, let source, source.stats.found > 0 {
            parts.append("watched: " + SearchText.stats(source.stats))
        } else if !c.watched {
            let via = foundVia(c.foundVia)
            if !via.isEmpty { parts.append(via) }
        }
        return parts.joined(separator: " · ")
    }

    /// A company's detail, as label and value: its status, jobs, how it was found, its reads.
    public static func companyFacts(_ c: IndexCompany, now: Date = Date()) -> [(label: String, value: String)] {
        var items: [(label: String, value: String)] = [
            (label: "Status", value: statusChip(c).text + (c.enabled ? "" : " · left out of the index")),
            (label: "Open jobs", value: c.jobs > 0 || c.status == "hiring"
                ? plural(c.jobs, "job") + " · \(number(c.matching)) matching your searches"
                : "none known yet"),
        ]
        let via = foundVia(c.foundVia)
        if !via.isEmpty { items.append((label: "How it's known", value: via.prefix(1).uppercased() + via.dropFirst())) }
        items.append((label: "Last read", value: c.hasLastReadAt ? relative(c.lastReadAt.date, now: now) : "not yet"))
        if c.enabled, c.hasNextReadAt {
            items.append((label: "Next read", value: c.nextReadAt.date <= now ? "due now" : relative(c.nextReadAt.date, now: now)))
        }
        if c.hasLastNote, !c.lastNote.isEmpty { items.append((label: "Last note", value: c.lastNote)) }
        return items
    }

    /// "2 hours ago", "in 3 days": the same in every locale, as the rest of the screen's words.
    static func relative(_ date: Date, now: Date) -> String {
        let f = RelativeDateTimeFormatter()
        f.locale = Locale(identifier: "en_US")
        f.dateTimeStyle = .named
        return f.localizedString(for: date, relativeTo: now)
    }

    /// Why the companies browser shows none: the filter, the pause, no discovery yet, or none on
    /// this ATS so far.
    public static func companiesEmpty(_ filter: IndexCompanyFilter, index: AtsIndex?, paused: Bool) -> String {
        if !filter.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || filter.matchingOnly {
            return filter.matchingOnly && filter.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "No company here has open jobs your searches match yet."
                : "No company matches the filter."
        }
        let scope = filter.ats.map { "No \(kindTitle($0)) companies" } ?? "No companies"
        if paused { return "\(scope) yet. Background work is paused: none are looked for until you resume." }
        if index?.discoveries.isEmpty ?? true { return "\(scope) yet: no discovery has run. Find More Companies looks for them." }
        if discovering(index) { return "\(scope) yet. A discovery is looking for them now." }
        return "\(scope) found yet. Find More Companies looks again; a board you add by URL joins here."
    }

    /// How a company got into the index.
    public static func foundVia(_ via: String) -> String {
        switch via {
        case "common-crawl": "found in Common Crawl"
        case "posting": "found behind a posting"
        case "planner": "found by the search planner"
        case "workable-search": "found by the Workable job search"
        case "smartrecruiters-search": "found by the SmartRecruiters job search"
        case "watch-list": "from your watch list"
        case "candidate": "added by you"
        default: via.isEmpty ? "" : "found via \(via)"
        }
    }
}
