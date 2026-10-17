// How the job lists split the postings so nothing is in two of them: New holds what has no
// application yet, To review every application that isn't sent (grouped by what it waits
// for), Saved what the candidate kept. Plain values, tested without SwiftUI.
import ApplyantAPI
import Foundation

/// New's filter: the postings worth a look first, or everything scored.
public enum NewFilter: String, CaseIterable, Identifiable, Sendable {
    case good, all

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .good: "Good Matches"
        case .all: "All"
        }
    }
}

/// A list's rows under one header ("Needs you"); `title` is empty for a list without headers.
public struct ListGroup: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let items: [ListItem]

    public init(id: String, title: String, items: [ListItem]) {
        self.id = id
        self.title = title
        self.items = items
    }
}

public enum JobLists {
    /// The daemon's auto-prepare threshold when the preferences don't say (scoring/prefs.ts).
    public static let defaultThreshold: Int32 = 80
    /// The good-match bar never goes above this: everything at the auto-prepare threshold is
    /// prepared on its own, so New's good matches are mostly the ones just under it.
    public static let goodMatchCeiling: Int32 = 70

    /// New's "Good matches": a score at or above this.
    public static func goodMatchScore(threshold: Int32?) -> Int32 {
        let threshold = threshold.flatMap { $0 > 0 ? $0 : nil } ?? defaultThreshold
        return min(threshold, goodMatchCeiling)
    }

    /// To review's groups, in the order they're worked through.
    public enum ReviewGroup: String, CaseIterable, Sendable {
        case needsYou, ready, preparing

        public var title: String {
            switch self {
            case .needsYou: "Needs you"
            case .ready: "Ready to send"
            case .preparing: "Preparing"
            }
        }

        /// The group an application is in; nil when it isn't in To review (sent, or approved and
        /// on its way).
        public static func of(_ app: Application) -> ReviewGroup? {
            switch app.stage {
            case .needsCandidate: .needsYou
            case .approved: app.hasHandOff ? .needsYou : nil
            case .readyForReview: .ready
            case .preparing: .preparing
            default: nil
            }
        }
    }

    /// "12 lower matches (under 70) hidden": the filter's tooltip.
    public static func hiddenLine(_ hidden: Int, below score: Int32) -> String? {
        guard hidden > 0 else { return nil }
        return "\(hidden) lower match\(hidden == 1 ? "" : "es") (under \(score)) hidden"
    }
}

public enum ListSelection {
    /// After the item open in the detail left its list (sent, skipped): the one that took its
    /// place, else the one before it; nil when the list is empty. The item itself when it's
    /// still there.
    public static func next(after postingId: Int64, before: [ListItem], now: [ListItem]) -> ListItem? {
        if let same = now.first(where: { $0.postingId == postingId }) { return same }
        let remaining = Set(now.map(\.postingId))
        guard let index = before.firstIndex(where: { $0.postingId == postingId }) else { return now.first }
        let after = before[(index + 1)...].first { remaining.contains($0.postingId) }
        let earlier = before[..<index].last { remaining.contains($0.postingId) }
        let pick = after ?? earlier
        return pick.flatMap { p in now.first { $0.postingId == p.postingId } } ?? now.first
    }

    /// The row after the open one (1) or before it (-1), for Next Job and Previous Job: the
    /// first (or the last) when nothing in the list is open; nil past either end.
    public static func step(_ step: Int, from postingId: Int64?, in items: [ListItem]) -> ListItem? {
        guard let index = postingId.flatMap({ id in items.firstIndex { $0.postingId == id } }) else {
            return step > 0 ? items.first : items.last
        }
        return items.indices.contains(index + step) ? items[index + step] : nil
    }
}
