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
