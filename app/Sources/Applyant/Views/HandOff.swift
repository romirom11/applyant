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
        GroupBox {
            VStack(alignment: .leading, spacing: 6) {
                Label(ApproveText.mayHaveBeenSent(app) ? "This one may already be sent" : "Finish this one in the browser", systemImage: "hand.raised.fill")
                    .font(.headline)
                    .foregroundStyle(.orange)
                Text(h.reason)
                if h.hasDetail { Text(h.detail).font(.callout).foregroundStyle(.secondary) }
                if let place = place(h) { Text(place).font(.callout) }
                Text("The Chrome window is open with the form filled. Finish it there and press submit.")
                    .font(.callout).foregroundStyle(.secondary)
                let sent = ApproveText.mayHaveBeenSent(app)
                if sent {
                    Text("Check the site or your mailbox for a confirmation before anything else.")
                        .font(.callout.weight(.medium))
                }
                HStack {
                    if sent {
                        Button("I submitted it") { confirmSubmitted = true }.buttonStyle(.borderedProminent)
                        Button("Show the browser window") { noWindow = !ChromeWindow.bringForward() }
                    } else {
                        Button("Show the browser window") { noWindow = !ChromeWindow.bringForward() }
                            .buttonStyle(.borderedProminent)
                        Button("I submitted it") { confirmSubmitted = true }
                    }
                    Button("Try delivery again…") { confirmRetry = true }
                    if ApproveText.canReturnToReview(app) {
                        Button("Back to review") { Task { await store.returnToReview(application: app.id) } }
                            .help("Nothing is sent: the application goes back to review, where you can change values and answers, then approve it again")
                    }
                    if h.hasURL, let url = URL(string: h.url) {
                        Link("Page ↗", destination: url)
                    }
                }
                if noWindow {
                    Text("Applyant's Chrome isn't running any more. “Try delivery again…” opens the form once more.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
        }
        .confirmationDialog("Did the site accept your application?", isPresented: $confirmSubmitted) {
            Button("Yes, I submitted it") { Task { await store.markSubmitted(application: app.id) } }
        } message: {
            Text("It's recorded as applied, with what the form was filled with.")
        }
        .confirmationDialog(ApproveText.retryTitle, isPresented: $confirmRetry) {
            Button("Fill and submit it again") { Task { await store.submit(application: app.id) } }
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
