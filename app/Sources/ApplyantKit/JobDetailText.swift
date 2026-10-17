// The job detail, one screen for every list: which tabs it has, its one primary action, the
// key facts, how the candidate matches, and when a site wants a sign-in first. Plain values,
// tested without SwiftUI.
import ApplyantAPI
import Foundation

public typealias RequirementMatch = Applyant_V1_RequirementMatch

public enum DetailTab: String, CaseIterable, Identifiable, Sendable {
    case job, application, company

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .job: "Job"
        case .application: "Application"
        case .company: "Company"
        }
    }

    /// Job always; Application once there is one; Company when the posting names it.
    public static func available(hasApplication: Bool, hasCompany: Bool) -> [DetailTab] {
        [.job] + (hasApplication ? [.application] : []) + (hasCompany ? [.company] : [])
    }

    /// The tab picked last when this job has it, else Job.
    public static func shown(_ picked: DetailTab, in available: [DetailTab]) -> DetailTab {
        available.contains(picked) ? picked : .job
    }
}

/// The detail's one primary action, by where the job stands.
public enum JobAction: Equatable, Sendable {
    /// No application yet.
    case prepare
    /// Ready, or waiting on the candidate: "Approve and send…", on only when nothing blocks it.
    case approve(enabled: Bool, help: String)
    /// Any other application: its tab.
    case review
    /// Nothing to start: skipped, closed or not scored yet.
    case none

    public static func primary(posting: Posting?, application: Application?) -> JobAction {
        let skipped = posting.map { $0.stage == .skipped || $0.decision == "skipped" } ?? false
        if skipped { return .none }
        guard let app = application else { return posting?.stage == .scored ? .prepare : .none }
        switch app.stage {
        case .readyForReview, .needsCandidate:
            let ok = ReviewRules.canApprove(app)
            let help = ok
                ? "Asks once more, then Applyant submits the application on its own"
                : (app.blockers.isEmpty ? "It isn't ready yet: " + (app.missing.first ?? "fill in what it needs") : app.blockers.joined(separator: "\n"))
            return .approve(enabled: ok, help: help)
        default:
            return .review
        }
    }
}

public struct KeyFact: Equatable, Sendable {
    public let label: String
    /// Short enough for its tile ("Remote · 71 countries").
    public let value: String
    /// All of it, for the tile's tooltip; the value itself when nothing was cut.
    public let full: String

    public init(_ label: String, _ value: String, full: String? = nil) {
        self.label = label
        self.value = value
        self.full = full ?? value
    }
}

/// The posting's facts at a glance, from the scorer's reading (the breakdown's notes) and the
/// JobPosting fields the capture kept.
public enum KeyFacts {
    public static func rows(
        _ p: Posting,
        description: PostingDescription,
        date: (Date) -> String = { $0.formatted(date: .abbreviated, time: .omitted) }
    ) -> [KeyFact] {
        let fields = description.structured
        var rows: [KeyFact] = []
        if let workplace = (firstPart(note(p, "location")) ?? structuredWorkplace(fields)).map(capitalized) {
            rows.append(KeyFact("Workplace", shortened(workplace), full: workplace))
        }
        if let places = fields["jobLocation"].flatMap(places) {
            let first = places.prefix(2).joined(separator: "; ")
            rows.append(KeyFact("Location", places.count > 2 ? "\(places[0]) +\(places.count - 1)" : first, full: places.joined(separator: "; ")))
        }
        if let employment = note(p, "employment") ?? fields["employmentType"].map(employmentName) {
            rows.append(KeyFact("Employment", capitalized(employment)))
        }
        if let seniority = firstPart(note(p, "role")), !seniority.lowercased().contains("not stated") {
            rows.append(KeyFact("Seniority", capitalized(seniority)))
        }
        if let salary = p.hasSalaryText ? p.salaryText : (fields["baseSalary"] ?? fields["estimatedSalary"]).flatMap(salary) {
            rows.append(KeyFact("Salary", salary))
        }
        if let language = firstPart(note(p, "language")) { rows.append(KeyFact("Language", language)) }
        if let posted = description.date("datePosted") { rows.append(KeyFact("Posted", date(posted))) }
        return rows
    }

