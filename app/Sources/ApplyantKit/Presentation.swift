// How the store's data reads on screen: sidebar sections, list rows, score points, chips and
// the review rules. Plain values, so they're tested without SwiftUI.
import ApplyantAPI
import Foundation

public enum Section: String, CaseIterable, Identifiable, Sendable {
    case overview
    case inbox, readyToReview, preparing, interested, skipped
    case applied, interviews, offers, whichApplication
    case profile, projects, interview
    case search, agentRuns, companies, settings

    public var id: String { rawValue }

    public enum Group: String, CaseIterable, Sendable { case top = "", jobs = "Jobs", applications = "Applications", me = "Me", system = "System" }

    public var group: Group {
        switch self {
        case .overview: .top
        case .inbox, .readyToReview, .preparing, .interested, .skipped: .jobs
        case .applied, .interviews, .offers, .whichApplication: .applications
        case .profile, .projects, .interview: .me
        case .search, .agentRuns, .companies, .settings: .system
        }
    }

    public var title: String {
        switch self {
        case .overview: "Overview"
        case .inbox: "Inbox"
        case .readyToReview: "Ready to review"
        case .preparing: "Preparing"
        case .interested: "Interested"
        case .skipped: "Skipped"
        case .applied: "Applied"
        case .interviews: "Interviews"
        case .offers: "Offers"
        case .whichApplication: "Which application?"
        case .profile: "Profile"
        case .projects: "Projects"
        case .interview: "Interview"
        case .search: "Search"
        case .agentRuns: "Agent runs"
        case .companies: "Companies"
        case .settings: "Settings"
        }
    }

    public var symbol: String {
        switch self {
        case .overview: "chart.pie"
        case .inbox: "tray"
        case .readyToReview: "pencil.and.list.clipboard"
        case .preparing: "hourglass"
        case .interested: "star"
        case .skipped: "xmark.circle"
        case .applied: "paperplane"
        case .interviews: "phone"
        case .offers: "checkmark.seal"
        case .whichApplication: "questionmark.bubble"
        case .profile: "person.crop.circle"
        case .projects: "folder"
        case .interview: "bubble.left.and.bubble.right"
        case .search: "magnifyingglass"
        case .agentRuns: "arrow.triangle.2.circlepath"
        case .companies: "building.2"
        case .settings: "gearshape"
        }
    }

    /// Sections with content so far; the rest show an empty state until their phase.
    public var isBuilt: Bool {
        switch self {
        case .inbox, .readyToReview, .preparing, .interested, .skipped, .applied, .interviews, .offers, .whichApplication,
             .interview, .search, .agentRuns, .companies: true
        default: false
        }
    }

    /// Which phase of the plan fills an empty section.
    public var comesWith: String? {
        switch self {
        case .overview: "the funnel view"
        case .profile, .projects: "onboarding (phase 16); the CLI has them now"
        case .settings: "onboarding (phase 16); `applyant secrets` and `candidate prefs` now"
        default: nil
        }
    }
}

public struct Navigation: Equatable, Sendable {
    public var section: Section = .inbox
    public var postingId: Int64?
    /// Set when the detail pane shows the application's review instead of the posting.
    public var reviewing: Int64?
    /// The interview thread open in the Interview section.
    public var interview: InterviewTarget?
    /// The strategy or source open in the Search section.
    public var search: SearchSelection?
    /// The run open in the Agent runs section.
    public var run: Int64?
    /// The company open in the Companies section.
    public var company: Int64?
    /// The reply open in Which application?.
    public var email: Int64?
    public init() {}

    public mutating func showInterview(_ target: InterviewTarget) {
        section = .interview
        postingId = nil
        reviewing = nil
        interview = target
    }

    public mutating func showReview(application: Int64, posting: Int64) {
        section = .readyToReview
        postingId = posting
        reviewing = application
    }
}

public struct Chip: Equatable, Sendable {
    public enum Tone: Sendable { case accent, warning, neutral, good }
    public let text: String
    public let tone: Tone

    public init(text: String, tone: Tone) {
        self.text = text
        self.tone = tone
    }
}

public struct ListItem: Identifiable, Equatable, Sendable {
    public let id: String
    public let postingId: Int64
    public let applicationId: Int64?
    public let score: Int32?
    public let title: String
    public let subtitle: String
    public let chips: [Chip]

    init(posting: Posting, application: Application?) {
        id = "p\(posting.id)"
        postingId = posting.id
        applicationId = application?.id
        score = posting.hasScore ? posting.score : nil
        title = posting.hasTitle ? posting.title : posting.canonicalURL
        subtitle = [posting.hasCompany ? posting.company : nil, posting.hasSalaryText ? posting.salaryText : nil]
            .compactMap { $0 }.joined(separator: " · ")
        var chips: [Chip] = []
        if let application { chips.append(StageText.chip(application)) }
        else if posting.stage == .skipped { chips.append(Chip(text: "Skipped", tone: .neutral)) }
        if let deviation = Score.mainDeviation(posting) { chips.append(Chip(text: deviation, tone: .warning)) }
        if let ats = Source.ats(posting.hasApplyURL ? posting.applyURL : posting.canonicalURL) {
            chips.append(Chip(text: ats, tone: .neutral))
        }
        self.chips = chips
    }

