// The app's one store. It holds no business state of its own: lists come from the daemon, and
// the event stream keeps them current. On every (re)connect the lists are reloaded before the
// stream resumes, so nothing is missed while the daemon was away. Actions are RPCs.
import ApplyantAPI
import Foundation
import Observation

/// Something worth a notification (only from live events, never from a reload).
public struct StoreNotification: Equatable, Sendable {
    public enum Kind: String, Sendable { case readyForReview, needsYou, handOff }
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
        async let box = api.mailbox()
        async let queue = api.mailQueue()
        let (p, a, i, s, r, c) = try await (postingList, applicationList, interviewList, searchList, runList, companyList)
        // An older daemon without the mailbox RPCs still loads everything else.
        mailbox = (try? await box) ?? nil
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
        reloads += 1
        // What's open on screen may have changed while we were away.
        for id in postingDetails.keys { await refreshPosting(id, api) }
        for id in applicationDetails.keys { await refreshApplication(id, api) }
        for target in interviewThreads.keys { await refreshThread(target, api) }
        for run in runEvents.keys { await refreshRunEvents(run, api) }
        for id in companyDetails.keys { await refreshCompany(id, api) }
    }

    // MARK: Events

    public func apply(_ event: DaemonEvent, live: Bool) async {
        guard let api else { return }
        eventsApplied += 1
        switch event.payload {
        case let .task(task)?:
            applyTask(task, message: event.message)
        case let .posting(p)?:
            await refreshPosting(p.postingID, api)
        case let .application(a)?:
            let before = applications[a.applicationID]?.stage
            await refreshApplication(a.applicationID, api)
            await refreshPosting(a.postingID, api)
            if live, before != a.stage, let app = applications[a.applicationID] {
                notifyStage(app)
            }
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
        if let box = try? await api.mailbox() { mailbox = box } else { mailbox = nil }
        if let queue = try? await api.mailQueue() { mailQueue = queue }
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
    }

    public func disconnectTelegram() async {
        guard let api, let t = await attempt({ try await api.disconnectTelegram() }) else { return }
        telegram = t
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
        await refreshSetup()
        return true
    }

    /// Connections: the GitHub login(s) whose commits are the candidate's own work.
    public func setGithubLogin(_ login: String) async {
        let s = login.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let api, !s.isEmpty, await attempt({ try await api.setProfileValue("github_logins", value: s) }) != nil else {
            return
        }
        await refreshSetup()
    }

    /// Connections: the Jev key (write-only, like the captcha key).
    public func setJevKey(_ key: String) async {
        let s = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let api, !s.isEmpty, await attempt({ try await api.setSecret("jev", value: s) }) != nil else { return }
        await refreshSetup()
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
            // Sent, and where the mail left them: rejections stay here, marked.
            return applicationItems { $0.stage == .approved || $0.stage == .applied || $0.stage == .rejected }
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
                return ListItem(application: app)
            }
    }

    private func item(_ posting: Posting, application: Application? = nil) -> ListItem {
        let app = application ?? (posting.hasApplicationID ? applications[posting.applicationID] : nil)
        return ListItem(posting: posting, application: app)
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
