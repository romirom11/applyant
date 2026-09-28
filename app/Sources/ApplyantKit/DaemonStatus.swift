// Is the daemon up, and what does GetSetupStatus say? The daemon writes {host, port, token,
// pid} to endpoint.json in its data directory; the app calls the Connect API with plain
// HTTP + JSON (connect-swift arrives with the full client in 8b).
import Foundation

public struct Endpoint: Decodable, Equatable, Sendable {
    public let host: String
    public let port: Int
    public let token: String
    public let pid: Int32

    public static func read(dataDir: URL) -> Endpoint? {
        guard let data = try? Data(contentsOf: dataDir.appendingPathComponent("endpoint.json")) else { return nil }
        return try? JSONDecoder().decode(Endpoint.self, from: data)
    }
}

/// proto3 JSON of applyant.v1.ToolStatus: false/empty fields are left out.
public struct ToolStatus: Decodable, Equatable, Sendable {
    public var found: Bool = false
    public var path: String = ""
    public var foundVia: String = ""
    public var version: String = ""
    public var signedIn: Bool = false
    public var error: String = ""

    enum CodingKeys: String, CodingKey { case found, path, foundVia, version, signedIn, error }

    public init() {}

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        found = try c.decodeIfPresent(Bool.self, forKey: .found) ?? false
        path = try c.decodeIfPresent(String.self, forKey: .path) ?? ""
        foundVia = try c.decodeIfPresent(String.self, forKey: .foundVia) ?? ""
        version = try c.decodeIfPresent(String.self, forKey: .version) ?? ""
        signedIn = try c.decodeIfPresent(Bool.self, forKey: .signedIn) ?? false
        error = try c.decodeIfPresent(String.self, forKey: .error) ?? ""
    }

    /// Found, runs and is signed in.
    public var ready: Bool { found && signedIn && error.isEmpty }
}

/// proto3 JSON of applyant.v1.SetupStatus (int64 comes as a string).
public struct SetupStatus: Decodable, Equatable, Sendable {
    public var claude = ToolStatus()
    public var codex = ToolStatus()
    public var nativeHelper = false
    public var secretsBackend = ""
    public var pid = ""
    public var home = ""
    public var startedAt = ""

    enum CodingKeys: String, CodingKey { case claude, codex, nativeHelper, secretsBackend, pid, home, startedAt }

    public init() {}

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        claude = try c.decodeIfPresent(ToolStatus.self, forKey: .claude) ?? ToolStatus()
        codex = try c.decodeIfPresent(ToolStatus.self, forKey: .codex) ?? ToolStatus()
        nativeHelper = try c.decodeIfPresent(Bool.self, forKey: .nativeHelper) ?? false
        secretsBackend = try c.decodeIfPresent(String.self, forKey: .secretsBackend) ?? ""
        pid = try c.decodeIfPresent(String.self, forKey: .pid) ?? ""
        home = try c.decodeIfPresent(String.self, forKey: .home) ?? ""
        startedAt = try c.decodeIfPresent(String.self, forKey: .startedAt) ?? ""
    }
}

struct GetSetupStatusResponse: Decodable {
    var status: SetupStatus?
}

public enum DaemonState: Equatable, Sendable {
    case running(SetupStatus)
    /// No endpoint file, or its process is gone.
    case stopped
    /// It has an endpoint but didn't answer (starting, stuck, or the token is stale).
    case unreachable(String)
}

public protocol HTTPTransport: Sendable {
    func post(_ request: URLRequest) async throws -> (Data, Int)
}

public struct URLSessionTransport: HTTPTransport {
    public init() {}
    public func post(_ request: URLRequest) async throws -> (Data, Int) {
        let (data, response) = try await URLSession.shared.data(for: request)
        return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    }
}

public struct DaemonClient: Sendable {
    public let dataDir: URL
    let transport: HTTPTransport
    let isAlive: @Sendable (Int32) -> Bool

    public init(
        dataDir: URL,
        transport: HTTPTransport = URLSessionTransport(),
        isAlive: @escaping @Sendable (Int32) -> Bool = { kill($0, 0) == 0 || errno == EPERM }
    ) {
        self.dataDir = dataDir
        self.transport = transport
        self.isAlive = isAlive
    }

    public func state() async -> DaemonState {
        guard let endpoint = Endpoint.read(dataDir: dataDir), isAlive(endpoint.pid) else { return .stopped }
        var request = URLRequest(
            url: URL(string: "http://\(endpoint.host):\(endpoint.port)/applyant.v1.ApplyantService/GetSetupStatus")!
        )
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(endpoint.token)", forHTTPHeaderField: "Authorization")
        request.httpBody = Data("{}".utf8)
        do {
            let (data, code) = try await transport.post(request)
            guard code == 200 else { return .unreachable("HTTP \(code)") }
            let response = try JSONDecoder().decode(GetSetupStatusResponse.self, from: data)
            return .running(response.status ?? SetupStatus())
        } catch {
            return .unreachable(error.localizedDescription)
        }
    }
}
