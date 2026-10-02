// Editing what setup decided, without a terminal (phase 16, app parity with the CLI):
// preferences (everything `prefs set` takes: dealbreakers, the threshold and the weights too),
// search strategies (new, edit, delete) and a board or career page as a search source.
import ApplyantAPI
import ApplyantKit
import SwiftUI

// MARK: Preferences

struct PreferencesEditor: View {
    let store: AppStore
    @State private var form = PreferencesForm()
    @State private var loaded = false
    @State private var saved = false

    var body: some View {
        Form {
            PreferenceControls(
                text: Binding(get: { form.text }, set: { form.text = $0; saved = false }),
                remote: Binding(get: { form.remote }, set: { form.remote = $0; saved = false }),
                dealbreakers: Binding(get: { form.dealbreakers }, set: { form.dealbreakers = $0; saved = false })
            )
            SwiftUI.Section {
                Stepper("Prepare applications at \(form.threshold) or above", value: Binding(
                    get: { form.threshold }, set: { form.threshold = $0; saved = false }
                ), in: 0 ... 100, step: 5)
                VStack(alignment: .leading, spacing: 2) {
                    Stepper(PreferenceChoices.dailyCap(form.dailyCap), value: Binding(
                        get: { form.dailyCap }, set: { form.dailyCap = $0; saved = false }
                    ), in: 0 ... 50)
                    Text(PreferenceChoices.dailyCapNote).font(.caption).foregroundStyle(.secondary)
                }
                ForEach(PreferencesForm.components, id: \.self) { c in
                    Stepper("\(PreferenceChoices.weight(c)): \(form.weights[c] ?? 0)", value: Binding(
                        get: { form.weights[c] ?? 0 }, set: { form.weights[c] = $0; saved = false }
                    ), in: 0 ... 100)
                }
            } header: {
                Text("Score")
            } footer: {
                Text("How much each part counts in a posting's score (relative weights).").font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                if saved { Label("Saved", systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
                Spacer()
                Button("Revert") { reload() }.disabled(!form.hasChanges)
                Button("Save preferences") {
                    let f = form
                    Task {
                        saved = await store.savePreferences(f)
                        reload()
                    }
                }
                .disabled(!form.hasChanges)
            }
        }
        .formStyle(.grouped)
        .task {
            guard !loaded else { return }
            await store.openPreferences()
            reload()
            loaded = true
        }
    }

    private func reload() {
        if let p = store.searchPreferences { form = PreferencesForm(p) }
    }
}

struct PreferencesSheet: View {
    let store: AppStore
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Preferences").font(.title2.bold())
                Spacer()
                Button("Done", action: close).keyboardShortcut(.cancelAction)
            }
            .padding(16)
            PreferencesEditor(store: store)
        }
        .frame(minWidth: 600, idealWidth: 680, minHeight: 600, idealHeight: 780)
        .showsErrors(store)
    }
}

// MARK: Search strategies

struct StrategyEditorSheet: View {
    let store: AppStore
    /// nil: a new strategy.
    let strategy: SearchStrategy?
    let close: () -> Void
    @State private var form = StrategyForm()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(strategy == nil ? "New search" : "Edit search").font(.title2.bold())
            Text("A search (a “strategy”) looks for job titles in the sources you pick, on a schedule.")
                .font(.callout).foregroundStyle(.secondary)
            Form {
                TextField("Name", text: $form.name, prompt: Text("AI Engineer · Remote EU"))
                VStack(alignment: .leading, spacing: 4) {
                    Text("Looks for (one title phrase per line)")
                    TextEditor(text: $form.queries)
                        .font(.body)
                        .frame(minHeight: 70)
                    Text("A listing matches when every word of one phrase is in its title; \"-word\" excludes. Empty: every listing.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Toggle("Remote jobs", isOn: $form.remote)
                TextField("Also in", text: $form.locations, prompt: Text("Athens, Cyprus, Germany (empty: anywhere)"))
                TextField("Reads", text: $form.sources, prompt: Text("all"))
                Text("Which sources this search reads: “all” (every source switched on in Search), or a comma-separated list of kinds (\(store.search.kinds.map(\.kind).joined(separator: ", "))) or single sources by the short name under each one in Search (for example board:hn).")
                    .font(.caption).foregroundStyle(.secondary)
                Stepper("Every \(form.everyHours) h", value: $form.everyHours, in: 1 ... 168)
                Toggle("Paused (doesn't run until resumed)", isOn: $form.paused)
            }
            .formStyle(.grouped)
            HStack {
                Spacer()
                Button("Cancel", action: close).keyboardShortcut(.cancelAction)
                Button(strategy == nil ? "Add strategy" : "Save") {
                    let f = form
                    Task { if await store.saveStrategy(f, id: strategy?.id) != nil { close() } }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(form.problem != nil)
            }
        }
        .padding(20)
        .frame(minWidth: 520, idealWidth: 560, minHeight: 520)
        .showsErrors(store)
        .onAppear { if let strategy { form = StrategyForm(strategy) } }
    }
}

// MARK: Search sources

/// A job board or a career page by URL (Search → Sources).
struct AddBoardOrPage: View {
    let store: AppStore
    @State private var input = ""
    @State private var added: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                TextField("Add a board or career page URL", text: $input)
                    .textFieldStyle(.roundedBorder)
                    .controlSize(.small)
                    .onSubmit(add)
                Button("Add", action: add)
                    .controlSize(.small)
                    .disabled(SourceInput.url(input) == nil)
            }
            if let added { Text(added).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
        }
        .help("A company's careers page or a job board: its feed or ATS board is found, or a listing recipe is built")
    }

    private func add() {
        let value = input
        Task {
            if let s = await store.addBoardOrPage(value) {
                input = ""
                added = SourceInput.added(s)
            }
        }
    }
}

// MARK: Layout

/// Lays its subviews out left to right at their own widths, wrapping to the next line when the
/// row is full (a grid would give a short "Data" the same cell as "Founding engineer").
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(subviews, width: proposal.width ?? .infinity)
        return CGSize(width: proposal.width ?? rows.width, height: rows.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = arrange(subviews, width: bounds.width)
        for (subview, origin) in zip(subviews, rows.origins) {
            subview.place(at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y), proposal: .unspecified)
        }
    }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> (origins: [CGPoint], width: CGFloat, height: CGFloat) {
        var origins: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            origins.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            widest = max(widest, x - spacing)
        }
        return (origins, widest, y + rowHeight)
    }
}
