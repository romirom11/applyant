// The app's look in one place: spacing, radii, type, colours (the window's colour worlds, the
// score ramp, the brand gradient, chip and verdict tints) and the springs everything moves
// with. The window is always one deep, saturated world (indigo into violet and magenta, tinted
// by the section that's open), so the colours here are made for it; tiles are translucent glass
// over it. Views use these instead of their own numbers, so the visual language is changed
// here. The shared pieces built from them are in Components.swift, the motion in Motion.swift
// and Ambient.swift.
import AppKit
import ApplyantKit
import SwiftUI

enum Theme {
    // MARK: Spacing and shape

    /// Around a detail page, and between its blocks.
    static let pagePadding: CGFloat = 24
    static let blockSpacing: CGFloat = 14
    /// Inside a tile: around its content and between its rows.
    static let cardPadding: CGFloat = 18
    static let rowSpacing: CGFloat = 6
    /// A glass tile's corners (CleanMyMac's are about this round).
    static let cornerRadius: CGFloat = 20
    /// Blocks inside a tile (a fact, a run's sources) and text fields.
    static let innerRadius: CGFloat = 12
    /// The list column's panel and the job's hero.
    static let panelRadius: CGFloat = 24
    /// Text reads best up to this width.
    static let readableWidth: CGFloat = 960
    /// Long text (a posting's description): about 75 characters a line.
    static let proseWidth: CGFloat = 700
    /// The rail of sections on the left.
    static let railWidth: CGFloat = 74

    // MARK: Type

    /// Home's greeting.
    static let displayTitle = Font.system(size: 34, weight: .bold)
    static let heroTitle = Font.system(size: 27, weight: .bold)
    /// A section's own title over its list ("To review").
    static let moduleTitle = Font.system(size: 24, weight: .bold)
    static let pageTitle = Font.system(size: 22, weight: .bold)
    static let cardTitle = Font.system(size: 14, weight: .semibold)
    /// A tile's label, top left ("Ready to send").
    static let tileLabel = Font.system(size: 13, weight: .semibold)
    static let caption = Font.caption
    /// Above a group of rows: small, spaced capitals.
    static let eyebrow = Font.system(size: 10.5, weight: .bold)
    /// Long text: a little larger than body, for easy reading.
    static let prose = Font.system(size: 14.5)

    /// Scores and counts: rounded, with even digits.
    static func number(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        .system(size: size, weight: weight, design: .rounded).monospacedDigit()
    }

    // MARK: Colour

    /// The window's deep base under every world (#140A2E).
    static let base = Color(.sRGB, red: 0.078, green: 0.039, blue: 0.18)
    /// Text on the world: white, and white at 60% for what's secondary.
    static let text = Color.white
    static let secondaryText = Color.white.opacity(0.62)
    static let tertiaryText = Color.white.opacity(0.42)

    /// Applyant's own accent on the world: a light lilac.
    static let accent = Color(.sRGB, red: 0.69, green: 0.58, blue: 1.0)
    static let violet = Color(.sRGB, red: 0.62, green: 0.40, blue: 1.0)
    static let magenta = Color(.sRGB, red: 0.86, green: 0.30, blue: 0.98)
    static let pink = Color(.sRGB, red: 1.0, green: 0.45, blue: 0.72)
    static let brandColors: [Color] = [magenta, violet]
    static let brand = LinearGradient(colors: brandColors, startPoint: .topLeading, endPoint: .bottomTrailing)
    /// Under white text (the primary buttons, your messages): deep enough to read on.
    static let brandFill = LinearGradient(
        colors: [Color(.sRGB, red: 0.76, green: 0.16, blue: 0.92), Color(.sRGB, red: 0.45, green: 0.22, blue: 0.95)],
        startPoint: .topLeading, endPoint: .bottomTrailing
    )
    /// The celebration's sparks.
    static let sparkColors: [Color] = [magenta, violet, pink, .orange, .mint, .yellow]

    static let warning = Color(.sRGB, red: 1.0, green: 0.68, blue: 0.30)
    static let good = Color(.sRGB, red: 0.38, green: 0.92, blue: 0.55)
    static let bad = Color(.sRGB, red: 1.0, green: 0.42, blue: 0.45)

    static func tint(_ tone: Chip.Tone) -> Color {
        switch tone {
        case .accent: accent
        case .warning: warning
        case .good: good
        case .neutral: secondaryText
        }
    }

