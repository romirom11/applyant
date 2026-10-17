// How the store's data reads on screen: sidebar sections, list rows, score points, chips and
// the review rules. Plain values, so they're tested without SwiftUI.
import ApplyantAPI
import Foundation

public enum Section: String, CaseIterable, Identifiable, Sendable {
    case overview
    // The jobs lists keep the raw values of their first names: scripted runs (`--script`) name
    // sections by them.
    case toReview = "readyToReview", new = "inbox", saved = "interested", skipped
    case applied, interviews, offers, whichApplication
    case profile, projects, interview, chat
    case search, agentRuns, companies, settings

    public var id: String { rawValue }

    public enum Group: String, CaseIterable, Sendable { case top = "", jobs = "Jobs", applications = "Applications", me = "Me", system = "System" }

    public var group: Group {
        switch self {
        case .overview: .top
        case .toReview, .new, .saved, .skipped: .jobs
        case .applied, .interviews, .offers, .whichApplication: .applications
        case .profile, .projects, .interview, .chat: .me
        case .search, .agentRuns, .companies, .settings: .system
        }
    }

    public var title: String {
        switch self {
        case .overview: "Overview"
        case .toReview: "To review"
        case .new: "New"
        case .saved: "Saved"
        case .skipped: "Skipped"
        case .applied: "Applied"
        case .interviews: "Interviews"
        case .offers: "Offers"
        case .whichApplication: "Replies"
        case .profile: "Profile"
        case .projects: "Projects"
        case .interview: "Questions for you"
        case .chat: "Chat"
        case .search: "Search"
        case .agentRuns: "Agent runs"
        case .companies: "Companies"
        case .settings: "Settings"
        }
    }

    public var symbol: String {
        switch self {
        case .overview: "chart.pie"
        case .toReview: "pencil.and.list.clipboard"
        case .new: "tray"
        case .saved: "bookmark"
        case .skipped: "xmark.circle"
        case .applied: "paperplane"
        case .interviews: "phone"
        case .offers: "checkmark.seal"
        case .whichApplication: "questionmark.bubble"
        case .profile: "person.crop.circle"
        case .projects: "folder"
        case .interview: "bubble.left.and.bubble.right"
        case .chat: "message"
        case .search: "magnifyingglass"
        case .agentRuns: "arrow.triangle.2.circlepath"
        case .companies: "building.2"
        case .settings: "gearshape"
        }
    }

    /// Every section has content.
    public var isBuilt: Bool { true }

    /// Sections that are one page: no list to pick from, so they take the whole window (Home
    /// is its grid of tiles). Settings has its panes as a list, like every other section.
    public var isSinglePane: Bool { self == .overview || self == .chat }

    /// Home's name in the rail: the Overview is where the window opens.
    /// The rail's label: short enough to fit beside a badge (the list header keeps the full title).
    public var railTitle: String {
        switch self {
        case .overview: "Home"
        case .whichApplication: "Replies"
        case .interview: "Questions"
        default: title
        }
    }

    /// The section after this one in the rail (⌥⌘↓), or before it (⌥⌘↑); nil past either end.
    public func neighbour(_ step: Int) -> Section? {
        let all = Section.allCases
        guard let i = all.firstIndex(of: self), all.indices.contains(i + step) else { return nil }
        return all[i + step]
    }
}

public struct Navigation: Equatable, Sendable {
    /// The window opens on Home.
    public var section: Section = .overview
    public var postingId: Int64?
    /// The application open with the posting (its Application tab).
    public var reviewing: Int64?
    /// A tab the job detail switches to once: a review asked for from a notification, the
    /// menu bar or another screen.
    public var tab: DetailTab?
    /// New lists the good matches only, or every scored posting.
    public var newFilter: NewFilter = .good
    /// The interview thread open in the Interview section.
    public var interview: InterviewTarget?
    /// The strategy or source open in the Search section.
    public var search: SearchSelection?
    /// The run open in the Agent runs section.
    public var run: Int64?
    /// Agent runs lists the model runs instead of the search runs.
    public var modelRuns = false
    /// The company open in the Companies section.
    public var company: Int64?
    /// The reply open in Which application?.
    public var email: Int64?
    /// The project open in Projects.
    public var project: Int64?
    public init() {}

