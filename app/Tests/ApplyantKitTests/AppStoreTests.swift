import ApplyantAPI
import Foundation
import Testing
@testable import ApplyantKit

/// A daemon in memory. Each connect gets one of these; its event stream is driven by the test.
final class FakeDaemon: DaemonAPI, @unchecked Sendable {
    private let lock = NSLock()
    var postings: [Int64: Posting]
    var applications: [Int64: Application]
    var lastId: Int64
    var calls: [String] = []
    var watchedAfter: [Int64] = []
    /// What confirmFacts does to the application (the daemon clears its blockers).
    var onConfirm: ((inout Application) -> Void)?
    let events: AsyncThrowingStream<DaemonEvent, Error>
    let feed: AsyncThrowingStream<DaemonEvent, Error>.Continuation

    init(postings: [Posting] = [], applications: [Application] = [], lastId: Int64 = 0) {
        self.postings = Dictionary(uniqueKeysWithValues: postings.map { ($0.id, $0) })
        self.applications = Dictionary(uniqueKeysWithValues: applications.map { ($0.id, $0) })
        self.lastId = lastId
        (events, feed) = AsyncThrowingStream.makeStream()
    }

    private func log(_ call: String) { lock.withLock { calls.append(call) } }

    func listPostings() async throws -> [Posting] { log("listPostings"); return Array(postings.values) }
    func getPosting(_ id: Int64) async throws -> Posting {
        log("getPosting \(id)")
        guard let p = postings[id] else { throw APIError("no posting \(id)") }
        return p
    }
    func listApplications() async throws -> [Application] {
        log("listApplications")
        return applications.values.map { var a = $0; a.fields = []; a.answers = []; return a }
    }
    func getApplication(_ id: Int64) async throws -> Application {
        log("getApplication \(id)")
        guard let a = applications[id] else { throw APIError("no application \(id)") }
        return a
    }
    func lastEventId() async throws -> Int64 { lastId }
    func events(after afterEventId: Int64) -> AsyncThrowingStream<DaemonEvent, Error> {
        lock.withLock { watchedAfter.append(afterEventId) }
        return events
    }
    func skip(posting id: Int64, reason: String) async throws -> Posting {
        log("skip \(id) \(reason)")
        postings[id]?.stage = .skipped
        postings[id]?.decision = "skipped"
        return postings[id]!
    }
    func markInterested(posting id: Int64) async throws -> Posting {
        log("interested \(id)")
        postings[id]?.decision = "interested"
        return postings[id]!
    }
    func prepare(posting id: Int64) async throws -> Application { throw APIError("unused") }
    func prepare(application id: Int64, rewrite: Bool) async throws -> Application { throw APIError("unused") }
    func confirmFacts(application id: Int64, factIds: [Int64]) async throws {
        log("confirm \(id) \(factIds)")
        if var app = applications[id] {
            onConfirm?(&app)
            applications[id] = app
        }
    }
    func editAnswer(application id: Int64, answer: Int32, sentence: Int32?, text: String?) async throws -> Application {
        throw APIError("unused")
    }
    func setField(application id: Int64, field: String, value: String?) async throws -> Application { throw APIError("unused") }
    func setCvMode(application id: Int64, mode: String) async throws -> Application { throw APIError("unused") }
    func approve(application id: Int64) async throws -> Application {
        log("approve \(id)")
        applications[id]?.stage = .approved
        return applications[id]!
    }
    func submit(application id: Int64) async throws -> Application { throw APIError("unused") }
    func setApplyForm(application id: Int64, form: Applyant_V1_ApplyForm) async throws -> Application {
        log("setApplyForm \(id) \(form)")
        applications[id]?.applyForm = form
        applications[id]?.stage = .preparing
        return applications[id]!
    }
    func markSubmitted(application id: Int64) async throws -> Application {
        log("markSubmitted \(id)")
        applications[id]?.stage = .applied
        applications[id]?.clearHandOff()
        return applications[id]!
    }

    // The interview: questions by id, projects, and threads the test sets up.
    var questions: [InterviewQuestion] = []
    var projectInterviews: [ProjectInterview] = []
    var threads: [InterviewTarget: InterviewThread] = [:]