    /// A score's colour on the red → amber → green ramp, bright enough for the dark world.
    static func score(_ score: Int32?) -> Color {
        guard let hue = ScoreScale.hue(score) else { return secondaryText }
        return Color(hue: hue, saturation: 0.66, brightness: 1.0)
    }

    /// A requirement's verdict: strong, partial, missing, or unknown.
    static func verdict(_ verdict: String) -> Color {
        switch verdict {
        case "strong": good
        case "missing": bad
        case "partial": warning
        default: secondaryText
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

    /// A company's own colour (its monogram, the hero's glow).
    static func company(_ name: String, shift: Double = 0) -> Color {
        let hue = (Monogram.hue(name) + shift).truncatingRemainder(dividingBy: 1)
        return Color(hue: hue, saturation: 0.6, brightness: 0.92)
    }

    // MARK: Worlds

    /// A section's colour world: the glow behind the window, its art, its selection.
    struct World: Equatable {
        let tone: WorldTone

        /// The world's own bright colour: a selection's edge, a badge, the live tile.
        var main: Color { Color(hue: tone.hue, saturation: tone.saturation * 0.78, brightness: 1) }
        var second: Color { Color(hue: tone.secondHue, saturation: tone.saturation * 0.85, brightness: 0.95) }
        /// The backdrop's glows, deep enough for white text on them.
        var glow: NSColor { NSColor(hue: tone.hue, saturation: min(1, tone.saturation * 1.1), brightness: 0.62, alpha: 1) }
        var secondGlow: NSColor { NSColor(hue: tone.secondHue, saturation: min(1, tone.saturation * 1.05), brightness: 0.5, alpha: 1) }
        var gradient: LinearGradient { LinearGradient(colors: [main, second], startPoint: .topLeading, endPoint: .bottomTrailing) }
    }

    static func world(_ section: ApplyantKit.Section) -> World { World(tone: WorldTone.of(section)) }

    /// A vivid world of its own hue (a live tile, a fallback's glass).
    static func world(hue: Double, saturation: Double = 0.8) -> World {
        World(tone: WorldTone(hue: hue, secondHue: (hue + 0.92).truncatingRemainder(dividingBy: 1), saturation: saturation))
    }

    // MARK: Glass

    /// A tile's glass over the world: white at a few percent (the world under it is a smooth
    /// glow, so a real blur would look the same and cost far more).
    static let glassFill = Color.white.opacity(0.07)
    static let glassFillHover = Color.white.opacity(0.11)
    /// Darker glass for long text: the words stay easy to read on any world.
    static let readingFill = Color(.sRGB, red: 0.04, green: 0.02, blue: 0.10, opacity: 0.42)
    /// A glass edge: lit along the top left, fading down the sides.
    static let glassEdge = LinearGradient(
        colors: [.white.opacity(0.30), .white.opacity(0.07), .white.opacity(0.04), .white.opacity(0.14)],
        startPoint: .topLeading, endPoint: .bottomTrailing
    )
    /// A block inside a tile.
    static let insetFill = Color.white.opacity(0.06)
    static let hairline = Color.white.opacity(0.10)
    static let shadow = Color.black.opacity(0.35)
    /// Behind a toast or a menu over the world.
    static let toastFill = Color(.sRGB, red: 0.13, green: 0.07, blue: 0.27, opacity: 0.92)

    // MARK: Motion

    enum Motion {
        /// Taps, toggles, the tab pill, the rail's pill.
        static let snappy = Animation.spring(duration: 0.32, bounce: 0.2)
        /// Content changing place: lists, the detail.
        static let smooth = Animation.smooth(duration: 0.4)
        /// Something arriving: chips, the toast.
        static let bouncy = Animation.spring(duration: 0.5, bounce: 0.32)
        /// Tiles making room for each other.
        static let morph = Animation.spring(duration: 0.7, bounce: 0.18)
        /// The score ring filling, numbers counting up.
        static let gauge = Animation.spring(duration: 1.1, bounce: 0.08)
        /// One world fading into the next.
        static let world = Animation.easeInOut(duration: 0.9)
        /// With Reduce Motion: things fade, nothing moves.
        static let fade = Animation.easeInOut(duration: 0.2)

        static func pick(_ animation: Animation, reduceMotion: Bool) -> Animation {
            reduceMotion ? fade : animation
        }
    }
}

extension Color {
    /// One colour for the light appearance and one for the dark (the window is always dark;
    /// a few system surfaces, like the menu bar's menu, follow the system).
    init(light: NSColor, dark: NSColor) {
        self.init(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
        })
    }
}
