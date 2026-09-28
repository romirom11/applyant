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
    func markSubmitted(application id: Int64) async throws -> Application {
        log("markSubmitted \(id)")
        applications[id]?.stage = .applied
        applications[id]?.clearHandOff()
        return applications[id]!
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