    func listInterview() async throws -> InterviewList {
        log("listInterview")
        return .with {
            $0.questions = questions.filter { $0.status == "open" || $0.status == "processing" }
            $0.projects = projectInterviews
        }
    }
    func interview(_ target: InterviewTarget) async throws -> InterviewThread {
        log("interview \(target)")
        guard let thread = threads[target] else { throw APIError("no thread") }
        return thread
    }
    func startInterview(project id: Int64) async throws -> InterviewStart {
        log("startInterview \(id)")
        threads[.project(id)]?.pending = true
        return .with { $0.pending = true }
    }
    func answerInterview(question id: Int64, text: String) async throws -> InterviewQuestion {
        log("answerInterview \(id) \(text)")
        return try setQuestion(id) {
            $0.status = "processing"
            $0.answer = text
        }
    }
    func dismissInterview(question id: Int64) async throws -> InterviewQuestion {
        log("dismissInterview \(id)")
        return try setQuestion(id) { $0.status = "dismissed" }
    }

    // Search: what ListSearch returns, the runs, and each run's events.
    var searchList = SearchList()
    var searchRuns: [SearchRun] = []
    var eventsByRun: [Int64: [DaemonEvent]] = [:]
    var nextRun: Int64 = 100

    func listSearch() async throws -> SearchList { log("listSearch"); return searchList }
    func listSearchRuns(limit: Int32) async throws -> [SearchRun] { log("listSearchRuns"); return searchRuns }
    func setStrategy(_ id: Int64, paused: Bool) async throws -> SearchStrategy {
        log("setStrategy \(id) \(paused ? "paused" : "active")")
        guard let i = searchList.strategies.firstIndex(where: { $0.id == id }) else { throw APIError("no strategy \(id)") }
        searchList.strategies[i].state = paused ? "paused" : "active"
        return searchList.strategies[i]
    }
    func runStrategy(_ id: Int64) async throws -> Int64? {
        log("runStrategy \(id)")
        guard let i = searchList.strategies.firstIndex(where: { $0.id == id }) else { throw APIError("no strategy \(id)") }
        if searchList.strategies[i].running { return nil }
        searchList.strategies[i].running = true
        nextRun += 1
        searchRuns.insert(.with { $0.id = nextRun; $0.strategyID = id; $0.status = "queued"; $0.trigger = "manual" }, at: 0)
        return nextRun
    }
    func setSource(_ target: String, enabled: Bool) async throws {
        log("setSource \(target) \(enabled)")
        for i in searchList.sources.indices where searchList.sources[i].key == target {
            searchList.sources[i].enabled = enabled
        }
        for i in searchList.kinds.indices where searchList.kinds[i].kind == target {
            searchList.kinds[i].enabled = enabled
            for j in searchList.sources.indices where searchList.sources[j].kind == target {
                searchList.sources[j].kindEnabled = enabled
            }
        }
    }
    func runEvents(_ runId: Int64) async throws -> [DaemonEvent] { log("runEvents \(runId)"); return eventsByRun[runId] ?? [] }
    /// Sources with their recipe's listings (GetSearchSource).
    var sourceDetails: [String: SearchSource] = [:]
    var nextPlan: Int64 = 0
    func planSearch() async throws -> Int64? {
        log("planSearch")
        if searchList.plans.first?.status == "queued" { return nil }
        nextPlan += 1
        let id = nextPlan
        searchList.plans.insert(.with { $0.id = id; $0.status = "queued"; $0.trigger = "manual" }, at: 0)
        return id
    }
    func searchSource(_ key: String) async throws -> SearchSource {
        log("searchSource \(key)")
        guard let s = sourceDetails[key] ?? searchList.sources.first(where: { $0.key == key }) else { throw APIError("no source \(key)") }
        return s
    }
    func rebuildRecipe(_ key: String) async throws -> Bool {
        log("rebuildRecipe \(key)")
        for i in searchList.sources.indices where searchList.sources[i].key == key {
            searchList.sources[i].recipe.status = "building"
        }
        sourceDetails[key]?.recipe.status = "building"
        return true
    }

