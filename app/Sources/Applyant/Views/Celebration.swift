// A moment after a job is dealt with: "Sent to Kalepa" with a burst of sparks, or "Skipped"
// with an Undo, floating over the bottom of the window for a few seconds while the next job
// opens. The window owns one Toasts; the job header posts to it.
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
        /// Sparks fly: something was sent.
        var celebrates = false
        var undo: (@MainActor () -> Void)?
    }

    private(set) var current: Toast?
    private var dismissal: Task<Void, Never>?

    func show(_ toast: Toast, for seconds: Double = 3.5) {
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
        .padding(.bottom, 18)
    }
}

private struct ToastView: View {
    let toast: Toasts.Toast
    let close: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            if toast.celebrates {
                SparkBurst(systemImage: toast.systemImage)
            } else {
                Image(systemName: toast.systemImage)
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .frame(width: 30, height: 30)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(toast.title).font(.callout.weight(.semibold))
                if let detail = toast.detail {
                    Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
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
        // Over busy text: mostly solid, with a little of the page showing through.
        .background {
            Capsule().fill(.thickMaterial)
            Capsule().fill(Theme.toastFill)
        }
        .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: 0.5))
        .shadow(color: .black.opacity(0.18), radius: 18, y: 6)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
    }
}
