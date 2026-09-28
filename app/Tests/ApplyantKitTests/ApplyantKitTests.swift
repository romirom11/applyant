import Foundation
import Testing
@testable import ApplyantKit

func tempDir() throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("applyant-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

@Suite struct LayoutTests {
    @Test func findsEverythingFromAnyExecutableInTheBundle() {
        let exe = URL(fileURLWithPath: "/Applications/Applyant.app/Contents/MacOS/applyantd")
        let layout = BundleLayout(executable: exe)
        #expect(layout.contents.path == "/Applications/Applyant.app/Contents")
        #expect(layout.node.path == "/Applications/Applyant.app/Contents/Resources/node/bin/node")
        #expect(layout.daemonMain.path == "/Applications/Applyant.app/Contents/Resources/daemon/src/main.ts")
        #expect(layout.nativeHelper.path == "/Applications/Applyant.app/Contents/Helpers/applyant-native")
        #expect(BundleLayout(executable: layout.nativeHelper) == layout)
    }

    @Test func dataDirIsTheDaemonsDarwinDefault() {
        let user = UserPaths(home: URL(fileURLWithPath: "/Users/me"))
        #expect(user.dataDir(env: [:]).path == "/Users/me/Library/Application Support/Applyant")
        #expect(user.dataDir(env: ["APPLYANT_HOME": "/tmp/a"]).path == "/tmp/a")
        #expect(user.daemonLog.path == "/Users/me/Library/Logs/Applyant/applyantd.log")
    }

    @Test func launchPlanRunsTheBundledNodeWithWhatLaunchdLacks() {
        let layout = BundleLayout(contents: URL(fileURLWithPath: "/A.app/Contents"))
        let user = UserPaths(home: URL(fileURLWithPath: "/Users/me"))
        let plan = LaunchPlan(layout: layout, user: user, env: ["PATH": "/usr/bin:/bin"])
        #expect(plan.executable == "/A.app/Contents/Resources/node/bin/node")
        #expect(plan.arguments == [plan.executable, "/A.app/Contents/Resources/daemon/src/main.ts"])
        #expect(plan.environment["PLAYWRIGHT_BROWSERS_PATH"] == "/Users/me/Library/Application Support/Applyant/browsers")
        #expect(plan.environment["APPLYANT_INSTALL_BROWSERS"] == "1")
        #expect(plan.environment["HOME"] == "/Users/me")
        #expect(plan.environment["PATH"] == "/usr/bin:/bin")
        let custom = LaunchPlan(layout: layout, user: user, env: ["PLAYWRIGHT_BROWSERS_PATH": "/x", "HOME": "/h"])
        #expect(custom.environment["PLAYWRIGHT_BROWSERS_PATH"] == "/x")
        #expect(custom.environment["HOME"] == "/h")
        #expect(plan.log == user.daemonLog)
        #expect(LaunchPlan(layout: layout, user: user, env: ["APPLYANT_LOG_FILE": "/tmp/d.log"]).log.path == "/tmp/d.log")
    }

    @Test func rotatesTheLogAtTheLimit() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let log = dir.appendingPathComponent("applyantd.log")
        try Data(count: 10).write(to: log)
        rotateLog(log, maxBytes: 100)
        #expect(FileManager.default.fileExists(atPath: log.path))
        try Data(count: 200).write(to: log)
        rotateLog(log, maxBytes: 100)
        #expect(!FileManager.default.fileExists(atPath: log.path))
        #expect(FileManager.default.fileExists(atPath: log.path + ".1"))
    }
}

/// What the daemon sends for GetSetupStatus (proto3 JSON: int64 as strings, false and
/// empty fields left out).
let sampleStatus = """
{"status":{"claude":{"found":true,"path":"/Users/me/.local/bin/claude","foundVia":"dir",
"version":"2.1.283 (Claude Code)","signedIn":true},
"codex":{"error":"`codex` not found: checked APPLYANT_CODEX_PATH (unset)"},
"nativeHelper":true,"secretsBackend":"keychain","pid":"4242",
"home":"/Users/me/Library/Application Support/Applyant","startedAt":"2026-09-28T15:00:00Z",
"checkedAt":"2026-09-28T15:00:01Z"}}
"""

struct FakeTransport: HTTPTransport {
    let body: String
    let code: Int
    let seen: Box<URLRequest?>
    func post(_ request: URLRequest) async throws -> (Data, Int) {
        seen.value = request
        return (Data(body.utf8), code)
    }
}

final class Box<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}

@Suite struct DaemonStatusTests {
    @Test func decodesTheProtoJson() throws {
        let status = try #require(try JSONDecoder().decode(GetSetupStatusResponse.self, from: Data(sampleStatus.utf8)).status)
        #expect(status.claude.ready)
        #expect(status.claude.foundVia == "dir")
        #expect(!status.codex.found && !status.codex.signedIn)
        #expect(status.codex.error.hasPrefix("`codex` not found"))
        #expect(status.pid == "4242")
        #expect(status.nativeHelper && status.secretsBackend == "keychain")
    }

