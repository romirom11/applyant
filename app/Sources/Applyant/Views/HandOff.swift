// A delivery that got stuck: the daemon left Applyant's Chrome window open, restored, with the
// form filled. This says why and where, brings that window forward, and can retry delivery.
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct HandOffCard: View {
    let store: AppStore
    let app: Application
    @State private var noWindow = false

    var body: some View {
        let h = app.handOff
        GroupBox {
            VStack(alignment: .leading, spacing: 6) {
                Label("Finish this one in the browser", systemImage: "hand.raised.fill")
                    .font(.headline)
                    .foregroundStyle(.orange)
                Text(h.reason)
                if h.hasDetail { Text(h.detail).font(.callout).foregroundStyle(.secondary) }
                if let place = place(h) { Text(place).font(.callout) }
                Text("The Chrome window is open with the form filled. Finish it there and press submit.")
                    .font(.callout).foregroundStyle(.secondary)
                HStack {
                    Button("Show the browser window") { noWindow = !ChromeWindow.bringForward() }
                        .buttonStyle(.borderedProminent)
                    Button("Try delivery again") { Task { await store.submit(application: app.id) } }
                    if h.hasURL, let url = URL(string: h.url) {
                        Link("Page ↗", destination: url)
                    }
                }
                if noWindow {
                    Text("Applyant's Chrome isn't running any more. “Try delivery again” opens the form once more.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
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
