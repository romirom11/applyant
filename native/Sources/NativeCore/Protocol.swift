// The JSON-lines protocol applyantd speaks with this helper (daemon/src/native/client.ts):
//
//   → {"id": 1, "op": "keychain_get", "name": "jev"}
//   ← {"id": 1, "ok": true, "result": {"value": "…"}}   or   {"id": 1, "ok": false, "error": "…"}
//   ← {"event": "wake"}                                  (unsolicited)
//
// Every request gets exactly one answer line, in any order; the daemon matches them by id.
// classify_email (ClassifyEmail.swift) is answered asynchronously, so a slow on-device model
// never holds up a Keychain read behind it.
import Foundation

public let helperVersion = "0.1.0"

public struct RequestError: Error, CustomStringConvertible {
    public let description: String
    public init(_ description: String) { self.description = description }
}

public final class Dispatcher {
    private let keychain: Keychain
    private let classifier: EmailClassifier

    public init(keychain: Keychain = Keychain(), classifier: EmailClassifier = EmailClassifier()) {
        self.keychain = keychain
        self.classifier = classifier
    }

    /// One request line in; `reply` gets the answer line, right away for everything but
    /// classify_email, which answers from a task when the model is done.
    public func handle(line: String, reply: @escaping @Sendable (String) -> Void) {
        guard let data = line.data(using: .utf8),
              let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              request["op"] as? String == "classify_email"
        else {
            reply(handle(line: line))
            return
        }
        let id = Self.sendableId(request["id"])
        let email = EmailInput(
            subject: request["subject"] as? String ?? "",
            body: request["body"] as? String ?? "",
            from: request["from"] as? String ?? ""
        )
        let classifier = classifier
        Task {
            let result = await classifier.classify(email)
            reply(encode(["id": id.value, "ok": true, "result": result.json]))
        }
    }

    /// The request id, carried into the task that answers it (ids are numbers or strings).
    struct RequestId: Sendable {
        let number: Int?
        let string: String?
        var value: Any { number.map { $0 as Any } ?? string.map { $0 as Any } ?? NSNull() }
    }

    static func sendableId(_ id: Any?) -> RequestId {
        RequestId(number: id as? Int, string: id as? String)
    }

    /// One request line in, one answer line out (without the trailing newline).
    public func handle(line: String) -> String {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let request = object as? [String: Any]
        else {
            return encode(["id": NSNull(), "ok": false, "error": "the request is not a JSON object"])
        }
        let id = request["id"] ?? NSNull()
        do {
            guard let op = request["op"] as? String else { throw RequestError("the request has no op") }
            let result = try run(op: op, request)
            return encode(["id": id, "ok": true, "result": result])
        } catch {
            return encode(["id": id, "ok": false, "error": "\(error)"])
        }
    }

    private func run(op: String, _ r: [String: Any]) throws -> [String: Any] {
        switch op {
        case "ping":
            return ["version": helperVersion, "pid": Int(ProcessInfo.processInfo.processIdentifier)]
        case "extract_text":
            let path = try string(r, "path")
            let text = try TextExtraction.extract(path: path, format: r["format"] as? String)
            return ["pages": text.pages, "title": text.title ?? NSNull()]
        case "keychain_get":
            return ["value": try keychain.get(try string(r, "name")) ?? NSNull()]
        case "keychain_set":
            try keychain.set(try string(r, "name"), value: try string(r, "value"))
            return [:]
        case "keychain_delete":
            return ["deleted": try keychain.delete(try string(r, "name"))]
        case "keychain_list":
            return ["names": try keychain.list()]
        case "classify_email":
            throw RequestError("classify_email is answered through handle(line:reply:)")
        default:
            throw RequestError("unknown op \(op)")
        }
    }

    private func string(_ r: [String: Any], _ key: String) throws -> String {
        guard let value = r[key] as? String, !value.isEmpty else {
            throw RequestError("\(key) is missing")
        }
        return value
    }
}

/// One JSON line; keys sorted so output is stable.
public func encode(_ object: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let line = String(data: data, encoding: .utf8)
    else { return #"{"ok":false,"error":"could not encode the answer"}"# }
    return line
}
