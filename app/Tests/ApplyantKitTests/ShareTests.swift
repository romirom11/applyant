import Foundation
import Testing
@testable import ApplyantKit

private struct FailingTransport: HTTPTransport {
    func post(_ request: URLRequest) async throws -> (Data, Int) { throw URLError(.cannotConnectToHost) }
}

private func writeEndpoint(_ dir: URL, _ json: String) throws {
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try Data(json.utf8).write(to: dir.appendingPathComponent("endpoint.json"))
}

@Suite struct ShareTokenTests {
    @Test func readsTheDaemonsEndpointUnderTheRealHome() throws {
        let home = URL(fileURLWithPath: "/Users/me")
        // The daemon's darwin default, whatever APPLYANT_HOME or the sandbox's HOME say.
        #expect(ShareEndpoint.candidates(home: home).map(\.path) == ["/Users/me/Library/Application Support/Applyant"])
        // getpwuid, not the container HOME a sandboxed extension gets.
        #expect(!ShareEndpoint.realHome().path.contains("/Library/Containers/"))
    }

    @Test func tokenReadSkipsMissingAndBrokenFiles() throws {
        let root = try tempDir()
        defer { try? FileManager.default.removeItem(at: root) }
        let missing = root.appendingPathComponent("missing")
        let broken = root.appendingPathComponent("broken")
        let empty = root.appendingPathComponent("empty-token")
        let good = root.appendingPathComponent("good")
        try writeEndpoint(broken, "{not json")
        try writeEndpoint(empty, #"{"version":1,"host":"127.0.0.1","port":5555,"token":"","pid":1}"#)
        try writeEndpoint(good, #"{"version":1,"host":"127.0.0.1","port":6123,"token":"secret","pid":4242}"#)

        #expect(ShareEndpoint.read(dirs: [missing, broken, empty]) == nil)
        let endpoint = try #require(ShareEndpoint.read(dirs: [missing, broken, empty, good]))
        #expect(endpoint.port == 6123 && endpoint.token == "secret" && endpoint.host == "127.0.0.1")
    }

    @Test func addsTheSharedURLWithTheToken() async throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try writeEndpoint(dir, #"{"version":1,"host":"127.0.0.1","port":6123,"token":"secret","pid":4242}"#)
        let seen = Box<URLRequest?>(nil)
        let created = #"{"posting":{"id":"7","stage":"POSTING_STAGE_FOUND","canonicalUrl":"https://jobs.example/1","title":"Backend Engineer","company":"Acme"},"created":true}"#
        let client = ShareClient(dirs: [dir], transport: FakeTransport(body: created, code: 200, seen: seen))
        let outcome = await client.add(URL(string: "https://jobs.example/1?utm_source=x")!)
        #expect(outcome == .added(title: "Backend Engineer", company: "Acme"))
        #expect(outcome.detail.hasPrefix("Backend Engineer at Acme"))

        let request = try #require(seen.value)
        #expect(request.url?.absoluteString == "http://127.0.0.1:6123/applyant.v1.ApplyantService/AddPosting")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer secret")
        #expect(request.httpMethod == "POST")
        let body = try #require(request.httpBody)
        let sent = try #require(try JSONSerialization.jsonObject(with: body) as? [String: String])
        #expect(sent == ["url": "https://jobs.example/1?utm_source=x"])
    }

    @Test func saysWhatHappened() async throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try writeEndpoint(dir, #"{"version":1,"host":"127.0.0.1","port":6123,"token":"secret","pid":4242}"#)
        let seen = Box<URLRequest?>(nil)
        let url = URL(string: "https://jobs.example/1")!

        let known = #"{"posting":{"id":"7","stage":"POSTING_STAGE_FAILED_VERIFICATION","title":"Backend Engineer"}}"#
        let knownOutcome = await ShareClient(dirs: [dir], transport: FakeTransport(body: known, code: 200, seen: seen)).add(url)
        #expect(knownOutcome == .alreadyKnown(title: "Backend Engineer", company: nil, stage: "failed verification"))

        let invalid = #"{"code":"invalid_argument","message":"not an http(s) URL"}"#
        #expect(await ShareClient(dirs: [dir], transport: FakeTransport(body: invalid, code: 400, seen: seen)).add(url)
            == .refused("not an http(s) URL"))
        guard case .refused = await ShareClient(dirs: [dir], transport: FakeTransport(body: "", code: 401, seen: seen)).add(url) else {
            Issue.record("a refused token should say so")
            return
        }
        // A stale endpoint.json: nothing listens on its port.
        #expect(await ShareClient(dirs: [dir], transport: FailingTransport()).add(url) == .notRunning)
        // No endpoint.json at all.
        #expect(await ShareClient(dirs: [dir.appendingPathComponent("nope")], transport: FailingTransport()).add(url) == .notRunning)
        #expect(await ShareClient(dirs: [dir], transport: FailingTransport()).add(URL(fileURLWithPath: "/tmp/x")) == .noURL)
    }

    @Test func findsTheLinkInSharedText() {
        #expect(ShareClient.firstWebURL(in: "Look at this: https://boards.greenhouse.io/acme/jobs/1 (remote)")?.absoluteString
            == "https://boards.greenhouse.io/acme/jobs/1")
        #expect(ShareClient.firstWebURL(in: "no link here") == nil)
    }
}
