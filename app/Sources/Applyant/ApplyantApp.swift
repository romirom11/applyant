// Applyant.app: the menu bar (daemon status, counters, quick actions) and the main window
// (Inbox → posting → review → approve). On launch it installs the daemon's launch agent and
// registers itself as a login item. All data comes from the daemon through AppStore.
import AppKit
import ApplyantKit
import Observation
import SwiftUI

/// The daemon's health for the menu bar (GetSetupStatus), next to the store's data.
@MainActor @Observable
final class StatusModel {
    var view = StatusView(.stopped)
    var registration: RegistrationOutcome?

    private let client: DaemonClient
    private let registrar: DaemonRegistration
    private var polling: Task<Void, Never>?

    init() {
        let user = UserPaths()
        client = DaemonClient(dataDir: user.dataDir())
        let layout = BundleLayout(contents: Bundle.main.bundleURL.appendingPathComponent("Contents"))
        registrar = DaemonRegistration(agent: LaunchctlAgent(user: user, layout: layout))
    }

    func start() {
        guard polling == nil else { return }
        // Only an installed bundle registers itself (not `swift run` from a checkout).
        let registrar = registrar
        let installed = Bundle.main.bundleURL.pathExtension == "app"
        polling = Task { [weak self] in
            if installed {
                let outcome = await registrar.ensure()
                self?.registration = outcome
                registrar.ensureLoginItem()
            }
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    func refresh() async {
        view = StatusView(await client.state())
    }

    func openLogs() { NSWorkspace.shared.open(UserPaths().logsDir) }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let store = AppStore(connector: EndpointConnector(dataDir: UserPaths().dataDir()))
    let status = StatusModel()
    private(set) var notifications: NotificationDelegate?
    private var running: Task<Void, Never>?
    /// Set by the SwiftUI scene, so notifications and the menu can open the main window.
    var openMainWindow: (() -> Void)?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // `--script steps.json --out dir`: a scripted check of the app (ScriptRunner.swift);
        // nothing is registered and no notifications are posted.
        if let script = ScriptRunner(arguments: CommandLine.arguments, store: store) {
            running = Task { await store.run() }
            Task { await script.run() }
            return
        }
        status.start()
        let notifications = NotificationDelegate(store: store) { [weak self] in self?.showMainWindow() }
        self.notifications = notifications
        notifications.install()
        store.onNotify = { notifications.post($0) }
        running = Task { await store.run() }
    }

    /// Opening the app again (Finder, Spotlight, Dock) shows the window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showMainWindow()
        return false
    }

    func showMainWindow() {
        NSApp.setActivationPolicy(.regular)
        openMainWindow?()
        NSApp.activate()
    }
}

@main
struct ApplyantApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        Window("Applyant", id: "main") {
            MainView(store: delegate.store)
                .frame(minWidth: 1000, minHeight: 620)
                .onAppear { NSApp.setActivationPolicy(.regular) }
                .onDisappear { NSApp.setActivationPolicy(.accessory) }
        }
        .defaultSize(width: 1440, height: 900)
        // Started at login as a menu bar app: the window opens on request, not at every login.
        .defaultLaunchBehavior(.suppressed)

        MenuBarExtra {
            StatusMenu(store: delegate.store, status: delegate.status, open: { delegate.showMainWindow() })
                .background(WindowOpener(delegate: delegate))
        } label: {
            MenuBarLabel(store: delegate.store, status: delegate.status)
                .background(WindowOpener(delegate: delegate))
        }
    }
}

/// Hands SwiftUI's openWindow to the app delegate (notification actions need it).
private struct WindowOpener: View {
    let delegate: AppDelegate
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .onAppear { delegate.openMainWindow = { openWindow(id: "main") } }
    }
}
