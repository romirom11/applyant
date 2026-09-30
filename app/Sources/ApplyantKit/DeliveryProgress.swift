import Foundation

/// What a delivery is doing right now, built from its live `task.progress` messages (deliver.ts
/// and the form engine): "Filling 14/16 fields · Resume uploaded · solving captcha".
public struct DeliveryProgress: Equatable, Sendable {
    /// The form's step (1-based); shown from step 2 on.
    public var step: Int?
    public var filled: Int?
    public var total: Int?
    /// Files put into the form on this delivery ("Resume").
    public var uploaded: [String] = []
    /// The one thing happening now, when it isn't filling: "solving captcha", "submitting".
    public var doing: String?

    public init() {}

    public init(messages: [String]) {
        for m in messages { apply(m) }
    }

    public mutating func apply(_ message: String) {
        let m = message.trimmingCharacters(in: .whitespaces)
        var rest = Substring(m)
        // "step 2: …" prefixes the step's own messages.
        if let match = m.firstMatch(of: /^step (\d+): (.*)$/) {
            let n = Int(match.1)
            if n != step { filled = nil; total = nil }
            step = n
            rest = match.2
        }
        if let fields = rest.firstMatch(of: /^(\d+) fields$/) {
            total = Int(fields.1)
            filled = 0
            doing = nil
        } else if let filling = rest.firstMatch(of: /^filling (\d+)\/(\d+):/) {
            filled = Int(filling.1)
            total = Int(filling.2)
            doing = nil
        } else if rest.hasPrefix("opening ") {
            doing = "opening the form"
        } else if rest.hasPrefix("uploaded ") {
            let what = String(rest.dropFirst("uploaded ".count))
            if !uploaded.contains(what) { uploaded.append(what) }
        } else if rest.hasPrefix("solving a") && rest.hasSuffix("captcha") {
            doing = "solving captcha"
        } else if rest.hasPrefix("captcha solved") {
            doing = "captcha solved"
        } else if let press = rest.firstMatch(of: /^pressing "(.*)"$/) {
            doing = "pressing “\(press.1)”"
        } else if rest.hasPrefix("submission not accepted") {
            doing = "fixing what the form rejected"
        } else if rest.contains("security code") {
            doing = "reading the emailed security code"
        }
    }

    /// "Filling 14/16 fields · Resume uploaded · solving captcha"; "Delivering" before anything.
    public var line: String {
        var parts: [String] = []
        if let step, step > 1 { parts.append("Step \(step)") }
        if let total, total > 0 { parts.append("Filling \(min(filled ?? 0, total))/\(total) fields") }
        for u in uploaded { parts.append("\(u) uploaded") }
        if let doing { parts.append(doing) }
        guard !parts.isEmpty else { return "Delivering" }
        parts[0] = parts[0].prefix(1).uppercased() + parts[0].dropFirst()
        return parts.joined(separator: " · ")
    }
}

public enum WorkingLine {
    /// The menu bar's Working line: each delivery with what it's doing ("Delivering to Helix:
    /// Filling 14/16 fields · solving captcha"), then the other running task kinds.
    public static func text(
        running: [Int64: String],
        deliveries: [Int64: DeliveryProgress],
        name: (Int64) -> String
    ) -> String {
        let kinds = Dictionary(grouping: running.values.filter { $0 != "deliver_application" || deliveries.isEmpty }, by: { $0 })
            .map { $0.value.count > 1 ? "\($0.key) ×\($0.value.count)" : $0.key }
            .sorted()
        let delivering = deliveries.sorted { $0.key < $1.key }
            .map { "Delivering to \(name($0.key)): \($0.value.line)" }
        let others = kinds.isEmpty ? [] : ["Working: " + kinds.joined(separator: ", ")]
        return (delivering + others).joined(separator: "\n")
    }
}
