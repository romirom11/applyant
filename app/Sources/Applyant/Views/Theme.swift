// The app's look in one place: spacing, radii, type, colours (the score ramp, the brand
// gradient, chip and verdict tints) and the springs everything moves with. Views use these
// instead of their own numbers, so the visual language is changed here. The shared pieces
// built from them are in Components.swift, the motion in Motion.swift.
import AppKit
import ApplyantKit
import SwiftUI

enum Theme {
    // MARK: Spacing and shape

    /// Around a detail page, and between its blocks.
    static let pagePadding: CGFloat = 24
    static let blockSpacing: CGFloat = 16
    /// Inside a card: around its content and between its rows.
    static let cardPadding: CGFloat = 16
    static let rowSpacing: CGFloat = 6
    static let cornerRadius: CGFloat = 14
    /// Blocks inside a card (a fact, a run's sources) and text fields.
    static let innerRadius: CGFloat = 9
    /// Text reads best up to this width.
    static let readableWidth: CGFloat = 860

    // MARK: Type

    static let heroTitle = Font.system(size: 24, weight: .bold)
    static let pageTitle = Font.title2.weight(.bold)
    static let cardTitle = Font.headline
    static let caption = Font.caption
    /// Above a group of rows: small, spaced capitals.
    static let eyebrow = Font.caption2.weight(.semibold)

    /// Scores and counts: rounded, with even digits.
    static func number(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        .system(size: size, weight: weight, design: .rounded).monospacedDigit()
    }

    // MARK: Colour

    /// Applyant's own accent, a little lighter in the dark.
    static let accent = Color(light: NSColor(srgbRed: 0.36, green: 0.35, blue: 0.95, alpha: 1),
                              dark: NSColor(srgbRed: 0.50, green: 0.49, blue: 1.0, alpha: 1))
    static let violet = Color(light: NSColor(srgbRed: 0.58, green: 0.32, blue: 0.93, alpha: 1),
                              dark: NSColor(srgbRed: 0.69, green: 0.47, blue: 1.0, alpha: 1))
    static let pink = Color(light: NSColor(srgbRed: 0.93, green: 0.30, blue: 0.62, alpha: 1),
                            dark: NSColor(srgbRed: 1.0, green: 0.45, blue: 0.72, alpha: 1))
    static let brandColors: [Color] = [accent, violet]
    static let brand = LinearGradient(colors: brandColors, startPoint: .topLeading, endPoint: .bottomTrailing)
    /// Under white text (the primary button, your messages): as deep in the dark as in the light,
    /// so the text stays easy to read.
    static let brandFill = LinearGradient(
        colors: [Color(nsColor: NSColor(srgbRed: 0.36, green: 0.35, blue: 0.95, alpha: 1)),
                 Color(nsColor: NSColor(srgbRed: 0.55, green: 0.29, blue: 0.90, alpha: 1))],
        startPoint: .topLeading, endPoint: .bottomTrailing
    )
    /// The celebration's sparks.
    static let sparkColors: [Color] = [accent, violet, pink, .orange, .mint]

    static let warning = Color.orange
    static let good = Color.green

    static func tint(_ tone: Chip.Tone) -> Color {
        switch tone {
        case .accent: accent
        case .warning: .orange
        case .good: .green
        case .neutral: .secondary
        }
    }

    /// A score's colour on the red → amber → green ramp; deeper in the light so it reads on white.
    static func score(_ score: Int32?) -> Color {
        guard let hue = ScoreScale.hue(score) else { return .secondary }
        // Amber and yellow need more depth than red or green to read as well.
        let yellowness = max(0, 1 - abs(hue - 0.14) / 0.12)
        return Color(
            light: NSColor(hue: hue, saturation: 0.82, brightness: 0.80 - 0.12 * yellowness, alpha: 1),
            dark: NSColor(hue: hue, saturation: 0.70, brightness: 0.95, alpha: 1)
        )
    }

    /// A requirement's verdict: strong, partial, missing, or unknown.
    static func verdict(_ verdict: String) -> Color {
        switch verdict {
        case "strong": .green
        case "missing": .red
        case "partial": .orange
        default: .secondary
        }
    }

    static func verdictSymbol(_ verdict: String) -> String {
        switch verdict {
        case "strong": "checkmark.circle.fill"
        case "missing": "xmark.circle.fill"
        case "partial": "circle.lefthalf.filled"
        default: "questionmark.circle"
        }
    }

    /// A company's own colour (its monogram, the header's glow).
    static func company(_ name: String, shift: Double = 0) -> Color {
        let hue = (Monogram.hue(name) + shift).truncatingRemainder(dividingBy: 1)
        return Color(
            light: NSColor(hue: hue, saturation: 0.62, brightness: 0.82, alpha: 1),
            dark: NSColor(hue: hue, saturation: 0.55, brightness: 0.88, alpha: 1)
        )
    }

    // MARK: Surfaces

    /// Behind a detail page: a quiet grey in the light, so white cards lift off it.
    static let page = Color(light: NSColor(srgbRed: 0.965, green: 0.965, blue: 0.975, alpha: 1),
                            dark: NSColor(srgbRed: 0.115, green: 0.115, blue: 0.125, alpha: 1))
    static let cardFill = Color(light: .white, dark: NSColor(white: 1, alpha: 0.055))
    /// A block inside a card, or a quiet panel on the page.
    static let insetFill = Color(light: NSColor(white: 0, alpha: 0.035), dark: NSColor(white: 1, alpha: 0.05))
    /// A toast floating over the page.
    static let toastFill = Color(light: NSColor(white: 1, alpha: 0.82), dark: NSColor(srgbRed: 0.17, green: 0.17, blue: 0.19, alpha: 0.85))
    static let hairline = Color(light: NSColor(white: 0, alpha: 0.08), dark: NSColor(white: 1, alpha: 0.09))
    static let shadow = Color(light: NSColor(white: 0, alpha: 0.06), dark: NSColor(white: 0, alpha: 0.35))

    // MARK: Motion

    enum Motion {
        /// Taps, toggles, the tab pill.
        static let snappy = Animation.spring(duration: 0.32, bounce: 0.18)
        /// Content changing place: lists, the detail.
        static let smooth = Animation.smooth(duration: 0.4)
        /// Something arriving: chips, the toast.
        static let bouncy = Animation.spring(duration: 0.5, bounce: 0.32)
        /// The score ring filling.
        static let gauge = Animation.spring(duration: 1.1, bounce: 0.08)
        /// With Reduce Motion: things fade, nothing moves.
        static let fade = Animation.easeInOut(duration: 0.2)

        static func pick(_ animation: Animation, reduceMotion: Bool) -> Animation {
            reduceMotion ? fade : animation
        }
    }
}

extension Color {
    /// One colour for the light appearance and one for the dark.
    init(light: NSColor, dark: NSColor) {
        self.init(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
        })
    }
}
