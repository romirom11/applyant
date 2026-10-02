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
    func undoDecision(posting id: Int64) async throws -> Posting {
        log("unskip \(id)")
        postings[id]?.stage = .scored
        postings[id]?.decision = ""
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
    /// Stored secrets by name (a Google client secret, the IMAP password): values never come back.
    var mailSecrets: [String: String] = [:]
    /// What the IMAP check says (nil: the login works).
    var imapRefusal: String?
    func mailboxSetup() async throws -> MailboxSetup {
        log("mailboxSetup")
        return .with {
            if let mailboxState { $0.mailbox = mailboxState }
            $0.googleClientSecretStored = mailSecrets["google.client_secret"] != nil
            if let id = mailboxState?.clientID, !id.isEmpty { $0.googleClientID = id }
        }
    }
    func connectGmail(clientId: String?, clientSecret: String?) async throws -> (mailbox: Mailbox, authURL: String) {
        log("connectGmail \(clientId ?? "-") secret:\(clientSecret == nil ? "none" : "given")")
        if let clientSecret { mailSecrets["google.client_secret"] = clientSecret }
        guard mailSecrets["google.client_secret"] != nil else { throw APIError("no client secret") }
        mailboxState = .with {
            $0.kind = "gmail"
            $0.status = "connecting"
            $0.clientID = clientId ?? ""
        }
        return (mailboxState!, "https://accounts.google.test/o/oauth2/v2/auth?client_id=\(clientId ?? "")")
    }
    func connectImap(address: String, settings: ImapSettings) async throws -> Mailbox {
        log("connectImap \(address) \(settings.imapHost):\(settings.imapPort) \(settings.smtpHost):\(settings.smtpPort)")
        if let imapRefusal { throw APIError(imapRefusal) }
        mailSecrets["mail.password"] = settings.password
        mailboxState = .with {
            $0.kind = "imap"
            $0.address = address
            $0.status = "connected"
            $0.imapHost = settings.imapHost
            $0.imapPort = settings.imapPort
            $0.smtpHost = settings.smtpHost
            $0.smtpPort = settings.smtpPort
        }
        return mailboxState!
    }
    func disconnectMailbox() async throws -> Bool {
        log("disconnectMailbox")
        defer { mailboxState = nil }
        mailSecrets["mail.password"] = nil
        return mailboxState != nil
    }
    /// The browser came back from Google (or the candidate said no).
    func finishConsent(address: String?) {
        if let address {
            mailboxState?.status = "connected"
            mailboxState?.address = address
        } else {
            mailboxState?.status = "failed"
            mailboxState?.note = "Google sign-in was not completed (access_denied)"
        }
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

    // The setup (phase 16): nil = an older daemon without it.
    var setupState: OnboardingStatus?
    var draft: [PreferenceSuggestion] = []
    var preferences: [String: String] = [:]
    var knowledgeSources: [String] = []
    var profileValues: [String: String] = [:]
    func setupStatus(refresh: Bool) async throws -> OnboardingStatus {
        log("setupStatus")
        guard let setupState else { throw APIError("unimplemented") }
        return setupState
    }
    func setSetupStep(_ step: String, state: String) async throws -> OnboardingStatus {
        log("setSetupStep \(step) \(state)")
        guard var s = setupState else { throw APIError("unimplemented") }
        if step == "preferences", state != "done" { throw APIError("Preferences can only be done") }
        if let i = s.steps.firstIndex(where: { $0.step == step }) { s.steps[i].state = state }
        if step == "preferences" { s.searchStarted = true }
        s.setupDone = s.steps.allSatisfy { $0.state != "pending" }
        setupState = s
        return s
    }
    func preferencesDraft() async throws -> [PreferenceSuggestion] { log("preferencesDraft"); return draft }
    func setPreference(_ key: String, value: String) async throws {
        log("setPreference \(key)")
        if key == "salary", !value.contains("/") { throw APIError("say per month or per year") }
        preferences[key] = value
    }
    func addKnowledgeSource(project: String?, kind: Applyant_V1_SourceKind, locator: String) async throws {
        log("addKnowledgeSource \(project.map { "project \($0) " } ?? "")\(kind) \(locator)")
        if locator.hasSuffix("/missing.pdf") { throw APIError("no file at \(locator)") }
        knowledgeSources.append(locator)
        setupState?.import.sources += 1
        setupState?.import.syncing += 1
        nextSourceId += 1
        let source = KnowledgeSource.with {
            $0.id = nextSourceId
            $0.kind = kind
            $0.locator = locator
            if let project, let id = Int64(project) { $0.projectID = id }
        }
        if let project, let id = Int64(project) {
            guard let i = projects.firstIndex(where: { $0.id == id }) else { throw APIError("no project \"\(project)\"") }
            projects[i].sourceCount += 1
            sourcesByProject[id, default: []].append(source)
        } else {
            profileSources.append(source)
        }
    }
    func setProfileValue(_ key: String, value: String) async throws {
        log("setProfileValue \(key)")
        if key == "email", !value.isEmpty, !value.contains("@") { throw APIError("\"\(value)\" is not an email address") }
        profileValues[key] = value
        if key == "github_logins" { setupState?.github = .with { $0.connected = true; $0.detail = value } }
    }

    // App parity with the CLI for setup: profile, projects, preferences, strategies.
    var projects: [KnowledgeProject] = []
    var sourcesByProject: [Int64: [KnowledgeSource]] = [:]
    var profileSources: [KnowledgeSource] = []
    var nextSourceId: Int64 = 0
    var prefs = SearchPreferences()
    var strategyRequests: [String] = []
    func candidate() async throws -> CandidateProfile {
        log("candidate")
        return .with {
            $0.profile = profileValues.filter { !$0.value.isEmpty }.sorted { $0.key < $1.key }.map { kv in
                .with { $0.key = kv.key; $0.values = kv.value.components(separatedBy: ", ") }
            }
            $0.projects = projects
            $0.profileSources = profileSources
        }
    }
    func project(_ ref: String) async throws -> (project: KnowledgeProject, sources: [KnowledgeSource]) {
        log("project \(ref)")
        guard let p = projects.first(where: { String($0.id) == ref }) else { throw APIError("no project \"\(ref)\"") }
        return (p, sourcesByProject[p.id] ?? [])
    }
    func createProject(name: String) async throws -> KnowledgeProject {
        log("createProject \(name)")
        let p = KnowledgeProject.with { $0.id = Int64(projects.count + 1); $0.name = name; $0.slug = name.lowercased() }
        projects.append(p)
        return p
    }
    func renameProject(_ ref: String, name: String) async throws -> KnowledgeProject {
        log("renameProject \(ref) \(name)")
        guard let i = projects.firstIndex(where: { String($0.id) == ref }) else { throw APIError("no project") }
        projects[i].name = name
        return projects[i]
    }
    func setProjectKind(_ ref: String, kind: String) async throws -> KnowledgeProject {
        log("setProjectKind \(ref) \(kind)")
        guard let i = projects.firstIndex(where: { String($0.id) == ref }) else { throw APIError("no project") }
        projects[i].kind = kind
        return projects[i]
    }
    func deleteProject(_ ref: String) async throws {
        log("deleteProject \(ref)")
        projects.removeAll { String($0.id) == ref }
        if let id = Int64(ref) { sourcesByProject[id] = nil }
    }
    func deleteSource(_ id: Int64) async throws -> Int {
        log("deleteSource \(id)")
        for (key, list) in sourcesByProject where list.contains(where: { $0.id == id }) {
            sourcesByProject[key] = list.filter { $0.id != id }
            if let i = projects.firstIndex(where: { $0.id == key }) { projects[i].sourceCount -= 1 }
        }
        profileSources.removeAll { $0.id == id }
        return 2
    }
    func syncSources(_ target: String, force: Bool) async throws -> Int {
        log("syncSources \(target)")
        return 1
    }
    var repoSuggestions = RepoSuggestions()
    var repoProblem: String?
    func suggestRepositories(project: String) async throws -> RepoSuggestions {
        log("suggestRepositories \(project)")
        if let repoProblem { throw APIError(repoProblem) }
        return repoSuggestions
    }
    func getPreferences() async throws -> SearchPreferences { log("getPreferences"); return prefs }
    func addStrategy(_ request: Applyant_V1_AddStrategyRequest) async throws -> SearchStrategy {
        log("addStrategy \(request.name)")
        let s = SearchStrategy.with {
            $0.id = Int64(searchList.strategies.count + 1)
            $0.name = request.name
            $0.queries = request.queries
            $0.locations = request.locations
            $0.sources = request.sources
            $0.everyMinutes = request.everyMinutes
            $0.state = request.paused ? "paused" : "active"
        }
        searchList.strategies.append(s)
        return s
    }
    func updateStrategy(_ request: Applyant_V1_UpdateStrategyRequest) async throws -> SearchStrategy {
        log("updateStrategy \(request.strategy)")
        guard let i = searchList.strategies.firstIndex(where: { String($0.id) == request.strategy }) else {
            throw APIError("no strategy")
        }
        if request.hasName { searchList.strategies[i].name = request.name }
        if request.hasQueries { searchList.strategies[i].queries = request.queries.values }
        if request.hasLocations { searchList.strategies[i].locations = request.locations.values }
        if request.hasEveryMinutes { searchList.strategies[i].everyMinutes = request.everyMinutes }
        if request.hasState { searchList.strategies[i].state = request.state }
        return searchList.strategies[i]
    }
    func deleteStrategy(_ id: Int64) async throws {
        log("deleteStrategy \(id)")
        searchList.strategies.removeAll { $0.id == id }
    }

    // Statuses by hand, re-scoring and the Overview.
    /// What SetApplicationStage says no with (nil: the move is allowed).
    var stageRefusal: String?
    /// Postings with a score task queued or running.
    var scoring: Set<Int64> = []
    /// GetOverview's answer per window.
    var overviews: [OverviewWindow: OverviewReport] = [:]
    func setStage(application id: Int64, to stage: ApplicationStage) async throws -> Application {
        log("setStage \(id) \(stage)")
        if let stageRefusal { throw APIError(stageRefusal) }
        guard applications[id] != nil else { throw APIError("no application \(id)") }
        applications[id]?.stage = stage
        return applications[id]!
    }
    func scorePostings(_ ids: [Int64], refresh: Bool) async throws -> [Int64] {
        log("scorePostings \(ids)")
        let fresh = (ids.isEmpty ? postings.keys.sorted() : ids).filter { !scoring.contains($0) }
        scoring.formUnion(fresh)
        return fresh
    }
    func overview(_ window: OverviewWindow) async throws -> OverviewReport {
        log("overview \(window)")
        guard let report = overviews[window] else { throw APIError("no overview for \(window)") }
        return report
    }

    // Minor gaps: add posting, model runs, notes and contacts, the CV template.
    var modelRuns: [AgentRun] = []
    var nextContact: Int64 = 0
    var template = CvTemplateInfo.with { $0.name = "Clean"; $0.dir = "/bundle/cv-template"; $0.files = ["index.html", "style.css"] }
    func addPosting(url: String) async throws -> (posting: Posting, created: Bool) {
        log("addPosting \(url)")
        if url.contains("not-a-job") { throw APIError("that page isn't a job posting") }
        if let known = postings.values.first(where: { $0.canonicalURL == url }) { return (known, false) }
        var p = Posting()
        p.id = (postings.keys.max() ?? 0) + 1
        p.stage = .found
        p.canonicalURL = url
        postings[p.id] = p
        return (p, true)
    }
    func listAgentRuns(limit: Int32, role: String?) async throws -> [AgentRun] {
        log("listAgentRuns \(limit)")
        return modelRuns
    }
    func setApplicationNotes(application id: Int64, notes: String) async throws -> Application {
        log("setApplicationNotes \(id) \(notes)")
        guard applications[id] != nil else { throw APIError("no application \(id)") }
        if notes.isEmpty { applications[id]?.clearNotes() } else { applications[id]?.notes = notes }
        return applications[id]!
    }
    func addApplicationContact(_ request: Applyant_V1_AddApplicationContactRequest) async throws -> Application {
        log("addApplicationContact \(request.applicationID) \(request.name) \(request.hasRole ? request.role : "-") \(request.hasEmail ? request.email : "-")")
        guard applications[request.applicationID] != nil else { throw APIError("no application \(request.applicationID)") }
        nextContact += 1
        let contact = ApplicationContact.with {
            $0.id = nextContact
            if request.hasName { $0.name = request.name }
            if request.hasRole { $0.role = request.role }
            if request.hasEmail { $0.email = request.email }
            if request.hasLinkedin { $0.linkedin = request.linkedin }
            if request.hasNote { $0.note = request.note }
        }
        applications[request.applicationID]?.contacts.append(contact)
        return applications[request.applicationID]!
    }
    func deleteApplicationContact(_ id: Int64) async throws -> Application {
        log("deleteApplicationContact \(id)")
        guard let appId = applications.values.first(where: { $0.contacts.contains { $0.id == id } })?.id else {
            throw APIError("no contact \(id)")
        }
        applications[appId]?.contacts.removeAll { $0.id == id }
        return applications[appId]!
    }
    func cvTemplate() async throws -> CvTemplateInfo { log("cvTemplate"); return template }
    func setCvTemplate(files: [CvTemplateFile], name: String?) async throws -> CvTemplateInfo {
        log("setCvTemplate \(name ?? "-") \(files.map(\.path))")
        guard let index = files.first(where: { $0.path == "index.html" }),
              String(decoding: index.content, as: UTF8.self).contains("{{cv}}")
        else { throw APIError("index.html has no {{cv}}: that's where the CV goes") }
        template = .with { $0.custom = true; $0.name = name ?? "cv-template"; $0.dir = "/home/cv-template"; $0.files = files.map(\.path) }
        return template
    }
    func resetCvTemplate() async throws -> CvTemplateInfo {
        log("resetCvTemplate")
        template = .with { $0.name = "Clean"; $0.dir = "/bundle/cv-template"; $0.files = ["index.html", "style.css"] }
        return template
    }

    // Gap audit: model roles, the facts browser, CV edits and stored keys.
    var roleList: [RoleRoute] = [
        .with { $0.role = "field_classify"; $0.route = "jev"; $0.defaultRoute = "jev"; $0.fallback = "claude:haiku"; $0.description_p = "what each form field asks for" },
        .with { $0.role = "email_classify"; $0.route = "apple"; $0.defaultRoute = "apple"; $0.description_p = "reads replies to applications" },
    ]
    var factsByRef: [String: [Fact]] = [:]
    var cvEdits: [String] = []
    func listRoles() async throws -> [RoleRoute] { log("listRoles"); return roleList }
    func setRole(_ role: String, route: String) async throws -> RoleRoute {
        log("setRole \(role) \(route)")
        if route == "apple" && role != "email_classify" { throw APIError("the on-device model only reads email (email_classify)") }
        guard let i = roleList.firstIndex(where: { $0.role == role }) else { throw APIError("unknown role \(role)") }
        roleList[i].route = route
        roleList[i].overridden = route != roleList[i].defaultRoute
        return roleList[i]
    }
    func resetRoles(_ role: String?) async throws -> [String] {
        log("resetRoles \(role ?? "all")")
        var reset: [String] = []
        for i in roleList.indices where roleList[i].overridden && (role == nil || roleList[i].role == role) {
            roleList[i].route = roleList[i].defaultRoute
            roleList[i].overridden = false
            reset.append(roleList[i].role)
        }
        return reset
    }
    func listFacts(project: String, status: FactStatus?) async throws -> [Fact] {
        log("listFacts \(project)")
        return factsByRef[project] ?? []
    }
    private func changeFacts(_ ids: [Int64], _ change: (inout Fact) -> Void) -> [Fact] {
        var changed: [Fact] = []
        for (ref, list) in factsByRef {
            factsByRef[ref] = list.map { f in
                var f = f
                if ids.contains(f.id) { change(&f); changed.append(f) }
                return f
            }
        }
        return changed
    }
    func confirmFacts(_ ids: [Int64]) async throws -> [Fact] {
        log("confirmFacts \(ids)")
        return changeFacts(ids) { $0.status = .confirmed }
    }
    func editFact(_ id: Int64, text: String) async throws -> Fact {
        log("editFact \(id) \(text)")
        guard let f = changeFacts([id], { $0.text = text; $0.status = .confirmed; $0.origin = "review_edit" }).first else {
            throw APIError("no fact \(id)")
        }
        return f
    }
    func rejectFacts(_ ids: [Int64]) async throws -> [Fact] {
        log("rejectFacts \(ids)")
        return changeFacts(ids) { $0.status = .rejected }
    }
    func editCv(application id: Int64, line: String, text: String?) async throws -> Application {
        log("editCv \(id) \(line) \(text ?? "-")")
        guard var app = applications[id] else { throw APIError("no application \(id)") }
        if let text, let i = app.cv.summary.firstIndex(where: { $0.handle == line }) {
            app.cv.summary[i].text = text
        } else if text == nil {
            app.cv.summary.removeAll { $0.handle == line }
        }
        app.cv.status = "planned"
        app.cv.clearPdfPath()
        applications[id] = app
        return app
    }
    func listSecrets() async throws -> [String] { log("listSecrets"); return Array(secrets.keys) }
    func deleteSecret(_ name: String) async throws -> Bool {
        log("deleteSecret \(name)")
        if name == "capmonster" { platformList.captchaSolver = false }
        return secrets.removeValue(forKey: name) != nil
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
        try await eventually("disconnected") { store.connection == .disconnected("Applyant's background service isn't running") }
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
        // Back to Inbox takes the skip back without marking it interested.
        await store.backToInbox(posting: 1)
        #expect(daemon.calls.contains("unskip 1"))
        #expect(store.items(.skipped).isEmpty)
        #expect(store.items(.inbox).map(\.postingId) == [1, 2])
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

    @Test func everySectionHasContentAndOnlySettingsIsOnePage() {
        for section in Section.allCases {
            #expect(section.isBuilt, "\(section)")
            #expect(section.isSinglePane == (section == .settings), "\(section)")
        }
        #expect(Section.interview.title == "Questions for you")
        #expect(Section.interviews.title == "Interviews")
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
        #expect(ReviewRules.flagText(s) == "Claims more than its facts say: claims the whole platform")
    }
}