    /// Companies (ListCompanies / GetCompany); researchCompany marks one researching.
    var companies: [Company] = []
    func listCompanies() async throws -> [Company] {
        log("listCompanies")
        return companies.map { var c = $0; c.sections = []; return c }
    }
    func company(_ target: CompanyTarget) async throws -> Company? {
        log("company \(target)")
        switch target {
        case let .id(id): return companies.first { $0.id == id }
        case let .posting(id): return companies.first { $0.postings.contains { $0.id == id } }
        }
    }
    func researchCompany(_ target: CompanyTarget, refresh: Bool) async throws -> (company: Company, queued: Bool) {
        log("researchCompany \(target) \(refresh)")
        let index: Int? = switch target {
        case let .id(id): companies.firstIndex { $0.id == id }
        case let .posting(id): companies.firstIndex { $0.postings.contains { $0.id == id } }
        }
        guard let i = index else {
            guard case let .posting(pid) = target else { throw APIError("no company") }
            let c = Company.with {
                $0.id = Int64(companies.count + 1)
                $0.name = postings[pid]?.company ?? "?"
                $0.status = "queued"
                $0.researching = true
                $0.postings = [.with { $0.id = pid }]
            }
            companies.append(c)
            postings[pid]?.companyResearch = c
            return (c, true)
        }
        if companies[i].researching || (companies[i].fresh && !refresh) { return (companies[i], false) }
        companies[i].researching = true
        companies[i].status = "queued"
        return (companies[i], true)
    }

    // The mailbox: its state, the ask queue, and what assigning does.
    var mailboxState: Mailbox?
    var queue: [Email] = []
    var syncs = 0

    func mailbox() async throws -> Mailbox? { log("mailbox"); return mailboxState }
    func mailQueue() async throws -> [Email] { log("mailQueue"); return queue }
    func assignEmail(_ id: Int64, application: Int64?, label: String?) async throws -> Email {
        log("assignEmail \(id) \(application.map(String.init) ?? "none") \(label ?? "-")")
        guard let i = queue.firstIndex(where: { $0.id == id }) else { throw APIError("no email \(id)") }
        var e = queue.remove(at: i)
        e.status = "assigned"
        if let application {
            e.applicationID = application
            if (label ?? e.label) == "interview" { applications[application]?.stage = .interview }
        }
        mailboxState?.asking = Int32(queue.count)
        return e
    }
    func syncMailbox() async throws -> Bool {
        log("syncMailbox")
        syncs += 1
        return syncs == 1
    }

    // LinkedIn/Xing and the captcha key (Settings).
    var platformList = PlatformList.with {
        $0.platforms = [
            .with { $0.platform = "linkedin"; $0.name = "LinkedIn"; $0.searchesPerDay = 8; $0.applicationsPerDay = 15 },
            .with { $0.platform = "xing"; $0.name = "Xing"; $0.searchesPerDay = 8; $0.applicationsPerDay = 15 },
        ]
    }
    var secrets: [String: String] = [:]

    func listPlatforms() async throws -> PlatformList { log("listPlatforms"); return platformList }
    private func changePlatform(_ key: String, _ change: (inout Platform) -> Void) throws -> Platform {
        guard let i = platformList.platforms.firstIndex(where: { $0.platform == key }) else { throw APIError("unknown platform \(key)") }
        change(&platformList.platforms[i])
        return platformList.platforms[i]
    }
    func setPlatformCaps(_ platform: String, searches: Int32?, applications: Int32?) async throws -> Platform {
        log("setPlatformCaps \(platform) \(searches.map(String.init) ?? "-") \(applications.map(String.init) ?? "-")")
        return try changePlatform(platform) {
            if let searches { $0.searchesPerDay = searches }
            if let applications { $0.applicationsPerDay = applications }
        }
    }
    func resumePlatform(_ platform: String) async throws -> Platform {
        log("resumePlatform \(platform)")
        return try changePlatform(platform) { $0.clearPausedAt(); $0.clearPauseReason() }
    }
    func signIn(_ target: String, force: Bool) async throws -> String {
        log("signIn \(target)")
        platformList.signInOpen = "https://www.linkedin.com/login"
        return platformList.signInOpen
    }
    func setSecret(_ name: String, value: String) async throws {
        log("setSecret \(name)")
        secrets[name] = value
        if name == "capmonster" { platformList.captchaSolver = true }
    }
    var telegramAccount = TelegramAccount.with { $0.state = .disconnected }
    var addedSources: [String] = []
    func telegram() async throws -> TelegramAccount { log("telegram"); return telegramAccount }
    func connectTelegram(_ step: Applyant_V1_ConnectTelegramRequest.OneOf_Step) async throws -> TelegramAccount {
        switch step {
        case let .start(start):
            log("connectTelegram start \(start.phone)")
            telegramAccount.state = .waitingCode
        case let .code(code):
            log("connectTelegram code")
            guard code == "11111" else { throw APIError("PHONE_CODE_INVALID") }
            telegramAccount.state = .connected
            telegramAccount.account = "@roman · Roman"
        case .password:
            log("connectTelegram password")
        case .cancel:
            telegramAccount.state = .disconnected
        }
        return telegramAccount
    }
    func disconnectTelegram() async throws -> TelegramAccount {
        log("disconnectTelegram")
        telegramAccount = .with { $0.state = .disconnected }
        return telegramAccount
    }
    func addSearchSource(kind: String, locator: String) async throws -> SearchSource {
        log("addSearchSource \(kind) \(locator)")
        addedSources.append(locator)
        return .with { $0.key = "\(kind):\(locator)"; $0.kind = kind; $0.locator = locator }
    }

