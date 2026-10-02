// App parity with the CLI for setup (phase 16): the profile, projects and their knowledge
// sources, search strategies, search sources and preferences, edited in the app. The forms
// here are plain values the views bind to; each knows what it would send (only what changed),
// so the store's actions stay one RPC per change and the rules are tested without a window.
import ApplyantAPI
import Foundation

public typealias CandidateProfile = Applyant_V1_GetCandidateResponse
public typealias KnowledgeProject = Applyant_V1_Project
public typealias KnowledgeSource = Applyant_V1_Source
public typealias SearchPreferences = Applyant_V1_Preferences

// MARK: The profile

public struct ProfileField: Hashable, Sendable {
    public let key: String
    public let label: String
    public let hint: String
    /// github_logins, commit_emails: several values, comma-separated in the form.
    public let isList: Bool
}

public struct ProfileForm: Equatable, Sendable {
    /// The keys `candidate profile set` takes that the form edits, in the order shown.
    public static let fields: [ProfileField] = [
        .init(key: "full_name", label: "Full name", hint: "Roman Kudin", isList: false),
        .init(key: "email", label: "Email", hint: "me@example.com", isList: false),
        .init(key: "phone", label: "Phone", hint: "+30 690 000 0000", isList: false),
        .init(key: "location", label: "Location", hint: "Athens, Greece", isList: false),
        .init(key: "work_authorization", label: "Work authorization", hint: "EU citizen", isList: false),
        .init(key: "visa_sponsorship", label: "Visa sponsorship", hint: "not needed", isList: false),
        .init(key: "relocation", label: "Relocation", hint: "open to relocation within the EU", isList: false),
        .init(key: "salary_expectation", label: "Salary expectation", hint: "80k EUR/year", isList: false),
        .init(key: "notice_period", label: "Notice period", hint: "1 month", isList: false),
        .init(key: "current_company", label: "Current company", hint: "Acme", isList: false),
        .init(key: "current_title", label: "Current title", hint: "Senior Engineer", isList: false),
        .init(key: "links.github", label: "GitHub", hint: "https://github.com/you", isList: false),
        .init(key: "links.website", label: "Website", hint: "https://you.dev", isList: false),
        .init(key: "links.linkedin", label: "LinkedIn", hint: "https://linkedin.com/in/you", isList: false),
        .init(key: "github_logins", label: "GitHub logins", hint: "your-login, old-login", isList: true),
        .init(key: "commit_emails", label: "Commit emails", hint: "me@example.com, me@work.com", isList: true),
    ]
    public static let baseCvKey = "base_cv_file"

    public var values: [String: String]
    /// What the daemon has now (changes are measured against it).
    public private(set) var original: [String: String]

    public init(entries: [Applyant_V1_ProfileEntry] = []) {
        var v: [String: String] = [:]
        for e in entries { v[e.key] = e.values.joined(separator: ", ") }
        values = v
        original = v
    }

    public subscript(key: String) -> String {
        get { values[key] ?? "" }
        set { values[key] = newValue }
    }

