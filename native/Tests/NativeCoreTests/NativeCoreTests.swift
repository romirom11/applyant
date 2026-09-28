import AppKit
import Foundation
import Testing
@testable import NativeCore

/// The fixture CV the daemon's pdfjs tests use (daemon/test/fixtures/cv).
let fixtureCV = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent()
    .appendingPathComponent("daemon/test/fixtures/cv/cv.pdf")

func json(_ line: String) throws -> [String: Any] {
    try #require(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
}

@Suite struct ProtocolTests {
    let dispatcher = Dispatcher(keychain: Keychain(service: "com.applyant.test.protocol"))

    @Test func pingAnswersWithTheRequestId() throws {
        let answer = try json(dispatcher.handle(line: #"{"id": 7, "op": "ping"}"#))
        #expect(answer["id"] as? Int == 7)
        #expect(answer["ok"] as? Bool == true)
        let result = try #require(answer["result"] as? [String: Any])
        #expect(result["version"] as? String == helperVersion)
    }

    @Test func badRequestsGetAnErrorNotACrash() throws {
        let garbage = try json(dispatcher.handle(line: "not json"))
        #expect(garbage["ok"] as? Bool == false)
        #expect(garbage["id"] is NSNull)
        let unknown = try json(dispatcher.handle(line: #"{"id": 1, "op": "format_disk"}"#))
        #expect(unknown["error"] as? String == "unknown op format_disk")
        let missing = try json(dispatcher.handle(line: #"{"id": 2, "op": "keychain_get"}"#))
        #expect(missing["error"] as? String == "name is missing")
    }

    @Test func extractTextOverTheProtocol() throws {
        let line = try String(
            data: JSONSerialization.data(withJSONObject: ["id": 3, "op": "extract_text", "path": fixtureCV.path]),
            encoding: .utf8
        )!
        let answer = try json(dispatcher.handle(line: line))
        let result = try #require(answer["result"] as? [String: Any])
        let pages = try #require(result["pages"] as? [String])
        #expect(pages.count == 2)
        #expect(pages[0].contains("Alex Example"))
    }
}

@Suite struct ExtractTextTests {
    @Test func readsThePdfTextLayerPageByPage() throws {
        let text = try TextExtraction.extract(path: fixtureCV.path, format: "pdf")
        // Two pages, like pdfjs reads it (cv.expected.txt).
        #expect(text.pages.count == 2)
        let page = text.pages[0]
        for expected in [
            "Senior Backend and AI Engineer",
            "Designed and built the asynchronous call-analysis pipeline",
            "Led a team of 4 engineers",
            "Wrote the invoice reconciliation service in Go and PostgreSQL.",
        ] {
            #expect(page.contains(expected), "missing: \(expected)")
        }
    }

    @Test func readsDocx() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("cv.docx")
        let source = NSAttributedString(string: "Alex Example\nBuilt the call-analysis pipeline.")
        let data = try source.data(
            from: NSRange(location: 0, length: source.length),
            documentAttributes: [.documentType: NSAttributedString.DocumentType.officeOpenXML]
        )
        try data.write(to: url)
        let text = try TextExtraction.extract(path: url.path, format: "docx")
        #expect(text.pages.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) } == [
            "Alex Example\nBuilt the call-analysis pipeline.",
        ])
    }

    @Test func reportsUnreadableFiles() {
        #expect(throws: RequestError.self) {
            try TextExtraction.extract(path: "/nonexistent/cv.pdf", format: "pdf")
        }
        let notPdf = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID()).pdf")
        FileManager.default.createFile(atPath: notPdf.path, contents: Data("hello".utf8))
        defer { try? FileManager.default.removeItem(at: notPdf) }
        #expect(throws: RequestError.self) {
            try TextExtraction.extract(path: notPdf.path, format: "pdf")
        }
    }
}

/// Writes real items to the login keychain, under a test-only service that is emptied after.
@Suite(.serialized) struct KeychainTests {
    let keychain = Keychain(service: "com.applyant.test.\(UUID().uuidString)")

    @Test func storesUpdatesListsAndDeletes() throws {
        defer { for name in (try? keychain.list()) ?? [] { _ = try? keychain.delete(name) } }
        #expect(try keychain.get("jev") == nil)
        #expect(try keychain.list() == [])
        try keychain.set("jev", value: "first-value")
        try keychain.set("jev", value: "second-value")
        try keychain.set("capmonster", value: "cap-ключ")
        #expect(try keychain.get("jev") == "second-value")
        #expect(try keychain.get("capmonster") == "cap-ключ")
        #expect(try keychain.list() == ["capmonster", "jev"])
        #expect(try keychain.delete("jev") == true)
        #expect(try keychain.delete("jev") == false)
        #expect(try keychain.list() == ["capmonster"])
    }

    @Test func servicesDontSeeEachOther() throws {
        let other = Keychain(service: keychain.service + ".other")
        defer {
            _ = try? keychain.delete("jev")
            _ = try? other.delete("jev")
        }
        try keychain.set("jev", value: "mine")
        #expect(try other.get("jev") == nil)
        #expect(try other.list() == [])
    }
}

@Suite struct WakeTests {
    @Test func forwardsDidWake() {
        let center = NotificationCenter()
        let count = Counter()
        let observer = WakeObserver(center: center) { count.increment() }
        center.post(name: NSWorkspace.didWakeNotification, object: nil)
        center.post(name: NSWorkspace.willSleepNotification, object: nil)
        withExtendedLifetime(observer) { #expect(count.value == 1) }
    }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    var value: Int { lock.withLock { n } }
    func increment() { lock.withLock { n += 1 } }
}
