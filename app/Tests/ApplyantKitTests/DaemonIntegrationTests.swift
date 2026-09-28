// The app's generated Connect client against the real daemon (daemon/src/main.ts on a
// throwaway data dir): unary calls, and WatchEvents streaming over HTTP/1.1. Runs when Node ≥ 24
// and the daemon's node_modules are there; skipped otherwise.
import ApplyantAPI
import Foundation
import Testing
@testable import ApplyantKit

let repoRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
let daemonDir = repoRoot.appendingPathComponent("daemon")

/// `node` from PATH when it's Node 24 or newer.
func node24() -> String? {
    for dir in (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":") {
        let path = "\(dir)/node"
        guard FileManager.default.isExecutableFile(atPath: path) else { continue }
        let (status, out) = runCommand(path, ["--version"])
        if status == 0, let major = Int(out.dropFirst().split(separator: ".").first ?? ""), major >= 24 { return path }
        return nil
    }
    return nil
}

let canRunDaemon = node24() != nil
    && FileManager.default.fileExists(atPath: daemonDir.appendingPathComponent("node_modules").path)

final class RunningDaemon: @unchecked Sendable {
    let home: URL
    let process = Process()

    init(node: String) throws {
        home = FileManager.default.temporaryDirectory.appendingPathComponent("applyant-app-it-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = ["src/main.ts"]
        process.currentDirectoryURL = daemonDir
        var env = ProcessInfo.processInfo.environment
        env["APPLYANT_HOME"] = home.path
        env["APPLYANT_EMBEDDER"] = "hash"
        env["APPLYANT_NATIVE_PATH"] = "off"
        env["APPLYANT_CLAUDE_PATH"] = daemonDir.appendingPathComponent("test/fixtures/bin/claude").path
        env["APPLYANT_CODEX_PATH"] = "/nonexistent/codex"
        env["APPLYANT_JEV_URL"] = "http://127.0.0.1:9/v1/systemone"
        env["APPLYANT_POLL_MS"] = "50"
        env["APPLYANT_NAV_TIMEOUT_MS"] = "3000"
        process.environment = env
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle(forWritingAtPath: "/dev/null")
        try process.run()
    }

    func waitForEndpoint() async throws -> Endpoint {
        for _ in 0..<150 {
            if let e = Endpoint.read(dataDir: home) { return e }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw APIError("the daemon wrote no endpoint")
    }

    func cli(_ args: [String]) -> (Int32, String) {
        let p = Process()
        p.executableURL = process.executableURL
        p.arguments = ["src/cli/index.ts"] + args
        p.currentDirectoryURL = daemonDir
        p.environment = process.environment
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        try? p.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus, String(decoding: data, as: UTF8.self))
    }

    func stop() {
        process.terminate()
        process.waitUntilExit()
        try? FileManager.default.removeItem(at: home)
    }
}

@MainActor
@Suite(.serialized, .enabled(if: canRunDaemon, "needs Node ≥ 24 on PATH and daemon/node_modules"))
struct DaemonIntegrationTests {
    @Test func theStoreConnectsReloadsAndFollowsLiveEvents() async throws {
        let daemon = try RunningDaemon(node: try #require(node24()))
        defer { daemon.stop() }
        _ = try await daemon.waitForEndpoint()

        let store = AppStore(connector: EndpointConnector(dataDir: daemon.home), backoff: { _ in
            try? await Task.sleep(for: .milliseconds(200))
        })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected", timeout: .seconds(15)) { store.connection == .connected }
        #expect(store.postings.isEmpty)

        // A posting added from the CLI reaches the app through the event stream alone.
        let (status, out) = daemon.cli(["jobs", "add", "http://127.0.0.1:9/jobs/42"])
        #expect(status == 0, "\(out)")
        try await eventually("posting from events", timeout: .seconds(20)) { !store.postings.isEmpty }
        let posting = try #require(store.postings.values.first)
        #expect(posting.canonicalURL.contains("127.0.0.1:9/jobs/42"))
        // The verify task's own events follow on the same stream (queued, started, retry…).
        try await eventually("task events", timeout: .seconds(20)) { store.eventsApplied >= 3 }
        #expect(store.reloads == 1)
        #expect(store.connection == .connected)

        await store.openPosting(posting.id)
        #expect(store.postingDetails[posting.id]?.id == posting.id)
        #expect(store.lastError == nil)
    }
}
