// The app's look in one place: spacing, radii, type, colours (the window's colour worlds, the
// score ramp, the brand gradient, chip and verdict tints) and the springs everything moves
// with. The window is always one deep navy world (cobalt glows drifting on it, one of them
// tinted by the section that's open), so the colours here are made for it; tiles are
// translucent glass over it, and colour lives in the 3D art and small accents. Views use these
// instead of their own numbers, so the visual language is changed here. The shared pieces built
// from them are in Components.swift, text in Reading.swift, figures and metrics in Figures.swift,
// the motion in Motion.swift and Ambient.swift.
import AppKit
import ApplyantKit
import SwiftUI

enum Theme {
    // MARK: Spacing and shape

    /// The spacing scale: every gap is one of these.
    enum Space {
        static let xxs: CGFloat = 2, xs: CGFloat = 4, s: CGFloat = 8, m: CGFloat = 12, l: CGFloat = 16, xl: CGFloat = 24, xxl: CGFloat = 32
    }

    /// Around a page or a tab (Home included), and between its blocks (Home's grid gap too).
    static let pagePadding: CGFloat = 20
    static let blockSpacing: CGFloat = 16
    /// Inside a card or a tile: one inset everywhere, and the gap between its rows.
    static let cardPadding: CGFloat = 16
    static let rowSpacing: CGFloat = 8
    /// Between paragraphs of running text (8 in a compact one).
    static let paragraphSpacing: CGFloat = 12
    /// A glass card's or tile's corners.
    static let cornerRadius: CGFloat = 18
    /// A list column's cards and Up next's rows: the panel's 24 less their 10 pt inset.
    static let rowRadius: CGFloat = 14
    /// Blocks inside a card (a fact, a Callout) and text fields.
    static let innerRadius: CGFloat = 10
    /// The list column's panel, the job's hero and Home's metrics panel.
    static let panelRadius: CGFloat = 24
    /// The widest a page's or a tab's column gets.
    static let pageWidth: CGFloat = 820
    /// Running text at 14 pt: about 75 Latin (65 Cyrillic) characters a line.
    static let measure: CGFloat = 540
    /// A lead sentence at 17 pt: about 75 characters.
    static let leadMeasure: CGFloat = 600
    /// EvidenceRow's right column ("4 facts ›", "Sep 2021").
    static let marginColumn: CGFloat = 132
    /// LabeledRow's label column.
    static let labelColumn: CGFloat = 200
    /// Kept for the views that name them: a page's width and running text's.
    static let readableWidth: CGFloat = pageWidth
    static let proseWidth: CGFloat = measure
    /// The rail of sections on the left.
    static let railWidth: CGFloat = 74

    // MARK: Type

    /// Home's greeting and the job's title.
    static let displayTitle = Font.system(size: 28, weight: .bold)
    static let heroTitle = Font.system(size: 28, weight: .bold)
    /// A section's own title over its list ("To review") and a page's title.
    static let moduleTitle = Font.system(size: 22, weight: .bold)
    static let pageTitle = Font.system(size: 22, weight: .bold)
    static let cardTitle = Font.system(size: 14, weight: .semibold)
    /// A tile's label, top left ("Ready to send").
    static let tileLabel = Font.system(size: 12, weight: .semibold)
    /// Nothing is smaller than 11 points.
    static let caption = Font.system(size: 11, weight: .medium)
    /// Above a group of rows: small, spaced capitals.
    static let eyebrow = Font.system(size: 11, weight: .bold)
    /// Running text.
    static let prose = Font.system(size: 14)

    /// Scores and counts: rounded, with even digits.
    static func number(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        .system(size: size, weight: weight, design: .rounded).monospacedDigit()
    }

    /// Every Home tile's figure (the funnel's too), and a metric card's or the panel's funnel.
    static let figure = number(FigureSize.large.pointSize)
    static let figureSmall = number(FigureSize.small.pointSize)

    /// A figure's two sizes. `capHeight` is what chevrons and connectors centre on (figureMid).
    enum FigureSize {
        case large, small

        var pointSize: CGFloat { self == .large ? 36 : 24 }
        var font: Font { Theme.number(pointSize) }
        var capHeight: CGFloat { NSFont.systemFont(ofSize: pointSize, weight: .bold).capHeight }
    }