    /// Opens a section (the rail, the Go menu) with nothing picked in it yet.
    public mutating func go(to section: Section) {
        guard section != self.section else { return }
        self.section = section
        postingId = nil
        reviewing = nil
    }

    public mutating func showInterview(_ target: InterviewTarget) {
        section = .interview
        postingId = nil
        reviewing = nil
        interview = target
    }

    /// A list's row: its posting, with its application when it has one.
    public mutating func select(_ item: ListItem?) {
        postingId = item?.postingId
        reviewing = item?.applicationId
    }

    /// Opens an application's review (its Application tab) in the list its stage puts it in
    /// (To review when the stage isn't known).
    public mutating func showReview(application: Int64, posting: Int64, stage: ApplicationStage? = nil) {
        section = stage.map(Navigation.section(for:)) ?? .toReview
        postingId = posting
        reviewing = application
        tab = .application
    }

    /// The same, from the application itself: a delivery waiting on the candidate is in To review.
    public mutating func showReview(_ app: Application) {
        showReview(application: app.id, posting: app.postingID, stage: app.stage)
        section = Navigation.section(for: app)
    }

    /// Opens a posting in the list it's in now (Companies, a posting link).
    public mutating func showPosting(_ posting: Posting, application: Application?) {
        section = Navigation.section(for: posting, application: application)
        postingId = posting.id
        reviewing = application?.id
    }

    /// The list an application is in, by its stage (AppStore.items follows the same split).
    public static func section(for stage: ApplicationStage) -> Section {
        switch stage {
        case .approved, .applied, .rejected, .withdrawn: .applied
        case .interview: .interviews
        case .offer: .offers
        default: .toReview
        }
    }

    /// An approved application whose delivery stopped for the candidate (a hand-off) waits in
    /// To review with the others that need them.
    public static func section(for app: Application) -> Section {
        app.stage == .approved && app.hasHandOff ? .toReview : section(for: app.stage)
    }

    public static func section(for posting: Posting, application: Application?) -> Section {
        if posting.stage == .skipped || posting.decision == "skipped" { return .skipped }
        if let application { return section(for: application) }
        return posting.decision == "interested" ? .saved : .new
    }
}

extension ActivityText {
    /// The title bar's capsule while background work is paused: "Paused since Oct 16, 23:16"
    /// (the time alone today); the whole line is its tooltip.
    public static func pausedSince(_ since: Date, now: Date = Date()) -> String {
        let time = Calendar.current.isDate(since, inSameDayAs: now)
            ? since.formatted(date: .omitted, time: .shortened)
            : since.formatted(.dateTime.month(.abbreviated).day().hour().minute())
        return "Paused since \(time)"
    }

    /// The title bar's capsule for the work running now: the status line's first part, and
    /// how many more there are ("Scoring 3 postings +2"); the whole line is its tooltip.
    public static func pill(_ line: String) -> String {
        let parts = line.components(separatedBy: " · ")
        let first = parts[0].prefix(1).uppercased() + parts[0].dropFirst()
        return parts.count > 1 ? "\(first) +\(parts.count - 1)" : first
    }
}

public struct Chip: Equatable, Sendable {
    public enum Tone: Sendable { case accent, warning, neutral, good }
    public let text: String
    public let tone: Tone
    /// Work under way (preparing, delivering): the chip shows it's alive.
    public let live: Bool
    /// All of it, for the chip's tooltip, when the text is a short form ("English: B1 < fluent").
    public let help: String?

