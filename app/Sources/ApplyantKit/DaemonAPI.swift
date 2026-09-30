// What the app asks of the daemon: the RPCs its screens use, over the connect-swift client
// generated from applyant.proto. The store talks to this protocol, so tests run it against a
// fake; `ConnectDaemonAPI` is the real one. A new one is made on every (re)connect, because a
// restarted daemon writes a new port and token.
import ApplyantAPI
import Connect
import Foundation

public typealias Posting = Applyant_V1_Posting
public typealias Application = Applyant_V1_Application
public typealias DaemonEvent = Applyant_V1_Event
public typealias ApplicationStage = Applyant_V1_ApplicationStage
public typealias PostingStage = Applyant_V1_PostingStage
public typealias InterviewQuestion = Applyant_V1_InterviewQuestion
public typealias ProjectInterview = Applyant_V1_ProjectInterview
public typealias InterviewThread = Applyant_V1_GetInterviewResponse
public typealias InterviewList = Applyant_V1_ListInterviewResponse
public typealias InterviewStart = Applyant_V1_StartInterviewResponse
public typealias SearchList = Applyant_V1_ListSearchResponse
public typealias SearchStrategy = Applyant_V1_SearchStrategy
public typealias SearchSource = Applyant_V1_SearchSource
public typealias SearchRun = Applyant_V1_SearchRun
public typealias SearchPlan = Applyant_V1_SearchPlan
public typealias Company = Applyant_V1_Company

/// Which company: by id, or a posting's company.
public enum CompanyTarget: Hashable, Sendable {
    case id(Int64)
    case posting(Int64)
}

public struct APIError: Error, LocalizedError, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

public protocol DaemonAPI: Sendable {
    func listPostings() async throws -> [Posting]
    func getPosting(_ id: Int64) async throws -> Posting
    func listApplications() async throws -> [Application]
    func getApplication(_ id: Int64) async throws -> Application
    /// The id of the newest stored event (0 when there is none): watching from it misses nothing.
    func lastEventId() async throws -> Int64
    /// Stored events after `afterEventId`, then live ones, until the stream breaks.
    func events(after afterEventId: Int64) -> AsyncThrowingStream<DaemonEvent, Error>

    func skip(posting id: Int64, reason: String) async throws -> Posting
    func markInterested(posting id: Int64) async throws -> Posting
    /// Starts (or re-starts) preparation: for a posting, or an application (`rewrite` redrafts all).
    func prepare(posting id: Int64) async throws -> Application
    func prepare(application id: Int64, rewrite: Bool) async throws -> Application
    /// Confirms facts the application relies on (all of them when `factIds` is empty).
    func confirmFacts(application id: Int64, factIds: [Int64]) async throws
    /// The candidate's words for an answer (or one sentence); nil text with a sentence confirms
    /// it as written.
    func editAnswer(application id: Int64, answer: Int32, sentence: Int32?, text: String?) async throws -> Application
    func setField(application id: Int64, field: String, value: String?) async throws -> Application
    func setCvMode(application id: Int64, mode: String) async throws -> Application
    /// The platform's form (LinkedIn Easy Apply, Xing apply) or the company's own, before
    /// approval: the form is read again and the application prepared for it.
    func setApplyForm(application id: Int64, form: Applyant_V1_ApplyForm) async throws -> Application
    func approve(application id: Int64) async throws -> Application
    /// Approve if needed and deliver, or retry a delivery that got stuck.
    func submit(application id: Int64) async throws -> Application
    /// The candidate finished a hand-off in the browser and pressed submit themselves.
    func markSubmitted(application id: Int64) async throws -> Application

    /// Questions waiting on the candidate (or being read) and each project's gaps.
    func listInterview() async throws -> InterviewList
    /// One thread: a project's interview, or an application question's.
    func interview(_ target: InterviewTarget) async throws -> InterviewThread
    /// The project's open question, or the interviewer is asked for one (`pending`).
    func startInterview(project id: Int64) async throws -> InterviewStart
    func answerInterview(question id: Int64, text: String) async throws -> InterviewQuestion
    /// "Later": an application question is then the candidate's to answer in review.
    func dismissInterview(question id: Int64) async throws -> InterviewQuestion

