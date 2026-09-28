// swift-tools-version: 6.0
// Applyant.app's own code. scripts/bundle.sh assembles the bundle from these products, the
// bundled Node, the daemon and applyant-native (native/).
import PackageDescription

let package = Package(
    name: "Applyant",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Applyant", targets: ["Applyant"]),
        .executable(name: "applyantd", targets: ["applyantd"]),
    ],
    targets: [
        // Everything testable: bundle paths, the daemon's endpoint and status, registration.
        .target(name: "ApplyantKit"),
        // The menu bar app (8a: daemon status only).
        .executableTarget(name: "Applyant", dependencies: ["ApplyantKit"]),
        // What launchd starts: a signed Mach-O that execs the bundled Node on the daemon.
        .executableTarget(name: "applyantd", dependencies: ["ApplyantKit"]),
        .testTarget(name: "ApplyantKitTests", dependencies: ["ApplyantKit"]),
    ]
)