    public init(text: String, tone: Tone, live: Bool = false, help: String? = nil) {
        self.text = text
        self.tone = tone
        self.live = live
        self.help = help
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

    init(posting: Posting, application: Application?, delivery: DeliveryProgress? = nil) {
        id = "p\(posting.id)"
        postingId = posting.id
        applicationId = application?.id
        score = posting.hasScore ? posting.score : nil
        title = posting.hasTitle ? posting.title : posting.canonicalURL
        let company = posting.hasCompany ? posting.company : nil
        // Sent: when it went says more than the salary that was read before.
        let second = application.flatMap(Self.sent) ?? (posting.hasSalaryText ? posting.salaryText : nil)
        subtitle = [company, second].compactMap { $0 }.joined(separator: " · ")
        var chips: [Chip] = []
        // Skipped is what it is, whatever its application had reached.
        if posting.stage == .skipped || posting.decision == "skipped" { chips.append(Chip(text: "Skipped", tone: .neutral)) }
        else if let application { chips.append(StageText.chip(application, delivery: delivery)) }
        if let deviation = Score.deviation(posting) { chips.append(Chip(text: deviation.short, tone: .warning, help: deviation.full)) }
        if let ats = Source.ats(posting.hasApplyURL ? posting.applyURL : posting.canonicalURL) {
            chips.append(Chip(text: ats, tone: .neutral))
        }
        self.chips = chips
    }

    init(application: Application, delivery: DeliveryProgress? = nil) {
        id = "a\(application.id)"
        postingId = application.postingID
        applicationId = application.id
        score = application.hasScore ? application.score : nil
        title = application.hasTitle ? application.title : application.postingURL
        subtitle = [application.hasCompany ? application.company : nil, Self.sent(application)].compactMap { $0 }.joined(separator: " · ")
        chips = [StageText.chip(application, delivery: delivery)]
    }

    /// The row's chips in a list: a stage chip that only repeats the list it's in goes (Applied
    /// in Applied, Interview in Interviews); a rejection or a withdrawal in Applied still says so.
    public func chips(in section: Section) -> [Chip] {
        let own: String? = switch section {
        case .applied: StageText.name(.applied)
        case .interviews: StageText.name(.interview)
        case .offers: StageText.name(.offer)
        default: nil
        }
        guard let own, applicationId != nil else { return chips }
        return chips.filter { $0.text != own }
    }

    /// "Sent Oct 3", once it's sent.
    static func sent(_ app: Application) -> String? {
        guard StageRules.isSent(app.stage), let date = SentText.date(app) else { return nil }
        return "Sent " + date.formatted(.dateTime.month(.abbreviated).day())
    }
}

public enum StageText {
    /// `delivery`: what a delivery under way is doing, from live events ("Filling 14/16 fields").
    public static func chip(_ app: Application, delivery: DeliveryProgress? = nil) -> Chip {
        switch app.stage {
        case .preparing: Chip(text: "Preparing…", tone: .neutral, live: true)
        case .readyForReview: Chip(text: "Ready to send", tone: .accent)
        case .needsCandidate: Chip(text: "Needs you", tone: .warning)
        case .approved: app.hasHandOff
            ? Chip(text: "Finish in browser", tone: .warning)
            : Chip(text: delivery.map(\.line) ?? "Approved · delivering", tone: .good, live: true)
        case .applied: Chip(text: "Applied", tone: .good)
        case .interview: Chip(text: "Interview", tone: .good)
        case .offer: Chip(text: "Offer", tone: .good)
        case .rejected: Chip(text: "Rejected", tone: .warning)
        case .withdrawn: Chip(text: "Withdrawn", tone: .neutral)
        default: Chip(text: "Application", tone: .neutral)
        }
    }

    /// A stage by its name, as Set status offers it.
    public static func name(_ stage: ApplicationStage) -> String {
        switch stage {
        case .preparing: "Preparing"
        case .readyForReview: "Ready to send"
        case .needsCandidate: "Needs you"
        case .approved: "Approved"
        case .applied: "Applied"
        case .interview: "Interview"
        case .offer: "Offer"
        case .rejected: "Rejected"
        case .withdrawn: "Withdrawn"
        default: "Application"
        }
    }

