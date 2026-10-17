// What moves all the time, done by Core Animation instead of SwiftUI: the window's drifting
// glow, a live tile's own glow, the 3D art floating, the round button's halo and the ring that
// circles it while work runs. Core Animation plays these in the render server, so an idle
// window costs the app no CPU; SwiftUI would redraw every frame. They stop (paused where they
// are) while the window isn't in front or with Reduce Motion, and never take a click.
import AppKit
import ApplyantKit
import QuartzCore
import SwiftUI

// MARK: - Pausing

extension CALayer {
    /// Holds the layer's animations where they are.
    func pauseAnimations() {
        guard speed != 0 else { return }
        let now = convertTime(CACurrentMediaTime(), from: nil)
        speed = 0
        timeOffset = now
    }

    /// Lets them go on from where they were held.
    func resumeAnimations() {
        guard speed == 0 else { return }
        let held = timeOffset
        speed = 1
        timeOffset = 0
        beginTime = 0
        beginTime = convertTime(CACurrentMediaTime(), from: nil) - held
    }

    func setAnimations(running: Bool) { running ? resumeAnimations() : pauseAnimations() }
}

/// A layer-hosting view that clicks go through.
class AmbientView: NSView {
    override init(frame: NSRect) {
        super.init(frame: frame)
        layer = CALayer()
        wantsLayer = true
        layer?.masksToBounds = false
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var isFlipped: Bool { true }
}

/// A slow back-and-forth of one of a layer's values, never quite in step with the others.
private func drift(_ keyPath: String, from: Any, to: Any, duration: Double, delay: Double = 0) -> CABasicAnimation {
    let a = CABasicAnimation(keyPath: keyPath)
    a.fromValue = from
    a.toValue = to
    a.duration = duration
    a.autoreverses = true
    a.repeatCount = .infinity
    a.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    a.beginTime = CACurrentMediaTime() - delay
    a.isRemovedOnCompletion = false
    return a
}

// MARK: - The glow

/// Soft light blobs on a deep base, drifting slowly: the window's world behind every column
/// (`GlowField(world:)`), or a live tile's own vivid one. A new world's colours fade in.
struct GlowField: NSViewRepresentable {
    var base: NSColor = NSColor(Theme.base)
    /// The blobs' colours, brightest first.
    let colors: [NSColor]
    var moving = true
    /// How strong the glow is over the base.
    var intensity: Double = 1

    init(world: Theme.World, moving: Bool) {
        // The world's two glows and, always, a little of Applyant's violet-magenta.
        let violet = NSColor(srgbRed: 0.42, green: 0.16, blue: 0.78, alpha: 1)
        let magenta = NSColor(srgbRed: 0.62, green: 0.14, blue: 0.70, alpha: 1)
        colors = [world.glow, violet, world.secondGlow, magenta]
        self.moving = moving
    }

    init(base: NSColor, colors: [NSColor], moving: Bool, intensity: Double = 1) {
        self.base = base
        self.colors = colors
        self.moving = moving
        self.intensity = intensity
    }

    func makeNSView(context: Context) -> GlowFieldView { GlowFieldView() }

    func updateNSView(_ view: GlowFieldView, context: Context) {
        // A held layer holds a fade too: while still, a new world is simply there.
        view.apply(base: base, colors: colors, intensity: intensity, animated: moving && view.hasColors)
        view.setMoving(moving)
    }
}

final class GlowFieldView: AmbientView {
    private let baseLayer = CALayer()
    private var blobs: [CAGradientLayer] = []
    private(set) var hasColors = false
    private var drifting = false

    /// Where each blob sits (its centre, in the view's unit square) and how big it is (of the
    /// view's longer side), and how far and how slowly it wanders.
    private static let places: [(x: CGFloat, y: CGFloat, size: CGFloat, wander: CGFloat, period: Double)] = [
        (0.18, 0.05, 1.25, 0.10, 23),
        (0.92, 0.12, 1.0, 0.12, 29),
        (0.80, 1.0, 1.15, 0.09, 31),
        (0.05, 0.92, 0.9, 0.11, 37),
    ]

    override init(frame: NSRect) {
        super.init(frame: frame)
        layer?.masksToBounds = true
        layer?.addSublayer(baseLayer)
        for _ in Self.places {
            let blob = CAGradientLayer()
            blob.type = .radial
            blob.startPoint = CGPoint(x: 0.5, y: 0.5)
            blob.endPoint = CGPoint(x: 1, y: 1)
            blob.locations = [0, 0.38, 1]
            layer?.addSublayer(blob)
            blobs.append(blob)
        }
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        baseLayer.frame = bounds
        let side = max(bounds.width, bounds.height)
        for (blob, place) in zip(blobs, Self.places) {
            let size = side * place.size
            blob.bounds = CGRect(x: 0, y: 0, width: size, height: size * 0.82)
            blob.position = CGPoint(x: bounds.width * place.x, y: bounds.height * place.y)
        }
        CATransaction.commit()
    }