    /// The facts the Job tab's strip shows: the ones the hero doesn't already say (it has the
    /// workplace, the place and the salary).
    public static func stripRows(_ p: Posting, description: PostingDescription) -> [KeyFact] {
        let inHero: Set<String> = ["Workplace", "Location", "Salary"]
        return rows(p, description: description).filter { !inHero.contains($0.label) }
    }

    private static func note(_ p: Posting, _ key: String) -> String? {
        p.breakdown.first { $0.key == key && $0.hasNote && !$0.note.isEmpty }?.note
    }

    /// "Remote (europe) · counts ×0.8: core fit 63%" → "Remote (europe)": the rest is scoring.
    private static func firstPart(_ note: String?) -> String? {
        guard let first = note?.components(separatedBy: " · ").first?.trimmingCharacters(in: .whitespaces), !first.isEmpty else {
            return nil
        }
        return first
    }

    private static func capitalized(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }

    /// A list of places in parentheses, short enough for a tile's two lines: two are kept,
    /// a few more are counted ("Remote (Estonia, Latvia +4)"), a long list is only counted
    /// ("Remote · 71 countries").
    static func shortened(_ s: String) -> String {
        guard let open = s.firstIndex(of: "("), let close = s.lastIndex(of: ")"), open < close else { return s }
        let items = s[s.index(after: open)..<close].components(separatedBy: ", ")
        let head = s[..<open].trimmingCharacters(in: .whitespaces)
        if items.count > 6 { return "\(head) · \(items.count) countries" }
        guard items.count > 2 else { return s }
        return "\(head) (" + items.prefix(2).joined(separator: ", ") + " +\(items.count - 2))"
    }

    /// "AdministrativeArea, address: PostalAddress, addressRegion: Europe" → [["addressRegion": "Europe"]].
    static func entries(_ flat: String) -> [[String: String]] {
        flat.components(separatedBy: "; ").map { entry in
            var out: [String: String] = [:]
            for part in entry.components(separatedBy: ", ") {
                guard let colon = part.range(of: ": ") else { continue }
                out[String(part[..<colon.lowerBound])] = String(part[colon.upperBound...])
            }
            return out
        }
    }

    private static func structuredWorkplace(_ fields: [String: String]) -> String? {
        let remote = fields["jobLocationType"]?.uppercased().contains("TELECOMMUTE") == true
        let regions = (fields["applicantLocationRequirements"].map(entries) ?? [])
            .compactMap { $0["name"] ?? $0["addressRegion"] ?? $0["addressCountry"] }
            .map { $0 == $0.uppercased() && $0.count > 3 ? $0.capitalized : $0 }
        guard remote || !regions.isEmpty else { return nil }
        let joined = regions.joined(separator: ", ")
        return remote ? (regions.isEmpty ? "Remote" : "Remote (\(joined))") : "Open to \(joined)"
    }

    /// "Place, address: PostalAddress, addressLocality: Hamburg, addressCountry: DE" → ["Hamburg, DE"].
    private static func places(_ flat: String) -> [String]? {
        let places = entries(flat).compactMap { e -> String? in
            let parts = [e["addressLocality"], e["addressCountry"]].compactMap { $0 }.filter { !$0.isEmpty }
            return parts.isEmpty ? nil : parts.joined(separator: ", ")
        }
        var seen = Set<String>()
        let unique = places.filter { seen.insert($0).inserted }
        return unique.isEmpty ? nil : unique
    }

    static func employmentName(_ raw: String) -> String {
        raw.components(separatedBy: "; ").map { value in
            switch value.uppercased().replacingOccurrences(of: "-", with: "_") {
            case "FULL_TIME", "FULLTIME": "Full-time"
            case "PART_TIME", "PARTTIME": "Part-time"
            case "CONTRACTOR", "CONTRACT": "Contract"
            case "TEMPORARY": "Temporary"
            case "INTERN", "INTERNSHIP": "Internship"
            case "FREELANCE": "Freelance"
            default: capitalized(value.lowercased().replacingOccurrences(of: "_", with: " "))
            }
        }.joined(separator: ", ")
    }