    /// Set status's item for a target: Applied before anything was sent means it went out
    /// some other way.
    public static func statusItem(_ target: ApplicationStage, from stage: ApplicationStage) -> String {
        target == .applied && !StageRules.isSent(stage) ? "Applied (sent outside Applyant)" : name(target)
    }
}

/// The statuses the candidate can set by hand. The daemon has the final say (it also refuses
/// Applied while a delivery is queued or running, which the app can't see).
public enum StageRules {
    /// Every status that can be set by hand, in the menu's order.
    public static let manual: [ApplicationStage] = [.applied, .interview, .offer, .rejected, .withdrawn]

    /// Sent: by Applyant or by hand, and what the replies (or the candidate) made of it since.
    public static func isSent(_ stage: ApplicationStage) -> Bool {
        [.applied, .interview, .offer, .rejected, .withdrawn].contains(stage)
    }

    /// Applied from any other status (sent outside Applyant, or a wrong reply undone); the reply
    /// statuses only once it was sent. Never the status it already has.
    public static func targets(from stage: ApplicationStage) -> [ApplicationStage] {
        manual.filter { $0 != stage && ($0 == .applied || isSent(stage)) }
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

    /// The component that costs the most points, short enough for a row's chip ("English: B1 <
    /// fluent", at most 24 characters).
    public static func mainDeviation(_ p: Posting) -> String? { deviation(p)?.short }

    /// The same, with the scorer's whole sentence for the chip's tooltip.
    public static func deviation(_ p: Posting) -> (short: String, full: String)? {
        if let dealbreaker = p.dealbreakers.first {
            let full = "Dealbreaker: \(dealbreaker)"
            return (full.count <= chipLength ? full : clipped(dealbreaker, to: chipLength), full)
        }
        let lossy = p.breakdown
            // Must-haves and nice-to-haves are the score itself, not a deviation to flag.
            .filter { $0.weight > 0 && !$0.uncertain && $0.hasNote && $0.value < 1 && $0.key != "must" && $0.key != "nice" }
            .max { lost($0) < lost($1) }
        guard let c = lossy, lost(c) >= 2 else { return nil }
        return (shortNote(c.key, c.note), c.note)
    }

    /// A chip's text never runs past this.
    public static let chipLength = 24

    /// The scorer's note, short: "English (fluent) · you have B1" → "English: B1 < fluent",
    /// "Salary $4k · 7% below target" → "Salary 7% below target", else its first part.
    static func shortNote(_ key: String, _ note: String) -> String {
        let parts = note.components(separatedBy: " · ").map { $0.trimmingCharacters(in: .whitespaces) }
        let head = parts.first ?? note
        switch key {
        case "language":
            // "English (fluent)" + "you have B1" | "you don't list it".
            let name = head.components(separatedBy: " (").first ?? head
            let level = head.range(of: #"\(([^)]*)\)"#, options: .regularExpression).map { String(head[$0].dropFirst().dropLast()) }
            if let have = parts.first(where: { $0.hasPrefix("you have ") })?.dropFirst("you have ".count), let level {
                return clipped("\(name): \(have) < \(level)", to: chipLength)
            }
            if parts.contains("you don't list it") { return clipped("\(name) not listed", to: chipLength) }
            return clipped(name, to: chipLength)
        case "salary":
            if let versus = parts.first(where: { $0.hasSuffix("below target") }) {
                return clipped(versus.hasPrefix("Salary") ? versus : "Salary " + versus, to: chipLength)
            }
            if head.hasPrefix("Salary below your floor") { return "Salary below your floor" }
            return clipped(head, to: chipLength)
        default:
            return clipped(head, to: chipLength)
        }
    }

    /// At most `n` characters, cut at a word with "…".
    static func clipped(_ s: String, to n: Int) -> String {
        guard s.count > n else { return s }
        let cut = s.prefix(n - 1)
        let word = cut.lastIndex(of: " ").map { cut[..<$0] } ?? cut
        return word.trimmingCharacters(in: CharacterSet(charactersIn: " ,;:·(")) + "…"
    }

    private static func lost(_ c: Applyant_V1_ScoreComponent) -> Double { c.weight * (1 - c.value) }

    /// The daemon scores verified, scored and skipped postings (not unverified or closed ones).
    public static func canRescore(_ p: Posting) -> Bool { [.verified, .scored, .skipped].contains(p.stage) }

    /// What Re-score says: "Re-scoring 1 posting", or that there was nothing new to enqueue.
    public static func rescored(_ enqueued: Int, all: Bool) -> String {
        if enqueued == 0 { return all ? "Nothing to re-score: already being scored" : "Already being scored" }
        return "Re-scoring \(enqueued) posting\(enqueued == 1 ? "" : "s")"
    }

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

    /// Where a posting was found, for the detail's chip: a board or an ATS by name, else the
    /// site's host ("Djinni", "Greenhouse", "elevenlabs.io").
    public static func site(_ url: String) -> String? {
        guard let host = URL(string: url)?.host?.lowercased() else { return nil }
        let boards: [(String, String)] = [
            ("djinni.co", "Djinni"), ("arbeitnow.", "Arbeitnow"), ("weworkremotely.com", "We Work Remotely"),
            ("remoteok.com", "Remote OK"), ("remotive.com", "Remotive"), ("t.me", "Telegram"), ("linkedin.com", "LinkedIn"),
            ("xing.com", "Xing"), ("jobico.io", "Jobico"), ("dou.ua", "DOU"), ("news.ycombinator.com", "Hacker News"),
            ("workatastartup.com", "Work at a Startup"), ("grnh.se", "Greenhouse"),
        ]
        if let board = boards.first(where: { host == $0.0 || host.hasSuffix("." + $0.0) || ($0.0.hasSuffix(".") && host.contains($0.0)) }) {
            return board.1
        }
        return ats(url) ?? (host.hasPrefix("www.") ? String(host.dropFirst(4)) : host)
    }
}

public enum ReviewRules {
    /// Approve is on only when the daemon reports nothing blocking it.
    public static func canApprove(_ app: Application) -> Bool {
        app.stage == .readyForReview && app.blockers.isEmpty
    }

    /// The posting has both forms and nothing has been approved or sent yet.
    public static func canSwitchForm(_ app: Application) -> Bool {
        app.applyFormSwitchable && [.preparing, .readyForReview, .needsCandidate].contains(app.stage)
    }

    /// "Applying through LinkedIn Easy Apply" / "… the company's own form".
    public static func formText(_ app: Application) -> String {
        app.applyForm == .platform ? "Applying through the platform's form (Easy Apply / Xing)" : "Applying through the company's own form"
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
        case "unconfirmed": "Relies on a fact you haven't confirmed yet"
        case "rejected_fact": "Cites a fact you rejected"
        case "absent_number": "A number the facts don't have"
        case "contradiction": "Contradicts its facts"
        default: s.flag.hasPrefix("verifier:")
            ? FieldText.verifierIssue(String(s.flag.dropFirst("verifier:".count))) + (s.hasNote ? ": \(s.note)" : "")
            : "Flagged: " + s.flag.replacingOccurrences(of: "_", with: " ")
        }
    }

    /// What the highlighted sentences mean and what to do about them.
    public static func flaggedIntro(_ count: Int) -> String {
        let n = count == 1 ? "1 highlighted sentence says" : "\(count) highlighted sentences say"
        return "\(n) more than your confirmed facts show, so Approve waits. For each: “It's true” keeps it (it becomes a fact you stand behind), “Edit…” puts it in your words. Or redraft the whole answer below."
    }

    /// Why a sentence is highlighted, in a few plain words, with the checker's note.
    public static func flagReason(_ s: Applyant_V1_AnswerSentence) -> String {
        switch s.flag {
        case "unconfirmed": return "It relies on a fact you haven't confirmed yet."
        case "rejected_fact": return "It cites a fact you rejected."
        case "absent_number": return "Your facts don't have this number."
        case "contradiction": return "A number here contradicts your facts: only an edit clears it."
        default:
            guard s.flag.hasPrefix("verifier:") else { return flagText(s) ?? "" }
            let issue: String = switch String(s.flag.dropFirst("verifier:".count)) {
            case "unsupported": "Your facts don't say this."
            case "role": "It makes your part bigger than your facts do."
            case "scope": "It makes the work bigger than your facts do."
            case "quantity": "A number differs from your facts."
            case "timeframe": "The dates or duration aren't in your facts."
            default: FieldText.verifierIssue(String(s.flag.dropFirst("verifier:".count)))
            }
            return s.hasNote ? "\(issue) \(s.note)" : issue
        }
    }

    /// A number the facts don't have can be confirmed as written; a contradiction can't.
    public static func canConfirmAsWritten(_ s: Applyant_V1_AnswerSentence) -> Bool {
        s.flag == "absent_number" || s.flag.hasPrefix("verifier:")
    }

    public static func unconfirmedFacts(_ app: Application) -> Set<Int64> { Set(app.unconfirmedFactIds) }

    /// The sentences an answer's paragraphs start with (never its first): after a greeting
    /// ("Dear team,") or a line ending in a colon, at a sign-off ("Best regards"), or where the
    /// draft itself began a new line. The sentences come without their line breaks otherwise.
    public static func paragraphStarts(_ sentences: [Applyant_V1_AnswerSentence]) -> Set<Int32> {
        let signOffs = ["best regards", "kind regards", "regards", "best,", "sincerely", "thank you", "thanks", "cheers", "warm regards", "з повагою"]
        var starts = Set<Int32>()
        for (i, s) in sentences.enumerated() where i > 0 {
            let previous = sentences[i - 1].text.trimmingCharacters(in: .whitespaces)
            let lower = s.text.trimmingCharacters(in: .whitespaces).lowercased()
            if s.text.hasPrefix("\n") || previous.hasSuffix(":") || previous.hasSuffix(",") && previous.count < 40
                || signOffs.contains(where: { lower.hasPrefix($0) }) {
                starts.insert(s.index)
            }
        }
        return starts
    }

    /// Answers waiting on something only the candidate knows.
    public static func answersNeedingYou(_ app: Application) -> [Applyant_V1_Answer] {
        activeAnswers(app).filter { $0.status == "needs_candidate" }
    }

    /// Highlighted sentences to check in the answers that are sent; one resting on an
    /// unconfirmed fact is the facts' to-do instead.
    public static func sentencesToCheck(_ app: Application) -> [(answer: Applyant_V1_Answer, sentence: Applyant_V1_AnswerSentence)] {
        activeAnswers(app).filter { $0.status != "needs_candidate" }.flatMap { a in
            a.sentences.filter { flagText($0) != nil && $0.flag != "unconfirmed" }.map { (a, $0) }
        }
    }

    /// What's left before it can be sent, from the application's own data, so the hero's link,
    /// the Application tab and any count agree. Nothing once it's approved or sent.
    public static func todo(_ app: Application) -> [ReviewTodo] {
        guard [.readyForReview, .needsCandidate].contains(app.stage) else { return [] }
        let counts: [(ReviewTodo.Kind, Int)] = [
            (.values, problemFields(app).count),
            (.answers, answersNeedingYou(app).count),
            (.sentences, sentencesToCheck(app).count),
            (.facts, Set(app.unconfirmedFactIds).count),
            (.cv, app.hasCv ? app.cv.stale.count : 0),
        ]
        return counts.filter { $0.1 > 0 }.map { ReviewTodo(kind: $0.0, count: $0.1) }
    }
}

/// Settings' list: each pane's one line of where it stands.
public enum SettingsText {
    /// "Roman Kudin · 21 projects".
    public static func general(name: String?, projects: Int) -> String {
        let count = projects == 0 ? nil : projects == 1 ? "1 project" : "\(projects) projects"
        return [name?.nonBlank, count].compactMap { $0 }.joined(separator: " · ").nonBlank ?? "Setup, profile and preferences"
    }