    init(application: Application) {
        id = "a\(application.id)"
        postingId = application.postingID
        applicationId = application.id
        score = application.hasScore ? application.score : nil
        title = application.hasTitle ? application.title : application.postingURL
        subtitle = application.hasCompany ? application.company : ""
        chips = [StageText.chip(application)]
    }
}

public enum StageText {
    public static func chip(_ app: Application) -> Chip {
        switch app.stage {
        case .preparing: Chip(text: "Preparing…", tone: .neutral)
        case .readyForReview: Chip(text: "Ready to review", tone: .accent)
        case .needsCandidate: Chip(text: "Needs you", tone: .warning)
        case .approved: app.hasHandOff
            ? Chip(text: "Finish in browser", tone: .warning)
            : Chip(text: "Approved · delivering", tone: .good)
        case .applied: Chip(text: "Applied", tone: .good)
        case .interview: Chip(text: "Interview", tone: .good)
        case .offer: Chip(text: "Offer", tone: .good)
        case .rejected: Chip(text: "Rejected", tone: .warning)
        default: Chip(text: "Application", tone: .neutral)
        }
    }
}

public enum Score {
    public static let componentTitles: [String: String] = [
        "must": "Must-haves", "nice": "Nice-to-haves", "role": "Role & seniority", "location": "Location",
        "remote": "Remote", "salary": "Salary", "language": "Language", "employment": "Employment", "company": "Company",
    ]

    /// Points earned and available for one component, as the breakdown shows them ("38/40").
    public static func points(_ c: Applyant_V1_ScoreComponent) -> (earned: Int, of: Int) {
        let of = Int(c.weight.rounded())
        let earned = Int((c.weight * c.value * (c.scale == 0 ? 1 : c.scale)).rounded())
        return (min(earned, of), of)
    }

    /// The component that costs the most points and says why ("Salary 7% below target").
    public static func mainDeviation(_ p: Posting) -> String? {
        if let dealbreaker = p.dealbreakers.first { return "Dealbreaker: \(dealbreaker)" }
        let lossy = p.breakdown
            // Must-haves and nice-to-haves are the score itself, not a deviation to flag.
            .filter { $0.weight > 0 && !$0.uncertain && $0.hasNote && $0.value < 1 && $0.key != "must" && $0.key != "nice" }
            .max { lost($0) < lost($1) }
        guard let c = lossy, lost(c) >= 2 else { return nil }
        return c.note
    }

    private static func lost(_ c: Applyant_V1_ScoreComponent) -> Double { c.weight * (1 - c.value) }

    public static func verdictMark(_ verdict: String) -> String {
        switch verdict {
        case "strong": "✓"
        case "partial": "~"
        case "missing": "✗"
        default: "?"
        }
    }
}

public enum Source {
    /// The ATS behind a URL, for the row chip.
    public static func ats(_ url: String) -> String? {
        guard let host = URL(string: url)?.host?.lowercased() else { return nil }
        let known: [(String, String)] = [
            ("greenhouse.io", "Greenhouse"), ("ashbyhq.com", "Ashby"), ("lever.co", "Lever"),
            ("workable.com", "Workable"), ("myworkdayjobs.com", "Workday"), ("smartrecruiters.com", "SmartRecruiters"),
            ("recruitee.com", "Recruitee"), ("personio.", "Personio"), ("teamtailor.com", "Teamtailor"),
        ]
        return known.first { host.contains($0.0) }?.1
    }
}

public enum ReviewRules {
    /// Approve is on only when the daemon reports nothing blocking it.
    public static func canApprove(_ app: Application) -> Bool {
        app.stage == .readyForReview && app.blockers.isEmpty
    }

    /// "11 standard fields ready": fields that need no attention.
    public static func routineFields(_ app: Application) -> [Applyant_V1_ApplicationField] {
        app.fields.filter { $0.active && $0.role != "question" && !$0.missing }
    }

    /// Fields pulled out of the summary: missing values.
    public static func problemFields(_ app: Application) -> [Applyant_V1_ApplicationField] {
        app.fields.filter { $0.active && $0.missing && $0.role != "question" }
    }

    public static func activeAnswers(_ app: Application) -> [Applyant_V1_Answer] {
        app.answers.filter { $0.active && !$0.overridden }
    }

    /// Whether a sentence is highlighted, and what the highlight says.
    public static func flagText(_ s: Applyant_V1_AnswerSentence) -> String? {
        switch s.flag {
        case "", "none": nil
        case "unchecked": "Not checked yet"
        case "unconfirmed": "Relies on an unconfirmed fact"
        case "rejected_fact": "Cites a fact you rejected"
        case "absent_number": "A number the facts don't have"
        case "contradiction": "Contradicts its facts"
        default: s.flag.hasPrefix("verifier:")
            ? "Verifier: \(s.flag.dropFirst("verifier:".count))" + (s.hasNote ? " — \(s.note)" : "")
            : s.flag
        }
    }

    /// A number the facts don't have can be confirmed as written; a contradiction can't.
    public static func canConfirmAsWritten(_ s: Applyant_V1_AnswerSentence) -> Bool {
        s.flag == "absent_number" || s.flag.hasPrefix("verifier:")
    }

    public static func unconfirmedFacts(_ app: Application) -> Set<Int64> { Set(app.unconfirmedFactIds) }
}
