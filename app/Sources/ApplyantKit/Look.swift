// The numbers behind the app's look, kept here so they're tested without SwiftUI: where a score
// sits on the red → amber → green ramp, a company's monogram and its colour, and how long a
// block waits before it comes in.
import Foundation

public enum ScoreScale {
    /// Hues along the ramp at a few scores: red at 40 and under, amber in the sixties and early
    /// seventies, green from 85. Between two stops the hue moves linearly.
    static let stops: [(score: Double, hue: Double)] = [(40, 0.0), (60, 0.075), (74, 0.125), (85, 0.33)]

    /// The ring's fill: the score out of 100 (none for no score).
    public static func fill(_ score: Int32?) -> Double {
        score.map { min(max(Double($0) / 100, 0), 1) } ?? 0
    }

    /// The ramp's hue for a score (0 red … 0.33 green); nil for no score.
    public static func hue(_ score: Int32?) -> Double? {
        guard let score else { return nil }
        let s = Double(score)
        guard let first = stops.first, let last = stops.last else { return nil }
        if s <= first.score { return first.hue }
        if s >= last.score { return last.hue }
        for (a, b) in zip(stops, stops.dropFirst()) where s <= b.score {
            return a.hue + (b.hue - a.hue) * (s - a.score) / (b.score - a.score)
        }
        return last.hue
    }
}

public enum Monogram {
    /// Endings that say what kind of company it is, not which one.
    private static let legalForms: Set<String> = [
        "gmbh", "inc", "llc", "ltd", "oy", "ab", "ag", "sa", "bv", "srl", "sro", "spa", "plc", "co", "corp", "limited",
    ]

    /// "Red Rocket Software" → "RR", "Nuitée" → "N", "modash.io" → "M", "DEMV Systems GmbH" → "DS".
    public static func initials(_ name: String) -> String {
        var name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        // A domain for a name: the part before its ending.
        if !name.contains(" "), let dot = name.firstIndex(of: "."), dot != name.startIndex { name = String(name[..<dot]) }
        let words = name.components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
        let kept = words.filter { !legalForms.contains($0.lowercased()) }
        let picked = (kept.isEmpty ? words : kept).prefix(2)
        let letters = picked.compactMap(\.first).map { String($0).uppercased() }.joined()
        return letters.isEmpty ? "?" : letters
    }

    /// A hue (0…1) of its own for every company name, the same on every launch.
    public static func hue(_ name: String) -> Double {
        // FNV-1a: Swift's own hash is seeded per process.
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in name.lowercased().utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100_0000_01b3
        }
        return Double(hash % 360) / 360
    }
}

public enum Stagger {
    /// How long the block at `index` waits before it comes in: a short beat each, so a page
    /// fills top to bottom, and never more than a third of a second for the last ones.
    public static func delay(_ index: Int, step: Double = 0.045) -> Double {
        Double(min(max(index, 0), 7)) * step
    }
}

extension DeliveryProgress {
    /// How far the form's filling is (0…1), while its fields are known.
    public var fraction: Double? {
        guard let total, total > 0 else { return nil }
        return min(Double(filled ?? 0) / Double(total), 1)
    }
}

/// Each section's colour world: the window's background glows in it, and its art, tiles and
/// selection pick it up. Two hues (the glow's main one and the one it drifts towards) and how
/// saturated they are: To review is magenta-violet, New teal, Saved amber, Skipped slate,
/// Applied azure, Interviews emerald, Offers gold, Which application? coral, Home and the
/// candidate's own sections violet, the system ones a quiet indigo.
public struct WorldTone: Equatable, Sendable {
    public let hue: Double
    public let secondHue: Double
    public let saturation: Double

    public init(hue: Double, secondHue: Double, saturation: Double) {
        self.hue = hue
        self.secondHue = secondHue
        self.saturation = saturation
    }

    public static func of(_ section: Section) -> WorldTone {
        switch section {
        case .toReview: WorldTone(hue: 0.87, secondHue: 0.76, saturation: 0.82)
        case .new: WorldTone(hue: 0.49, secondHue: 0.55, saturation: 0.78)
        case .saved: WorldTone(hue: 0.09, secondHue: 0.04, saturation: 0.85)
        case .skipped: WorldTone(hue: 0.62, secondHue: 0.66, saturation: 0.32)
        case .applied: WorldTone(hue: 0.58, secondHue: 0.64, saturation: 0.8)
        case .interviews: WorldTone(hue: 0.40, secondHue: 0.46, saturation: 0.75)
        case .offers: WorldTone(hue: 0.13, secondHue: 0.09, saturation: 0.85)
        case .whichApplication: WorldTone(hue: 0.02, secondHue: 0.95, saturation: 0.75)
        case .overview, .profile, .projects, .interview, .chat: WorldTone(hue: 0.77, secondHue: 0.84, saturation: 0.78)
        case .search, .agentRuns, .companies, .settings: WorldTone(hue: 0.68, secondHue: 0.62, saturation: 0.5)
        }
    }
}