    private var applied: [NSColor] = []

    func apply(base: NSColor, colors: [NSColor], intensity: Double, animated: Bool) {
        // Every redraw of the window asks again: only a new world changes anything.
        let wanted = [base.withAlphaComponent(CGFloat(intensity))] + colors
        guard wanted != applied else { return }
        applied = wanted
        CATransaction.begin()
        CATransaction.setAnimationDuration(animated ? 0.9 : 0)
        CATransaction.setDisableActions(!animated)
        baseLayer.backgroundColor = base.cgColor
        for (i, blob) in blobs.enumerated() {
            // A fade held half-way (the window went to the back) mustn't hide the new colours.
            if !animated { blob.removeAnimation(forKey: "colors") }
            let color = colors[i % max(colors.count, 1)]
            let strength = (i == 0 ? 0.95 : i == 1 ? 0.7 : 0.75) * intensity
            blob.colors = [
                color.withAlphaComponent(strength).cgColor,
                color.withAlphaComponent(strength * 0.55).cgColor,
                color.withAlphaComponent(0).cgColor,
            ]
        }
        CATransaction.commit()
        hasColors = true
    }

    func setMoving(_ moving: Bool) {
        let moving = moving && ProcessInfo.processInfo.environment["BISECT_NOGLOW"] == nil
        if moving && !drifting {
            drifting = true
            for (i, (blob, place)) in zip(blobs, Self.places).enumerated() {
                guard blob.animation(forKey: "x") == nil else { continue }
                let side = max(bounds.width, bounds.height, 800)
                let d = side * place.wander
                blob.add(drift("transform.translation.x", from: -d, to: d, duration: place.period, delay: Double(i) * 5), forKey: "x")
                blob.add(drift("transform.translation.y", from: d * 0.7, to: -d * 0.7, duration: place.period * 1.37, delay: Double(i) * 3), forKey: "y")
                blob.add(drift("transform.scale", from: 0.92, to: 1.1, duration: place.period * 0.83, delay: Double(i) * 7), forKey: "scale")
            }
        }
        layer?.setAnimations(running: moving)
    }
}

/// Film grain over the world, so its glow reads as light and not as a flat gradient.
struct Grain: View {
    var opacity: Double = 0.05

    var body: some View {
        Image(nsImage: Self.tile)
            .resizable(resizingMode: .tile)
            .opacity(opacity)
            .blendMode(.overlay)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    /// Made once: 160 points of random grey specks.
    @MainActor static let tile: NSImage = {
        let side = 160
        var generator = SystemRandomNumberGenerator()
        var pixels = [UInt8](repeating: 0, count: side * side * 4)
        for i in 0..<(side * side) {
            let v = UInt8.random(in: 0...255, using: &generator)
            pixels[i * 4] = v
            pixels[i * 4 + 1] = v
            pixels[i * 4 + 2] = v
            pixels[i * 4 + 3] = 255
        }
        let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side, bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: side * 4, bitsPerPixel: 32
        )!
        pixels.withUnsafeBytes { raw in
            if let data = rep.bitmapData, let src = raw.baseAddress { memcpy(data, src, raw.count) }
        }
        let image = NSImage(size: NSSize(width: side, height: side))
        image.addRepresentation(rep)
        return image
    }()
}

/// The whole window's world: the section's glow drifting on the deep base, and the grain.
struct WorldBackground: View {
    let section: ApplyantKit.Section
    private let motion = EndlessMotion()

