// Applyant.app in 8a: registers the daemon's launch agent and itself as a login item on
// launch, and shows the daemon's status in the menu bar. Views come in 8b.
import AppKit
import ApplyantKit
import Observation
import SwiftUI

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
        registrar = DaemonRegistration(fallback: LaunchctlAgent(user: user, layout: layout))
    }

    func start() {
        guard polling == nil else { return }
        registration = registrar.ensure()
        registrar.ensureLoginItem()
        polling = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    func refresh() async {
        view = StatusView(await client.state())
    }

    func openLoginItems() {
        registrar.openLoginItemsSettings()
    }

    func openLogs() {
        NSWorkspace.shared.open(UserPaths().logsDir)
    }
}

struct StatusMenu: View {
    let model: StatusModel

    var body: some View {
        Text(model.view.title)
        ForEach(model.view.lines, id: \.self) { Text($0) }
        if let note = registrationNote {
            Divider()
            Text(note)
        }
        if model.registration == .needsApproval {
            Button("Allow in Login Items…") { model.openLoginItems() }
        }
        Divider()
        Button("Refresh") { Task { await model.refresh() } }
            .keyboardShortcut("r")
        Button("Show Logs") { model.openLogs() }
        Divider()
        Button("Quit Applyant") { NSApplication.shared.terminate(nil) }
            .keyboardShortcut("q")
    }

    private var registrationNote: String? {
        switch model.registration {
        case .needsApproval: "The daemon waits for your OK in System Settings → Login Items."
        case let .failed(reason): "Couldn't register the daemon: \(reason)"
        default: nil
        }
    }
}

@main
struct ApplyantApp: App {
    @State private var model = StatusModel()

    var body: some Scene {
        MenuBarExtra {
            StatusMenu(model: model)
        } label: {
            Image(systemName: model.view.symbol)
                .task { model.start() }
        }
    }
}
