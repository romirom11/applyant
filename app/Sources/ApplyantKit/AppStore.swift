// The app's one store. It holds no business state of its own: lists come from the daemon, and
// the event stream keeps them current. On every (re)connect the lists are reloaded before the
// stream resumes, so nothing is missed while the daemon was away. Actions are RPCs.
import ApplyantAPI
import Foundation
import Observation

/// Something worth a notification (only from live events, never from a reload).
public struct StoreNotification: Equatable, Sendable {
    /// `statusChange`: a reply the mailbox read moved an application (interview, offer, rejected).
    public enum Kind: String, Sendable { case readyForReview, needsYou, handOff, statusChange }
    public let kind: Kind
    public let applicationId: Int64
    public let postingId: Int64
    public let title: String
    public let body: String

    public init(kind: Kind, applicationId: Int64, postingId: Int64, title: String, body: String) {
        self.kind = kind
        self.applicationId = applicationId
        self.postingId = postingId
        self.title = title
        self.body = body
    }
}

public struct Activity: Equatable, Sendable {
    /// Running task id → its kind.
    public var running: [Int64: String] = [:]
    /// "Waiting for claude limit · resumes 15:45".
    public var paused: String?
}

@MainActor @Observable
public final class AppStore {
    public enum Connection: Equatable, Sendable {
        case connecting
        case connected
        case disconnected(String)
    }

    public private(set) var connection: Connection = .connecting
    /// Every posting, as ListPostings returns it (details come from GetPosting).
    public private(set) var postings: [Int64: Posting] = [:]
    public private(set) var applications: [Int64: Application] = [:]
    /// GetPosting / GetApplication results for what's open on screen.
    public private(set) var postingDetails: [Int64: Posting] = [:]
    public private(set) var applicationDetails: [Int64: Application] = [:]
    public private(set) var activity = Activity()
    /// Deliveries under way: application id → what the delivery is doing now, from live events.
    public private(set) var deliveries: [Int64: DeliveryProgress] = [:]
    /// Interview questions waiting on the candidate or being read (application ones first).
    public private(set) var interviewQuestions: [InterviewQuestion] = []
    /// Every project with what its facts don't show yet.
    public private(set) var projectInterviews: [ProjectInterview] = []
    /// GetInterview results for the threads open on screen.
    public private(set) var interviewThreads: [InterviewTarget: InterviewThread] = [:]
    /// Search strategies, sources and kind switches, with what each found.
    public private(set) var search = SearchList()
    /// Recent search runs, newest first.
    public private(set) var searchRuns: [SearchRun] = []
    /// Sources open in the Search detail pane, with their recipe's listings.
    public private(set) var sourceDetails: [String: SearchSource] = [:]
    /// The events of the runs open on screen (Agent runs).
    public private(set) var runEvents: [Int64: [DaemonEvent]] = [:]
    /// Researched companies (the Companies section).
    public private(set) var companies: [Company] = []
    /// GetCompany results for the companies open on screen.
    public private(set) var companyDetails: [Int64: Company] = [:]
    /// The connected mailbox (nil when none is), and the replies waiting for "Which application?".
    public private(set) var mailbox: Mailbox?
    public private(set) var mailQueue: [Email] = []
    /// Whether a Google client secret is stored (never its value) and the client id to offer.
    public private(set) var mailboxSecretStored = false
    public private(set) var googleClientId = ""
    /// The Google consent URL while the browser is still out (the sheet waits on it).
    public private(set) var googleConsentURL: URL?
    /// Opens a URL in the browser (the app sets NSWorkspace; tests record it).
    public var onOpenURL: (@MainActor (URL) -> Void)?
    /// How often the connecting mailbox is asked about while Google's consent is open.
    public var consentPollInterval: Duration = .seconds(1)
    private var consentWatch: Task<Void, Never>?
    /// LinkedIn/Xing (caps, pauses, sign-in) and the captcha solver's key status: Settings.
    public private(set) var platforms: PlatformList?
    /// The candidate's Telegram account (Settings → Telegram).
    public private(set) var telegram: TelegramAccount?
    /// The first-launch setup (phase 16): what the daemon says, and the setup window's state.
    public private(set) var setup: OnboardingStatus?
    public var onboarding = OnboardingFlow()
    public private(set) var preferencesDraft: [PreferenceSuggestion] = []
    /// The setup window is open: on the first launch while setup isn't done, or from the menu.
    public var showOnboarding = false
    /// The profile's values, projects and profile sources (Profile, Projects, the Import step).
    public private(set) var candidateProfile: CandidateProfile?
    /// Each open project's sources, with their sync state.
    public private(set) var projectSources: [Int64: [KnowledgeSource]] = [:]
    /// Knowledge sources being read right now (or waiting to try again, or given up on), from
    /// live `sync_source` task events: source id → where its reading stands.
    public private(set) var sourceSync: [Int64: SourceSync] = [:]
    /// The scoring preferences (Settings → Preferences).
    public private(set) var searchPreferences: SearchPreferences?
    /// The Overview: the funnel and the success metrics over `overviewWindow` (nil until loaded).
    public private(set) var overview: OverviewReport?
    /// The Overview's window; the screen loads again when it changes.
    public var overviewWindow: OverviewWindow = .overviewWindow30Days
    /// Model roles (Settings → Models).
    public private(set) var roles: [RoleRoute] = []
    /// Facts per project ref (FactsText.ref: a project id, or "profile"), for the facts browser.
    public private(set) var facts: [String: [Fact]] = [:]
    /// The names of the stored secrets (Settings → Stored keys; values are never read).
    public private(set) var secretNames: [String] = []
    private var onboardingOffered = false
    /// The last failed action, for an alert.
    public var lastError: String?
    /// Where the main window is (notifications and the menu bar move it).
    public var navigation = Navigation()
    /// Full reloads so far (tests: one per connect).
    public private(set) var reloads = 0
    /// Events applied from the stream since launch.
    public private(set) var eventsApplied = 0

    public var onNotify: (@MainActor (StoreNotification) -> Void)?

    private let connector: DaemonConnector
    private let backoff: @Sendable (Int) async -> Void
    private var api: DaemonAPI?

    public init(
        connector: DaemonConnector,
        backoff: @escaping @Sendable (Int) async -> Void = { attempt in
            try? await Task.sleep(for: .seconds(min(10, 1 << min(attempt, 4))))
        }
    ) {
        self.connector = connector
        self.backoff = backoff
    }

