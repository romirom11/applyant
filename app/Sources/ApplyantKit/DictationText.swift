// Dictation into a text field: what was there before, the phrases already recognised, and the
// phrase being spoken right now (which the recogniser keeps revising until it's final).
import Foundation

public struct DictationText: Equatable, Sendable {
    /// What the field held when dictation started.
    public var base: String
    /// Phrases the recogniser finished.
    public var committed: [String] = []
    /// The phrase in progress.
    public var partial = ""

    public init(base: String) {
        self.base = base
    }

    /// The phrase in progress is final: it's kept, and the next one starts empty.
    public mutating func commit() {
        let phrase = partial.trimmingCharacters(in: .whitespacesAndNewlines)
        if !phrase.isEmpty { committed.append(phrase) }
        partial = ""
    }

    /// The field's text: the original, then everything said, separated by single spaces.
    public var text: String {
        let said = (committed + [partial])
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        let start = base.trimmingCharacters(in: .whitespacesAndNewlines)
        if start.isEmpty { return said }
        return said.isEmpty ? base : start + " " + said
    }
}

/// Which languages the microphone button offers, and which one it starts with.
public enum DictationLanguages {
    /// The recogniser's locales for the languages the candidate speaks (their preferences) and
    /// the Mac's own languages, in that order, one per language; every locale when none match.
    public static func offered(supported: [String], spoken: [String], system: [String]) -> [String] {
        let language = { (id: String) in String(id.prefix { $0 != "-" && $0 != "_" }).lowercased() }
        var out: [String] = []
        // The Mac's exact locales first ("en-GB" before "en-US"), then any locale of a language.
        for want in system + spoken.map(language) {
            let exact = supported.first { $0.replacingOccurrences(of: "_", with: "-").lowercased() == want.lowercased() }
            let match = exact ?? supported.sorted().first { language($0) == language(want) }
            if let match, !out.contains(where: { language($0) == language(match) }) { out.append(match) }
        }
        return out.isEmpty ? supported.sorted() : out
    }

    /// The saved choice if it's still offered, else the first one.
    public static func initial(saved: String?, offered: [String]) -> String? {
        if let saved, offered.contains(saved) { return saved }
        return offered.first
    }

    /// "Ukrainian", "English (United Kingdom)" when two locales of a language are offered.
    public static func name(_ id: String, among offered: [String]) -> String {
        let locale = Locale(identifier: id)
        let code = locale.language.languageCode?.identifier ?? id
        let same = offered.filter { Locale(identifier: $0).language.languageCode?.identifier == code }
        let english = Locale(identifier: "en")
        if same.count > 1 { return english.localizedString(forIdentifier: id) ?? id }
        return english.localizedString(forLanguageCode: code) ?? id
    }
}