    /// Strategies, sources and kind switches, with what each found (the Search screen).
    func listSearch() async throws -> SearchList
    /// Recent search runs, newest first, each with what every source gave.
    func listSearchRuns(limit: Int32) async throws -> [SearchRun]
    func setStrategy(_ id: Int64, paused: Bool) async throws -> SearchStrategy
    /// A run now, outside the schedule; nil when one is already waiting or running.
    func runStrategy(_ id: Int64) async throws -> Int64?
    /// A source by key (board:hn) or a whole kind (greenhouse, board, …).
    func setSource(_ target: String, enabled: Bool) async throws
    /// Starts the search planner; nil when it's already running.
    func planSearch() async throws -> Int64?
    /// One source with its listing recipe and what the recipe read when it was built.
    func searchSource(_ key: String) async throws -> SearchSource
    /// A new listing recipe for a career page; false when a build was already going.
    func rebuildRecipe(_ key: String) async throws -> Bool
    /// The events of one run (its tasks, the postings it found), oldest first.
    func runEvents(_ runId: Int64) async throws -> [DaemonEvent]

    /// Researched companies (without their sections), most recently changed first.
    func listCompanies() async throws -> [Company]
    /// One company's profile with every finding and its sources; nil when never researched.
    func company(_ target: CompanyTarget) async throws -> Company?
    /// Company research now; `queued` is false when it was already going or the profile is fresh.
    func researchCompany(_ target: CompanyTarget, refresh: Bool) async throws -> (company: Company, queued: Bool)

    /// The connected mailbox (or the one being connected); nil when there is none.
    func mailbox() async throws -> Mailbox?
    /// Replies waiting for "Which application is this?", newest first.
    func mailQueue() async throws -> [Email]
    /// The candidate's answer: an application (nil = none), and what the email is if they say.
    func assignEmail(_ id: Int64, application: Int64?, label: String?) async throws -> Email
    /// Reads the mailbox now; false when a sync was already waiting or running.
    func syncMailbox() async throws -> Bool
    /// The mailbox with what connecting needs: whether a Google client secret is stored (never
    /// its value) and the client id to offer.
    func mailboxSetup() async throws -> MailboxSetup
    /// Starts Google's consent (Gmail, Calendar, Drive); the secret goes to the daemon's Secrets.
    /// The mailbox is `connecting` until the browser comes back; open the URL returned.
    func connectGmail(clientId: String?, clientSecret: String?) async throws -> (mailbox: Mailbox, authURL: String)
    /// Checks the login with a first sync, then keeps the password in the daemon's Secrets.
    func connectImap(address: String, settings: ImapSettings) async throws -> Mailbox
    /// Forgets the mailbox and its tokens or password; false when none was connected.
    func disconnectMailbox() async throws -> Bool

    // LinkedIn/Xing and the captcha solver (phase 14): Settings.
    /// The guarded platforms, whether a CapMonster key is stored, and an open sign-in window.
    func listPlatforms() async throws -> PlatformList
    /// A platform's daily caps (nil leaves that cap as it is).
    func setPlatformCaps(_ platform: String, searches: Int32?, applications: Int32?) async throws -> Platform
    /// Lets a platform paused by a challenge run again.
    func resumePlatform(_ platform: String) async throws -> Platform
    /// Opens Applyant's browser profile, unautomated, for a one-time sign-in; the URL it opened.
    func signIn(_ target: String, force: Bool) async throws -> String
    /// Stores a secret (write-only: values never come back).
    func setSecret(_ name: String, value: String) async throws

    // Telegram (phase 15): Settings → Telegram, Search → Telegram channels.
    /// The candidate's Telegram account: connected or not, or waiting in a sign-in.
    func telegram() async throws -> TelegramAccount
    /// One sign-in step: start (phone, app credentials once), the code, the 2FA password, cancel.
    func connectTelegram(_ step: Applyant_V1_ConnectTelegramRequest.OneOf_Step) async throws -> TelegramAccount
    /// Forgets Applyant's Telegram session.
    func disconnectTelegram() async throws -> TelegramAccount
    /// Follows a source: a Telegram channel (@name, t.me link), a board URL or a career page.
    func addSearchSource(kind: String, locator: String) async throws -> SearchSource

