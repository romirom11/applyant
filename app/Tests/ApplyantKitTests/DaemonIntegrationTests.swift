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

    /// The Share extension's request (16b): the daemon's own endpoint.json and AddPosting.
    @Test func theShareExtensionAddsAPostingOnce() async throws {
        let daemon = try RunningDaemon(node: try #require(node24()))
        defer { daemon.stop() }
        _ = try await daemon.waitForEndpoint()

        let share = ShareClient(dirs: [daemon.home])
        let url = URL(string: "http://127.0.0.1:9/jobs/share-1")!
        #expect(await share.add(url) == .added(title: nil, company: nil))
        guard case let .alreadyKnown(_, _, stage) = await share.add(url) else {
            Issue.record("the second share should find the posting")
            return
        }
        #expect(["found", "failed verification"].contains(stage))
        guard case .refused = await share.add(URL(string: "https://")!) else {
            Issue.record("the daemon should refuse a URL without a host")
            return
        }
        let (status, out) = daemon.cli(["jobs", "list"])
        #expect(status == 0 && out.contains("127.0.0.1:9/jobs/share-1"), "\(out)")
    }

    /// Settings → Mailbox over the wire (13): nothing is opened, so Google is never contacted.
    @Test func theMailboxConnectsAndDisconnectsOverTheWire() async throws {
        let daemon = try RunningDaemon(node: try #require(node24()))
        defer { daemon.stop() }
        let api = ConnectDaemonAPI(endpoint: try await daemon.waitForEndpoint())

        let empty = try await api.mailboxSetup()
        #expect(!empty.hasMailbox && !empty.googleClientSecretStored)
        #expect(try await api.disconnectMailbox() == false)

        // IMAP without a password is refused before any server is contacted.
        await #expect(throws: APIError.self) {
            _ = try await api.connectImap(address: "me@example.org", settings: .with {
                $0.imapHost = "127.0.0.1"
                $0.smtpHost = "127.0.0.1"
            })
        }

        let started = try await api.connectGmail(clientId: "it.apps.googleusercontent.com", clientSecret: "it-secret")
        let url = try #require(URLComponents(string: started.authURL))
        #expect(url.host == "accounts.google.com")
        #expect(url.queryItems?.first { $0.name == "client_id" }?.value == "it.apps.googleusercontent.com")
        #expect(url.queryItems?.first { $0.name == "redirect_uri" }?.value?.hasPrefix("http://127.0.0.1:") == true)
        #expect(started.mailbox.status == "connecting" && started.mailbox.clientID == "it.apps.googleusercontent.com")
        let setup = try await api.mailboxSetup()
        #expect(setup.googleClientSecretStored && setup.googleClientID == "it.apps.googleusercontent.com")
        #expect(!(try setup.serializedData()).contains(Data("it-secret".utf8)))

        #expect(try await api.disconnectMailbox())
        let after = try await api.mailboxSetup()
        #expect(!after.hasMailbox && after.googleClientSecretStored)
    }

    /// Profile, projects, preferences and strategies from the app over the wire (16). No source
    /// is added and the strategy stays paused, so nothing is read or searched.
    @Test func setupEditsGoOverTheWire() async throws {
        let daemon = try RunningDaemon(node: try #require(node24()))
        defer { daemon.stop() }
        let api = ConnectDaemonAPI(endpoint: try await daemon.waitForEndpoint())

        try await api.setProfileValue("full_name", value: "Roman Kudin")
        try await api.setProfileValue("commit_emails", value: "me@example.com, me@work.com")
        await #expect(throws: APIError.self) { try await api.setProfileValue("email", value: "nope") }
        let profile = try await api.candidate().profile
        #expect(profile.first { $0.key == "commit_emails" }?.values == ["me@example.com", "me@work.com"])

        let p = try await api.createProject(name: "Solovei")
        let renamed = try await api.renameProject(String(p.id), name: "Solovei Voice")
        #expect(renamed.name == "Solovei Voice" && renamed.slug == p.slug)
        #expect(try await api.project(p.slug).sources.isEmpty)
        #expect(try await api.syncSources(String(p.id), force: false) == 0)
        await #expect(throws: APIError.self) { _ = try await api.syncSources("source:999", force: false) }
        try await api.deleteProject(String(p.id))
        #expect(try await api.candidate().projects.isEmpty)

        try await api.setPreference("dealbreakers", value: "outstaffing,onsite")
        try await api.setPreference("weight.salary", value: "20")
        let prefs = try await api.getPreferences()
        #expect(prefs.dealbreakers == ["outstaffing", "onsite"] && prefs.weights["salary"] == 20)

        var form = StrategyForm()
        form.name = "AI Engineer"
        form.queries = "ai engineer"
        form.remote = true
        form.paused = true
        let added = try await api.addStrategy(form.addRequest)
        #expect(added.state == "paused" && added.locations == ["remote"])
        form.name = "AI / LLM Engineer"
        form.queries = ""
        let updated = try await api.updateStrategy(form.updateRequest(added.id))
        #expect(updated.name == "AI / LLM Engineer" && updated.queries.isEmpty && updated.state == "paused")
        try await api.deleteStrategy(added.id)
        #expect(try await api.listSearch().strategies.allSatisfy { $0.id != added.id })
    }
}
