// What the Preferences controls read and write, without the views: job titles as tokens,
// languages as rows, and countries and languages by name. The daemon keeps its own wire forms
// ("Chef; CFO" · "en:B1, de:C1" · "GR"); nobody types those.
import Foundation

// MARK: Roles: free job titles

public enum RoleTokens {
    /// As many titles as one search can sensibly be about.
    public static let limit = 15

    /// "Chef; CFO, Backend Engineer" → its titles, trimmed, each once (whatever the case).
    public static func parse(_ text: String) -> [String] {
        var seen: Set<String> = []
        var out: [String] = []
        for part in text.components(separatedBy: CharacterSet(charactersIn: ",;\n")) {
            let title = part.split(whereSeparator: \.isWhitespace).joined(separator: " ")
            guard !title.isEmpty, seen.insert(title.lowercased()).inserted else { continue }
            out.append(title)
            if out.count == limit { break }
        }
        return out
    }

    /// The wire form: SetPreference("roles", …).
    public static func joined(_ roles: [String]) -> String { roles.joined(separator: "; ") }

    /// What was typed, added to the titles (several at once when it holds a comma or semicolon).
    public static func adding(_ typed: String, to text: String) -> String {
        joined(parse(text + ";" + typed))
    }

    public static func removing(_ role: String, from text: String) -> String {
        joined(parse(text).filter { $0.lowercased() != role.lowercased() })
    }

    /// Suggested titles that aren't chosen yet.
    public static func offered(_ suggestions: [String], chosen text: String) -> [String] {
        let have = Set(parse(text).map { $0.lowercased() })
        return parse(suggestions.joined(separator: ";")).filter { !have.contains($0.lowercased()) }
    }

    /// True when typing should commit the title: a comma or a semicolon ends one.
    public static func endsTitle(_ typed: String) -> Bool {
        typed.last.map { ",;".contains($0) } ?? false
    }

    /// "Chef, CFO +2" for a one-line summary; "any role" when nothing is set.
    public static func summary(_ roles: [String]) -> String {
        guard !roles.isEmpty else { return "any role" }
        let shown = roles.prefix(2).joined(separator: ", ")
        return roles.count > 2 ? "\(shown) +\(roles.count - 2)" : shown
    }
}

// MARK: Languages: one row each

public struct LanguageRow: Hashable, Sendable, Identifiable {
    /// ISO 639-1, lower-case.
    public var code: String
    /// A1 … C2 or native, as the daemon writes them.
    public var level: String
    public var id: String { code }

    public init(code: String, level: String) {
        self.code = code
        self.level = level
    }
}

/// The languages the candidate would rather work in, among the ones they speak: "de, uk".
public enum WorkingLanguages {
    public static func parse(_ text: String) -> [String] {
        text.split(whereSeparator: { $0 == "," || $0 == " " }).map { $0.lowercased() }.filter { !$0.isEmpty }
    }

    public static func serialise(_ codes: [String]) -> String { codes.joined(separator: ", ") }

    public static func toggled(_ code: String, in text: String) -> String {
        var codes = parse(text)
        if let i = codes.firstIndex(of: code) { codes.remove(at: i) } else { codes.append(code) }
        return serialise(codes)
    }

    /// A language dropped from the ones spoken is dropped here too.
    public static func keeping(_ text: String, spoken: [String]) -> String {
        serialise(parse(text).filter(spoken.contains))
    }
}

public enum LanguageRows {
    public static let levels: [Choice] = [
        .init(key: "A1", title: "A1 · beginner"),
        .init(key: "A2", title: "A2 · elementary"),
        .init(key: "B1", title: "B1 · intermediate"),
        .init(key: "B2", title: "B2 · upper intermediate"),
        .init(key: "C1", title: "C1 · advanced"),
        .init(key: "C2", title: "C2 · proficient"),
        .init(key: "native", title: "Native"),
    ]
    /// The level a newly added language starts at.
    public static let defaultLevel = "B2"

    private static func level(_ raw: String) -> String? {
        levels.first { $0.key.lowercased() == raw.lowercased() }?.key
    }

    /// "en:B1, de:c1, uk:native" → rows in that order (each language once; unreadable parts dropped).
    public static func parse(_ text: String) -> [LanguageRow] {
        var seen: Set<String> = []
        var out: [LanguageRow] = []
        for part in text.components(separatedBy: CharacterSet(charactersIn: ",;\n")) {
            let pair = part.split(separator: ":").map { $0.trimmingCharacters(in: .whitespaces) }
            guard pair.count == 2, pair[0].count == 2, let level = level(pair[1]) else { continue }
            let code = pair[0].lowercased()
            if seen.insert(code).inserted { out.append(LanguageRow(code: code, level: level)) }
        }
        return out
    }

    /// The wire form: SetPreference("languages", …).
    public static func serialise(_ rows: [LanguageRow]) -> String {
        rows.map { "\($0.code):\($0.level)" }.joined(separator: ", ")
    }

