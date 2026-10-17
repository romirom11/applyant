// A delivery that got stuck: the daemon left Applyant's Chrome window open, restored, with the
// form filled. This says why and where, brings that window forward, and can retry delivery.
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct HandOffCard: View {
    let store: AppStore
    let app: Application
    @State private var noWindow = false
    @State private var confirmSubmitted = false
    @State private var confirmRetry = false

    var body: some View {
        let h = app.handOff
        let sent = ApproveText.mayHaveBeenSent(app)
        Card {
            VStack(alignment: .leading, spacing: Theme.rowSpacing + 2) {
                // Why it stopped, and the one thing to do now.
                Callout(
                    .warning,
                    title: sent ? "This one may already be sent" : "Finish this one in the browser",
                    detail: FieldText.plain(h.reason),
                    systemImage: "hand.raised.fill"
                ) {
                    if sent {
                        Button("I Submitted It") { confirmSubmitted = true }.buttonStyle(.primary)
                    } else {
                        Button("Show Browser Window") { noWindow = !ChromeWindow.bringForward() }.buttonStyle(.primary)
                    }
                }
                if h.hasDetail { Text(FieldText.plain(h.detail)).textRole(.body, color: Theme.secondaryText).fixedSize(horizontal: false, vertical: true) }
                if let place = place(h) { MetaLine(place, systemImage: "mappin.and.ellipse") }
                Text(sent
                    ? "Check the site or your mailbox for a confirmation before anything else."
                    : "The Chrome window is open with the form filled. Finish it there and press submit.")
                    .textRole(.body, color: sent ? Theme.text : Theme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
                FlowRow(spacing: 8) {
                    if sent {
                        Button("Show Browser Window") { noWindow = !ChromeWindow.bringForward() }
                    } else {
                        Button("I Submitted It") { confirmSubmitted = true }
                    }
                    Button("Try Delivery Again…") { confirmRetry = true }
                    if ApproveText.canReturnToReview(app) {
                        Button("Back to Review") { Task { await store.returnToReview(application: app.id) } }
                            .help("Nothing is sent: the application goes back to review, where you can change values and answers, then approve it again")
                    }
                    if h.hasURL, let url = URL(string: h.url) {
                        Link("Open Page ↗", destination: url).font(.system(size: 12)).foregroundStyle(Theme.accent)
                    }
                }
                .buttonStyle(.secondary)
                .controlSize(.small)
                if noWindow {
                    MetaLine("Applyant's Chrome isn't running any more. Try Delivery Again… opens the form once more.", systemImage: "info.circle")
                }
            }
        }
        .confirmationDialog("Did the site accept your application?", isPresented: $confirmSubmitted) {
            Button("Yes, I Submitted It") { Task { await store.markSubmitted(application: app.id) } }
        } message: {
            Text("It's recorded as applied, with what the form was filled with.")
        }
        .confirmationDialog(ApproveText.retryTitle, isPresented: $confirmRetry) {
            Button("Fill and Submit It Again") { Task { await store.submit(application: app.id) } }
        } message: {
            Text(ApproveText.mayHaveBeenSent(app) ? ApproveText.retryAfterSubmitMessage : ApproveText.retryMessage)
        }
    }

    private func place(_ h: Applyant_V1_HandOff) -> String? {
        var parts: [String] = []
        if h.hasScope { parts.append(h.scope == "field" ? "at a field" : h.scope == "captcha" ? "at a captcha" : "at a step") }
        if h.hasStep { parts.append("step \(h.step)") }
        if h.hasFieldLabel { parts.append("“\(h.fieldLabel)”") }
        return parts.isEmpty ? nil : "Stopped " + parts.joined(separator: ", ")
    }
}