    /// Changes a question everywhere it's listed.
    func setQuestion(_ id: Int64, _ change: (inout InterviewQuestion) -> Void) throws -> InterviewQuestion {
        guard let i = questions.firstIndex(where: { $0.id == id }) else { throw APIError("no question \(id)") }
        change(&questions[i])
        for (target, var thread) in threads {
            if let j = thread.questions.firstIndex(where: { $0.id == id }) {
                change(&thread.questions[j])
                threads[target] = thread
            }
        }
        return questions[i]
    }
}

/// Hands out the daemons in order; nil (daemon down) once they run out.
final class FakeConnector: DaemonConnector, @unchecked Sendable {
    private let lock = NSLock()
    private var queue: [FakeDaemon?]
    private(set) var connects = 0
    init(_ daemons: [FakeDaemon?]) { queue = daemons }
    func connect() -> DaemonAPI? {
        lock.withLock {
            connects += 1
            return queue.isEmpty ? nil : queue.removeFirst()
        }
    }
}

func posting(_ id: Int64, score: Int32, title: String, company: String = "Acme", appId: Int64? = nil) -> Posting {
    var p = Posting()
    p.id = id
    p.stage = .scored
    p.score = score
    p.title = title
    p.company = company
    p.canonicalURL = "https://jobs.ashbyhq.com/acme/\(id)"
    if let appId { p.applicationID = appId }
    return p
}

func application(_ id: Int64, posting: Int64, stage: ApplicationStage, blockers: [String] = []) -> Application {
    var a = Application()
    a.id = id
    a.postingID = posting
    a.stage = stage
    a.title = "Senior AI Engineer"
    a.company = "Acme"
    a.score = 91
    a.blockers = blockers
    return a
}

func event(_ id: Int64, _ payload: Applyant_V1_Event.OneOf_Payload) -> DaemonEvent {
    var e = DaemonEvent()
    e.id = id
    e.payload = payload
    return e
}

/// Polls the main actor until `condition` holds (the store runs in its own task).
@MainActor
func eventually(_ what: String, timeout: Duration = .seconds(3), _ condition: () -> Bool) async throws {
    let clock = ContinuousClock()
    let deadline = clock.now + timeout
    while !condition() {
        if clock.now > deadline {
            Issue.record("timed out waiting for \(what)")
            throw APIError("timeout")
        }
        try await Task.sleep(for: .milliseconds(10))
    }
}

@MainActor
@Suite struct AppStoreTests {
    @Test func reloadsEverythingOnEachReconnectAndWatchesFromTheNewestEvent() async throws {
        let first = FakeDaemon(postings: [posting(1, score: 80, title: "Backend")], lastId: 41)
        let second = FakeDaemon(
            postings: [posting(1, score: 80, title: "Backend"), posting(2, score: 91, title: "AI Engineer")],
            lastId: 57
        )
        let connector = FakeConnector([first, nil, second])
        let store = AppStore(connector: connector, backoff: { _ in await Task.yield() })
        let run = Task { await store.run() }
        defer { run.cancel() }

        try await eventually("first connect") { store.connection == .connected && store.reloads == 1 }
        #expect(store.items(.inbox).map(\.title) == ["Backend"])
        #expect(first.watchedAfter == [41])

        // The daemon goes away (the stream breaks), is down for one try, then comes back.
        first.feed.finish(throwing: APIError("connection reset"))
        try await eventually("second connect") { store.reloads == 2 }
        #expect(connector.connects == 3)
        #expect(store.connection == .connected)
        // What was added while the stream was down is there: nothing missed during the gap.
        #expect(store.items(.inbox).map(\.title) == ["AI Engineer", "Backend"])
        #expect(second.watchedAfter == [57])
    }