    // The first-launch setup (phase 16).
    /// The connections, the setup steps, the import's progress and whether search has started.
    func setupStatus(refresh: Bool) async throws -> OnboardingStatus
    /// A step done, skipped or left for later; finishing Preferences starts search.
    func setSetupStep(_ step: String, state: String) async throws -> OnboardingStatus
    /// Preferences pre-filled from the imported CV (nothing stored until SetPreference).
    func preferencesDraft() async throws -> [PreferenceSuggestion]
    func setPreference(_ key: String, value: String) async throws
    /// A knowledge source (nil project = the profile: a CV that covers many projects); it syncs.
    func addKnowledgeSource(project: String?, kind: Applyant_V1_SourceKind, locator: String) async throws
    func setProfileValue(_ key: String, value: String) async throws

    // App parity with the CLI for setup (phase 16).
    /// The profile's values, every project and the profile's own sources.
    func candidate() async throws -> CandidateProfile
    /// A project with its sources (by id, slug or name).
    func project(_ ref: String) async throws -> (project: KnowledgeProject, sources: [KnowledgeSource])
    func createProject(name: String) async throws -> KnowledgeProject
    func renameProject(_ ref: String, name: String) async throws -> KnowledgeProject
    /// Removes the project with its sources and facts.
    func deleteProject(_ ref: String) async throws
    /// Syncs again: a project ref, "profile", "source:<id>"; `force` re-reads unchanged material.
    func syncSources(_ target: String, force: Bool) async throws -> Int
    func getPreferences() async throws -> SearchPreferences
    func addStrategy(_ request: Applyant_V1_AddStrategyRequest) async throws -> SearchStrategy
    func updateStrategy(_ request: Applyant_V1_UpdateStrategyRequest) async throws -> SearchStrategy
    func deleteStrategy(_ id: Int64) async throws

    // Statuses by hand, re-scoring and the Overview.
    /// Corrects an application's status by hand (Applied, Interview, Offer, Rejected, Withdrawn);
    /// moves that can't be true are refused, saying why.
    func setStage(application id: Int64, to stage: ApplicationStage) async throws -> Application
    /// Scores postings again (empty: every verified or scored one); the ids enqueued, none when
    /// they were all being scored already.
    func scorePostings(_ ids: [Int64], refresh: Bool) async throws -> [Int64]
    /// The funnel and the success metrics over a window.
    func overview(_ window: OverviewWindow) async throws -> OverviewReport
}

/// Older fakes and daemons: the setup RPCs answer "not available" unless implemented.
public extension DaemonAPI {
    func setStage(application id: Int64, to stage: ApplicationStage) async throws -> Application {
        throw APIError("setting a status by hand needs a newer applyantd")
    }
    func scorePostings(_ ids: [Int64], refresh: Bool) async throws -> [Int64] {
        throw APIError("re-scoring needs a newer applyantd")
    }
    func overview(_ window: OverviewWindow) async throws -> OverviewReport {
        throw APIError("the overview needs a newer applyantd")
    }
    func mailboxSetup() async throws -> MailboxSetup {
        var setup = MailboxSetup()
        if let box = try await mailbox() { setup.mailbox = box }
        return setup
    }
    func connectGmail(clientId: String?, clientSecret: String?) async throws -> (mailbox: Mailbox, authURL: String) {
        throw APIError("connecting a mailbox isn't available")
    }
    func connectImap(address: String, settings: ImapSettings) async throws -> Mailbox {
        throw APIError("connecting a mailbox isn't available")
    }
    func disconnectMailbox() async throws -> Bool { throw APIError("disconnecting a mailbox isn't available") }
    func setupStatus(refresh: Bool) async throws -> OnboardingStatus { throw APIError("setup isn't available") }
    func setSetupStep(_ step: String, state: String) async throws -> OnboardingStatus { throw APIError("setup isn't available") }
    func preferencesDraft() async throws -> [PreferenceSuggestion] { [] }
    func setPreference(_ key: String, value: String) async throws { throw APIError("setup isn't available") }
    func addKnowledgeSource(project: String?, kind: Applyant_V1_SourceKind, locator: String) async throws {
        throw APIError("setup isn't available")
    }
    func setProfileValue(_ key: String, value: String) async throws { throw APIError("setup isn't available") }
    func candidate() async throws -> CandidateProfile { throw APIError("the profile isn't available") }
    func project(_ ref: String) async throws -> (project: KnowledgeProject, sources: [KnowledgeSource]) {
        throw APIError("projects aren't available")
    }
    func createProject(name: String) async throws -> KnowledgeProject { throw APIError("projects aren't available") }
    func renameProject(_ ref: String, name: String) async throws -> KnowledgeProject {
        throw APIError("renaming a project needs a newer applyantd")
    }
    func deleteProject(_ ref: String) async throws { throw APIError("removing a project needs a newer applyantd") }
    func syncSources(_ target: String, force: Bool) async throws -> Int { throw APIError("syncing isn't available") }
    func getPreferences() async throws -> SearchPreferences { throw APIError("preferences aren't available") }
    func addStrategy(_ request: Applyant_V1_AddStrategyRequest) async throws -> SearchStrategy {
        throw APIError("adding a strategy isn't available")
    }
    func updateStrategy(_ request: Applyant_V1_UpdateStrategyRequest) async throws -> SearchStrategy {
        throw APIError("editing a strategy isn't available")
    }
    func deleteStrategy(_ id: Int64) async throws { throw APIError("deleting a strategy isn't available") }
}