    /// "Gmail connected" · "Gmail signed out" · "No mailbox", and " · Telegram" once it's connected.
    public static func connections(_ box: Mailbox?, telegram: TelegramAccount?) -> String {
        let gmail = box?.kind == "gmail"
        let mailbox = if MailText.problem(box) != nil {
            gmail ? "Gmail signed out" : "Mailbox not syncing"
        } else {
            switch box?.status {
            case "connected"?: gmail ? "Gmail connected" : "Mailbox connected"
            case "connecting"?: "Waiting for Google"
            case "failed"?: "Mailbox failed"
            default: "No mailbox"
            }
        }
        return mailbox + (telegram?.state == .connected ? " · Telegram" : "")
    }

    /// The mailbox needs the candidate: signed out, not syncing, or failed.
    public static func connectionsNeedYou(_ box: Mailbox?) -> Bool {
        MailText.problem(box) != nil || box?.status == "failed"
    }

    /// The sites Applyant is signed in to, by name: "Djinni · LinkedIn · Xing" (LinkedIn and Xing
    /// by their sign-in, any other by its kept login).
    public static func sites(_ list: PlatformList?, secrets: [String]) -> String {
        let platforms = (list?.platforms ?? []).filter(\.hasSignedInAt).map(\.name)
        let logins = secrets.filter { $0.hasPrefix("login.") }.compactMap { name -> String? in
            // The name is the sign-in address flattened ("djinni.co-login"): its host comes first.
            let key = String(name.dropFirst("login.".count))
            let host = key.range(of: #"^[a-z0-9.-]*?\.[a-z]{2,}(?=-|$)"#, options: .regularExpression).map { String(key[$0]) } ?? key
            return Source.site("https://" + host)
        }
        let names = Set(platforms + logins).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
        return names.isEmpty ? "No sign-ins yet" : names.joined(separator: " · ")
    }

    /// "Claude · 14 roles": the providers the roles run on, the most used first.
    public static func models(_ roles: [RoleRoute]) -> String {
        guard !roles.isEmpty else { return "Models and stored keys" }
        let counts = Dictionary(grouping: roles) { RolesText.provider($0.route) }.mapValues(\.count)
        let providers = counts.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.map { provider in
            switch provider.key {
            case "apple": "On-device"
            case "": "Default"
            default: provider.key.prefix(1).uppercased() + provider.key.dropFirst()
            }
        }
        return (providers.prefix(2) + [roles.count == 1 ? "1 role" : "\(roles.count) roles"]).joined(separator: " · ")
    }
}

private extension String {
    var nonBlank: String? { trimmingCharacters(in: .whitespaces).isEmpty ? nil : self }
}

/// One kind of thing left to do before an application can go: "3 values only you can give".
public struct ReviewTodo: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable { case values, answers, sentences, facts, cv }
    public let kind: Kind
    public let count: Int

    public init(kind: Kind, count: Int) {
        self.kind = kind
        self.count = count
    }

    public var id: Kind { kind }

    public var title: String {
        let one = count == 1
        return switch kind {
        case .values: one ? "1 value only you can give" : "\(count) values only you can give"
        case .answers: one ? "1 question only you can answer" : "\(count) questions only you can answer"
        case .sentences: one ? "1 sentence to check" : "\(count) sentences to check"
        case .facts: one ? "1 fact to confirm" : "\(count) facts to confirm"
        case .cv: one ? "1 CV line to fix" : "\(count) CV lines to fix"
        }
    }
}