    /// Key → value for SetProfileValue, only for what changed (empty clears the key).
    public var changes: [(key: String, value: String)] {
        (Self.fields.map(\.key) + [Self.baseCvKey]).compactMap { key in
            let now = (values[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let was = (original[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return now == was ? nil : (key, now)
        }
    }

    public var hasChanges: Bool { !changes.isEmpty }
}

// MARK: Knowledge sources

public enum KnowledgeText {
    /// What the candidate typed or picked → the source kind: a path is a file, a GitHub repo
    /// link is `github`, a Google Docs/Drive link `drive`, anything else a page.
    public static func sourceKind(for input: String) -> Applyant_V1_SourceKind {
        let s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("/") || s.hasPrefix("~") { return .file }
        let lower = s.lowercased()
        if lower.contains("github.com/") {
            let path = lower.components(separatedBy: "github.com/").last ?? ""
            if path.split(separator: "/").count >= 2 { return .github }
        }
        return OnboardingText.sourceKind(for: s)
    }

    /// A folder is a local directory (a file source) or a Drive folder (its files are read).
    public static func kindName(_ kind: Applyant_V1_SourceKind, folder: Bool = false) -> String {
        switch kind {
        case .file: folder ? "Folder" : "File"
        case .url: "Page"
        case .github: "GitHub"
        case .drive: folder ? "Drive folder" : "Google Docs"
        case .manual: "Typed in"
        default: "Source"
        }
    }

    public static func kindName(_ s: KnowledgeSource) -> String { kindName(s.kind, folder: s.folder) }

    /// The SF Symbol for a source's kind.
    public static func symbol(_ s: KnowledgeSource) -> String {
        switch s.kind {
        case .file: s.folder ? "folder" : "doc"
        case .url: "link"
        case .github: "chevron.left.forwardslash.chevron.right"
        case .drive: s.folder ? "folder" : "doc.richtext"
        case .manual: "text.quote"
        default: "doc"
        }
    }

    /// "cv.pdf", "Projects" (a folder), "github.com/me/app", "acme.dev/case-study", "1AbC" (a Drive folder).
    public static func title(_ s: KnowledgeSource) -> String {
        if s.kind == .file { return (s.locator as NSString).lastPathComponent }
        if s.kind == .drive, s.locator.hasPrefix("folder:") { return String(s.locator.dropFirst("folder:".count)) }
        return s.locator
            .replacingOccurrences(of: "https://", with: "")
            .replacingOccurrences(of: "http://", with: "")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    public enum SyncState: Equatable, Sendable { case waiting, synced, failed }

    public static func syncState(_ s: KnowledgeSource) -> SyncState {
        if s.hasSyncNote, s.syncNote.hasPrefix("sync failed") { return .failed }
        return s.hasLastSyncedAt ? .synced : .waiting
    }

    /// "Synced 30 Sep 14:05 · 12 new facts, …", "Waiting for its first sync", "sync failed: …".
    public static func syncLine(_ s: KnowledgeSource) -> String {
        switch syncState(s) {
        case .failed:
            return s.syncNote.prefix(1).uppercased() + s.syncNote.dropFirst()
        case .waiting:
            return "Waiting for its first sync"
        case .synced:
            let when = s.lastSyncedAt.date.formatted(date: .abbreviated, time: .shortened)
            return "Synced \(when)" + (s.hasSyncNote && !s.syncNote.isEmpty ? " · \(s.syncNote)" : "")
        }
    }

    public static func chip(_ s: KnowledgeSource) -> Chip {
        switch syncState(s) {
        case .failed: Chip(text: "Failed", tone: .warning)
        case .waiting: Chip(text: "Reading…", tone: .neutral)
        case .synced: Chip(text: "Synced", tone: .good)
        }
    }

    /// After removing a source: how many facts went with it.
    public static func removedLine(factsRemoved n: Int) -> String {
        switch n {
        case 0: "Removed the source · no facts went with it"
        case 1: "Removed the source · 1 fact went with it"
        default: "Removed the source · \(n) facts went with it"
        }
    }

    /// "3 sources · 24 facts (5 to confirm)".
    public static func projectLine(_ p: KnowledgeProject) -> String {
        let sources = p.sourceCount == 1 ? "1 source" : "\(p.sourceCount) sources"
        let facts = p.factCount == 1 ? "1 fact" : "\(p.factCount) facts"
        return "\(sources) · \(facts)" + (p.unconfirmedCount > 0 ? " (\(p.unconfirmedCount) to confirm)" : "")
    }
}

// MARK: Search strategies

public struct StrategyForm: Equatable, Sendable {
    public var name = ""
    /// One title phrase per line ("-word" excludes).
    public var queries = ""
    /// Location words, comma-separated; "remote" matches remote jobs.
    public var locations = ""
    public var remote = false
    /// Source selectors, comma-separated: all, a kind (greenhouse, board, …) or a key (board:hn).
    public var sources = "all"
    public var everyHours = 6
    public var paused = false

    public init() {}

    public init(_ s: SearchStrategy) {
        name = s.name
        queries = s.queries.joined(separator: "\n")
        remote = s.locations.contains { $0.lowercased() == "remote" }
        locations = s.locations.filter { $0.lowercased() != "remote" }.joined(separator: ", ")
        sources = s.sources.joined(separator: ", ")
        everyHours = max(1, Int((Double(s.everyMinutes) / 60).rounded()))
        paused = s.state == "paused"
    }

    public var queryList: [String] { Self.split(queries, by: CharacterSet.newlines) }
    public var locationList: [String] {
        let places = Self.split(locations, by: CharacterSet(charactersIn: ",\n")).filter { $0.lowercased() != "remote" }
        return remote ? ["remote"] + places : places
    }
    public var sourceList: [String] {
        let list = Self.split(sources, by: CharacterSet(charactersIn: ",\n "))
        return list.isEmpty ? ["all"] : list
    }
    public var everyMinutes: Int32 { Int32(max(1, everyHours) * 60) }

    /// Why it can't be saved yet; nil when it can.
    public var problem: String? {
        name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Give the strategy a name." : nil
    }

    public var addRequest: Applyant_V1_AddStrategyRequest {
        .with {
            $0.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
            $0.queries = queryList
            $0.locations = locationList
            $0.sources = sourceList
            $0.everyMinutes = everyMinutes
            $0.paused = paused
        }
    }

    /// Every field replaced (an empty list clears queries or locations).
    public func updateRequest(_ id: Int64) -> Applyant_V1_UpdateStrategyRequest {
        .with {
            $0.strategy = String(id)
            $0.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
            $0.queries = .with { $0.values = queryList }
            $0.locations = .with { $0.values = locationList }
            $0.sources = .with { $0.values = sourceList }
            $0.everyMinutes = everyMinutes
            $0.state = paused ? "paused" : "active"
        }
    }

    static func split(_ s: String, by set: CharacterSet) -> [String] {
        s.components(separatedBy: set).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
}

// MARK: Search sources

public enum SourceInput {
    /// A board or career page URL (feed/ATS detection or a listing recipe follow in the daemon);
    /// nil when it isn't a web address.
    public static func url(_ input: String) -> String? {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty, !s.contains(" ") else { return nil }
        if !s.lowercased().hasPrefix("http://") && !s.lowercased().hasPrefix("https://") { s = "https://" + s }
        guard let url = URL(string: s), let host = url.host, host.contains(".") else { return nil }
        return s
    }

    /// "Added page:https://acme.com/careers (Acme) · read as greenhouse board acme".
    public static func added(_ s: SearchSource) -> String {
        "Added \(s.label.isEmpty ? s.key : s.label)" + (s.hasResolved ? " · read as \(s.resolved)" : " · it's read on the next run")
    }
}

// MARK: Preferences

public struct PreferencesForm: Equatable, Sendable {
    public struct Field: Hashable, Sendable {
        public let key: String
        public let label: String
        public let hint: String
    }

    /// The text fields (`prefs set <key>`), in order; dealbreakers, remote, the threshold and
    /// the weights have their own controls.
    public static let fields: [Field] = [
        .init(key: "roles", label: "Roles", hint: "any job titles, in your own words"),
        .init(key: "seniority", label: "Seniority", hint: "intern, junior, mid, senior, lead, staff, principal, head"),
        .init(key: "based_in", label: "Based in", hint: "a country"),
        .init(key: "based_city", label: "City", hint: "Athens"),
        .init(key: "locations", label: "Also on-site/hybrid in", hint: "countries"),
        .init(key: "salary", label: "Target salary", hint: "4500 EUR/month or 60k EUR/year"),
        .init(key: "salary_floor", label: "Salary floor", hint: "below it is a dealbreaker: 3500 EUR/month"),
        .init(key: "languages", label: "Languages", hint: "en:C1, el:native"),
        .init(key: "working_languages", label: "Rather work in", hint: "de, uk"),
        .init(key: "employment", label: "Employment", hint: "full_time, part_time, contract, freelance, internship"),
    ]
    public static let dealbreakers = ["outstaffing", "onsite", "location", "language", "employment", "seniority"]
    public static let remoteOptions = ["required", "preferred", "any"]
    public static let components = ["must", "nice", "role", "location", "remote", "salary", "language", "employment", "company"]

    public var text: [String: String] = [:]
    public var remote = "any"
    public var dealbreakers: Set<String> = []
    public var threshold = 70
    /// Applications started on their own per 24 hours (0: only the ones asked for).
    public var dailyCap = 10
    public var weights: [String: Int] = [:]
    public private(set) var original: PreferencesFormSnapshot

    public init(_ p: SearchPreferences = SearchPreferences()) {
        text["roles"] = RoleTokens.joined(p.roles)
        text["seniority"] = p.seniority.joined(separator: ", ")
        text["based_in"] = p.hasBasedIn ? p.basedIn : ""
        text["based_city"] = p.hasBasedCity ? p.basedCity : ""
        text["locations"] = p.locations.joined(separator: ", ")
        text["salary"] = p.hasSalary ? Self.money(p.salary) : ""
        text["salary_floor"] = p.hasSalaryFloor ? Self.money(p.salaryFloor) : ""
        text["languages"] = p.languages.sorted { $0.key < $1.key }.map { "\($0.key):\($0.value)" }.joined(separator: ", ")
        text["working_languages"] = p.workingLanguages.joined(separator: ", ")
        text["employment"] = p.employment.joined(separator: ", ")
        remote = p.remote.isEmpty ? "any" : p.remote
        dealbreakers = Set(p.dealbreakers)
        threshold = Int(p.threshold)
        dailyCap = Int(p.dailyCap)
        for c in Self.components { weights[c] = Int((p.weights[c] ?? 0).rounded()) }
        original = PreferencesFormSnapshot(text: text, remote: remote, dealbreakers: dealbreakers, threshold: threshold, dailyCap: dailyCap, weights: weights)
    }

    public subscript(key: String) -> String {
        get { text[key] ?? "" }
        set { text[key] = newValue }
    }

    /// "4500 EUR/month" (whole amounts without a decimal point).
    public static func money(_ m: Applyant_V1_Money) -> String {
        let amount = m.amount.rounded() == m.amount ? String(Int(m.amount)) : String(m.amount)
        return "\(amount) \(m.currency)/\(m.period)"
    }

    /// Key → value for SetPreference, only for what changed (an empty text resets the key).
    public var changes: [(key: String, value: String)] {
        var out: [(key: String, value: String)] = []
        for f in Self.fields {
            let now = (text[f.key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let was = (original.text[f.key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if now != was { out.append((f.key, now)) }
        }
        if remote != original.remote { out.append(("remote", remote)) }
        if dealbreakers != original.dealbreakers {
            out.append(("dealbreakers", Self.dealbreakers.filter(dealbreakers.contains).joined(separator: ",")))
        }
        if threshold != original.threshold { out.append(("threshold", String(threshold))) }
        if dailyCap != original.dailyCap { out.append(("daily_cap", String(dailyCap))) }
        for c in Self.components where weights[c] != original.weights[c] {
            out.append(("weight.\(c)", String(weights[c] ?? 0)))
        }
        return out
    }

    public var hasChanges: Bool { !changes.isEmpty }
}

public struct PreferencesFormSnapshot: Equatable, Sendable {
    var text: [String: String]
    var remote: String
    var dealbreakers: Set<String>
    var threshold: Int
    var dailyCap: Int
    var weights: [String: Int]
}

public enum PreferencesText {
    /// "Chef, CFO +1 · senior · based in Athens, Greece · remote preferred · 4500 EUR/month · …".
    public static func summary(_ p: SearchPreferences?) -> String {
        guard let p else { return "Not loaded yet" }
        var parts: [String] = []
        parts.append(RoleTokens.summary(p.roles))
        if !p.seniority.isEmpty { parts.append(p.seniority.joined(separator: ", ")) }
        if p.hasBasedIn {
            let city = p.hasBasedCity && !p.basedCity.isEmpty ? "\(p.basedCity), " : ""
            parts.append("based in \(city)\(Places.countryName(p.basedIn))")
        }
        parts.append("remote \(p.remote.isEmpty ? "any" : p.remote)")
        if p.hasSalary { parts.append(PreferencesForm.money(p.salary)) }
        if !p.dealbreakers.isEmpty { parts.append("dealbreakers: \(p.dealbreakers.joined(separator: ", "))") }
        parts.append("prepares at \(p.threshold)+")
        parts.append(p.dailyCap == 0 ? "starts no applications on its own" : "up to \(p.dailyCap) a day on its own")
        return parts.joined(separator: " · ")
    }
}
