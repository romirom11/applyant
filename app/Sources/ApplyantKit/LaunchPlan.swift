// What applyantd (the launcher launchd starts) runs: the bundled Node on the daemon's
// main.ts, with the environment a launchd agent lacks. Its output goes to a log file,
// because a launchd agent has no terminal.
import Foundation

public struct LaunchPlan: Equatable, Sendable {
    public let executable: String
    public let arguments: [String]
    public let environment: [String: String]
    public let log: URL

    public init(layout: BundleLayout, user: UserPaths, env: [String: String]) {
        executable = layout.node.path
        arguments = [layout.node.path, layout.daemonMain.path]
        var e = env
        // Playwright's browsers live with Applyant's data, fetched on first launch.
        if e["PLAYWRIGHT_BROWSERS_PATH"]?.isEmpty ?? true {
            e["PLAYWRIGHT_BROWSERS_PATH"] = user.dataDir(env: env).appendingPathComponent("browsers").path
        }
        e["APPLYANT_INSTALL_BROWSERS"] = "1"
        // launchd gives agents HOME but not always USER/SHELL; the daemon copes (cli-paths.ts).
        if e["HOME"]?.isEmpty ?? true { e["HOME"] = user.home.path }
        environment = e
        // APPLYANT_LOG_FILE: somewhere else (the bundle smoke test keeps the real log clean).
        log = env["APPLYANT_LOG_FILE"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) } ?? user.daemonLog
    }
}

/// Keeps one previous log: at `maxBytes` the log becomes `<name>.1`.
public func rotateLog(_ url: URL, maxBytes: Int = 10 << 20) {
    let fm = FileManager.default
    guard let size = (try? fm.attributesOfItem(atPath: url.path))?[.size] as? Int, size >= maxBytes else { return }
    let old = url.appendingPathExtension("1")
    try? fm.removeItem(at: old)
    try? fm.moveItem(at: url, to: old)
}
