// Actionable notifications from live daemon events: "Acme AI · Senior AI Engineer · 91" with
// Review · Skip · Open. Button presses become RPCs (Skip) or navigation (Review, Open). A status
// a reply set ("Helix invites you to an interview") comes with Open, which shows the application.
import AppKit
import ApplyantKit
import UserNotifications

@MainActor
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    enum Category: String {
        case review = "applyant.review", needsYou = "applyant.needs-you", handOff = "applyant.hand-off"
        case statusChange = "applyant.status-change"
    }
    enum Action: String { case review = "review", skip = "skip", open = "open" }

    private let store: AppStore
    private let showMainWindow: () -> Void
    private let center = UNUserNotificationCenter.current()

    init(store: AppStore, showMainWindow: @escaping () -> Void) {
        self.store = store
        self.showMainWindow = showMainWindow
    }

    func install() {
        center.delegate = self
        let review = UNNotificationAction(identifier: Action.review.rawValue, title: "Review", options: [.foreground])
        let skip = UNNotificationAction(identifier: Action.skip.rawValue, title: "Skip", options: [])
        let open = UNNotificationAction(identifier: Action.open.rawValue, title: "Open", options: [.foreground])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Category.review.rawValue, actions: [review, skip, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: Category.needsYou.rawValue, actions: [review, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: Category.handOff.rawValue, actions: [open], intentIdentifiers: []),
            UNNotificationCategory(identifier: Category.statusChange.rawValue, actions: [open], intentIdentifiers: []),
        ])
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func post(_ n: StoreNotification) {
        let content = UNMutableNotificationContent()
        content.title = n.title
        content.body = n.body
        content.sound = n.kind == .handOff || n.kind == .statusChange ? .default : nil
        content.categoryIdentifier = switch n.kind {
        case .readyForReview: Category.review.rawValue
        case .needsYou: Category.needsYou.rawValue
        case .handOff: Category.handOff.rawValue
        case .statusChange: Category.statusChange.rawValue
        }
        content.userInfo = ["application": n.applicationId, "posting": n.postingId, "kind": n.kind.rawValue]
        let request = UNNotificationRequest(identifier: "\(n.kind.rawValue)-\(n.applicationId)", content: content, trigger: nil)
        center.add(request)
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        guard let app = (info["application"] as? NSNumber)?.int64Value,
              let posting = (info["posting"] as? NSNumber)?.int64Value
        else { return }
        let kind = info["kind"] as? String
        let action = response.actionIdentifier
        await MainActor.run {
            self.handle(action: action, kind: kind, application: app, posting: posting)
        }
    }

    private func handle(action: String, kind: String?, application: Int64, posting: Int64) {
        switch action {
        case Action.skip.rawValue:
            Task { await store.skip(posting: posting, reason: "skipped from a notification") }
        case Action.open.rawValue where kind == StoreNotification.Kind.handOff.rawValue:
            ChromeWindow.bringForward()
            navigate(application: application, posting: posting, kind: kind)
        case Action.open.rawValue where kind == StoreNotification.Kind.statusChange.rawValue:
            navigate(application: application, posting: posting, kind: kind)
        case Action.open.rawValue:
            if let url = store.postings[posting]?.canonicalURL, let link = URL(string: url) {
                NSWorkspace.shared.open(link)
            }
        default:
            // Review, or a click on the notification itself.
            navigate(application: application, posting: posting, kind: kind)
        }
    }

    private func navigate(application: Int64, posting: Int64, kind: String?) {
        store.navigation.showReview(application: application, posting: posting)
        if kind == StoreNotification.Kind.handOff.rawValue { store.navigation.section = .applied }
        if kind == StoreNotification.Kind.statusChange.rawValue {
            store.navigation.section = switch store.applications[application]?.stage {
            case .interview?: .interviews
            case .offer?: .offers
            default: .applied
            }
        }
        showMainWindow()
    }
}

/// Applyant's own Chrome (the submission profile the daemon restored for a hand-off).
enum ChromeWindow {
    @discardableResult
    static func bringForward() -> Bool {
        let profile = UserPaths().dataDir().appendingPathComponent("browser").path
        let pgrep = Process()
        pgrep.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        // "--": the pattern starts with dashes, and pgrep would read it as an option.
        pgrep.arguments = ["-f", "--", "--user-data-dir=\(profile)"]
        let pipe = Pipe()
        pgrep.standardOutput = pipe
        guard (try? pgrep.run()) != nil else { return false }
        pgrep.waitUntilExit()
        let pids = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            .split(separator: "\n").compactMap { Int32($0) }
        for pid in pids {
            if let app = NSRunningApplication(processIdentifier: pid) {
                return app.activate(options: [.activateAllWindows])
            }
        }
        return false
    }
}
