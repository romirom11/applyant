// The posting's text as the Job tab shows it. The daemon captures it for the extractor
// (posting-text.ts): a header of its own ("# <page title>", the page's labels, the JobPosting
// JSON-LD fields), then the page as lines, "## " headings and "- " list items. This takes the
// header apart (the JSON-LD fields become key facts), drops page chrome and what follows the
// posting (similar jobs, cookie banners), and reads the rest as headings, paragraphs and lists.
import Foundation

public struct PostingDescription: Equatable, Sendable {
    public enum Block: Equatable, Sendable {
        case heading(String)
        /// One paragraph; lines the page broke without a blank line between stay as "\n".
        case paragraph(String)
        /// A list: `start` is the first number of a numbered one ("1. …"), nil for bullets.
        case list([String], start: Int?)
    }

    public let blocks: [Block]
    /// The JobPosting fields the capture put above the text, by name (employmentType,
    /// datePosted, baseSalary…), as the capture flattened them.
    public let structured: [String: String]

    public init(blocks: [Block], structured: [String: String] = [:]) {
        self.blocks = blocks
        self.structured = structured
    }

    /// `title` and `company` are the posting's: a heading repeating the title marks where the
    /// posting starts on pages that put navigation first, and their repeats are dropped.
    public static func parse(_ text: String, title: String? = nil, company: String? = nil) -> PostingDescription {
        var lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
        let structured = takeHeader(&lines)
        lines = body(lines, title: title)
        let blocks = read(lines, title: title, company: company)
        return PostingDescription(blocks: blocks, structured: structured)
    }

    public static func blocks(text: String, title: String? = nil, company: String? = nil) -> [Block] {
        parse(text, title: title, company: company).blocks
    }