    var body: some View {
        ZStack {
            GlowField(world: Theme.world(section), moving: motion.ambient)
            // The bottom of the window settles darker, the way a lit room does.
            LinearGradient(colors: [.clear, Theme.base.opacity(0.35)], startPoint: .center, endPoint: .bottom)
            Grain()
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

// MARK: - Floating art

/// A picture that floats: a slow bob and sway, and a tilt of a few degrees towards the pointer.
struct FloatingImage: NSViewRepresentable {
    let image: CGImage
    var floats = true
    /// -1…1 on each axis: where the pointer is over the picture's tile.
    var tilt: CGPoint = .zero
    /// How far it bobs, of its size.
    var lift: CGFloat = 0.035

    func makeNSView(context: Context) -> FloatingImageView { FloatingImageView() }

    func updateNSView(_ view: FloatingImageView, context: Context) {
        view.show(image)
        view.lift = lift
        view.setFloating(floats)
        view.setTilt(tilt)
    }
}

final class FloatingImageView: AmbientView {
    private let holder = CALayer()
    private let picture = CALayer()
    private var shown: CGImage?
    private var floating = false
    private var floatHeight: CGFloat = 0
    var lift: CGFloat = 0.035

    override init(frame: NSRect) {
        super.init(frame: frame)
        layer?.addSublayer(holder)
        holder.addSublayer(picture)
        picture.contentsGravity = .resizeAspect
        picture.minificationFilter = .trilinear
        var perspective = CATransform3DIdentity
        perspective.m34 = -1 / 600
        layer?.sublayerTransform = perspective
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        holder.bounds = bounds
        holder.position = CGPoint(x: bounds.midX, y: bounds.midY)
        picture.frame = holder.bounds
        picture.contentsScale = window?.backingScaleFactor ?? 2
        CATransaction.commit()
        // The bob's distance follows the size (a tile growing).
        if floating && abs(bounds.height - floatHeight) > 8 { restartFloat() }
    }

    func show(_ image: CGImage) {
        guard image !== shown else { return }
        shown = image
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        picture.contents = image
        CATransaction.commit()
    }

    func setFloating(_ on: Bool) {
        let on = on && ProcessInfo.processInfo.environment["BISECT_NOART"] == nil
        if on && !floating {
            floating = true
            restartFloat()
        }
        picture.setAnimations(running: on)
    }

    private func restartFloat() {
        floatHeight = bounds.height
        let d = max(bounds.height, 40) * lift
        picture.removeAnimation(forKey: "bob")
        picture.removeAnimation(forKey: "sway")
        let phase = Double(abs(ObjectIdentifier(self).hashValue % 40)) / 10
        picture.add(drift("transform.translation.y", from: d, to: -d, duration: 3.6, delay: phase), forKey: "bob")
        picture.add(drift("transform.rotation.z", from: -0.022, to: 0.022, duration: 5.3, delay: phase * 1.3), forKey: "sway")
    }

    func setTilt(_ tilt: CGPoint) {
        var t = CATransform3DIdentity
        // A few degrees towards the pointer: the side under it comes forward.
        t = CATransform3DRotate(t, tilt.x * 0.16, 0, 1, 0)
        t = CATransform3DRotate(t, -tilt.y * 0.16, 1, 0, 0)
        let scale = tilt == .zero ? 1 : 1.04
        t = CATransform3DScale(t, scale, scale, 1)
        CATransaction.begin()
        CATransaction.setAnimationDuration(0.35)
        CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .easeOut))
        holder.transform = t
        CATransaction.commit()
    }
}

// MARK: - The halo and the ring

/// A soft glow around a round button that breathes in and out.
struct Halo: NSViewRepresentable {
    let color: NSColor
    var breathing = true

    func makeNSView(context: Context) -> HaloView { HaloView() }

    func updateNSView(_ view: HaloView, context: Context) {
        view.color = color
        view.setBreathing(breathing)
    }
}

final class HaloView: AmbientView {
    private let glow = CAGradientLayer()
    private var started = false
    var color: NSColor = .magenta {
        didSet {
            glow.colors = [color.withAlphaComponent(0.75).cgColor, color.withAlphaComponent(0.32).cgColor, color.withAlphaComponent(0).cgColor]
        }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        glow.type = .radial
        glow.startPoint = CGPoint(x: 0.5, y: 0.5)
        glow.endPoint = CGPoint(x: 1, y: 1)
        glow.locations = [0.3, 0.55, 1]
        layer?.addSublayer(glow)
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        glow.frame = bounds
        CATransaction.commit()
    }

    func setBreathing(_ on: Bool) {
        if on && !started {
            started = true
            glow.add(drift("transform.scale", from: 0.9, to: 1.06, duration: 2.2), forKey: "breathe")
            glow.add(drift("opacity", from: 0.65, to: 1, duration: 2.2), forKey: "glow")
        }
        layer?.setAnimations(running: on)
    }
}

/// A bright arc circling a round button while work runs (ClearVPN's "connecting").
struct SpinningRing: NSViewRepresentable {
    let colors: [NSColor]
    var lineWidth: CGFloat = 3
    var spinning = true

    func makeNSView(context: Context) -> SpinningRingView { SpinningRingView() }

    func updateNSView(_ view: SpinningRingView, context: Context) {
        view.configure(colors: colors, lineWidth: lineWidth)
        view.setSpinning(spinning)
    }
}

final class SpinningRingView: AmbientView {
    private let sweep = CAGradientLayer()
    private let arc = CAShapeLayer()
    private var started = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        sweep.type = .conic
        sweep.startPoint = CGPoint(x: 0.5, y: 0.5)
        sweep.endPoint = CGPoint(x: 0.5, y: 0)
        arc.fillColor = nil
        arc.strokeColor = NSColor.white.cgColor
        arc.lineCap = .round
        arc.strokeStart = 0
        arc.strokeEnd = 0.7
        sweep.mask = arc
        layer?.addSublayer(sweep)
    }

