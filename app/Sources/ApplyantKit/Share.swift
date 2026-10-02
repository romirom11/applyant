// The Share extension's side of the daemon: find the endpoint, send the shared URL to
// AddPosting, and say what happened. The extension (Sources/ApplyantShare) is only the UI.
//
// The extension is sandboxed, so it can't read the daemon's data directory by default, and
// FileManager's home directory is its own container. It reads the same endpoint.json the app
// and the CLI read, through a read-only temporary-exception entitlement on exactly that file
// (app/Bundle/ShareExtension.entitlements), under the user's real home from getpwuid. An App
// Group container would need a Team ID: ad-hoc signed claims aren't authorised on macOS 15+
// (see the 16b notes in the structure outline).
import Foundation

public enum ShareEndpoint {
    /// The account's real home, not the sandbox container `HOME` points to.
    public static func realHome() -> URL {
        if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir {
            return URL(fileURLWithPath: String(cString: dir), isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
    }

    /// Where the extension looks, in order: the daemon's darwin default data directory.
    /// (APPLYANT_HOME isn't visible to an extension, and a custom home isn't in its sandbox.)
    public static func candidates(home: URL = realHome()) -> [URL] {
        [UserPaths(home: home).dataDir(env: [:])]
    }

    /// The first readable, well-formed endpoint.json among `dirs`.
    public static func read(dirs: [URL]) -> Endpoint? {
        for dir in dirs {
            if let endpoint = Endpoint.read(dataDir: dir), !endpoint.token.isEmpty, endpoint.port > 0 {
                return endpoint
            }
        }
        return nil
    }
}

/// What the confirmation says.
public enum ShareOutcome: Equatable, Sendable {
    case added(title: String?, company: String?)
    case alreadyKnown(title: String?, company: String?, stage: String)
    /// No endpoint file, or nothing listening on it.
    case notRunning
    /// The daemon refused it (not a job URL, bad token…).
    case refused(String)
    case noURL

    public var headline: String {
        switch self {
        case .added: "Added to Applyant"
        case .alreadyKnown: "Already in Applyant"
        case .notRunning: "Applyant isn't running"
        case .refused: "Couldn't add it"
        case .noURL: "Nothing to add"
        }
    }

    public var detail: String {
        switch self {
        case let .added(title, company):
            return [Self.describe(title, company), "It will be checked and scored like any other posting."]
                .compactMap { $0 }.joined(separator: "\n")
        case let .alreadyKnown(title, company, stage):
            return [Self.describe(title, company), "Stage: \(stage)."].compactMap { $0 }.joined(separator: "\n")
        case .notRunning:
            return "Open Applyant so its service starts, then share the page again."
        case let .refused(message):
            return message
        case .noURL:
            return "Share a page's link (Safari, Chrome), not its text."
        }
    }

    static func describe(_ title: String?, _ company: String?) -> String? {
        switch (title?.nilIfBlank, company?.nilIfBlank) {
        case let (t?, c?): "\(t) at \(c)"
        case let (t?, nil): t
        case let (nil, c?): c
        default: nil
        }
    }
}

extension String {
    var nilIfBlank: String? { trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : self }
}

/// proto3 JSON of AddPostingResponse (only the fields the confirmation shows).
struct AddPostingReply: Decodable {
    struct Posting: Decodable {
        var stage: String?
        var title: String?
        var company: String?
        var canonicalUrl: String?
    }

    var posting: Posting?
    var created: Bool?
}

/// A Connect error body: {"code": "invalid_argument", "message": "…"}.
struct ConnectErrorBody: Decodable {
    var code: String?
    var message: String?
}

public struct ShareClient: Sendable {
    let dirs: [URL]
    let transport: HTTPTransport

    public init(dirs: [URL] = ShareEndpoint.candidates(), transport: HTTPTransport = URLSessionTransport()) {
        self.dirs = dirs
        self.transport = transport
    }

    /// Sends the URL to AddPosting: the same `found` flow as `applyant jobs add`.
    public func add(_ url: URL) async -> ShareOutcome {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return .noURL }
        guard let endpoint = ShareEndpoint.read(dirs: dirs),
              let target = URL(string: "http://\(endpoint.host):\(endpoint.port)/applyant.v1.ApplyantService/AddPosting")
        else { return .notRunning }
        var request = URLRequest(url: target)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(endpoint.token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["url": url.absoluteString])
        let data: Data
        let code: Int
        do {
            (data, code) = try await transport.post(request)
        } catch {
            // A stale endpoint.json after a crash: nothing listens on the port.
            return .notRunning
        }
        guard code == 200 else {
            let body = try? JSONDecoder().decode(ConnectErrorBody.self, from: data)
            if code == 401 { return .refused("Applyant didn't accept the extension's token. Restart Applyant and try again.") }
            return .refused(body?.message?.nilIfBlank ?? "HTTP \(code)")
        }
        guard let reply = try? JSONDecoder().decode(AddPostingReply.self, from: data) else {
            return .refused("Unexpected answer from Applyant.")
        }
        let posting = reply.posting
        if reply.created == true { return .added(title: posting?.title, company: posting?.company) }
        return .alreadyKnown(title: posting?.title, company: posting?.company, stage: Self.stageName(posting?.stage))
    }

    static func stageName(_ raw: String?) -> String {
        guard let raw, raw.hasPrefix("POSTING_STAGE_") else { return "found" }
        return raw.dropFirst("POSTING_STAGE_".count).lowercased().replacingOccurrences(of: "_", with: " ")
    }

    /// The first web URL in what Safari/Chrome shared: a URL item, or a link inside text.
    public static func firstWebURL(in text: String) -> URL? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        for match in detector.matches(in: text, range: range) {
            if let url = match.url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" {
                return url
            }
        }
        return nil
    }
}