/// Unary answers → value or APIError.
func unwrap<T>(_ response: ResponseMessage<T>) throws -> T {
    switch response.result {
    case let .success(message): return message
    case let .failure(error):
        if error.code == .unavailable || error.code == .unknown && error.message == nil {
            throw APIError("applyantd is not reachable")
        }
        throw APIError(error.message ?? "\(error.code)")
    }
}

public final class ConnectDaemonAPI: DaemonAPI {
    let unary: Applyant_V1_ApplyantServiceClient
    private let streaming: Applyant_V1_ApplyantServiceClient
    let headers: Headers

    public init(endpoint: Endpoint) {
        let host = "http://\(endpoint.host):\(endpoint.port)"
        unary = Applyant_V1_ApplyantServiceClient(
            client: ProtocolClient(
                httpClient: URLSessionHTTPClient(),
                config: ProtocolClientConfig(host: host, networkProtocol: .connect, codec: ProtoCodec(), timeout: 60)
            )
        )
        // The event stream is quiet for long stretches: no idle timeout on it.
        let quiet = URLSessionConfiguration.default
        quiet.timeoutIntervalForRequest = 7 * 24 * 3600
        quiet.timeoutIntervalForResource = 7 * 24 * 3600
        streaming = Applyant_V1_ApplyantServiceClient(
            client: ProtocolClient(
                httpClient: URLSessionHTTPClient(configuration: quiet),
                config: ProtocolClientConfig(host: host, networkProtocol: .connect, codec: ProtoCodec())
            )
        )
        headers = ["authorization": ["Bearer \(endpoint.token)"]]
    }

    public func listPostings() async throws -> [Posting] {
        var request = Applyant_V1_ListPostingsRequest()
        request.byScore = true
        return try unwrap(await unary.listPostings(request: request, headers: headers)).postings
    }

    public func getPosting(_ id: Int64) async throws -> Posting {
        try unwrap(await unary.getPosting(request: .with { $0.id = id }, headers: headers)).posting
    }

    public func listApplications() async throws -> [Application] {
        try unwrap(await unary.listApplications(request: .init(), headers: headers)).applications
    }

    public func getApplication(_ id: Int64) async throws -> Application {
        try unwrap(await unary.getApplication(request: .with { $0.id = id }, headers: headers)).application
    }

    public func lastEventId() async throws -> Int64 {
        let events = try unwrap(await unary.listEvents(request: .with { $0.limit = 1 }, headers: headers)).events
        return events.last?.id ?? 0
    }