    // MARK: Connection

    /// Runs for the app's lifetime: connect, reload everything, follow events; again on any break.
    public func run() async {
        var attempt = 0
        while !Task.isCancelled {
            guard let api = connector.connect() else {
                connection = .disconnected("applyantd isn't running")
                self.api = nil
                await backoff(attempt)
                attempt += 1
                continue
            }
            self.api = api
            do {
                // The newest event before the reload: watching from it can't miss anything.
                let after = try await api.lastEventId()
                try await reloadAll(api)
                connection = .connected
                attempt = 0
                for try await event in api.events(after: after) {
                    await apply(event, live: true)
                }
                connection = .disconnected("the event stream ended")
            } catch {
                if Task.isCancelled { return }
                connection = .disconnected(error.localizedDescription)
            }
            await backoff(attempt)
            attempt += 1
        }
    }

    func reloadAll(_ api: DaemonAPI) async throws {
        async let postingList = api.listPostings()
        async let applicationList = api.listApplications()
        async let interviewList = api.listInterview()
        async let searchList = api.listSearch()
        async let runList = api.listSearchRuns(limit: 50)
        async let companyList = api.listCompanies()
        async let box = api.mailboxSetup()
        async let queue = api.mailQueue()
        let (p, a, i, s, r, c) = try await (postingList, applicationList, interviewList, searchList, runList, companyList)
        // An older daemon without the mailbox RPCs still loads everything else.
        applyMailbox(try? await box)
        mailQueue = (try? await queue) ?? []
        platforms = try? await api.listPlatforms()
        if let status = try? await api.setupStatus(refresh: false) { applySetup(status) }
        postings = Dictionary(p.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        applications = Dictionary(a.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        interviewQuestions = i.questions
        projectInterviews = i.projects
        search = s
        searchRuns = r
        companies = c
        activity = Activity()
        deliveries = [:]
        reloads += 1
        // What's open on screen may have changed while we were away.
        for id in postingDetails.keys { await refreshPosting(id, api) }
        for id in applicationDetails.keys { await refreshApplication(id, api) }
        for target in interviewThreads.keys { await refreshThread(target, api) }
        for run in runEvents.keys { await refreshRunEvents(run, api) }
        for id in companyDetails.keys { await refreshCompany(id, api) }
        if overview != nil { await refreshOverview(api) }
    }

    // MARK: Events

    public func apply(_ event: DaemonEvent, live: Bool) async {
        guard let api else { return }
        eventsApplied += 1
        switch event.payload {
        case let .task(task)?:
            applyTask(task, message: event.message)
            // A knowledge source finished (or gave up) syncing: its state and counts changed.
            if task.taskKind == "sync_source", [.done, .failed, .retry].contains(task.type), candidateProfile != nil {
                await refreshKnowledge(api)
            }
            // The setup's Import step counts sources, reading and facts: it follows them live.
            if task.taskKind == "sync_source", [.queued, .done, .failed, .retry].contains(task.type), setup != nil {
                await refreshSetup()
            }
        case let .posting(p)?:
            await refreshPosting(p.postingID, api)
            if navigation.section == .overview { await refreshOverview(api) }
        case let .application(a)?:
            let before = applications[a.applicationID]?.stage
            await refreshApplication(a.applicationID, api)
            await refreshPosting(a.postingID, api)
            if live, before != a.stage, let app = applications[a.applicationID] {
                if a.fromMail { notifyMail(app) } else { notifyStage(app) }
            }
            // The Overview on screen follows the funnel as postings and applications move.
            if navigation.section == .overview { await refreshOverview(api) }
        case let .handoff(h)?:
            await refreshApplication(h.applicationID, api)
            if live, let app = applications[h.applicationID] {
                onNotify?(StoreNotification(
                    kind: .handOff,
                    applicationId: app.id,
                    postingId: app.postingID,
                    title: "Finish in the browser: \(headline(app))",
                    body: h.reason
                ))
            }
        case .interview?:
            await refreshInterview(api)
        case .search?:
            await refreshSearch(api)
        case let .company(c)?:
            await refreshCompanies(api)
            if companyDetails[c.companyID] != nil { await refreshCompany(c.companyID, api) }
            // A posting or review open on screen shows the company's research too.
            for id in postingDetails.keys { await refreshPosting(id, api) }
            for id in applicationDetails.keys { await refreshApplication(id, api) }
        case let .mail(m)?:
            // Syncs, new questions and answers (status moves also arrive as application
            // events); a calendar event changes what an open application shows.
            await refreshMail(api)
            if ["connected", "failed", "disconnected"].contains(m.status) { await refreshSetup() }
            if m.status == "calendar" || m.status == "assigned" {
                for id in applicationDetails.keys { await refreshApplication(id, api) }
            }
        case .platform?:
            // LinkedIn/Xing paused, resumed, capped or signed in: Settings shows it. A pause
            // during a delivery also arrives as its hand-off event, which notifies.
            await refreshPlatforms(api)
        case nil:
            break
        }
        // A run open on screen follows its own events.
        if event.hasRunID, runEvents[event.runID] != nil { await refreshRunEvents(event.runID, api) }
    }

    private func applyTask(_ t: Applyant_V1_TaskEvent, message: String) {
        if t.taskKind == "sync_source" { sourceSync[t.entityID] = SourceSync.after(t.type, message: message, before: sourceSync[t.entityID]) }
        // A delivery's live progress ("Filling 14/16 fields · solving captcha"), per application.
        if t.taskKind == "deliver_application" {
            switch t.type {
            case .started: deliveries[t.entityID] = DeliveryProgress()
            case .progress: deliveries[t.entityID, default: DeliveryProgress()].apply(message)
            case .queued, .providerPaused: break
            default: deliveries[t.entityID] = nil
            }
        }
        switch t.type {
        case .started, .progress:
            activity.running[t.taskID] = t.taskKind
            activity.paused = nil
        case .providerPaused:
            activity.running[t.taskID] = nil
            activity.paused = pauseText(message)
        default:
            activity.running[t.taskID] = nil
        }
    }

    private func notifyStage(_ app: Application) {
        switch app.stage {
        case .readyForReview:
            onNotify?(StoreNotification(
                kind: .readyForReview,
                applicationId: app.id,
                postingId: app.postingID,
                title: headline(app) + (app.hasScore ? " · \(app.score)" : ""),
                body: "Ready to review"
            ))
        case .needsCandidate:
            onNotify?(StoreNotification(
                kind: .needsYou,
                applicationId: app.id,
                postingId: app.postingID,
                title: headline(app),
                body: app.missing.first ?? app.note
            ))
        default:
            break
        }
    }

    /// A reply moved the application: "Helix invites you to an interview" (only from a mail sync,
    /// never the candidate's own answer to "Which application is this?").
    private func notifyMail(_ app: Application) {
        guard let title = MailText.statusNotification(app) else { return }
        onNotify?(StoreNotification(
            kind: .statusChange,
            applicationId: app.id,
            postingId: app.postingID,
            title: title.title,
            body: title.body
        ))
    }

    // MARK: Refreshes

    private func refreshPosting(_ id: Int64, _ api: DaemonAPI) async {
        guard let posting = try? await api.getPosting(id) else { return }
        postings[id] = posting
        if postingDetails[id] != nil { postingDetails[id] = posting }
    }

    private func refreshApplication(_ id: Int64, _ api: DaemonAPI) async {
        guard let app = try? await api.getApplication(id) else { return }
        applications[id] = app
        if applicationDetails[id] != nil { applicationDetails[id] = app }
    }

    private func refreshInterview(_ api: DaemonAPI) async {
        if let list = try? await api.listInterview() {
            interviewQuestions = list.questions
            projectInterviews = list.projects
        }
        for target in interviewThreads.keys { await refreshThread(target, api) }
    }

    private func refreshThread(_ target: InterviewTarget, _ api: DaemonAPI) async {
        guard let thread = try? await api.interview(target) else { return }
        interviewThreads[target] = thread
    }

    private func refreshSearch(_ api: DaemonAPI) async {
        if let list = try? await api.listSearch() { search = list }
        if let runs = try? await api.listSearchRuns(limit: 50) { searchRuns = runs }
        for key in sourceDetails.keys {
            if let source = try? await api.searchSource(key) { sourceDetails[key] = source }
        }
    }

    private func refreshRunEvents(_ run: Int64, _ api: DaemonAPI) async {
        guard let events = try? await api.runEvents(run) else { return }
        runEvents[run] = events
    }

    /// Loads the full posting for its detail pane (and keeps it current from then on).
    public func openPosting(_ id: Int64) async {
        guard let api else { return }
        guard let posting = await attempt({ try await api.getPosting(id) }) else { return }
        postings[id] = posting
        postingDetails[id] = posting
    }

    public func openApplication(_ id: Int64) async {
        guard let api else { return }
        guard let app = await attempt({ try await api.getApplication(id) }) else { return }
        record(app)
    }

    private func record(_ app: Application) {
        applicationDetails[app.id] = app
        // The list keeps the summary shape: without the heavy fields.
        var summary = app
        summary.fields = []
        summary.answers = []
        summary.clearCv()
        applications[app.id] = summary
    }

    // MARK: Actions (each one RPC; the stream brings the rest)

    public func skip(posting id: Int64, reason: String) async {
        guard let api, let p = await attempt({ try await api.skip(posting: id, reason: reason) }) else { return }
        postings[id] = p
        if postingDetails[id] != nil { await openPosting(id) }
    }

    public func markInterested(posting id: Int64) async {
        guard let api, let p = await attempt({ try await api.markInterested(posting: id) }) else { return }
        postings[id] = p
        if postingDetails[id] != nil { await openPosting(id) }
    }

    /// Starts preparation for a posting; returns its application.
    @discardableResult
    public func prepare(posting id: Int64) async -> Int64? {
        guard let api, let app = await attempt({ try await api.prepare(posting: id) }) else { return nil }
        record(app)
        await refreshPosting(id, api)
        return app.id
    }

    public func regenerate(application id: Int64) async {
        guard let api, let app = await attempt({ try await api.prepare(application: id, rewrite: true) }) else { return }
        record(app)
    }

    public func confirmFacts(application id: Int64, factIds: [Int64]) async {
        guard let api else { return }
        guard await attempt({ try await api.confirmFacts(application: id, factIds: factIds) }) != nil else { return }
        await openApplication(id)
    }

    /// "Shorter" / "Use another project…": the answer is drafted again (the application prepares
    /// again; its events bring the new draft).
    public func redraftAnswer(application id: Int64, answer: Int32, shorter: Bool, project: String?) async {
        guard let api,
              let app = await attempt({ try await api.redraftAnswer(application: id, answer: answer, shorter: shorter, project: project) })
        else { return }
        record(app)
        await refreshApplication(id, api)
    }

    public func editAnswer(application id: Int64, answer: Int32, sentence: Int32?, text: String?) async {
        guard let api,
              let app = await attempt({ try await api.editAnswer(application: id, answer: answer, sentence: sentence, text: text) })
        else { return }
        record(app)
    }

    public func setField(application id: Int64, field: String, value: String?) async {
        guard let api, let app = await attempt({ try await api.setField(application: id, field: field, value: value) }) else {
            return
        }
        record(app)
    }

    public func setCvMode(application id: Int64, mode: String) async {
        guard let api, let app = await attempt({ try await api.setCvMode(application: id, mode: mode) }) else { return }
        record(app)
    }

    public func approve(application id: Int64) async {
        guard let app = applicationDetails[id] ?? applications[id], ReviewRules.canApprove(app) else {
            lastError = "This application can't be approved yet."
            return
        }
        guard let api, let approved = await attempt({ try await api.approve(application: id) }) else { return }
        record(approved)
    }

    /// Retries a delivery that got stuck (or approves and delivers).
    public func submit(application id: Int64) async {
        guard let api, let app = await attempt({ try await api.submit(application: id) }) else { return }
        record(app)
    }

    /// "I submitted it": a hand-off the candidate finished in the browser.
    public func setApplyForm(application id: Int64, form: Applyant_V1_ApplyForm) async {
        guard let app = applicationDetails[id] ?? applications[id], ReviewRules.canSwitchForm(app) else {
            lastError = "This application's form can't be switched."
            return
        }
        guard let api, let switched = await attempt({ try await api.setApplyForm(application: id, form: form) }) else { return }
        record(switched)
    }

    public func markSubmitted(application id: Int64) async {
        guard let api, let app = await attempt({ try await api.markSubmitted(application: id) }) else { return }
        record(app)
    }

    /// Set status: Applied, Interview, Offer, Rejected or Withdrawn by hand. The daemon says no to
    /// moves that can't be true (the reason is shown). True when it was set.
    @discardableResult
    public func setStage(application id: Int64, to stage: ApplicationStage) async -> Bool {
        guard let api, let app = await attempt({ try await api.setStage(application: id, to: stage) }) else { return false }
        record(app)
        await refreshPosting(app.postingID, api)
        if overview != nil { await refreshOverview(api) }
        return true
    }

    /// Scores postings again (empty: every verified or scored one). What to tell the candidate
    /// ("Re-scoring 1 posting", "Already being scored"); nil when the daemon refused.
    @discardableResult
    public func rescore(_ ids: [Int64] = []) async -> String? {
        guard let api, let enqueued = await attempt({ try await api.scorePostings(ids, refresh: false) }) else { return nil }
        return Score.rescored(enqueued.count, all: ids.isEmpty)
    }

    // MARK: The Overview

    private func refreshOverview(_ api: DaemonAPI) async {
        let window = overviewWindow
        guard let report = try? await api.overview(window), window == overviewWindow else { return }
        overview = report
    }

    /// Loads the Overview for its window (`window` picks another first). A slow answer for a
    /// window no longer picked is dropped.
    public func openOverview(window: OverviewWindow? = nil) async {
        if let window { overviewWindow = window }
        let asked = overviewWindow
        guard let api, let report = await attempt({ try await api.overview(asked) }), asked == overviewWindow else { return }
        overview = report
    }

    // MARK: Search

    /// Fresh counts for the Search and Agent runs screens (postings move on between events).
    public func openSearch() async {
        guard let api else { return }
        await refreshSearch(api)
    }

    public func setStrategy(_ id: Int64, paused: Bool) async {
        guard let api, await attempt({ try await api.setStrategy(id, paused: paused) }) != nil else { return }
        await refreshSearch(api)
    }

    /// Runs a strategy now; returns the run, or nil when one was already waiting or running.
    @discardableResult
    public func runStrategy(_ id: Int64) async -> Int64? {
        guard let api, let run = await attempt({ try await api.runStrategy(id) }) else { return nil }
        await refreshSearch(api)
        return run
    }

    /// Switches a source (by key) or a whole kind on or off.
    public func setSource(_ target: String, enabled: Bool) async {
        guard let api, await attempt({ try await api.setSource(target, enabled: enabled) }) != nil else { return }
        await refreshSearch(api)
    }

    /// Starts the search planner: new strategies (agent-generated) and boards for the watch list.
    /// Returns the plan, or nil when one was already going.
    @discardableResult
    public func planSearch() async -> Int64? {
        guard let api else { return nil }
        let plan = await attempt({ try await api.planSearch() })
        await refreshSearch(api)
        return plan ?? nil
    }

    /// The planner is waiting or running.
    public var planning: Bool { search.plans.first?.status == "queued" }

    /// Loads a source for its detail pane, with its recipe's listings (kept current from then on).
    public func openSource(_ key: String) async {
        guard let api, let source = await attempt({ try await api.searchSource(key) }) else { return }
        sourceDetails[key] = source
    }

    /// Asks for a new listing recipe for a career page.
    public func rebuildRecipe(_ key: String) async {
        guard let api, await attempt({ try await api.rebuildRecipe(key) }) != nil else { return }
        await refreshSearch(api)
    }

    /// Loads a run's events for its detail pane (and keeps them current from then on).
    public func openRun(_ id: Int64) async {
        guard let api, let events = await attempt({ try await api.runEvents(id) }) else { return }
        runEvents[id] = events
    }

    public var strategyRows: [SearchRow] { SearchText.strategyRows(search) }

    public func strategy(_ id: Int64) -> SearchStrategy? { search.strategies.first { $0.id == id } }

    public func source(_ key: String) -> SearchSource? { search.sources.first { $0.key == key } }

    public func runs(of strategy: Int64) -> [SearchRun] { searchRuns.filter { $0.strategyID == strategy } }

    // MARK: Companies

    private func refreshCompanies(_ api: DaemonAPI) async {
        if let list = try? await api.listCompanies() { companies = list }
    }

    private func refreshCompany(_ id: Int64, _ api: DaemonAPI) async {
        if let c = try? await api.company(.id(id)) { companyDetails[id] = c }
    }

    public func openCompany(_ id: Int64) async {
        guard let api, let found = await attempt({ try await api.company(.id(id)) }), let c = found else { return }
        companyDetails[id] = c
    }

    /// Company research: for a posting's company (from its detail) or a company (Companies).
    /// Returns the company, or nil when the call failed.
    @discardableResult
    public func researchCompany(_ target: CompanyTarget, refresh: Bool = false) async -> Company? {
        guard let api, let res = await attempt({ try await api.researchCompany(target, refresh: refresh) }) else { return nil }
        companyDetails[res.company.id] = res.company
        await refreshCompanies(api)
        if case let .posting(id) = target { await refreshPosting(id, api) }
        return res.company
    }

    public func companyListing(_ id: Int64) -> Company? { companies.first { $0.id == id } }

    // MARK: The mailbox

    private func refreshMail(_ api: DaemonAPI) async {
        applyMailbox(try? await api.mailboxSetup())
        if let queue = try? await api.mailQueue() { mailQueue = queue }
    }

    private func applyMailbox(_ setup: MailboxSetup?) {
        mailbox = setup?.hasMailbox == true ? setup?.mailbox : nil
        mailboxSecretStored = setup?.googleClientSecretStored ?? false
        googleClientId = setup?.hasGoogleClientID == true ? setup?.googleClientID ?? "" : ""
        if mailbox?.status != "connecting" {
            googleConsentURL = nil
            consentWatch?.cancel()
            consentWatch = nil
        }
    }

    /// Gmail: stores the client (the secret goes to the daemon's Secrets and is never read back),
    /// opens Google's consent in the browser, and follows the mailbox until the browser comes
    /// back (a mail event, or asking every `consentPollInterval`). False when it couldn't start.
    @discardableResult
    public func connectGmail(_ form: GmailForm) async -> Bool {
        guard let api, form.problem(secretStored: mailboxSecretStored) == nil else { return false }
        let id = form.clientId.trimmingCharacters(in: .whitespacesAndNewlines)
        let secret = form.clientSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let started = await attempt({ try await api.connectGmail(clientId: id, clientSecret: secret.isEmpty ? nil : secret) }),
              let url = URL(string: started.authURL)
        else { return false }
        mailbox = started.mailbox
        mailboxSecretStored = true
        googleClientId = id
        googleConsentURL = url
        onOpenURL?(url)
        watchConsent(api)
        return true
    }

    /// Until the consent lands or fails (the daemon's listener gives up after 10 minutes).
    private func watchConsent(_ api: DaemonAPI) {
        consentWatch?.cancel()
        let interval = consentPollInterval
        consentWatch = Task { [weak self] in
            let deadline = ContinuousClock.now + .seconds(11 * 60)
            while !Task.isCancelled, ContinuousClock.now < deadline {
                try? await Task.sleep(for: interval)
                guard let self, !Task.isCancelled else { return }
                let setup = try? await api.mailboxSetup()
                if Task.isCancelled { return }
                if let setup {
                    let settled = setup.mailbox.status != "connecting"
                    self.applyMailbox(setup)
                    if settled {
                        await self.refreshSetup()
                        return
                    }
                }
            }
        }
    }

    /// Opens the consent again (the candidate closed the browser tab).
    public func reopenGoogleConsent() {
        if let url = googleConsentURL { onOpenURL?(url) }
    }

    /// IMAP + SMTP: the daemon checks the login with a first sync, then keeps the password.
    @discardableResult
    public func connectImap(_ form: ImapForm) async -> Bool {
        guard let api, let settings = form.settings else { return false }
        let address = form.address.trimmingCharacters(in: .whitespaces).lowercased()
        guard let box = await attempt({ try await api.connectImap(address: address, settings: settings) }) else {
            return false
        }
        mailbox = box
        await refreshMail(api)
        await refreshSetup()
        return true
    }

    /// Forgets the mailbox (and its tokens or password); the Google client secret stays.
    public func disconnectMailbox() async {
        guard let api, await attempt({ try await api.disconnectMailbox() }) != nil else { return }
        googleConsentURL = nil
        consentWatch?.cancel()
        consentWatch = nil
        await refreshMail(api)
        await refreshSetup()
    }

    /// Fresh mailbox state and queue (the Which application? screen opens with this).
    public func openMail() async {
        guard let api else { return }
        await refreshMail(api)
    }

    /// "Which application is this?": an application, or none (`application` nil). `label` is
    /// what the email is, when the classifier couldn't tell.
    public func assignEmail(_ id: Int64, application: Int64?, label: String? = nil) async {
        guard let api, await attempt({ try await api.assignEmail(id, application: application, label: label) }) != nil else {
            return
        }
        mailQueue.removeAll { $0.id == id }
        await refreshMail(api)
        if let application { await refreshApplication(application, api) }
    }

    /// Reads the mailbox now; false when a sync was already going (or there's no mailbox).
    @discardableResult
    public func syncMailbox() async -> Bool {
        guard let api, let queued = await attempt({ try await api.syncMailbox() }) else { return false }
        await refreshMail(api)
        return queued
    }

    // MARK: Settings: LinkedIn/Xing and the captcha solver

    private func refreshPlatforms(_ api: DaemonAPI) async {
        if let list = try? await api.listPlatforms() { platforms = list }
    }

    /// Fresh platform state (Settings opens with this).
    public func openSettings() async {
        guard let api else { return }
        await refreshPlatforms(api)
        await refreshMail(api)
        if let t = try? await api.telegram() { telegram = t }
    }

    public func platform(_ key: String) -> Platform? { platforms?.platforms.first { $0.platform == key } }

    public func setPlatformCaps(_ key: String, searches: Int32?, applications: Int32?) async {
        guard let api, await attempt({ try await api.setPlatformCaps(key, searches: searches, applications: applications) }) != nil else {
            return
        }
        await refreshPlatforms(api)
    }

    public func resumePlatform(_ key: String) async {
        guard let api, await attempt({ try await api.resumePlatform(key) }) != nil else { return }
        await refreshPlatforms(api)
    }

    /// Opens the sign-in window; the URL it opened, nil when it couldn't (the reason is shown).
    @discardableResult
    public func signIn(_ target: String, force: Bool = false) async -> String? {
        guard let api, let url = await attempt({ try await api.signIn(target, force: force) }) else { return nil }
        await refreshPlatforms(api)
        return url
    }

    /// Stores the CapMonster key through the secrets path; the value is never read back.
    public func setCaptchaKey(_ key: String) async {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let api, !trimmed.isEmpty, await attempt({ try await api.setSecret(PlatformText.captchaSecret, value: trimmed) }) != nil else {
            return
        }
        await refreshPlatforms(api)
        await refreshSetup()
    }

    /// Opens a site's sign-in window, keeping its login in Secrets first when one is given (the
    /// CLI's `--save-login`). The URL it opened; nil when refused (the reason is shown).
    @discardableResult
    public func signIn(site input: String, username: String, password: String) async -> String? {
        guard let target = SiteLogin.target(input) else {
            lastError = "Give a site's address (https://…), or linkedin or xing."
            return nil
        }
        let user = username.trimmingCharacters(in: .whitespacesAndNewlines)
        if let api, !user.isEmpty {
            guard !password.isEmpty else {
                lastError = "Give the password too, or leave the username empty to only sign in."
                return nil
            }
            let value = SiteLogin.secretValue(username: user, password: password)
            guard await attempt({ try await api.setSecret(SiteLogin.secretName(target), value: value) }) != nil else { return nil }
            await refreshSecrets(api)
        }
        return await signIn(target)
    }

    // MARK: Settings: model roles

    public func openModels() async {
        guard let api, let list = await attempt({ try await api.listRoles() }) else { return }
        roles = list
    }

    /// Routes a role; false when the daemon refused (the reason is shown).
    @discardableResult
    public func setRole(_ role: String, route: String) async -> Bool {
        guard let api, await attempt({ try await api.setRole(role, route: route) }) != nil else { return false }
        await openModels()
        return true
    }

    /// Puts one role (nil: all) back on its default.
    public func resetRoles(_ role: String? = nil) async {
        guard let api, await attempt({ try await api.resetRoles(role) }) != nil else { return }
        await openModels()
    }

    /// The opt-in: replies are classified by a cloud model instead of the on-device one.
    public func setCloudEmail(_ on: Bool) async {
        if on { await setRole(RolesText.emailRole, route: RolesText.cloudEmailRoute) } else { await resetRoles(RolesText.emailRole) }
    }

    // MARK: Settings: stored keys

    private func refreshSecrets(_ api: DaemonAPI) async {
        if let names = try? await api.listSecrets() { secretNames = names.sorted() }
    }

    public func openSecrets() async {
        guard let api else { return }
        await refreshSecrets(api)
    }

    /// Deletes a stored secret by name (Settings asks first).
    public func deleteSecret(_ name: String) async {
        guard let api, await attempt({ try await api.deleteSecret(name) }) != nil else { return }
        await refreshSecrets(api)
        await refreshPlatforms(api)
        await refreshMail(api)
    }

    // MARK: Settings and Search: Telegram

    /// One sign-in step; the account's state after it (the reason is shown when it fails).
    public func connectTelegram(_ step: Applyant_V1_ConnectTelegramRequest.OneOf_Step) async {
        guard let api else { return }
        if let t = await attempt({ try await api.connectTelegram(step) }) {
            telegram = t
        } else if let t = try? await api.telegram() {
            telegram = t
        }
        await refreshSetup()
    }

    public func disconnectTelegram() async {
        guard let api, let t = await attempt({ try await api.disconnectTelegram() }) else { return }
        telegram = t
        await refreshSetup()
    }

    /// Follows a Telegram channel (`@name`, `t.me/name`, `https://t.me/s/name`).
    @discardableResult
    public func followChannel(_ input: String) async -> Bool {
        guard let api, let locator = TelegramText.channelLocator(input),
              await attempt({ try await api.addSearchSource(kind: "telegram", locator: locator) }) != nil
        else { return false }
        await refreshSearch(api)
        return true
    }

    // MARK: The interview

    /// Loads a thread for its chat view (and keeps it current from then on).
    public func openInterview(_ target: InterviewTarget) async {
        guard let api, let thread = await attempt({ try await api.interview(target) }) else { return }
        interviewThreads[target] = thread
    }

    /// "Ask me about this project": its open question, or the interviewer writes one.
    public func startInterview(project id: Int64) async {
        guard let api, await attempt({ try await api.startInterview(project: id) }) != nil else { return }
        await refreshInterview(api)
        await refreshThread(.project(id), api)
    }

    public func answerInterview(_ target: InterviewTarget, question id: Int64, text: String) async {
        guard let api, await attempt({ try await api.answerInterview(question: id, text: text) }) != nil else { return }
        await refreshInterview(api)
        await refreshThread(target, api)
    }

    public func dismissInterview(_ target: InterviewTarget, question id: Int64) async {
        guard let api, await attempt({ try await api.dismissInterview(question: id) }) != nil else { return }
        await refreshInterview(api)
        await refreshThread(target, api)
    }

    /// Questions waiting for the candidate's answer (the sidebar badge).
    public var openInterviewCount: Int {
        interviewQuestions.filter { $0.status == "open" }.count
    }

    public var interviewRows: (waiting: [InterviewRow], projects: [InterviewRow]) {
        InterviewText.rows(questions: interviewQuestions, projects: projectInterviews)
    }

    // MARK: The first-launch setup

    /// Takes the daemon's setup state; the first time it says setup isn't done, the window opens.
    private func applySetup(_ status: OnboardingStatus) {
        setup = status
        onboarding.merge(status)
        if !status.setupDone && !onboardingOffered {
            onboardingOffered = true
            showOnboarding = true
        }
    }

    /// Opens the setup (the menu, Settings); it's reachable after setup is done too.
    public func openOnboarding() async {
        showOnboarding = true
        await refreshSetup()
    }

    public func refreshSetup(refresh: Bool = false) async {
        guard let api, let status = try? await api.setupStatus(refresh: refresh) else { return }
        setup = status
        onboarding.merge(status)
    }

    /// A step done, skipped or left for later. Settling the Interview (the last step) closes the
    /// window; finishing Preferences starts search, so Search reloads.
    @discardableResult
    public func settleStep(_ step: OnboardingStep, as state: String = "done") async -> Bool {
        var next = onboarding
        guard let api, next.settle(step, as: state),
              let status = await attempt({ try await api.setSetupStep(step.rawValue, state: state) })
        else { return false }
        onboarding = next
        setup = status
        onboarding.merge(status)
        if step == .preferences, let list = try? await api.listSearch() { search = list }
        if step == .interview { showOnboarding = false }
        return true
    }

    public func loadPreferencesDraft() async {
        guard let api else { return }
        preferencesDraft = (try? await api.preferencesDraft()) ?? []
    }

    /// The candidate's preferences (key → SetPreference value; empty values are left alone),
    /// then Preferences done: search starts.
    @discardableResult
    public func confirmPreferences(_ values: [(key: String, value: String)]) async -> Bool {
        guard let api else { return false }
        for (key, value) in values {
            let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if v.isEmpty { continue }
            guard await attempt({ try await api.setPreference(key, value: v) }) != nil else { return false }
        }
        return await settleStep(.preferences)
    }

    /// Import: a CV or LinkedIn PDF (a path on this Mac) or a link (a page, a Google Doc).
    @discardableResult
    public func importSource(_ input: String) async -> Bool {
        let s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let api, !s.isEmpty else { return false }
        let kind: Applyant_V1_SourceKind = s.hasPrefix("/") ? .file : OnboardingText.sourceKind(for: s)
        guard await attempt({ try await api.addKnowledgeSource(project: nil, kind: kind, locator: s) }) != nil else {
            return false
        }
        // The step lists what was imported (the profile's sources) with each one's reading.
        await refreshKnowledge(api)
        await refreshSetup()
        return true
    }

    /// The Import step's list: the profile's sources (what the step imports), each with where its
    /// reading stands, newest first.
    public var importRows: [ImportRow] {
        OnboardingText.importRows(candidateProfile?.profileSources ?? [], sync: sourceSync)
    }

    /// Connections: the GitHub login(s) whose commits are the candidate's own work.
    /// False when refused (the reason is shown).
    @discardableResult
    public func setGithubLogin(_ login: String) async -> Bool {
        let s = login.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let api, !s.isEmpty, await attempt({ try await api.setProfileValue("github_logins", value: s) }) != nil else {
            return false
        }
        await refreshSetup()
        if candidateProfile != nil { await refreshKnowledge(api) }
        return true
    }

    /// Connections: the Jev key (write-only, like the captcha key).
    @discardableResult
    public func setJevKey(_ key: String) async -> Bool {
        let s = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let api, !s.isEmpty, await attempt({ try await api.setSecret("jev", value: s) }) != nil else { return false }
        await refreshSetup()
        return true
    }

    // MARK: The profile and projects (app parity with the CLI for setup)

    private func refreshKnowledge(_ api: DaemonAPI) async {
        if let c = try? await api.candidate() { candidateProfile = c }
        for id in projectSources.keys {
            if let p = try? await api.project(String(id)) { projectSources[id] = p.sources }
        }
    }

    /// Loads the profile, the projects and the profile's sources (Profile and Projects open with it).
    public func openProfile() async {
        guard let api, let c = await attempt({ try await api.candidate() }) else { return }
        candidateProfile = c
    }

    public var knowledgeProjects: [KnowledgeProject] { candidateProfile?.projects ?? [] }

    public func knowledgeProject(_ id: Int64) -> KnowledgeProject? { knowledgeProjects.first { $0.id == id } }

    /// Saves what changed in the profile form, one value at a time (the first refusal stops it
    /// and is shown). True when everything was saved.
    @discardableResult
    public func saveProfile(_ form: ProfileForm) async -> Bool {
        guard let api else { return false }
        for (key, value) in form.changes {
            guard await attempt({ try await api.setProfileValue(key, value: value) }) != nil else {
                await refreshKnowledge(api)
                return false
            }
        }
        await refreshKnowledge(api)
        await refreshSetup()
        return true
    }

    /// The base CV the tailored ones start from (a file on this Mac; empty clears it).
    @discardableResult
    public func setBaseCv(_ path: String) async -> Bool {
        guard let api, await attempt({ try await api.setProfileValue(ProfileForm.baseCvKey, value: path) }) != nil else {
            return false
        }
        await refreshKnowledge(api)
        return true
    }

    /// A new project; its id (and it's opened in Projects), nil when refused.
    @discardableResult
    public func createProject(_ name: String) async -> Int64? {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let api, !n.isEmpty, let p = await attempt({ try await api.createProject(name: n) }) else { return nil }
        await refreshKnowledge(api)
        projectSources[p.id] = []
        navigation.project = p.id
        return p.id
    }

    @discardableResult
    public func renameProject(_ id: Int64, to name: String) async -> Bool {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let api, !n.isEmpty, await attempt({ try await api.renameProject(String(id), name: n) }) != nil else {
            return false
        }
        await refreshKnowledge(api)
        return true
    }

    /// Removes a project with its sources and facts.
    public func deleteProject(_ id: Int64) async {
        guard let api, await attempt({ try await api.deleteProject(String(id)) }) != nil else { return }
        projectSources[id] = nil
        if navigation.project == id { navigation.project = nil }
        await refreshKnowledge(api)
        await refreshInterview(api)
        await refreshSetup()
    }

    /// Loads a project's sources for its detail (kept current from then on).
    public func openProject(_ id: Int64) async {
        guard let api, let p = await attempt({ try await api.project(String(id)) }) else { return }
        projectSources[id] = p.sources
    }

    /// Adds a GitHub repo, a file (a path on this Mac) or a link to a project (nil: the profile);
    /// its first sync starts in the daemon.
    @discardableResult
    public func addKnowledgeSource(to project: Int64?, _ input: String) async -> Bool {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let api, !s.isEmpty else { return false }
        if s.hasPrefix("~") { s = (s as NSString).expandingTildeInPath }
        let kind = KnowledgeText.sourceKind(for: s)
        guard await attempt({ try await api.addKnowledgeSource(project: project.map { String($0) }, kind: kind, locator: s) }) != nil else {
            return false
        }
        if let project, projectSources[project] == nil { projectSources[project] = [] }
        await refreshKnowledge(api)
        await refreshSetup()
        return true
    }

    /// Removes one source with what was read from it; the facts only it supported go too (facts
    /// in the candidate's own words stay). The number of facts removed, nil when refused.
    @discardableResult
    public func deleteSource(_ id: Int64) async -> Int? {
        guard let api, let n = await attempt({ try await api.deleteSource(id) }) else { return nil }
        await refreshKnowledge(api)
        for ref in facts.keys {
            if let list = try? await api.listFacts(project: ref, status: nil) { facts[ref] = list }
        }
        await refreshInterview(api)
        await refreshSetup()
        // A review open on screen may have relied on its facts.
        for id in applicationDetails.keys { await refreshApplication(id, api) }
        return n
    }

    /// Reads a project's sources again (nil: the profile's), or one source.
    @discardableResult
    public func syncKnowledge(project: Int64? = nil, source: Int64? = nil) async -> Int? {
        let target = source.map { "source:\($0)" } ?? project.map { String($0) } ?? "profile"
        guard let api, let n = await attempt({ try await api.syncSources(target, force: false) }) else { return nil }
        await refreshKnowledge(api)
        return n
    }

    // MARK: The facts browser

    /// Loads a project's facts (nil: the profile's) for the browser.
    public func openFacts(project: Int64?) async {
        guard let api else { return }
        let ref = FactsText.ref(project)
        guard let list = await attempt({ try await api.listFacts(project: ref, status: nil) }) else { return }
        facts[ref] = list
    }

    private func afterFactChange(_ project: Int64?, _ api: DaemonAPI) async {
        if let list = try? await api.listFacts(project: FactsText.ref(project), status: nil) { facts[FactsText.ref(project)] = list }
        await refreshKnowledge(api)
        // A review open on screen may rely on the fact.
        for id in applicationDetails.keys { await refreshApplication(id, api) }
    }

    public func confirmFacts(_ ids: [Int64], project: Int64?) async {
        guard let api, !ids.isEmpty, await attempt({ try await api.confirmFacts(ids) }) != nil else { return }
        await afterFactChange(project, api)
    }

    /// The candidate's words for a fact (saved confirmed); false when refused.
    @discardableResult
    public func editFact(_ id: Int64, text: String, project: Int64?) async -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let api, !t.isEmpty, await attempt({ try await api.editFact(id, text: t) }) != nil else { return false }
        await afterFactChange(project, api)
        return true
    }

    public func rejectFacts(_ ids: [Int64], project: Int64?) async {
        guard let api, !ids.isEmpty, await attempt({ try await api.rejectFacts(ids) }) != nil else { return }
        await afterFactChange(project, api)
    }

    // MARK: Review: the tailored CV's lines

    /// A CV line in the candidate's words (nil removes it); the CV is rendered again, and the
    /// preview follows once it's ready. False when refused.
    @discardableResult
    public func editCv(application id: Int64, line: String, text: String?) async -> Bool {
        guard let api, let app = await attempt({ try await api.editCv(application: id, line: line, text: text) }) else { return false }
        record(app)
        return true
    }

    // MARK: Preferences after setup

    public func openPreferences() async {
        guard let api, let p = await attempt({ try await api.getPreferences() }) else { return }
        searchPreferences = p
    }

    /// Saves what changed, one key at a time (the first refusal stops it and is shown).
    @discardableResult
    public func savePreferences(_ form: PreferencesForm) async -> Bool {
        guard let api else { return false }
        var ok = true
        for (key, value) in form.changes {
            guard await attempt({ try await api.setPreference(key, value: value) }) != nil else {
                ok = false
                break
            }
        }
        if let p = try? await api.getPreferences() { searchPreferences = p }
        return ok
    }

    // MARK: Search: strategies and sources

    /// A new strategy (id nil) or the whole strategy replaced; its id, opened in Search.
    @discardableResult
    public func saveStrategy(_ form: StrategyForm, id: Int64? = nil) async -> Int64? {
        if let problem = form.problem {
            lastError = problem
            return nil
        }
        guard let api else { return nil }
        let saved: SearchStrategy?
        if let id {
            saved = await attempt({ try await api.updateStrategy(form.updateRequest(id)) })
        } else {
            saved = await attempt({ try await api.addStrategy(form.addRequest) })
        }
        guard let saved else { return nil }
        await refreshSearch(api)
        navigation.search = .strategy(saved.id)
        return saved.id
    }

    public func deleteStrategy(_ id: Int64) async {
        guard let api, await attempt({ try await api.deleteStrategy(id) }) != nil else { return }
        if navigation.search == .strategy(id) { navigation.search = nil }
        await refreshSearch(api)
    }

    /// A job board or a career page by URL: the daemon finds its feed or ATS board, or builds a
    /// listing recipe. The source, opened in Search; nil when refused.
    @discardableResult
    public func addBoardOrPage(_ input: String) async -> SearchSource? {
        guard let url = SourceInput.url(input) else {
            lastError = "That isn't a web address."
            return nil
        }
        guard let api, let source = await attempt({ try await api.addSearchSource(kind: "", locator: url) }) else { return nil }
        await refreshSearch(api)
        navigation.search = .source(source.key)
        return source
    }

    private func attempt<T>(_ call: () async throws -> T) async -> T? {
        do {
            return try await call()
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    // MARK: Lists

    public func items(_ section: Section) -> [ListItem] {
        switch section {
        case .inbox:
            return postings.values
                .filter { $0.stage == .scored && $0.decision != "skipped" }
                .sorted(by: byScore)
                .map { item($0) }
        case .interested:
            return postings.values.filter { $0.decision == "interested" }.sorted(by: byScore).map { item($0) }
        case .skipped:
            return postings.values
                .filter { $0.stage == .skipped || $0.decision == "skipped" }
                .sorted { $0.firstSeenAt.date > $1.firstSeenAt.date }
                .map { item($0) }
        case .readyToReview:
            return applicationItems { $0.stage == .readyForReview || $0.stage == .needsCandidate }
        case .preparing:
            return applicationItems { $0.stage == .preparing }
        case .applied:
            // Sent, and where the mail (or the candidate) left them: rejections and withdrawals
            // stay here, marked.
            return applicationItems { [.approved, .applied, .rejected, .withdrawn].contains($0.stage) }
        case .interviews:
            return applicationItems { $0.stage == .interview }
        case .offers:
            return applicationItems { $0.stage == .offer }
        default:
            return []
        }
    }

    public func count(_ section: Section) -> Int {
        if section == .interview { return openInterviewCount }
        // A badge on Search only while a run is going.
        if section == .search { return search.strategies.filter(\.running).count + (planning ? 1 : 0) }
        if section == .agentRuns { return 0 }
        // A badge on Companies only while research is going.
        if section == .companies { return companies.filter(\.researching).count }
        if section == .whichApplication { return mailQueue.count }
        return section.isBuilt ? items(section).count : 0
    }

    /// Applications waiting on the candidate: missing values, or a delivery to finish by hand.
    public var needsYou: [Application] {
        applications.values
            .filter { $0.stage == .needsCandidate || ($0.stage == .approved && $0.hasHandOff) }
            .sorted { $0.id < $1.id }
    }

    private func applicationItems(_ include: (Application) -> Bool) -> [ListItem] {
        applications.values.filter(include)
            .sorted { ($0.hasScore ? $0.score : -1, $0.id) > ($1.hasScore ? $1.score : -1, $1.id) }
            .map { app in
                if let posting = postings[app.postingID] { return item(posting, application: app) }
                return ListItem(application: app, delivery: deliveries[app.id])
            }
    }

    private func item(_ posting: Posting, application: Application? = nil) -> ListItem {
        let app = application ?? (posting.hasApplicationID ? applications[posting.applicationID] : nil)
        return ListItem(posting: posting, application: app, delivery: app.flatMap { deliveries[$0.id] })
    }

    private func byScore(_ a: Posting, _ b: Posting) -> Bool {
        let sa = a.hasScore ? a.score : -1
        let sb = b.hasScore ? b.score : -1
        return sa != sb ? sa > sb : a.id > b.id
    }
}

func headline(_ app: Application) -> String {
    let title = app.hasTitle ? app.title : "Application \(app.id)"
    return app.hasCompany ? "\(app.company) · \(title)" : title
}

/// "waiting for claude limit, resumes at 2026-09-28T15:45:00.000Z" → "Waiting for claude limit · resumes 15:45".
func pauseText(_ message: String) -> String {
    guard let range = message.range(of: "resumes at ") else { return message }
    let iso = String(message[range.upperBound...])
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let head = message[..<range.lowerBound].trimmingCharacters(in: CharacterSet(charactersIn: ", "))
    guard let date = formatter.date(from: iso) else { return message }
    let time = date.formatted(date: .omitted, time: .shortened)
    return head.prefix(1).uppercased() + head.dropFirst() + " · resumes \(time)"
}
