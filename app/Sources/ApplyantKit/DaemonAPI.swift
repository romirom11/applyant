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
    private let unary: Applyant_V1_ApplyantServiceClient
    private let streaming: Applyant_V1_ApplyantServiceClient
    private let headers: Headers

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