    public func events(after afterEventId: Int64) -> AsyncThrowingStream<DaemonEvent, Error> {
        let stream = streaming.watchEvents(headers: headers)
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    try stream.send(.with { $0.afterEventID = afterEventId })
                } catch {
                    continuation.finish(throwing: error)
                    return
                }
                for await result in stream.results() {
                    switch result {
                    case .headers:
                        continue
                    case let .message(response):
                        continuation.yield(response.event)
                    case let .complete(code, error, _):
                        continuation.finish(throwing: error ?? APIError("the event stream ended (\(code))"))
                        return
                    }
                }
                continuation.finish(throwing: APIError("the event stream ended"))
            }
            continuation.onTermination = { _ in
                task.cancel()
                stream.cancel()
            }
        }
    }

    public func skip(posting id: Int64, reason: String) async throws -> Posting {
        try unwrap(await unary.skipPosting(request: .with { $0.id = id; $0.reason = reason }, headers: headers)).posting
    }

    public func markInterested(posting id: Int64) async throws -> Posting {
        try unwrap(await unary.markInterested(request: .with { $0.id = id }, headers: headers)).posting
    }

    public func prepare(posting id: Int64) async throws -> Application {
        try unwrap(await unary.prepareApplication(request: .with { $0.postingID = id }, headers: headers)).application
    }

    public func prepare(application id: Int64, rewrite: Bool) async throws -> Application {
        let request = Applyant_V1_PrepareApplicationRequest.with {
            $0.applicationID = id
            $0.rewrite = rewrite
        }
        return try unwrap(await unary.prepareApplication(request: request, headers: headers)).application
    }

    public func confirmFacts(application id: Int64, factIds: [Int64]) async throws {
        let request = Applyant_V1_ConfirmFactRequest.with {
            $0.applicationID = id
            $0.ids = factIds
        }
        _ = try unwrap(await unary.confirmFact(request: request, headers: headers))
    }

    public func editAnswer(application id: Int64, answer: Int32, sentence: Int32?, text: String?) async throws -> Application {
        let request = Applyant_V1_EditAnswerRequest.with {
            $0.applicationID = id
            $0.answer = "q\(answer)"
            if let sentence { $0.sentence = sentence }
            if let text { $0.text = text }
        }
        return try unwrap(await unary.editAnswer(request: request, headers: headers)).application
    }

    public func setField(application id: Int64, field: String, value: String?) async throws -> Application {
        let request = Applyant_V1_SetFieldValueRequest.with {
            $0.applicationID = id
            $0.field = field
            if let value { $0.value = value } else { $0.clear = true }
        }
        return try unwrap(await unary.setFieldValue(request: request, headers: headers)).application
    }

    public func setCvMode(application id: Int64, mode: String) async throws -> Application {
        let request = Applyant_V1_SetCvModeRequest.with {
            $0.applicationID = id
            $0.mode = mode
        }
        return try unwrap(await unary.setCvMode(request: request, headers: headers)).application
    }

    public func approve(application id: Int64) async throws -> Application {
        try unwrap(await unary.approveApplication(request: .with { $0.id = id }, headers: headers)).application
    }

    public func submit(application id: Int64) async throws -> Application {
        try unwrap(await unary.submitApplication(request: .with { $0.id = id }, headers: headers)).application
    }

    public func setApplyForm(application id: Int64, form: Applyant_V1_ApplyForm) async throws -> Application {
        let request = Applyant_V1_SetApplyFormRequest.with {
            $0.applicationID = id
            $0.form = form
        }
        return try unwrap(await unary.setApplyForm(request: request, headers: headers)).application
    }

    public func markSubmitted(application id: Int64) async throws -> Application {
        try unwrap(await unary.markSubmitted(request: .with { $0.applicationID = id }, headers: headers)).application
    }

    public func listInterview() async throws -> InterviewList {
        try unwrap(await unary.listInterview(request: .init(), headers: headers))
    }

    public func interview(_ target: InterviewTarget) async throws -> InterviewThread {
        let request = Applyant_V1_GetInterviewRequest.with {
            switch target {
            case let .project(id): $0.project = String(id)
            case let .question(id): $0.questionID = id
            }
        }
        return try unwrap(await unary.getInterview(request: request, headers: headers))
    }

    public func startInterview(project id: Int64) async throws -> InterviewStart {
        try unwrap(await unary.startInterview(request: .with { $0.project = String(id) }, headers: headers))
    }

    public func answerInterview(question id: Int64, text: String) async throws -> InterviewQuestion {
        let request = Applyant_V1_AnswerInterviewQuestionRequest.with {
            $0.id = id
            $0.text = text
        }
        return try unwrap(await unary.answerInterviewQuestion(request: request, headers: headers)).question
    }

    public func dismissInterview(question id: Int64) async throws -> InterviewQuestion {
        try unwrap(await unary.dismissInterviewQuestion(request: .with { $0.id = id }, headers: headers)).question
    }

    public func listSearch() async throws -> SearchList {
        try unwrap(await unary.listSearch(request: .init(), headers: headers))
    }

    public func listSearchRuns(limit: Int32) async throws -> [SearchRun] {
        try unwrap(await unary.listSearchRuns(request: .with { $0.limit = limit }, headers: headers)).runs
    }

    public func setStrategy(_ id: Int64, paused: Bool) async throws -> SearchStrategy {
        let request = Applyant_V1_UpdateStrategyRequest.with {
            $0.strategy = String(id)
            $0.state = paused ? "paused" : "active"
        }
        return try unwrap(await unary.updateStrategy(request: request, headers: headers)).strategy
    }

    public func runStrategy(_ id: Int64) async throws -> Int64? {
        let response = try unwrap(await unary.runStrategy(request: .with { $0.strategy = String(id) }, headers: headers))
        return response.hasRunID ? response.runID : nil
    }

    public func setSource(_ target: String, enabled: Bool) async throws {
        let request = Applyant_V1_SetSearchSourceEnabledRequest.with {
            $0.target = target
            $0.enabled = enabled
        }
        _ = try unwrap(await unary.setSearchSourceEnabled(request: request, headers: headers))
    }

    public func planSearch() async throws -> Int64? {
        let response = try unwrap(await unary.planSearch(request: .init(), headers: headers))
        return response.hasPlanID ? response.planID : nil
    }

    public func searchSource(_ key: String) async throws -> SearchSource {
        try unwrap(await unary.getSearchSource(request: .with { $0.source = key }, headers: headers)).source
    }

    public func rebuildRecipe(_ key: String) async throws -> Bool {
        try unwrap(await unary.rebuildRecipe(request: .with { $0.source = key }, headers: headers)).queued
    }

    public func runEvents(_ runId: Int64) async throws -> [DaemonEvent] {
        let request = Applyant_V1_ListEventsRequest.with {
            $0.runID = runId
            $0.limit = 500
        }
        return try unwrap(await unary.listEvents(request: request, headers: headers)).events
    }

    public func listCompanies() async throws -> [Company] {
        try unwrap(await unary.listCompanies(request: .init(), headers: headers)).companies
    }

    public func company(_ target: CompanyTarget) async throws -> Company? {
        let request = Applyant_V1_GetCompanyRequest.with {
            switch target {
            case let .id(id): $0.company = String(id)
            case let .posting(id): $0.postingID = id
            }
        }
        let response = try unwrap(await unary.getCompany(request: request, headers: headers))
        return response.hasCompany ? response.company : nil
    }

    public func researchCompany(_ target: CompanyTarget, refresh: Bool) async throws -> (company: Company, queued: Bool) {
        let request = Applyant_V1_ResearchCompanyRequest.with {
            switch target {
            case let .id(id): $0.company = String(id)
            case let .posting(id): $0.postingID = id
            }
            $0.refresh = refresh
        }
        let response = try unwrap(await unary.researchCompany(request: request, headers: headers))
        return (response.company, response.queued)
    }
}