    public static func adding(_ code: String, to text: String) -> String {
        var rows = parse(text)
        let code = code.lowercased()
        if !rows.contains(where: { $0.code == code }) { rows.append(LanguageRow(code: code, level: defaultLevel)) }
        return serialise(rows)
    }

    public static func setting(_ code: String, level: String, in text: String) -> String {
        serialise(parse(text).map { $0.code == code ? LanguageRow(code: code, level: level) : $0 })
    }

    public static func removing(_ code: String, from text: String) -> String {
        serialise(parse(text).filter { $0.code != code })
    }

    /// "English B1, German C1" for a one-line summary.
    public static func summary(_ text: String, locale: Locale = .current) -> String {
        parse(text).map { "\(Places.languageName($0.code, locale: locale)) \($0.level == "native" ? "native" : $0.level)" }
            .joined(separator: ", ")
    }
}

// MARK: Countries and languages by name

/// Something picked from a searchable list: a country ("GR" · "Greece") or a language.
public struct NamedCode: Hashable, Sendable, Identifiable {
    public let code: String
    public let name: String
    public var id: String { code }

    public init(code: String, name: String) {
        self.code = code
        self.name = name
    }
}

public enum Places {
    private static let english = Locale(identifier: "en_US")

    /// "GR" → "Greece" (the Mac's language, English when it has no name for it, the code last).
    public static func countryName(_ code: String, locale: Locale = .current) -> String {
        let code = code.uppercased()
        return locale.localizedString(forRegionCode: code) ?? english.localizedString(forRegionCode: code) ?? code
    }

    /// "uk" → "Ukrainian".
    public static func languageName(_ code: String, locale: Locale = .current) -> String {
        let code = code.lowercased()
        let name = locale.localizedString(forLanguageCode: code) ?? english.localizedString(forLanguageCode: code) ?? code
        return name.prefix(1).uppercased() + name.dropFirst()
    }

    /// "GR" → "🇬🇷" (two regional indicators); empty for anything that isn't two letters.
    public static func flag(_ code: String) -> String {
        let scalars = code.uppercased().unicodeScalars
        guard scalars.count == 2, scalars.allSatisfy({ $0.value >= 65 && $0.value <= 90 }) else { return "" }
        return String(String.UnicodeScalarView(scalars.compactMap { Unicode.Scalar(127_397 + $0.value) }))
    }

    /// Every country (two-letter ISO regions), by name.
    public static func countries(locale: Locale = .current) -> [NamedCode] {
        Locale.Region.isoRegions
            .filter { $0.subRegions.isEmpty && $0.identifier.count == 2 && $0.identifier.allSatisfy(\.isLetter) }
            .map { NamedCode(code: $0.identifier, name: countryName($0.identifier, locale: locale)) }
            .filter { $0.name != $0.code }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// Every language with a two-letter code, by name.
    public static func languages(locale: Locale = .current) -> [NamedCode] {
        Locale.LanguageCode.isoLanguageCodes
            .filter { $0.identifier.count == 2 }
            .map { NamedCode(code: $0.identifier, name: languageName($0.identifier, locale: locale)) }
            .filter { $0.name.lowercased() != $0.code }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    static func folded(_ text: String) -> String {
        text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: english)
            .trimmingCharacters(in: .whitespaces)
    }

    /// What typing finds: names that start with it first, then names with a word starting with
    /// it, then names containing it; the code itself finds its entry too ("gr" → Greece). Case
    /// and accents don't matter. Nothing typed: everything.
    public static func search(_ query: String, in items: [NamedCode]) -> [NamedCode] {
        let q = folded(query)
        guard !q.isEmpty else { return items }
        var ranked: [(rank: Int, item: NamedCode)] = []
        for item in items {
            let name = folded(item.name)
            let rank: Int
            if item.code.lowercased() == q { rank = 0 }
            else if name.hasPrefix(q) { rank = 1 }
            else if name.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).contains(where: { $0.hasPrefix(q) }) { rank = 2 }
            else if name.contains(q) { rank = 3 }
            else { continue }
            ranked.append((rank, item))
        }
        // Stable within a rank: the list's own (alphabetical) order.
        return ranked.enumerated().sorted { a, b in
            a.element.rank != b.element.rank ? a.element.rank < b.element.rank : a.offset < b.offset
        }.map(\.element.item)
    }
}

// MARK: Country lists on the wire

public enum CountryCodes {
    /// "cy, DE" → ["CY", "DE"], each once.
    public static func parse(_ text: String) -> [String] {
        var seen: Set<String> = []
        return text.components(separatedBy: CharacterSet(charactersIn: ",; \n"))
            .map { $0.trimmingCharacters(in: .whitespaces).uppercased() }
            .filter { $0.count == 2 && seen.insert($0).inserted }
    }

    public static func joined(_ codes: [String]) -> String { codes.joined(separator: ", ") }

    public static func adding(_ code: String, to text: String) -> String { joined(parse(text + "," + code)) }

    public static func removing(_ code: String, from text: String) -> String {
        joined(parse(text).filter { $0 != code.uppercased() })
    }
}
