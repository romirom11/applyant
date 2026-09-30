// Settings → CV template: the template tailored CVs are printed with (the bundled Clean one or
// the candidate's own folder). The app reads the picked folder itself and sends its files, so
// the daemon needs no access to it; index.html must hold {{cv}} (the daemon says so otherwise).
import AppKit
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct CvTemplateSection: View {
    let store: AppStore
    @State private var confirmReset = false
    @State private var working = false

    var body: some View {
        SwiftUI.Section {
            if let t = store.cvTemplate {
                LabeledContent("In use") {
                    Text(CvTemplateText.title(t))
                }
                LabeledContent("Folder") {
                    Text(t.dir).font(.callout).foregroundStyle(.secondary).lineLimit(2).truncationMode(.middle).textSelection(.enabled)
                }
                LabeledContent("Files") {
                    Text(CvTemplateText.files(t)).font(.callout).foregroundStyle(.secondary).lineLimit(3)
                }
                if t.hasProblem, !t.problem.isEmpty {
                    Label(t.problem, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).font(.callout)
                }
            } else {
                Text("The daemon hasn't said which template is in use.").foregroundStyle(.secondary)
            }
            // Side by side when the column is wide enough, else one under the other (never cut).
            ViewThatFits(in: .horizontal) {
                HStack {
                    if working { ProgressView().controlSize(.small) }
                    Spacer()
                    buttons
                }
                VStack(alignment: .leading, spacing: 6) {
                    buttons
                    if working { ProgressView().controlSize(.small) }
                }
            }
        } header: {
            Text("CV template")
        } footer: {
            Text("A folder with an index.html that has {{cv}} where the CV goes, plus its CSS, fonts and images (hidden files are skipped, 5 MB at most). New CVs are printed with it.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .task { await store.openCvTemplate() }
        .confirmationDialog("Go back to the default template (Clean)?", isPresented: $confirmReset) {
            Button("Reset to default", role: .destructive) { Task { await store.resetCvTemplate() } }
        } message: {
            Text("Your custom template is removed from Applyant; the folder you picked stays as it is.")
        }
    }

    @ViewBuilder
    private var buttons: some View {
        Button("Use a custom template…", action: pick)
            .fixedSize()
            .disabled(working)
        if store.cvTemplate?.custom == true {
            Button("Reset to default") { confirmReset = true }
                .fixedSize()
                .disabled(working)
        }
    }

    private func pick() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Use this template"
        panel.message = "Pick the folder with your template's index.html"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        working = true
        Task {
            await store.useCvTemplate(folder: url)
            working = false
        }
    }
}