extension ConnectDaemonAPI {
    public func mailbox() async throws -> Mailbox? {
        let response = try unwrap(await unary.getMailbox(request: .init(), headers: headers))
        return response.hasMailbox ? response.mailbox : nil
    }

    public func mailQueue() async throws -> [Email] {
        try unwrap(await unary.listMailQueue(request: .init(), headers: headers)).emails
    }

    public func assignEmail(_ id: Int64, application: Int64?, label: String?) async throws -> Email {
        let request = Applyant_V1_AssignEmailRequest.with {
            $0.emailID = id
            if let application { $0.applicationID = application }
            if let label { $0.label = label }
        }
        return try unwrap(await unary.assignEmail(request: request, headers: headers)).email
    }

    public func syncMailbox() async throws -> Bool {
        try unwrap(await unary.syncMailbox(request: .init(), headers: headers)).queued
    }

    public func mailboxSetup() async throws -> MailboxSetup {
        try unwrap(await unary.getMailbox(request: .init(), headers: headers))
    }

    public func connectGmail(clientId: String?, clientSecret: String?) async throws -> (mailbox: Mailbox, authURL: String) {
        let request = Applyant_V1_ConnectMailboxRequest.with {
            $0.gmail = .with {
                if let clientId { $0.clientID = clientId }
                if let clientSecret { $0.clientSecret = clientSecret }
            }
        }
        let response = try unwrap(await unary.connectMailbox(request: request, headers: headers))
        guard response.hasAuthURL else { throw APIError("the daemon gave no Google sign-in URL") }
        return (response.mailbox, response.authURL)
    }