    @Test func appliesEventsAndNotifiesOnlyForLiveStageChanges() async throws {
        let daemon = FakeDaemon(
            postings: [posting(5, score: 88, title: "Founding Engineer", appId: 9)],
            applications: [application(9, posting: 5, stage: .preparing)]
        )
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        var notes: [StoreNotification] = []
        store.onNotify = { notes.append($0) }
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }
        #expect(store.items(.preparing).map(\.applicationId) == [9])
        #expect(store.items(.inbox).first?.chips.first?.text == "Preparing…")

        // Preparation finishes on the daemon; the event says so.
        daemon.applications[9]?.stage = .readyForReview
        var stage = Applyant_V1_ApplicationEvent()
        stage.applicationID = 9
        stage.postingID = 5
        stage.stage = .readyForReview
        daemon.feed.yield(event(60, .application(stage)))
        try await eventually("ready") { store.applications[9]?.stage == .readyForReview }
        #expect(store.items(.readyToReview).map(\.applicationId) == [9])
        #expect(store.items(.preparing).isEmpty)
        #expect(notes.map(\.kind) == [.readyForReview])
        #expect(notes.first?.title == "Acme · Senior AI Engineer · 91")

        // A task event changes activity, not the lists; a limit pause is shown.
        var task = Applyant_V1_TaskEvent()
        task.taskID = 77
        task.taskKind = "prepare_application"
        task.type = .started
        daemon.feed.yield(event(61, .task(task)))
        try await eventually("running") { store.activity.running[77] == "prepare_application" }
        task.type = .providerPaused
        var paused = event(62, .task(task))
        paused.message = "waiting for claude limit, resumes at 2026-09-28T15:45:00.000Z"
        daemon.feed.yield(paused)
        try await eventually("paused") { store.activity.paused != nil }
        #expect(store.activity.running.isEmpty)
        #expect(store.activity.paused?.hasPrefix("Waiting for claude limit · resumes ") == true)

        // A hand-off notifies too.
        daemon.applications[9]?.stage = .approved
        daemon.applications[9]?.handOff = .with { $0.reason = "a captcha" }
        var handOff = Applyant_V1_HandOffEvent()
        handOff.applicationID = 9
        handOff.reason = "a captcha"
        daemon.feed.yield(event(63, .handoff(handOff)))
        try await eventually("hand-off") { notes.count == 2 }
        #expect(notes.last?.kind == .handOff)
        #expect(store.needsYou.map(\.id) == [9])
        #expect(store.items(.applied).first?.chips.first?.text == "Finish in browser")

