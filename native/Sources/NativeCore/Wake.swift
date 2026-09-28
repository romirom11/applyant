// Sleep/wake: NSWorkspace posts didWakeNotification on its own notification center, and the
// helper forwards it to the daemon as {"event":"wake"} (phase 10's scheduler catches up then).
// Notifications arrive on the main run loop, so the process has to keep one running.
import AppKit
import Foundation

public final class WakeObserver {
    private let center: NotificationCenter
    private var token: NSObjectProtocol?

    public init(
        center: NotificationCenter = NSWorkspace.shared.notificationCenter,
        onWake: @escaping @Sendable () -> Void
    ) {
        self.center = center
        token = center.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: nil) { _ in
            onWake()
        }
    }

    deinit {
        if let token { center.removeObserver(token) }
    }
}
