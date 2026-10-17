// Settings → CV template: the template tailored CVs are printed with (the bundled Clean one,
// "Built in", or the candidate's own folder, with Show in Finder). The app reads the picked
// folder itself and sends its files, so the daemon needs no access to it; index.html must hold
// {{cv}} (the daemon says so otherwise).
import AppKit
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct CvTemplateCard: View {
    let store: AppStore
    @State private var confirmReset = false
    @State private var working = false

    var body: some View {
        Card(title: "CV template", accessory: { if working { ProgressView().controlSize(.small) } }) {
            if let t = store.cvTemplate {
                LabeledRow("In use", note: t.custom ? nil : "Built in") {
                    Text(CvTemplateText.title(t)).textRole(.body)
                }
                // Where it lives matters only for the candidate's own folder.
                if t.custom {
                    LabeledRow("Folder", note: CvTemplateText.files(t)) {
                        HStack {
                            Text(t.dir).textRole(.meta).lineLimit(1).truncationMode(.middle).help(t.dir)
                            Button("Show in Finder") {
                                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: t.dir)])
                            }
                            .controlSize(.small)
                            .fixedSize()
                        }
                    }
                }
                if t.hasProblem, !t.problem.isEmpty {
                    Callout(.warning, title: "The template can't be used", detail: t.problem)
                }
            } else {
                Text("Not loaded yet.").textRole(.body, color: Theme.secondaryText)
            }
            HStack {
                Button("Use a Custom Template…", action: pick)
                    .fixedSize()
                    .disabled(working)
                if store.cvTemplate?.custom == true {
                    Button("Reset to Default") { confirmReset = true }
                        .fixedSize()
                        .disabled(working)
                }
            }
            Text("A folder with an index.html that has {{cv}} where the CV goes, plus its CSS, fonts and images (hidden files are skipped, 5 MB at most). New CVs are printed with it.")
                .textRole(.meta)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: Theme.measure, alignment: .leading)
        }
        .task { await store.openCvTemplate() }
        .confirmationDialog("Go back to the default template (Clean)?", isPresented: $confirmReset) {
            Button("Reset to Default", role: .destructive) { Task { await store.resetCvTemplate() } }
        } message: {
            Text("Your custom template is removed from Applyant; the folder you picked stays as it is.")
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