    public func connectImap(address: String, settings: ImapSettings) async throws -> Mailbox {
        let request = Applyant_V1_ConnectMailboxRequest.with {
            $0.address = address
            $0.imap = settings
        }
        return try unwrap(await unary.connectMailbox(request: request, headers: headers)).mailbox
    }

    public func disconnectMailbox() async throws -> Bool {
        try unwrap(await unary.disconnectMailbox(request: .init(), headers: headers)).disconnected
    }

    public func listPlatforms() async throws -> PlatformList {
        try unwrap(await unary.listPlatforms(request: .init(), headers: headers))
    }

    public func setPlatformCaps(_ platform: String, searches: Int32?, applications: Int32?) async throws -> Platform {
        let request = Applyant_V1_SetPlatformCapsRequest.with {
            $0.platform = platform
            if let searches { $0.searchesPerDay = searches }
            if let applications { $0.applicationsPerDay = applications }
        }
        return try unwrap(await unary.setPlatformCaps(request: request, headers: headers)).platform
    }

    public func resumePlatform(_ platform: String) async throws -> Platform {
        try unwrap(await unary.resumePlatform(request: .with { $0.platform = platform }, headers: headers)).platform
    }

    public func signIn(_ target: String, force: Bool) async throws -> String {
        let request = Applyant_V1_SignInRequest.with {
            $0.target = target
            $0.force = force
        }
        return try unwrap(await unary.signIn(request: request, headers: headers)).url
    }

    public func setSecret(_ name: String, value: String) async throws {
        let request = Applyant_V1_SetSecretRequest.with {
            $0.name = name
            $0.value = value
        }
        _ = try unwrap(await unary.setSecret(request: request, headers: headers))
    }

    public func setupStatus(refresh: Bool) async throws -> OnboardingStatus {
        try unwrap(await unary.getSetupStatus(request: .with { $0.refresh = refresh }, headers: headers)).status
    }

    public func setSetupStep(_ step: String, state: String) async throws -> OnboardingStatus {
        let request = Applyant_V1_SetSetupStepRequest.with {
            $0.step = step
            $0.state = state
        }
        return try unwrap(await unary.setSetupStep(request: request, headers: headers)).status
    }

    public func preferencesDraft() async throws -> [PreferenceSuggestion] {
        try unwrap(await unary.getPreferencesDraft(request: .init(), headers: headers)).suggestions
    }

    public func setPreference(_ key: String, value: String) async throws {
        let request = Applyant_V1_SetPreferenceRequest.with {
            $0.key = key
            $0.value = value
        }
        _ = try unwrap(await unary.setPreference(request: request, headers: headers))
    }

    public func addKnowledgeSource(project: String?, kind: Applyant_V1_SourceKind, locator: String) async throws {
        let request = Applyant_V1_AddSourceRequest.with {
            $0.project = project ?? ""
            $0.kind = kind
            $0.locator = locator
        }
        _ = try unwrap(await unary.addSource(request: request, headers: headers))
    }

    public func setProfileValue(_ key: String, value: String) async throws {
        let request = Applyant_V1_SetProfileValueRequest.with {
            $0.key = key
            $0.value = value
        }
        _ = try unwrap(await unary.setProfileValue(request: request, headers: headers))
    }

    public func telegram() async throws -> TelegramAccount {
        try unwrap(await unary.getTelegram(request: .init(), headers: headers)).telegram
    }