    /// The type scale: twelve roles on eight text sizes, nothing under 11 points. Hierarchy comes
    /// from size and weight first, colour second; sentences are never tertiary, amber or green.
    enum TextRole: CaseIterable {
        /// Home's greeting, the job's title.
        case display
        /// Module and page titles.
        case title
        /// The one-sentence take on a page.
        case lead
        /// Card titles, Up next, a panel's header, StatStrip's values.
        case heading
        /// A list column's row.
        case rowTitle
        /// Paragraphs: a description, an answer, mail, a company.
        case prose
        /// A short name in a card: a metric, a field's label, a question.
        case itemTitle
        /// Sentence-length claims, values, short text.
        case body
        /// Reasons, subtitles, captions, dates: one line.
        case meta
        /// Tile labels, goal lines.
        case label
        /// Group headers, key facts' labels, a finding's date: spaced capitals.
        case eyebrow
        /// A chip's words.
        case chip

        var font: Font {
            switch self {
            case .display: .system(size: 28, weight: .bold)
            case .title: .system(size: 22, weight: .bold)
            case .lead: .system(size: 17, weight: .medium)
            case .heading: .system(size: 15, weight: .semibold)
            case .rowTitle: .system(size: 14, weight: .semibold)
            case .prose: .system(size: 14)
            case .itemTitle: .system(size: 13, weight: .semibold)
            case .body: .system(size: 13)
            case .meta: .system(size: 12)
            case .label: .system(size: 12, weight: .semibold)
            case .eyebrow: .system(size: 11, weight: .bold)
            case .chip: .system(size: 11, weight: .semibold)
            }
        }

        var color: Color {
            switch self {
            case .meta, .label, .eyebrow: Theme.secondaryText
            case .chip: Theme.chipText(.neutral)
            default: Theme.text
            }
        }

        var lineSpacing: CGFloat {
            switch self {
            case .lead: 4
            case .rowTitle: 1
            case .prose: 5
            case .itemTitle, .body: 2
            default: 0
            }
        }

        var tracking: CGFloat { self == .eyebrow ? 0.8 : 0 }
    }

    // MARK: Colour

    /// The deepest navy, where the window settles at its foot (#070B1A).
    static let deepest = Color(hex: 0x070B1A)
    /// The window's base under every world (#0B1430).
    static let base = Color(hex: 0x0B1430)
    /// A surface raised off the base: a toast, a menu (#12224A).
    static let raised = Color(hex: 0x12224A)

    /// Text on the world, measured (WCAG) on every surface it sits on, the picked card (#303973)
    /// the brightest of them:
    /// - `text`, near-white: 16.7:1 on the base, 9.8:1 on a picked card;
    /// - `secondaryText` (meta, reasons, labels): 6.76:1 on a card, at least 5.17:1 anywhere;
    /// - `tertiaryText` (timestamps and counts only, one line, never a sentence): 7.91:1 on the
    ///   base, 5.10:1 on a card, 4.88:1 on an amber wash, at least 4.67:1 on a picked card.
    /// With Increase Contrast secondary text is primary and tertiary rises to #C9D1E6.
    static let text = Color(hex: 0xF2F5FF)
    static let secondaryText = adaptive(NSColor(hex: 0xA9B4D0), contrast: NSColor(hex: 0xF2F5FF))
    static let tertiaryText = adaptive(NSColor(hex: 0xA0ABC8), contrast: NSColor(hex: 0xC9D1E6))
    /// Chevrons, connectors, disclosure arrows: non-text only (3.4:1 or more), never words.
    static let glyph = adaptive(NSColor(hex: 0x8591B0), contrast: NSColor(hex: 0xA9B4D0))

    /// The one interaction accent: a prominent button, the picked tab, row or field, under white
    /// text (5.5:1). Never decoration.
    static let accentFill = Color(hex: 0x2F5BEA)
    /// The accent as text on the world: links, a card's symbol (6.3:1 on a card).
    static let accent = Color(hex: 0x7AA2FF)
    /// The world's own blues: cobalt under everything, a little teal and indigo drifting in it.
    static let cobalt = Color(hex: 0x1E3A8A)
    static let teal = Color(hex: 0x0E7490)
    static let indigo = Color(hex: 0x312E81)
    /// Kept for the views that still name them: the blues that took the old violet and magenta's
    /// place (no pink or violet in the chrome).
    static let violet = accentFill
    static let magenta = accent
    static let pink = Color(hex: 0x7DD3FC)
    static let brandColors: [Color] = [accent, accentFill]
    static let brand = LinearGradient(colors: brandColors, startPoint: .topLeading, endPoint: .bottomTrailing)
    /// Under white text (the primary buttons, your messages): the accent, flat.
    static let brandFill = LinearGradient(colors: [accentFill, accentFill], startPoint: .top, endPoint: .bottom)
    /// The celebration's sparks: the one moment that's allowed to be festive.
    static let sparkColors: [Color] = [accent, good, warning, pink, .white, accentFill]