    /// "MonetaryAmount, currency: EUR, value: QuantitativeValue, minValue: 80000.00, maxValue:
    /// 110000.00, unitText: YEAR" → "EUR 80,000–110,000 a year".
    static func salary(_ flat: String) -> String? {
        let e = entries(flat).reduce(into: [String: String]()) { $0.merge($1) { first, _ in first } }
        let numbers = NumberFormatter()
        numbers.locale = Locale(identifier: "en_US")
        numbers.numberStyle = .decimal
        numbers.maximumFractionDigits = 0
        func amount(_ key: String) -> String? { e[key].flatMap(Double.init).flatMap { numbers.string(from: NSNumber(value: $0)) } }
        let range: String
        if let min = amount("minValue"), let max = amount("maxValue") {
            range = min == max ? min : "\(min)–\(max)"
        } else if let one = amount("minValue") ?? amount("maxValue") ?? amount("value") {
            range = one
        } else {
            return nil
        }
        let unit: String? = switch e["unitText"]?.uppercased() {
        case "YEAR"?: "a year"
        case "MONTH"?: "a month"
        case "WEEK"?: "a week"
        case "DAY"?: "a day"
        case "HOUR"?: "an hour"
        default: nil
        }
        return [e["currency"], range, unit].compactMap { $0 }.joined(separator: " ")
    }
}

/// How the candidate matches the posting: its requirements by kind, the score's parts, and
/// what might be a problem.
public enum MatchText {
    public struct RequirementGroup: Identifiable, Equatable, Sendable {
        public let id: String
        public let title: String
        /// The scorer's count ("7 strong · 2 partial of 9").
        public let note: String?
        public let requirements: [RequirementMatch]
    }

    /// Must-haves, then nice-to-haves (an empty kind is left out), each with what's missing
    /// first, then what's partly there, then what's met: the gaps are what to read.
    public static func requirementGroups(_ p: Posting) -> [RequirementGroup] {
        let note = { (key: String) in p.breakdown.first { $0.key == key && $0.hasNote }?.note }
        return [
            RequirementGroup(id: "must", title: "Must-haves", note: note("must"), requirements: ordered(p.requirements.filter(\.must))),
            RequirementGroup(id: "nice", title: "Nice-to-haves", note: note("nice"), requirements: ordered(p.requirements.filter { !$0.must })),
        ].filter { !$0.requirements.isEmpty }
    }

    /// Missing, then unknown (a condition to ask about), then partial, then strong; the
    /// posting's own order within each.
    public static func ordered(_ requirements: [RequirementMatch]) -> [RequirementMatch] {
        let rank = ["missing": 0, "partial": 2, "strong": 3]
        return requirements.enumerated()
            .sorted { (rank[$0.element.verdict] ?? 1, $0.offset) < (rank[$1.element.verdict] ?? 1, $1.offset) }
            .map(\.element)
    }

    /// The met ones, folded into one line: "7 met · 8+ years, ownership, system design"; nil
    /// when none is met.
    public static func metSummary(_ group: RequirementGroup) -> String? {
        let met = group.requirements.filter { $0.verdict == "strong" }
        guard !met.isEmpty else { return nil }
        let names = met.prefix(3).map { shortName($0.text) }
        return "\(met.count) met · " + names.joined(separator: ", ") + (met.count > 3 ? "…" : "")
    }

