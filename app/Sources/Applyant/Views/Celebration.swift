// A moment after a job is dealt with. Sent: the success art springs in over the window with a
// halo and sparks, "Sent to Kalepa", for a second and a half while the next job opens under
// it. Skipped: "Skipped" with an Undo, floating over the bottom of the window for a few
// seconds. The window owns one Toasts; the job header posts to it.
import ApplyantKit
import Observation
import SwiftUI

@MainActor @Observable
final class Toasts {
    struct Toast: Identifiable {
        let id = UUID()
        let systemImage: String
        let title: String
        var detail: String?
        /// Something was sent: the big moment instead of a toast.
        var celebrates = false
        var undo: (@MainActor () -> Void)?
    }

    private(set) var current: Toast?
    /// The big moment on screen (a toast that celebrates).
    private(set) var moment: Toast?
    private var dismissal: Task<Void, Never>?
    private var momentEnd: Task<Void, Never>?

    func show(_ toast: Toast, for seconds: Double = 3.5) {
        if toast.celebrates {
            moment = toast
            momentEnd?.cancel()
            momentEnd = Task { [weak self] in
                guard (try? await Task.sleep(for: .seconds(2.2))) != nil else { return }
                self?.moment = nil
            }
            return
        }
        current = toast
        dismissal?.cancel()
        dismissal = Task { [weak self] in
            guard (try? await Task.sleep(for: .seconds(seconds))) != nil else { return }
            self?.current = nil
        }
    }

    func dismiss() {
        dismissal?.cancel()
        current = nil
    }

    func endMoment() {
        momentEnd?.cancel()
        moment = nil
    }
}

/// The toast itself, along the bottom of the window.
struct ToastHost: View {
    let toasts: Toasts
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            if let toast = toasts.current {
                ToastView(toast: toast) { toasts.dismiss() }
                    .id(toast.id)
                    .transition(reduceMotion
                        ? .opacity
                        : .asymmetric(
                            insertion: .move(edge: .bottom).combined(with: .scale(scale: 0.85)).combined(with: .opacity),
                            removal: .opacity.combined(with: .scale(scale: 0.95))
                        ))
            }
        }
        .animation(Theme.Motion.pick(Theme.Motion.bouncy, reduceMotion: reduceMotion), value: toasts.current?.id)
        .padding(.bottom, 22)
    }
}

private struct ToastView: View {
    let toast: Toasts.Toast
    let close: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: toast.systemImage)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white.opacity(0.85))
                .frame(width: 30, height: 30)
                .background(Circle().fill(Color.white.opacity(0.1)))
            VStack(alignment: .leading, spacing: 1) {
                Text(toast.title).font(.system(size: 13.5, weight: .bold)).foregroundStyle(.white)
                if let detail = toast.detail {
                    Text(detail).font(.caption).foregroundStyle(Theme.secondaryText).lineLimit(1)
                }
            }
            if let undo = toast.undo {
                Button("Undo") {
                    undo()
                    close()
                }
                .buttonStyle(.secondary)
                .controlSize(.small)
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, 16)
        .padding(.vertical, 9)
        // Over busy text: mostly solid, with a little of the world showing through.
        .background(Capsule().fill(Theme.toastFill))
        .overlay(Capsule().strokeBorder(Theme.glassEdge, lineWidth: 1))
        .shadow(color: .black.opacity(0.4), radius: 20, y: 8)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
    }
}

/// The big moment over the window: the world dims, a halo opens, the success art springs in
/// with sparks around it, and the line says where it went. A click ends it early.
struct MomentHost: View {
    let toasts: Toasts
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            if let moment = toasts.moment {
                MomentView(moment: moment)
                    .id(moment.id)
                    .transition(.opacity)
                    .onTapGesture { toasts.endMoment() }
            }
        }
        .animation(Theme.Motion.pick(.easeInOut(duration: 0.35), reduceMotion: reduceMotion), value: toasts.moment?.id)
        .allowsHitTesting(toasts.moment != nil)
    }
}

private struct MomentView: View {
    let moment: Toasts.Toast
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            // The world dims, darkest in the middle where the moment is.
            RadialGradient(colors: [Theme.base.opacity(0.92), Theme.base.opacity(0.7)], center: .center, startRadius: 60, endRadius: 700)
                .ignoresSafeArea()
            VStack(spacing: 18) {
                ZStack {
                    // The halo opening out, and a second, fainter one after it.
                    ForEach(0..<2) { ring in
                        Circle()
                            .strokeBorder(Theme.good.opacity(0.7 - Double(ring) * 0.3), lineWidth: 3)
                            .frame(width: 180, height: 180)
                            .scaleEffect(shown && !reduceMotion ? 1.9 + Double(ring) * 0.5 : 0.6)
                            .opacity(shown ? 0 : 1)
                            .animation(.easeOut(duration: 1.1).delay(Double(ring) * 0.18), value: shown)
                    }
                    Circle()
                        .fill(RadialGradient(colors: [Theme.good.opacity(0.55), .clear], center: .center, startRadius: 10, endRadius: 150))
                        .frame(width: 300, height: 300)
                        .opacity(shown ? 1 : 0)
                    Sparks(size: 190, count: 16)
                    ArtView(.success, size: 190, tilts: false)
                        .scaleEffect(shown || reduceMotion ? 1 : 0.3)
                        .rotationEffect(.degrees(shown || reduceMotion ? 0 : -14))
                }
                VStack(spacing: 5) {
                    Text(moment.title)
                        .font(.system(size: 30, weight: .bold))
                        .foregroundStyle(.white)
                        .shadow(color: Theme.good.opacity(0.4), radius: 12)
                    if let detail = moment.detail {
                        Text(detail).font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.secondaryText)
                    }
                }
                .multilineTextAlignment(.center)
                .offset(y: shown || reduceMotion ? 0 : 16)
                .opacity(shown ? 1 : 0)
            }
        }
        .onAppear {
            withAnimation(reduceMotion ? Theme.Motion.fade : .spring(duration: 0.6, bounce: 0.45)) { shown = true }
        }
        .accessibilityElement(children: .combine)
    }
}