    func configure(colors: [NSColor], lineWidth: CGFloat) {
        // Clear at the arc's tail, bright at its head.
        sweep.colors = [colors.first?.withAlphaComponent(0).cgColor ?? NSColor.clear.cgColor] + colors.map(\.cgColor)
        arc.lineWidth = lineWidth
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        sweep.frame = bounds
        arc.frame = sweep.bounds
        let inset = arc.lineWidth / 2
        arc.path = CGPath(ellipseIn: bounds.insetBy(dx: inset, dy: inset), transform: nil)
        CATransaction.commit()
    }

    func setSpinning(_ on: Bool) {
        if on && !started {
            started = true
            let spin = CABasicAnimation(keyPath: "transform.rotation.z")
            spin.fromValue = 0
            spin.toValue = CGFloat.pi * 2
            spin.duration = 1.6
            spin.repeatCount = .infinity
            spin.isRemovedOnCompletion = false
            sweep.add(spin, forKey: "spin")
        }
        layer?.setAnimations(running: on)
    }
}

// MARK: - A breathing dot, a sweeping sheen

/// A dot with a soft ring that breathes: LiveDot's.
struct BreathingDot: NSViewRepresentable {
    let color: NSColor
    var breathing = true

    func makeNSView(context: Context) -> BreathingDotView { BreathingDotView() }

    func updateNSView(_ view: BreathingDotView, context: Context) {
        view.color = color
        view.setBreathing(breathing)
    }
}

final class BreathingDotView: AmbientView {
    private let ring = CALayer()
    private let dot = CALayer()
    private var started = false
    var color: NSColor = .white {
        didSet {
            guard color != oldValue else { return }
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            dot.backgroundColor = color.cgColor
            ring.backgroundColor = color.withAlphaComponent(0.35).cgColor
            CATransaction.commit()
        }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        layer?.addSublayer(ring)
        layer?.addSublayer(dot)
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        ring.frame = bounds
        ring.cornerRadius = bounds.width / 2
        let side = bounds.width / 2.2
        dot.frame = CGRect(x: bounds.midX - side / 2, y: bounds.midY - side / 2, width: side, height: side)
        dot.cornerRadius = side / 2
        CATransaction.commit()
    }

    func setBreathing(_ on: Bool) {
        if on && !started {
            started = true
            dot.add(drift("opacity", from: 1, to: 0.35, duration: 0.8), forKey: "breathe")
            ring.add(drift("transform.scale", from: 0.6, to: 1, duration: 0.8), forKey: "ring")
            ring.add(drift("opacity", from: 0.9, to: 0.2, duration: 0.8), forKey: "fade")
        }
        layer?.setAnimations(running: on)
    }
}

/// A band of light sweeping across a card while its work runs.
struct SheenBand: NSViewRepresentable {
    var radius: CGFloat

    func makeNSView(context: Context) -> SheenBandView { SheenBandView() }

    func updateNSView(_ view: SheenBandView, context: Context) {
        view.layer?.cornerRadius = radius
        view.layer?.cornerCurve = .continuous
    }
}

final class SheenBandView: AmbientView {
    private let band = CAGradientLayer()
    private var width: CGFloat = 0

    override init(frame: NSRect) {
        super.init(frame: frame)
        layer?.masksToBounds = true
        band.startPoint = CGPoint(x: 0, y: 0.5)
        band.endPoint = CGPoint(x: 1, y: 0.5)
        band.colors = [
            NSColor.clear.cgColor,
            NSColor(Theme.magenta).withAlphaComponent(0.16).cgColor,
            NSColor.white.withAlphaComponent(0.12).cgColor,
            NSColor(Theme.violet).withAlphaComponent(0.14).cgColor,
            NSColor.clear.cgColor,
        ]
        band.transform = CATransform3DMakeRotation(-0.2, 0, 0, 1)
        layer?.addSublayer(band)
    }

    override func layout() {
        super.layout()
        guard abs(bounds.width - width) > 1 else { return }
        width = bounds.width
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        band.bounds = CGRect(x: 0, y: 0, width: bounds.width * 0.6, height: bounds.height * 2)
        band.position = CGPoint(x: -bounds.width * 0.4, y: bounds.midY)
        CATransaction.commit()
        let sweep = CABasicAnimation(keyPath: "position.x")
        sweep.fromValue = -bounds.width * 0.4
        sweep.toValue = bounds.width * 1.4
        sweep.duration = 2.4
        sweep.repeatCount = .infinity
        sweep.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        sweep.isRemovedOnCompletion = false
        band.add(sweep, forKey: "sweep")
    }
}
