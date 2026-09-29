// The menu bar: daemon status, what's waiting (counters), what's running, quick actions.
import AppKit
import ApplyantKit
import SwiftUI

struct MenuBarLabel: View {
    let store: AppStore
    let status: StatusModel

    var body: some View {
        let waiting = store.count(.readyToReview)
        HStack(spacing: 3) {
            Image(systemName: status.view.symbol)
            if waiting > 0 { Text("\(waiting)") }
        }
    }
}

struct StatusMenu: View {
    let store: AppStore
    let status: StatusModel
    let open: () -> Void

    var body: some View {
        Text(status.view.title)
        ForEach(status.view.lines, id: \.self) { Text($0) }
        if let note = registrationNote {
            Text(note)
        }

        Text(MailText.menuLine(store.mailbox))
        if !store.mailQueue.isEmpty {
            Button("Which application? (\(store.mailQueue.count))") {
                store.navigation.section = .whichApplication
                store.navigation.email = store.mailQueue.first?.id
                open()
            }
        }

        Divider()
        let ready = store.items(.readyToReview)
        let needs = store.needsYou
        Text(counterLine(ready: ready.count, needs: needs.count, preparing: store.count(.preparing)))
        if let paused = store.activity.paused {
            Text(paused)
        } else if !store.activity.running.isEmpty {
            Text(workingLine)
        }
        if let next = ready.first, let app = next.applicationId {
            Button("Review next: \(next.title)") {
                store.navigation.showReview(application: app, posting: next.postingId)
                open()
            }
        }
        ForEach(needs.prefix(3), id: \.id) { app in
            Button("Needs you: \(app.hasCompany ? app.company : "application \(app.id)")") {
                store.navigation.showReview(application: app.id, posting: app.postingID)
                store.navigation.section = app.stage == .approved ? .applied : .readyToReview
                open()
            }
        }

        Divider()
        Button("Open Applyant") { open() }
            .keyboardShortcut("o")
        Button("Refresh") { Task { await status.refresh() } }
            .keyboardShortcut("r")
        Button("Show Logs") { status.openLogs() }
        Divider()
        Button("Quit Applyant") { NSApplication.shared.terminate(nil) }
            .keyboardShortcut("q")
    }

    private func counterLine(ready: Int, needs: Int, preparing: Int) -> String {
        var parts = ["\(ready) ready to review"]
        if needs > 0 { parts.append("\(needs) need you") }
        if preparing > 0 { parts.append("\(preparing) preparing") }
        return parts.joined(separator: " · ")
    }

    private var workingLine: String {
        let kinds = Dictionary(grouping: store.activity.running.values, by: { $0 })
            .map { $0.value.count > 1 ? "\($0.key) ×\($0.value.count)" : $0.key }
            .sorted()
        return "Working: " + kinds.joined(separator: ", ")
    }

    private var registrationNote: String? {
        switch status.registration {
        case let .failed(reason): "Couldn't register the daemon: \(reason)"
        default: nil
        }
    }
}