    /// A requirement in a word or three: "Have 8+ years of software engineering experience." →
    /// "8+ years", "Strong system design skills" → "system design skills".
    public static func shortName(_ text: String) -> String {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: ".")))
        let fillers = [
            "you have ", "you are ", "you've ", "have ", "has ", "be ", "are ", "is ", "strong ", "solid ", "proven ", "deep ",
            "excellent ", "good ", "great ", "extensive ", "demonstrated ", "hands-on ", "practical ", "professional ",
            "experience with ", "experience in ", "experience of ", "experience building ", "knowledge of ", "familiarity with ",
            "understanding of ", "ability to ", "comfortable with ", "comfort with ", "proficiency in ", "proficient in ",
            "expertise in ", "background in ", "track record of ", "a ", "an ", "the ",
        ]
        var changed = true
        while changed {
            changed = false
            for f in fillers where s.lowercased().hasPrefix(f) && s.count > f.count {
                s = String(s.dropFirst(f.count))
                changed = true
            }
        }
        // Up to the first break in the phrase.
        let breaks = [",", ";", ":", " (", " – ", " — ", " - ", " and ", " or ", " of ", " with ", " in ", " for ", " to ", " that ", " who ", " using ", " such as "]
        let cut = breaks.compactMap { s.range(of: $0)?.lowerBound }.filter { $0 > s.startIndex }.min()
        if let cut { s = String(s[..<cut]) }
        var words = s.split(separator: " ").prefix(3).map(String.init)
        // An ordinary word starts lower case in a list; a name ("Python", "AWS") keeps its case.
        let ordinary = ["ship", "ing", "tion", "sion", "ment", "ness", "ity", "ence", "ance", "ive", "ism"]
        if let first = words.first, words.count > 1 || ordinary.contains(where: { first.lowercased().hasSuffix($0) }),
           first.dropFirst().allSatisfy({ !$0.isUppercase }) {
            words[0] = first.prefix(1).lowercased() + first.dropFirst()
        }
        return words.joined(separator: " ")
    }

    /// The facts a requirement rests on, one line each, under their project's name
    /// ("Acme API: Built the billing service"). `projects`: the candidate's projects by slug.
    public static func evidence(_ r: RequirementMatch, projects: [String: String] = [:]) -> [String] {
        r.facts.map { f in
            (f.hasProjectSlug ? projectName(f.projectSlug, projects: projects) + ": " : "") + f.text + (f.status == .unconfirmed ? " (unconfirmed)" : "")
        }
    }

    /// A project by its name, else its slug in words ("tech-lead-at-nda" → "Tech lead at nda").
    public static func projectName(_ slug: String, projects: [String: String]) -> String {
        if let name = projects[slug], !name.isEmpty { return name }
        let words = slug.split(whereSeparator: { $0 == "-" || $0 == "_" }).joined(separator: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    /// The disclosure over a requirement's facts: "1 fact", "3 facts".
    public static func factsLabel(_ count: Int) -> String { "\(count) fact\(count == 1 ? "" : "s")" }

    /// The score's parts that count or couldn't be judged.
    public static func breakdown(_ p: Posting) -> [Applyant_V1_ScoreComponent] {
        p.breakdown.filter { $0.weight > 0 || $0.uncertain }
    }

    /// A potential issue as a callout says it: "Dealbreaker" over "outstaffing", "Location
    /// isn't clear" over "remote, region not stated".
    public struct Issue: Equatable, Sendable {
        public let title: String
        public let detail: String?
    }

    public static func issueList(_ p: Posting) -> [Issue] {
        p.dealbreakers.map { Issue(title: "Dealbreaker", detail: $0) }
            + p.breakdown.filter { $0.uncertain && $0.hasNote }.map {
                Issue(title: "\(Score.componentTitles[$0.key] ?? $0.key) isn't clear", detail: $0.note.isEmpty ? nil : $0.note)
            }
    }

    /// Dealbreakers, and what the posting doesn't say enough about to score.
    public static func issues(_ p: Posting) -> [String] {
        p.dealbreakers.map { "Dealbreaker: \($0)" }
            + p.breakdown.filter { $0.uncertain && $0.hasNote }.map { "\(Score.componentTitles[$0.key] ?? $0.key): \($0.note)" }
    }
}

/// The hero's words around its buttons: one line of what and where the job is, and what's left
/// before it can go as one link.
public enum HeaderText {
    /// "Kalepa · Remote (europe) · $100k–$185k USD · Greenhouse · Found 4 days ago"; once it's
    /// sent, "… · Interview · Sent Oct 3 · 14 days ago · 1 reply".
    public static func meta(posting: Posting?, app: Application?, facts: [KeyFact], delivering: Bool = false, now: Date = Date()) -> String {
        let company = posting.flatMap { $0.hasCompany ? $0.company : nil } ?? app.flatMap { $0.hasCompany ? $0.company : nil }
        let place = ["Workplace", "Location", "Salary"].map { label in facts.first { $0.label == label }?.value }
        let site = Source.site(posting?.canonicalURL ?? app?.postingURL ?? "")
        let parts = [company] + place + [site, state(posting: posting, app: app, delivering: delivering), when(posting: posting, app: app, now: now)]
        return parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// Where the job stands, in words only where its buttons and its list don't say it already:
    /// "Preparing…", "Interview", "Closed"; nil while it waits for review.
    public static func state(posting: Posting?, app: Application?, delivering: Bool = false) -> String? {
        if let app {
            switch app.stage {
            case .preparing: return "Preparing…"
            case .approved: return app.hasHandOff ? "Finish in browser" : delivering ? nil : "Approved · delivering"
            case .applied: return SentText.line(app) == nil ? "Applied" : nil
            case .interview, .offer, .rejected, .withdrawn: return StageText.name(app.stage)
            default: return nil
            }
        }
        return posting?.stage == .closed ? "Closed" : nil
    }

    /// "Sent Oct 3 · 14 days ago · no reply yet" once it's sent, else "Found 4 days ago".
    static func when(posting: Posting?, app: Application?, now: Date) -> String? {
        if let app, let line = SentText.line(app, now: now) { return line }
        guard let posting, posting.hasFirstSeenAt else { return nil }
        let formatter = RelativeDateTimeFormatter()
        formatter.dateTimeStyle = .named
        return "Found " + formatter.localizedString(for: posting.firstSeenAt.date, relativeTo: now)
    }

    /// "5 things left", and each kind for its tooltip: "3 values only you can give, 1 question
    /// only you can answer, 1 sentence to check". Nil when nothing's left.
    public static func todo(_ items: [ReviewTodo]) -> (title: String, help: String)? {
        let total = items.map(\.count).reduce(0, +)
        guard total > 0 else { return nil }
        return (total == 1 ? "1 thing left" : "\(total) things left", items.map(\.title).joined(separator: ", "))
    }

    /// "1 red flag", "2 red flags".
    public static func redFlags(_ count: Int) -> String {
        count == 1 ? "1 red flag" : "\(count) red flags"
    }
}

/// When a sent application went, for the hero and the lists: "Sent Oct 3 · 14 days ago · no
/// reply yet".
public enum SentText {
    /// When it was sent: the recorded send, else the receipt's.
    public static func date(_ app: Application) -> Date? {
        if app.hasAppliedAt { return app.appliedAt.date }
        if app.hasReceipt, app.receipt.hasSubmittedAt { return app.receipt.submittedAt.date }
        return nil
    }

    public static func line(_ app: Application, now: Date = Date()) -> String? {
        guard StageRules.isSent(app.stage), let sent = date(app) else { return nil }
        let replies = app.emails.count
        return [
            "Sent " + sent.formatted(.dateTime.month(.abbreviated).day()),
            ago(sent, now: now),
            replies == 0 ? "no reply yet" : replies == 1 ? "1 reply" : "\(replies) replies",
        ].joined(separator: " · ")
    }

    /// "14 days ago", "today".
    static func ago(_ date: Date, now: Date) -> String {
        let days = Calendar.current.dateComponents([.day], from: Calendar.current.startOfDay(for: date), to: Calendar.current.startOfDay(for: now)).day ?? 0
        switch days {
        case ..<1: return "today"
        case 1: return "yesterday"
        default: return "\(days) days ago"
        }
    }
}

/// The site wants the candidate signed in before the application can go through: one button
/// opens Applyant's browser at its sign-in.
public struct SignInHint: Equatable, Sendable {
    public let host: String
    /// What SignIn opens.
    public let url: String

    public var title: String { "Sign in to \(host)…" }

    /// When the application's note, a blocker or its hand-off asks for a sign-in, and it isn't
    /// sent yet (an old note says nothing about a sent one). The site is the apply form's, else
    /// the posting's.
    public static func of(_ app: Application) -> SignInHint? {
        guard !StageRules.isSent(app.stage) else { return nil }
        let said = [app.hasNote ? app.note : "", app.hasHandOff ? app.handOff.reason : "", app.hasHandOff ? app.handOff.detail : ""] + app.blockers
        guard said.contains(where: asksToSignIn) else { return nil }
        return target(app.hasFormURL && !app.formURL.isEmpty ? app.formURL : app.postingURL)
    }

    public static func asksToSignIn(_ text: String) -> Bool {
        let lower = text.lowercased()
        return ["sign in", "sign-in", "signed in", "log in", "logged in"].contains { lower.contains($0) }
    }

    /// Djinni's own login page; any other site at its https origin.
    public static func target(_ url: String) -> SignInHint? {
        guard let host = URL(string: url)?.host?.lowercased(), !host.isEmpty else { return nil }
        let bare = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
        if bare == "djinni.co" { return SignInHint(host: bare, url: "https://djinni.co/login") }
        return SignInHint(host: bare, url: "https://\(host)")
    }
}