    static let warning = Color(hex: 0xFBBF24)
    static let good = Color(hex: 0x34D399)
    static let bad = Color(hex: 0xF87171)

    static func tint(_ tone: Chip.Tone) -> Color {
        switch tone {
        case .accent: accent
        case .warning: warning
        case .good: good
        case .neutral: secondaryText
        }
    }

    /// A chip's words in its tone: a lighter shade of the tint, at least 6.8:1 on the chip's
    /// tinted fill over any card or a picked row (the tint itself is too dark for 11 points).
    static func chipText(_ tone: Chip.Tone) -> Color {
        switch tone {
        case .accent: Color(hex: 0xC7D7FF)
        case .warning: Color(hex: 0xFCD34D)
        case .good: Color(hex: 0x6EE7B7)
        case .neutral: adaptive(NSColor(hex: 0xC9D1E6), contrast: NSColor(hex: 0xF2F5FF))
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

    /// A section's colour world: one soft glow behind the window, its art and its small accents
    /// (a badge, a group's header). Selection is always the interaction accent.
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

    /// A tile's glass over the world: white at 6% (the world under it is a smooth glow, so a
    /// real blur would look the same and cost far more). With Reduce Transparency: opaque.
    static let glassFill = adaptive(NSColor.white.withAlphaComponent(0.06), opaque: NSColor(hex: 0x141C36))
    /// Raised glass: under the pointer, or a block that stands out.
    static let glassFillHover = adaptive(NSColor.white.withAlphaComponent(0.09), opaque: NSColor(hex: 0x1A2442))
    /// Darker glass for long text: the words stay easy to read on any world.
    static let readingFill = adaptive(NSColor(hex: 0x070B1A).withAlphaComponent(0.45), opaque: NSColor(hex: 0x0E1529))
    /// A glass edge: a 1 px hairline, a little brighter along the top (20% with Increase Contrast).
    static let glassEdge = LinearGradient(colors: [topEdge, hairline, hairline], startPoint: .top, endPoint: .bottom)
    private static let topEdge = adaptive(NSColor.white.withAlphaComponent(0.15), contrast: NSColor.white.withAlphaComponent(0.26))
    /// A block inside a tile.
    static let insetFill = adaptive(NSColor.white.withAlphaComponent(0.05), opaque: NSColor(hex: 0x182140))
    static let hairline = adaptive(NSColor.white.withAlphaComponent(0.10), contrast: NSColor.white.withAlphaComponent(0.20))
    /// A neutral chip's fill.
    static let chipNeutralFill = adaptive(NSColor.white.withAlphaComponent(0.07), contrast: NSColor.white.withAlphaComponent(0.14), opaque: NSColor(hex: 0x1E2846))
    /// The round button's disc while it can't be pressed.
    static let discFill = adaptive(NSColor.white.withAlphaComponent(0.10), opaque: NSColor(hex: 0x1A2442))
    static let shadow = Color.black.opacity(0.35)
    /// Behind a toast or a menu over the world.
    static let toastFill = adaptive(NSColor(hex: 0x12224A).withAlphaComponent(0.96), opaque: NSColor(hex: 0x12224A))

    /// A colour that follows the display's accessibility settings: `contrast` with Increase
    /// Contrast, `opaque` with Reduce Transparency, else `normal`.
    static func adaptive(_ normal: NSColor, contrast: NSColor? = nil, opaque: NSColor? = nil) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            if let opaque, NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency { return opaque }
            let high = appearance.bestMatch(from: [.darkAqua, .accessibilityHighContrastDarkAqua, .aqua, .accessibilityHighContrastAqua])
            if let contrast, high == .accessibilityHighContrastDarkAqua || high == .accessibilityHighContrastAqua { return contrast }
            return normal
        })
    }

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
    /// A colour written the way designers write it: 0x0B1430.
    init(hex: UInt32) { self.init(nsColor: NSColor(hex: hex)) }

    /// One colour for the light appearance and one for the dark (the window is always dark;
    /// a few system surfaces, like the menu bar's menu, follow the system).
    init(light: NSColor, dark: NSColor) {
        self.init(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
        })
    }
}

extension NSColor {
    convenience init(hex: UInt32) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}
