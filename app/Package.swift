// swift-tools-version: 6.0
// Applyant.app's own code. scripts/bundle.sh assembles the bundle from these products, the
// bundled Node, the daemon and applyant-native (native/).
import PackageDescription

let package = Package(
    name: "Applyant",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "Applyant", targets: ["Applyant"]),
        .executable(name: "applyantd", targets: ["applyantd"]),
        .executable(name: "ApplyantShare", targets: ["ApplyantShare"]),
    ],
    dependencies: [
        // Pinned to the versions of the hosted buf plugins in buf.gen.yaml.
        .package(url: "https://github.com/connectrpc/connect-swift.git", exact: "1.2.3"),
        .package(url: "https://github.com/apple/swift-protobuf.git", exact: "1.38.1"),
    ],
    targets: [
        // Generated from proto/applyant/v1/applyant.proto by `buf generate` (don't edit).
        .target(
            name: "ApplyantAPI",
            dependencies: [
                .product(name: "Connect", package: "connect-swift"),
                .product(name: "SwiftProtobuf", package: "swift-protobuf"),
            ],
            path: "Generated",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // Everything testable: the store, the daemon connection, bundle paths, registration.
        .target(
            name: "ApplyantKit",
            dependencies: [
                "ApplyantAPI",
                .product(name: "Connect", package: "connect-swift"),
            ]
        ),
        // The app: menu bar and main window.
        .executableTarget(name: "Applyant", dependencies: ["ApplyantKit", "ApplyantAPI"]),
        // What launchd starts: a signed Mach-O that execs the bundled Node on the daemon.
        .executableTarget(name: "applyantd", dependencies: ["ApplyantKit"]),
        // The Share extension's executable; scripts/bundle.sh wraps it in PlugIns/ApplyantShare.appex.
        .executableTarget(name: "ApplyantShare", dependencies: ["ApplyantKit"]),
        .testTarget(name: "ApplyantKitTests", dependencies: ["ApplyantKit", "ApplyantAPI"]),
    ]
)