    public func connectTelegram(_ step: Applyant_V1_ConnectTelegramRequest.OneOf_Step) async throws -> TelegramAccount {
        let request = Applyant_V1_ConnectTelegramRequest.with { $0.step = step }
        return try unwrap(await unary.connectTelegram(request: request, headers: headers)).telegram
    }

    public func disconnectTelegram() async throws -> TelegramAccount {
        try unwrap(await unary.disconnectTelegram(request: .init(), headers: headers)).telegram
    }

    public func addSearchSource(kind: String, locator: String) async throws -> SearchSource {
        let request = Applyant_V1_AddSearchSourceRequest.with {
            $0.kind = kind
            $0.locator = locator
        }
        return try unwrap(await unary.addSearchSource(request: request, headers: headers)).source
    }
}

extension ConnectDaemonAPI {
    public func candidate() async throws -> CandidateProfile {
        try unwrap(await unary.getCandidate(request: .init(), headers: headers))
    }

    public func project(_ ref: String) async throws -> (project: KnowledgeProject, sources: [KnowledgeSource]) {
        let response = try unwrap(await unary.getProject(request: .with { $0.ref = ref }, headers: headers))
        return (response.project, response.sources)
    }

    public func createProject(name: String) async throws -> KnowledgeProject {
        try unwrap(await unary.createProject(request: .with { $0.name = name }, headers: headers)).project
    }

    public func renameProject(_ ref: String, name: String) async throws -> KnowledgeProject {
        let request = Applyant_V1_UpdateProjectRequest.with {
            $0.project = ref
            $0.name = name
        }
        return try unwrap(await unary.updateProject(request: request, headers: headers)).project
    }

    public func deleteProject(_ ref: String) async throws {
        _ = try unwrap(await unary.deleteProject(request: .with { $0.project = ref }, headers: headers))
    }

    public func syncSources(_ target: String, force: Bool) async throws -> Int {
        let request = Applyant_V1_SyncSourcesRequest.with {
            $0.target = target
            $0.force = force
        }
        return try unwrap(await unary.syncSources(request: request, headers: headers)).enqueuedSourceIds.count
    }

    public func getPreferences() async throws -> SearchPreferences {
        try unwrap(await unary.getPreferences(request: .init(), headers: headers)).preferences
    }

    public func addStrategy(_ request: Applyant_V1_AddStrategyRequest) async throws -> SearchStrategy {
        try unwrap(await unary.addStrategy(request: request, headers: headers)).strategy
    }

    public func updateStrategy(_ request: Applyant_V1_UpdateStrategyRequest) async throws -> SearchStrategy {
        try unwrap(await unary.updateStrategy(request: request, headers: headers)).strategy
    }

    public func deleteStrategy(_ id: Int64) async throws {
        _ = try unwrap(await unary.deleteStrategy(request: .with { $0.strategy = String(id) }, headers: headers))
    }
}

extension ConnectDaemonAPI {
    public func setStage(application id: Int64, to stage: ApplicationStage) async throws -> Application {
        let request = Applyant_V1_SetApplicationStageRequest.with {
            $0.applicationID = id
            $0.stage = stage
        }
        return try unwrap(await unary.setApplicationStage(request: request, headers: headers)).application
    }

    public func scorePostings(_ ids: [Int64], refresh: Bool) async throws -> [Int64] {
        let request = Applyant_V1_ScorePostingsRequest.with {
            $0.ids = ids
            $0.refresh = refresh
        }
        return try unwrap(await unary.scorePostings(request: request, headers: headers)).enqueuedIds
    }

    public func overview(_ window: OverviewWindow) async throws -> OverviewReport {
        try unwrap(await unary.getOverview(request: .with { $0.window = window }, headers: headers))
    }
}

/// Makes a fresh API from the endpoint file on each connect; nil while the daemon is down.
public protocol DaemonConnector: Sendable {
    func connect() -> DaemonAPI?
}

public struct EndpointConnector: DaemonConnector {
    public let dataDir: URL
    public init(dataDir: URL) { self.dataDir = dataDir }

    public func connect() -> DaemonAPI? {
        guard let endpoint = Endpoint.read(dataDir: dataDir), kill(endpoint.pid, 0) == 0 || errno == EPERM else {
            return nil
        }
        return ConnectDaemonAPI(endpoint: endpoint)
    }
}