    @Test func callsGetSetupStatusWithTheEndpointToken() async throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let endpoint = #"{"version":1,"host":"127.0.0.1","port":5555,"token":"tok","pid":4242}"#
        try Data(endpoint.utf8).write(to: dir.appendingPathComponent("endpoint.json"))
        let seen = Box<URLRequest?>(nil)
        let client = DaemonClient(dataDir: dir, transport: FakeTransport(body: sampleStatus, code: 200, seen: seen)) { $0 == 4242 }
        guard case let .running(status) = await client.state() else {
            Issue.record("not running")
            return
        }
        #expect(status.pid == "4242")
        let request = try #require(seen.value)
        #expect(request.url?.absoluteString == "http://127.0.0.1:5555/applyant.v1.ApplyantService/GetSetupStatus")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
        #expect(request.httpMethod == "POST")

        let unauthorized = DaemonClient(dataDir: dir, transport: FakeTransport(body: "", code: 401, seen: seen)) { _ in true }
        #expect(await unauthorized.state() == .unreachable("HTTP 401"))
        let dead = DaemonClient(dataDir: dir, transport: FakeTransport(body: sampleStatus, code: 200, seen: seen)) { _ in false }
        #expect(await dead.state() == .stopped)
        let none = DaemonClient(dataDir: dir.appendingPathComponent("nope")) { _ in true }
        #expect(await none.state() == .stopped)
    }

    @Test func menuLinesSayWhatIsWrong() throws {
        let status = try #require(try JSONDecoder().decode(GetSetupStatusResponse.self, from: Data(sampleStatus.utf8)).status)
        let view = StatusView(.running(status))
        #expect(view.health == .ok)
        #expect(view.title == "Daemon running (pid 4242)")
        #expect(view.lines == [
            "claude: ✓ 2.1.283 · /Users/me/.local/bin/claude",
            "codex: ✗ not found",
            "Secrets: keychain · native helper ✓",
        ])
        var signedOut = status
        signedOut.claude.signedIn = false
        #expect(StatusView(.running(signedOut)).health == .warning)
        #expect(StatusView(.stopped).health == .down)
        #expect(StatusView(.stopped).symbol == "briefcase")
    }
}

@Suite struct RegistrationTests {
    @Test func theAgentRunsTheLauncherAndIsKeptAlive() throws {
        let program = URL(fileURLWithPath: "/Applications/Applyant.app/Contents/MacOS/applyantd")
        let plist = try #require(
            try PropertyListSerialization.propertyList(from: launchAgentPlist(program: program), format: nil)
                as? [String: Any]
        )
        #expect(plist["Label"] as? String == Identity.daemonLabel)
        #expect(plist["Program"] as? String == program.path)
        #expect(plist["KeepAlive"] as? Bool == true)
        #expect(plist["RunAtLoad"] as? Bool == true)
        #expect(plist["AssociatedBundleIdentifiers"] as? [String] == [Identity.appBundleId])
    }

    @Test func installWritesThePlistAndBootstrapsIt() throws {
        let home = try tempDir()
        defer { try? FileManager.default.removeItem(at: home) }
        let calls = Box<[[String]]>([])
        let loaded = Box(false)
        let run: RunCommand = { _, args in
            calls.value.append(args)
            switch args.first {
            case "print": return (loaded.value ? 0 : 113, "")
            case "bootstrap":
                loaded.value = true
                return (0, "")
            default: return (0, "")
            }
        }
        let user = UserPaths(home: home)
        let layout = BundleLayout(contents: URL(fileURLWithPath: "/Applications/Applyant.app/Contents"))
        let agent = LaunchctlAgent(user: user, layout: layout, run: run, uid: 501)
        #expect(!agent.installed)
        #expect(agent.install() == .launchAgentFile)
        #expect(agent.installed)
        #expect(calls.value.contains(["bootstrap", "gui/501", user.userAgentPlist.path]))
        // Again: already loaded and unchanged, so launchd is left alone.
        calls.value = []
        #expect(agent.install() == .launchAgentFile)
        #expect(calls.value.allSatisfy { $0.first == "print" })
        // The app moved: the old agent is booted out and the new plist bootstrapped.
        let moved = LaunchctlAgent(
            user: user,
            layout: BundleLayout(contents: URL(fileURLWithPath: "/Users/me/Applications/Applyant.app/Contents")),
            run: run,
            uid: 501
        )
        #expect(moved.install() == .launchAgentFile)
        #expect(calls.value.contains(["bootout", "gui/501/com.applyant.daemon"]))
        let written = try String(contentsOf: user.userAgentPlist, encoding: .utf8)
        #expect(written.contains("/Users/me/Applications/Applyant.app/Contents/MacOS/applyantd"))
    }
}
