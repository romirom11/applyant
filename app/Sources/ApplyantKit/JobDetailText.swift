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
    public let value: String

    public init(_ label: String, _ value: String) {
        self.label = label
        self.value = value
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
        if let workplace = firstPart(note(p, "location")) ?? structuredWorkplace(fields) {
            rows.append(KeyFact("Workplace", shortened(capitalized(workplace))))
        }
        if let place = fields["jobLocation"].flatMap(place) { rows.append(KeyFact("Location", place)) }
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

    /// A long list of countries in parentheses, cut to its first few.
    private static func shortened(_ s: String, keep: Int = 8) -> String {
        guard let open = s.firstIndex(of: "("), let close = s.lastIndex(of: ")"), open < close else { return s }
        let items = s[s.index(after: open)..<close].components(separatedBy: ", ")
        guard items.count > keep else { return s }
        return s[..<open] + "(" + items.prefix(keep).joined(separator: ", ") + " +\(items.count - keep) more)"
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

    /// "Place, address: PostalAddress, addressLocality: Hamburg, addressCountry: DE" → "Hamburg, DE".
    private static func place(_ flat: String) -> String? {
        let places = entries(flat).compactMap { e -> String? in
            let parts = [e["addressLocality"], e["addressCountry"]].compactMap { $0 }.filter { !$0.isEmpty }
            return parts.isEmpty ? nil : parts.joined(separator: ", ")
        }
        var seen = Set<String>()
        let unique = places.filter { seen.insert($0).inserted }
        return unique.isEmpty ? nil : unique.joined(separator: "; ")
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

    /// Must-haves, then nice-to-haves (an empty kind is left out).
    public static func requirementGroups(_ p: Posting) -> [RequirementGroup] {
        let note = { (key: String) in p.breakdown.first { $0.key == key && $0.hasNote }?.note }
        return [
            RequirementGroup(id: "must", title: "Must-haves", note: note("must"), requirements: p.requirements.filter(\.must)),
            RequirementGroup(id: "nice", title: "Nice-to-haves", note: note("nice"), requirements: p.requirements.filter { !$0.must }),
        ].filter { !$0.requirements.isEmpty }
    }

    /// The facts a requirement rests on, as one line each ("acme-api: Built the billing service").
    public static func evidence(_ r: RequirementMatch) -> [String] {
        r.facts.map { f in
            (f.hasProjectSlug ? "\(f.projectSlug): " : "") + f.text + (f.status == .unconfirmed ? " (unconfirmed)" : "")
        }
    }

    /// The score's parts that count or couldn't be judged.
    public static func breakdown(_ p: Posting) -> [Applyant_V1_ScoreComponent] {
        p.breakdown.filter { $0.weight > 0 || $0.uncertain }
    }

    /// Dealbreakers, and what the posting doesn't say enough about to score.
    public static func issues(_ p: Posting) -> [String] {
        p.dealbreakers.map { "Dealbreaker: \($0)" }
            + p.breakdown.filter { $0.uncertain && $0.hasNote }.map { "\(Score.componentTitles[$0.key] ?? $0.key): \($0.note)" }
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