        // The candidate finishes it in the browser and says so.
        await store.markSubmitted(application: 9)
        #expect(daemon.calls.contains("markSubmitted 9"))
        #expect(store.needsYou.isEmpty)
        #expect(store.items(.applied).first?.chips.first?.text == "Applied")
    }

    @Test func switchesBetweenThePlatformFormAndTheCompanyForm() async throws {
        var app = application(9, posting: 5, stage: .readyForReview)
        app.applyForm = .company
        app.applyFormSwitchable = true
        let daemon = FakeDaemon(postings: [posting(5, score: 88, title: "Founding Engineer", appId: 9)], applications: [app])
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }
        await store.openApplication(9)
        let before = try #require(store.applicationDetails[9])
        #expect(ReviewRules.canSwitchForm(before))
        #expect(ReviewRules.formText(before) == "Applying through the company's own form")

        await store.setApplyForm(application: 9, form: .platform)
        #expect(daemon.calls.contains("setApplyForm 9 platform"))
        #expect(store.applications[9]?.applyForm == .platform)
        #expect(store.applications[9]?.stage == .preparing)

        // Approved (or a posting with one form only): no switch, and the daemon isn't asked.
        daemon.calls.removeAll()
        var approved = app
        approved.stage = .approved
        #expect(!ReviewRules.canSwitchForm(approved))
        var single = app
        single.applyFormSwitchable = false
        #expect(!ReviewRules.canSwitchForm(single))
        daemon.applications[9]?.stage = .approved
        await store.openApplication(9)
        await store.setApplyForm(application: 9, form: .company)
        #expect(!daemon.calls.contains { $0.hasPrefix("setApplyForm") })
        #expect(store.lastError != nil)
    }

    @Test func approveStaysOffWhileAnythingBlocksIt() async throws {
        let daemon = FakeDaemon(
            postings: [posting(5, score: 88, title: "Founding Engineer", appId: 9)],
            applications: [application(9, posting: 5, stage: .readyForReview, blockers: ["2 unconfirmed facts"])]
        )
        daemon.onConfirm = { $0.blockers = [] }
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }
        await store.openApplication(9)
        let blocked = try #require(store.applicationDetails[9])
        #expect(!ReviewRules.canApprove(blocked))

        // The button is off, and even a direct call doesn't reach the daemon.
        await store.approve(application: 9)
        #expect(!daemon.calls.contains("approve 9"))
        #expect(store.lastError != nil)

        await store.confirmFacts(application: 9, factIds: [])
        let clear = try #require(store.applicationDetails[9])
        #expect(ReviewRules.canApprove(clear))
        await store.approve(application: 9)
        #expect(daemon.calls.contains("approve 9"))
        #expect(store.applications[9]?.stage == .approved)
        // Needs-you and preparing applications can't be approved either.
        #expect(!ReviewRules.canApprove(application(1, posting: 1, stage: .needsCandidate)))
        #expect(!ReviewRules.canApprove(application(1, posting: 1, stage: .preparing)))
    }

    @Test func showsDisconnectedWhileTheDaemonIsDown() async throws {
        let store = AppStore(connector: FakeConnector([]), backoff: { _ in try? await Task.sleep(for: .milliseconds(5)) })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("disconnected") { store.connection == .disconnected("applyantd isn't running") }
    }

    @Test func skipMovesAPostingOutOfTheInbox() async throws {
        let daemon = FakeDaemon(postings: [posting(1, score: 70, title: "A"), posting(2, score: 60, title: "B")])
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }
        await store.skip(posting: 1, reason: "salary too low")
        #expect(daemon.calls.contains("skip 1 salary too low"))
        #expect(store.items(.inbox).map(\.postingId) == [2])
        #expect(store.items(.skipped).map(\.postingId) == [1])
        await store.markInterested(posting: 2)
        #expect(store.items(.interested).map(\.postingId) == [2])
    }
}

@Suite struct PresentationTests {
    @Test func scorePointsAndTheMainDeviation() {
        var salary = Applyant_V1_ScoreComponent()
        salary.key = "salary"
        salary.weight = 10
        salary.value = 0.7
        salary.scale = 1
        salary.note = "Salary 7% below target"
        var must = Applyant_V1_ScoreComponent()
        must.key = "must"
        must.weight = 40
        must.value = 0.95
        must.scale = 1
        #expect(Score.points(must) == (38, 40))
        #expect(Score.points(salary) == (7, 10))
        var p = posting(1, score: 74, title: "Backend")
        p.breakdown = [must, salary]
        #expect(Score.mainDeviation(p) == "Salary 7% below target")
        p.dealbreakers = ["outstaffing"]
        #expect(Score.mainDeviation(p) == "Dealbreaker: outstaffing")
        #expect(ListItem(posting: p, application: nil).chips.map(\.text) == ["Dealbreaker: outstaffing", "Ashby"])
    }

    @Test func sectionsWithoutContentSayWhichPhaseFillsThem() {
        for section in Section.allCases {
            #expect(section.isBuilt == (section.comesWith == nil), "\(section)")
        }
    }

    @Test func flaggedSentences() {
        var s = Applyant_V1_AnswerSentence()
        s.flag = "none"
        #expect(ReviewRules.flagText(s) == nil)
        s.flag = "absent_number"
        #expect(ReviewRules.flagText(s) == "A number the facts don't have")
        #expect(ReviewRules.canConfirmAsWritten(s))
        s.flag = "contradiction"
        #expect(!ReviewRules.canConfirmAsWritten(s))
        s.flag = "verifier:scope"
        s.note = "claims the whole platform"
        #expect(ReviewRules.flagText(s) == "Verifier: scope — claims the whole platform")
    }
}
