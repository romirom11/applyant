// Where things are: inside Applyant.app, and in the candidate's Library.
//
//   Applyant.app/Contents/
//   ├── MacOS/Applyant · MacOS/applyantd
//   ├── Resources/node/bin/node · Resources/daemon/src/main.ts · Resources/bin/applyant
//   ├── Helpers/applyant-native
//   └── Library/LaunchAgents/com.applyant.daemon.plist
import Foundation

public enum Identity {
    public static let appBundleId = "com.applyant.app"
    public static let daemonLabel = "com.applyant.daemon"
    public static let daemonPlist = "com.applyant.daemon.plist"
}

public struct BundleLayout: Equatable, Sendable {
    /// …/Applyant.app/Contents
    public let contents: URL

    public init(contents: URL) {
        self.contents = contents.standardizedFileURL
    }

    /// From any executable in Contents/MacOS or Contents/Helpers.
    public init(executable: URL) {
        self.init(contents: executable.resolvingSymlinksInPath().deletingLastPathComponent().deletingLastPathComponent())
    }

    public var node: URL { contents.appendingPathComponent("Resources/node/bin/node") }
    public var daemonMain: URL { contents.appendingPathComponent("Resources/daemon/src/main.ts") }
    public var launcher: URL { contents.appendingPathComponent("MacOS/applyantd") }
    public var cli: URL { contents.appendingPathComponent("Resources/bin/applyant") }
    public var nativeHelper: URL { contents.appendingPathComponent("Helpers/applyant-native") }
}

public struct UserPaths: Equatable, Sendable {
    public let home: URL

    public init(home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        self.home = home
    }

    /// The daemon's data directory (daemon/src/config.ts's darwin default), unless APPLYANT_HOME.
    public func dataDir(env: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let custom = env["APPLYANT_HOME"], !custom.isEmpty { return URL(fileURLWithPath: custom) }
        return home.appendingPathComponent("Library/Application Support/Applyant")
    }

    public var logsDir: URL { home.appendingPathComponent("Library/Logs/Applyant") }
    public var daemonLog: URL { logsDir.appendingPathComponent("applyantd.log") }
    /// The fallback registration's plist, when SMAppService refuses the ad-hoc signed app.
    public var userAgentPlist: URL {
        home.appendingPathComponent("Library/LaunchAgents/\(Identity.daemonPlist)")
    }
}