    /// A block's text with its inline markdown (bold, links), or as it is when it isn't markdown.
    /// The text comes from any web page, so only http(s) links stay clickable: a `file:` or another
    /// app's scheme is left as plain text.
    public static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        guard var parsed = try? AttributedString(markdown: text, options: options) else { return AttributedString(text) }
        for run in parsed.runs {
            guard let url = run.link else { continue }
            if !["http", "https"].contains(url.scheme?.lowercased() ?? "") { parsed[run.range].link = nil }
        }
        return parsed
    }

    /// The JobPosting date fields ("2026-09-17T14:43:13.857463", "2025-07-01") as dates.
    public func date(_ field: String) -> Date? {
        guard let value = structured[field], value.count >= 10 else { return nil }
        // Only the day: some boards write the time in their own format ("T08-25-14").
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: String(value.prefix(10)))
    }

    // MARK: The capture's header

    static let pageHeaderPrefix = "Page header (labels shown around the title): "
    static let structuredMarker = "Structured data (JobPosting):"
    static let structuredFields: Set<String> = [
        "title", "hiringOrganization", "employmentType", "jobLocationType", "jobLocation",
        "applicantLocationRequirements", "baseSalary", "estimatedSalary", "datePosted", "validThrough",
    ]

    /// Removes the header the capture wrote above the page and returns its JobPosting fields.
    private static func takeHeader(_ lines: inout [String]) -> [String: String] {
        var i = 0
        // A single "#" is the capture's page title: the page's own headings start at "##".
        if let first = lines.first, first.hasPrefix("# ") { i = 1 }
        var fields: [String: String] = [:]
        var inStructured = false
        while i < lines.count {
            let line = lines[i]
            if line.hasPrefix(pageHeaderPrefix) {
                inStructured = false
            } else if line == structuredMarker {
                inStructured = true
            } else if inStructured, let colon = line.range(of: ": "), structuredFields.contains(String(line[..<colon.lowerBound])) {
                fields[String(line[..<colon.lowerBound])] = String(line[colon.upperBound...]).trimmingCharacters(in: .whitespaces)
            } else {
                break
            }
            i += 1
        }
        lines.removeFirst(i)
        return fields
    }

    // MARK: Where the posting starts and ends

    /// Headings after which a page lists other jobs, asks about cookies or shows its footer.
    private static let endHeadings = [
        "similar jobs", "similar vacancies", "related jobs", "more jobs", "other jobs", "job recommendations",
        "jobs at ", "схожі вакансії", "похожие вакансии", "інші вакансії",
    ]

    /// Lines where a page's own furniture starts after the posting: Djinni's "Published 12
    /// October" and its view counts, cookie consent.
    private static func endsPosting(_ line: String) -> Bool {
        let lower = line.lowercased()
        if let heading = headingText(line)?.lowercased(), endHeadings.contains(where: { heading.hasPrefix($0) }) { return true }
        if lower.contains("asks for your consent") { return true }
        for word in ["published ", "опубліковано ", "опубликовано "] where lower.hasPrefix(word) {
            if lower.dropFirst(word.count).first?.isNumber == true { return true }
        }
        return false
    }

    private static func body(_ lines: [String], title: String?) -> [String] {
        var lines = lines
        // Pages that put their navigation (or a cookie banner) first repeat the title as a
        // heading where the posting starts (Djinni, Arbeitnow, ElevenLabs): everything above it
        // is the page's. Not when little follows it: that's a list of other jobs.
        if let title = title.map(normalized), !title.isEmpty,
           let start = lines.firstIndex(where: { headingText($0).map(normalized) == title }),
           lines[(start + 1)...].reduce(0, { $0 + $1.count }) >= 400 {
            lines.removeSubrange(...start)
        }
        if let end = lines.firstIndex(where: endsPosting) { lines.removeSubrange(end...) }
        return lines
    }

    // MARK: Reading the lines

    /// Lines that are the page's, not the posting's (compared lowercased).
    private static let chrome: Set<String> = [
        "error", "помилка", "ошибка", "open in djinni mobile app", "відкрити в застосунку djinni",
        "learn more", "back to jobs", "back", "apply", "apply now", "apply for this job", "share", "share this job",
        "save", "save job", "report", "got it!", "more info", "see applicant insights", "огляд кандидатів",
        "show more", "read more", "+ 3 more",
    ]
    private static let chromePrefixes = [
        "we use cookies", "this website uses cookies", "we value your privacy", "see stats of candidates", "подивитись статистику", "📊",
    ]
    /// The last word of a board's company-type label ("Product", "🪖 DefTech Product", "Outsource").
    private static let companyKinds: Set<String> = ["product", "outsource", "outstaff", "outstaffing", "agency", "startup", "deftech", "компанія"]
    /// The first item of a breadcrumb trail.
    private static let breadcrumbRoots: Set<String> = ["all jobs", "всі вакансії", "все вакансии", "jobs", "home"]

    private static func isChrome(_ line: String, title: String?, company: String?) -> Bool {
        guard !line.isEmpty else { return false }
        let lower = line.lowercased()
        if chrome.contains(lower) || chromePrefixes.contains(where: { lower.hasPrefix($0) }) { return true }
        // Djinni's salary band ("$$$$") and lone separators.
        if line.allSatisfy({ $0 == "$" || $0 == "|" || $0 == "·" }) { return true }
        // Cookie banners and their tables.
        if lower.contains("cookies") { return true }
        let words = line.split(separator: " ").map { $0.lowercased().filter(\.isLetter) }.filter { !$0.isEmpty }
        if !line.hasPrefix("#"), !line.hasSuffix(":"), (1...2).contains(words.count), let last = words.last, companyKinds.contains(last) { return true }
        if let title, normalized(line) == normalized(title) { return true }
        // The company's name with the board's badges ("Temy Responds Quickly", "Adaptiq 🔥").
        if let company, !company.isEmpty, lower.hasPrefix(company.lowercased()) {
            let rest = line.dropFirst(company.count)
            if rest.count <= 25, !rest.contains(where: { ".,;:!?".contains($0) }) { return true }
        }
        return false
    }

    private enum Line: Equatable {
        case blank, heading(String), plain(String), bullet(String), numbered(Int, String), emptyBullet
    }

    private static func classify(_ line: String) -> Line {
        if line.isEmpty { return .blank }
        if let heading = headingText(line) { return heading.isEmpty ? .blank : .heading(heading) }
        if ["-", "•", "*", "–", "·"].contains(line) { return .emptyBullet }
        for marker in ["- ", "• ", "* ", "– ", "· "] where line.hasPrefix(marker) {
            let text = line.dropFirst(marker.count).trimmingCharacters(in: .whitespaces)
            return text.isEmpty ? .emptyBullet : .bullet(text)
        }
        // "1. Turn customer pain into product decisions."
        let digits = line.prefix { $0.isASCII && $0.isNumber }
        if (1...2).contains(digits.count), let n = Int(digits) {
            let rest = line.dropFirst(digits.count)
            if let mark = rest.first, mark == "." || mark == ")", rest.dropFirst().first == " " {
                let text = rest.dropFirst(2).trimmingCharacters(in: .whitespaces)
                if !text.isEmpty { return .numbered(n, text) }
            }
        }
        return .plain(line)
    }

    private static func read(_ raw: [String], title: String?, company: String?) -> [Block] {
        var lines = raw.filter { !isChrome($0, title: title, company: company) }.map(classify)
        // "-" on a line of its own, the item's text on the next (a list item holding a paragraph).
        var i = 0
        while i < lines.count {
            if lines[i] == .emptyBullet {
                if i + 1 < lines.count, case let .plain(text) = lines[i + 1] {
                    lines[i] = .bullet(text)
                    lines.remove(at: i + 1)
                } else {
                    lines.remove(at: i)
                    continue
                }
            }
            i += 1
        }

        var blocks: [Block] = []
        var paragraph: [String] = []
        var list: [String] = []
        var listStart: Int?
        func flushParagraph() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))) }
            paragraph = []
        }
        func flushList() {
            if !list.isEmpty { blocks.append(.list(list, start: listStart)) }
            list = []
            listStart = nil
        }
        for (index, line) in lines.enumerated() {
            switch line {
            case .blank, .emptyBullet:
                flushParagraph()
            case let .heading(text):
                flushParagraph()
                flushList()
                blocks.append(.heading(text))
            case let .bullet(text) where text.hasSuffix(":") && text.count <= 60 && text.split(separator: " ").count <= 9:
                // "- Responsibilities:" over the list it names.
                flushParagraph()
                flushList()
                blocks.append(.heading(stripColon(text)))
            case let .bullet(text):
                flushParagraph()
                if listStart != nil { flushList() }
                list.append(text)
            case let .numbered(n, text):
                flushParagraph()
                if listStart == nil { flushList() }
                if list.isEmpty { listStart = n }
                list.append(text)
            case let .plain(text) where !list.isEmpty && text.first?.isLowercase == true && index > 0 && lines[index - 1] != .blank:
                // A list item the page wrapped onto the next line.
                list[list.count - 1] += " " + text
            case let .plain(text):
                if isPseudoHeading(text, next: next(after: index, in: lines)) {
                    flushParagraph()
                    flushList()
                    blocks.append(.heading(stripColon(text)))
                } else {
                    flushList()
                    paragraph.append(text)
                }
            }
        }
        flushParagraph()
        flushList()
        // Before the text starts: a breadcrumb trail, the page's labels under the title
        // ("Hamburg", "6 hours": the key facts say them better), and a "Description" heading
        // (the detail titles the text so already).
        while let first = blocks.first {
            if case let .list(items, nil) = first, let root = items.first, breadcrumbRoots.contains(root.lowercased()) {
                // The trail's short steps; a list the page ran on into stays.
                let rest = Array(items.drop { $0.count <= 30 && $0.last.map { ".!?:".contains($0) } != true })
                if rest.isEmpty { blocks.removeFirst() } else { blocks[0] = .list(rest, start: nil) }
            } else if leadsIn(first) {
                blocks.removeFirst()
            } else {
                break
            }
        }
        // A heading with nothing under it (the posting ended, or chrome followed it).
        while case .heading = blocks.last { blocks.removeLast() }
        return blocks.enumerated().filter { i, block in i == 0 || block != blocks[i - 1] }.map(\.1)
    }

    private static func leadsIn(_ block: Block) -> Bool {
        switch block {
        case let .paragraph(text):
            return text.split(separator: " ").count <= 3 && !text.contains("\n") && text.last.map({ ".!?:".contains($0) }) != true
        case let .heading(text):
            return ["description", "job description", "опис вакансії", "описание вакансии"].contains(text.lowercased())
        default:
            return false
        }
    }

    private static func next(after index: Int, in lines: [Line]) -> Line? {
        lines[(index + 1)...].first { $0 != .blank }
    }

    /// Section names postings use without marking them as headings.
    private static let knownHeadings: Set<String> = [
        "requirements", "responsibilities", "what you will do", "what you'll do", "what you’ll do", "about us",
        "about the role", "about the company", "about the team", "about the project", "the role", "nice to have",
        "benefits", "what we offer", "we offer", "qualifications", "tech stack", "our stack", "your tasks",
        "вимоги", "обов'язки", "обов’язки", "ми пропонуємо", "буде плюсом", "про нас", "про компанію", "про проєкт",
        "требования", "обязанности", "мы предлагаем", "aufgaben", "dein profil", "ihr profil", "wir bieten",
    ]

    /// A short line without end punctuation that introduces a list or a longer paragraph
    /// ("What you will do", "Вимоги:", "Ми пропонуємо").
    private static func isPseudoHeading(_ text: String, next: Line?) -> Bool {
        let words = text.split(separator: " ").count
        guard text.count <= 70, words <= 9, let first = text.first, !first.isLowercase, !first.isNumber else { return false }
        if knownHeadings.contains(stripColon(text).lowercased()) { return true }
        if text.hasSuffix(":") { return text.count <= 60 && !text.dropLast().contains(":") }
        // "Salary range: $100k" is a line of facts, not a heading.
        if text.contains(":") || text.last.map({ ".,;!?…*)".contains($0) }) == true { return false }
        switch next {
        case .bullet?, .numbered?:
            return true
        case let .plain(following)?:
            return following.count >= 60 && following.count >= text.count * 2
        default:
            return false
        }
    }

    // MARK: Helpers

    /// "## About us" → "About us"; nil for a line that isn't a markdown heading.
    private static func headingText(_ line: String) -> String? {
        guard line.first == "#" else { return nil }
        let hashes = line.prefix { $0 == "#" }
        let rest = line.dropFirst(hashes.count)
        guard hashes.count <= 6, rest.first == " " else { return nil }
        return stripColon(rest.trimmingCharacters(in: .whitespaces))
    }

    private static func stripColon(_ text: String) -> String {
        text.hasSuffix(":") ? String(text.dropLast()).trimmingCharacters(in: .whitespaces) : text
    }

    private static func normalized(_ text: String) -> String {
        text.lowercased().split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }
}
