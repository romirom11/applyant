// Applyant.app: the menu bar (daemon status, counters, quick actions) and the main window
// (New → job → To review → approve). On launch it installs the daemon's launch agent and
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

    /// Quitting while background work is paused: the daemon has nothing to do, so launchd stops
    /// it instead of keeping it alive. The next launch (or login) starts it again, still paused.
    func stopDaemon() {
        guard Bundle.main.bundleURL.pathExtension == "app" else { return }
        registrar.agent.unload()
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let store = AppStore(connector: EndpointConnector(dataDir: UserPaths().dataDir()))
    let status = StatusModel()
    /// The main window's toasts (a scripted run shows them too).
    let toasts = Toasts()
    private(set) var notifications: NotificationDelegate?
    private var running: Task<Void, Never>?
    /// A scripted check (`--script`): quitting leaves the daemon alone.
    private var scripted = false
    /// Set by the SwiftUI scene, so notifications and the menu can open the main window.
    var openMainWindow: (() -> Void)?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // `--script steps.json --out dir`: a scripted check of the app (ScriptRunner.swift);
        // nothing is registered and no notifications are posted.
        if let script = ScriptRunner(arguments: CommandLine.arguments, store: store, toasts: toasts) {
            script.showWindow = { [weak self] in self?.showMainWindow() }
            script.openWindowQuietly = { [weak self] in
                NSApp.setActivationPolicy(.regular)
                self?.openMainWindow?()
            }
            scripted = true
            running = Task { await store.run() }
            Task { await script.run() }
            return
        }
        status.start()
        // Google's consent (Settings → Mailbox) opens in the default browser.
        store.onOpenURL = { NSWorkspace.shared.open($0) }
        // A checkout build (.build/debug/Applyant) isn't a bundle, and notifications need one.
        if Bundle.main.bundleURL.pathExtension == "app" {
            let notifications = NotificationDelegate(store: store) { [weak self] in self?.showMainWindow() }
            self.notifications = notifications
            notifications.install()
            store.onNotify = { notifications.post($0) }
        }
        running = Task { await store.run() }
        // Opened by hand (Finder, Spotlight, the first install): show the window right away, with
        // "Starting…" until the background service answers. At login it stays in the menu bar.
        if !Self.launchedAtLogin {
            Task { [weak self] in
                for _ in 0..<50 {
                    guard let self else { return }
                    if self.openMainWindow != nil {
                        self.showMainWindow()
                        return
                    }
                    try? await Task.sleep(for: .milliseconds(100))
                }
            }
        }
        // First launch: the setup opens with the window as soon as the daemon says it isn't done.
        Task { [weak self] in
            for _ in 0..<120 {
                guard let self else { return }
                if self.store.showOnboarding {
                    self.showMainWindow()
                    return
                }
                if self.store.connection == .connected && self.store.setup != nil { return }
                try? await Task.sleep(for: .milliseconds(500))
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        guard scripted == false, store.backgroundPausedAt != nil else { return }
        status.stopDaemon()
    }

    /// macOS started the app as a login item (nobody asked for a window).
    private static var launchedAtLogin: Bool {
        guard let event = NSAppleEventManager.shared().currentAppleEvent,
              event.eventID == kAEOpenApplication
        else { return false }
        return event.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
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
            MainView(store: delegate.store, toasts: delegate.toasts)
                .frame(minWidth: 1040, minHeight: 640)
                .onAppear { NSApp.setActivationPolicy(.regular) }
                .onDisappear { NSApp.setActivationPolicy(.accessory) }
        }
        // No title bar of its own: the traffic lights sit over the window's world, and the
        // world's empty parts move the window.
        .windowStyle(.hiddenTitleBar)
        .windowBackgroundDragBehavior(.enabled)
        .defaultSize(width: 1440, height: 900)
        // Started at login as a menu bar app: the window opens on request, not at every login.
        .defaultLaunchBehavior(.suppressed)
        .commands { AppCommands(store: delegate.store) }

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

// MARK: - The menu bar's commands

/// What the job open in the window can do, for the Job menu, the job's header and their
/// shortcuts alike: nil where it doesn't apply (the menu item is then off, not gone).
struct JobCommands {
    var approve: (() -> Void)?
    var prepare: (() -> Void)?
    var review: (() -> Void)?
    /// Save, or Unsave once it's saved.
    var save: (() -> Void)?
    var saved = false
    var skip: (() -> Void)?
    /// The skip taken back: "Back to New", or to its application's list.
    var unskip: (() -> Void)?
    var unskipTitle = "Back to New"
    var regenerate: (() -> Void)?
    var rescore: (() -> Void)?
    var openPosting: (() -> Void)?
}

/// The open job list's Next Job and Previous Job.
struct ListCommands {
    var next: (() -> Void)?
    var previous: (() -> Void)?
}

extension FocusedValues {
    @Entry var jobCommands: JobCommands?
    @Entry var listCommands: ListCommands?
}

/// The menu bar's Job and Go menus, Settings… in the app menu, and View › Show Labels and Show
/// How It's Going: every command the window's buttons and shortcuts have, in one place.
struct AppCommands: Commands {
    let store: AppStore
    @FocusedValue(\.jobCommands) private var job
    @FocusedValue(\.listCommands) private var list
    /// Home's How it's going panel; nil off Home.
    @FocusedBinding(\.showsHowItsGoing) private var showsHowItsGoing
    @Environment(\.openWindow) private var openWindow
    /// The rail's labels beside its icons (MainView's IconRail).
    @AppStorage("railLabels") private var railLabels = true

    var body: some Commands {
        // Settings is a section of the main window: ⌘, opens the window on it.
        CommandGroup(replacing: .appSettings) {
            Button("Settings…") {
                openWindow(id: "main")
                go(.settings)
            }
            .keyboardShortcut(",", modifiers: .command)
        }
        CommandGroup(before: .sidebar) {
            Button(railLabels ? "Hide Labels" : "Show Labels") { railLabels.toggle() }
            Button(showsHowItsGoing == true ? "Hide How It's Going" : "Show How It's Going") {
                let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
                withAnimation(Theme.Motion.pick(Theme.Motion.disclose, reduceMotion: reduceMotion)) { showsHowItsGoing?.toggle() }
            }
            .keyboardShortcut("0", modifiers: [.command, .option])
            .disabled(showsHowItsGoing == nil)
            Divider()
        }
        CommandMenu("Job") {
            Button("Approve and Send…") { perform(job?.approve) }
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(job?.approve == nil)
            Button("Prepare Application") { perform(job?.prepare) }
                .keyboardShortcut("p", modifiers: [.command, .shift])
                .disabled(job?.prepare == nil)
            Button("Review Application") { perform(job?.review) }
                .disabled(job?.review == nil)
            Divider()
            Button(job?.saved == true ? "Unsave" : "Save") { perform(job?.save) }
                .keyboardShortcut("d", modifiers: .command)
                .disabled(job?.save == nil)
            Button("Skip…") {
                // ⌘⌫ typed in a text field deletes to the line's start there, as anywhere else.
                if NSApp.currentEvent?.type == .keyDown, let editor = NSApp.keyWindow?.firstResponder as? NSTextView, editor.isEditable {
                    editor.deleteToBeginningOfLine(nil)
                    return
                }
                perform(job?.skip)
            }
            .keyboardShortcut(.delete, modifiers: .command)
            .disabled(job?.skip == nil)
            Button(job?.unskipTitle ?? "Back to New") { perform(job?.unskip) }
                .disabled(job?.unskip == nil)
            Divider()
            Button("Regenerate…") { perform(job?.regenerate) }
                .disabled(job?.regenerate == nil)
            Button("Re-score") { perform(job?.rescore) }
                .disabled(job?.rescore == nil)
            Button("Open Posting") { perform(job?.openPosting) }
                .keyboardShortcut("o", modifiers: .command)
                .disabled(job?.openPosting == nil)
            Divider()
            Button("Next Job") { perform(list?.next) }
                .keyboardShortcut("]", modifiers: .command)
                .disabled(list?.next == nil)
            Button("Previous Job") { perform(list?.previous) }
                .keyboardShortcut("[", modifiers: .command)
                .disabled(list?.previous == nil)
        }
        CommandMenu("Go") {
            // ⌥⌘1…9 for the first nine, in the rail's order; ⌥⌘↑ and ⌥⌘↓ step through them all.
            ForEach(Array(ApplyantKit.Section.allCases.enumerated()), id: \.element) { index, section in
                if index > 0, section.group != ApplyantKit.Section.allCases[index - 1].group { Divider() }
                if index < 9 {
                    Button(section.railTitle) { go(section) }
                        .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: [.command, .option])
                } else {
                    Button(section.railTitle) { go(section) }
                }
            }
            Divider()
            Button("Previous Section") { store.navigation.section.neighbour(-1).map(go) }
                .keyboardShortcut(.upArrow, modifiers: [.command, .option])
            Button("Next Section") { store.navigation.section.neighbour(1).map(go) }
                .keyboardShortcut(.downArrow, modifiers: [.command, .option])
        }
    }

    /// A job's command, unless a sheet is in front of the window (an edit, a question): the
    /// menu stays on for sheets, but what it does belongs to the window behind.
    private func perform(_ action: (() -> Void)?) {
        guard NSApp.keyWindow?.sheetParent == nil, NSApp.modalWindow == nil else { return }
        action?()
    }

    private func go(_ section: ApplyantKit.Section) {
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        withAnimation(Theme.Motion.pick(Theme.Motion.snappy, reduceMotion: reduceMotion)) {
            store.navigation.go(to: section)
        }
    }
}
