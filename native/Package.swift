// swift-tools-version: 6.0
// applyant-native: the Swift helper applyantd runs as a child process (JSON lines over
// stdin/stdout) for what only Apple frameworks can do: PDFKit/AppKit text extraction, the
// Keychain, sleep/wake notifications and on-device email classification (Foundation Models).
import PackageDescription

let package = Package(
    name: "applyant-native",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "applyant-native", targets: ["applyant-native"]),
    ],
    targets: [
        // Everything testable: the protocol, text extraction, the Keychain, the wake observer,
        // the email classifier.
        .target(name: "NativeCore"),
        // The process: the stdin loop, the stdout writer and the run loop wake events need.
        .executableTarget(name: "applyant-native", dependencies: ["NativeCore"]),
        .testTarget(name: "NativeCoreTests", dependencies: ["NativeCore"]),
    ]
)
