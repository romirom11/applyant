// Profile and Projects (phase 16, app parity with the CLI for setup): the profile values
// application forms ask for and the base CV; projects (add, rename, remove) and the knowledge
// sources behind them (a GitHub repo, a file, a page or a Docs link), each with its sync state.
// The same views open as sheets from Settings and the setup's Import step. Each project (and the
// profile) lists its facts: status, kind, evidence; Confirm, Edit, Reject; to-confirm filter.
import ApplyantAPI
import ApplyantKit
import SwiftUI
import UniformTypeIdentifiers

let knowledgeFileTypes: [UTType] = [.pdf, .plainText, UTType(filenameExtension: "md") ?? .plainText, UTType(filenameExtension: "docx") ?? .data]

// MARK: Profile

/// The profile form: every value `candidate profile set` takes, and the base CV.
struct ProfileEditor: View {
    let store: AppStore
    @State private var form = ProfileForm()
    @State private var loadedFrom: [Applyant_V1_ProfileEntry]?
    @State private var pickingCv = false
    @State private var saved = false

    var body: some View {
        Form {
            SwiftUI.Section {
                ForEach(ProfileForm.fields, id: \.key) { field in
                    TextField(field.label, text: Binding(get: { form[field.key] }, set: { form[field.key] = $0; saved = false }),
                              prompt: Text(field.hint))
                }
            } header: {
                Text("What application forms ask for")
            } footer: {
                Text("Defaults for every application; each one can still be changed in its review. GitHub logins and commit emails decide which commits are yours (comma-separated).")
                    .font(.caption).foregroundStyle(.secondary)
            }
            SwiftUI.Section("Base CV") {
                HStack {
                    Text(form[ProfileForm.baseCvKey].isEmpty ? "None chosen" : form[ProfileForm.baseCvKey])
                        .lineLimit(1).truncationMode(.middle)
                        .foregroundStyle(form[ProfileForm.baseCvKey].isEmpty ? .secondary : .primary)
                    Spacer()
                    Button("Choose…") { pickingCv = true }
                    if !form[ProfileForm.baseCvKey].isEmpty {
                        Button("Clear") { form[ProfileForm.baseCvKey] = ""; saved = false }
                    }
                }
                Text("The CV sent as is, and the one tailored CVs start from.").font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                if saved { Label("Saved", systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
                Spacer()
                Button("Revert") { load(force: true) }.disabled(!form.hasChanges)
                Button("Save profile") {
                    let f = form
                    Task { saved = await store.saveProfile(f); if saved { load(force: true) } }
                }
                .keyboardShortcut("s")
                .disabled(!form.hasChanges)
            }
        }
        .formStyle(.grouped)
        .fileImporter(isPresented: $pickingCv, allowedContentTypes: [.pdf, UTType(filenameExtension: "docx") ?? .data]) { result in
            if case let .success(url) = result { form[ProfileForm.baseCvKey] = url.path; saved = false }
        }
        .task { await store.openProfile(); load(force: false) }
        .onChange(of: store.candidateProfile?.profile) { load(force: false) }
    }

    /// Takes the daemon's values unless the candidate is in the middle of editing.
    private func load(force: Bool) {
        guard let entries = store.candidateProfile?.profile else { return }
        if force || !form.hasChanges || loadedFrom == nil {
            form = ProfileForm(entries: entries)
            loadedFrom = entries
        }
    }
}

/// The Profile section's detail: the sources that belong to no single project (a CV, LinkedIn).
struct ProfileSourcesPane: View {
    let store: AppStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Your CV and other profile sources").font(.title2.weight(.semibold))
                Text("A CV or LinkedIn PDF covers many projects: facts are drafted from it into projects, and \(store.candidateProfile?.profileFactCount ?? 0) facts belong to no single project.")
                    .foregroundStyle(.secondary)
                KnowledgeSourcesSection(store: store, project: nil, sources: store.candidateProfile?.profileSources ?? [])
                FactsSection(store: store, project: nil)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// MARK: Projects

struct ProjectsList: View {
    @Bindable var store: AppStore
    @State private var newName = ""

    var body: some View {
        List(selection: $store.navigation.project) {
            SwiftUI.Section {
                HStack {
                    TextField("New project", text: $newName, prompt: Text("New project: Solovei, Ordi…"))
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(add)
                    Button("Add", action: add)
                        .disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                if store.knowledgeProjects.isEmpty {
                    Text("No projects yet. Add one, or import a CV: projects are drafted from it.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                ForEach(store.knowledgeProjects, id: \.id) { p in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(p.name).font(.headline)
                        Text(KnowledgeText.projectLine(p)).font(.subheadline).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 3)
                    .tag(p.id)
                }
            }
        }
        .navigationTitle("Projects")
        .task { await store.openProfile() }
    }

    private func add() {
        let name = newName
        Task { if await store.createProject(name) != nil { newName = "" } }
    }
}

struct ProjectDetail: View {
    let store: AppStore

    var body: some View {
        if let id = store.navigation.project, let p = store.knowledgeProject(id) {
            ProjectPane(store: store, project: p).id(id)
        } else {
            ContentUnavailableView(
                "Projects",
                systemImage: ApplyantKit.Section.projects.symbol,
                description: Text("Your experience is told in projects. Pick one to rename it, add a GitHub repo, a file or a page to it, or sync it.")
            )
        }
    }
}

private struct ProjectPane: View {
    let store: AppStore
    let project: KnowledgeProject
    @State private var name = ""
    @State private var confirmingDelete = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    TextField("Name", text: $name).textFieldStyle(.roundedBorder).font(.title3)
                        .onSubmit(rename)
                    if name.trimmingCharacters(in: .whitespaces) != project.name {
                        Button("Rename", action: rename).disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    Button("Remove…", role: .destructive) { confirmingDelete = true }
                }
                Text(KnowledgeText.projectLine(project)).foregroundStyle(.secondary)
                if project.hasSummary { Text(project.summary) }
                if !project.stack.isEmpty {
                    Text(project.stack.joined(separator: " · ")).font(.callout).foregroundStyle(.secondary)
                }
                KnowledgeSourcesSection(store: store, project: project.id, sources: store.projectSources[project.id] ?? [])
                FactsSection(store: store, project: project.id)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onAppear { name = project.name }
        .onChange(of: project.name) { name = project.name }
        .task { await store.openProject(project.id) }
        .confirmationDialog("Remove \(project.name)?", isPresented: $confirmingDelete) {
            Button("Remove the project, its sources and facts", role: .destructive) {
                Task { await store.deleteProject(project.id) }
            }
        } message: {
            Text("Its \(project.sourceCount) sources and \(project.factCount) facts go with it. Applications already sent keep what they said.")
        }
    }

    private func rename() {
        let n = name
        Task { await store.renameProject(project.id, to: n) }
    }
}

/// A project's (or the profile's) sources with their sync state, and adding one.
struct KnowledgeSourcesSection: View {
    let store: AppStore
    /// nil: the profile's sources.
    let project: Int64?
    let sources: [KnowledgeSource]
    @State private var input = ""
    @State private var picking = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Sources").font(.headline)
                Spacer()
                if !sources.isEmpty {
                    Button("Sync all") { Task { await store.syncKnowledge(project: project) } }
                        .help("Read every source again; only changed material is re-extracted")
                }
            }
            if sources.isEmpty {
                Text(project == nil ? "No profile sources yet: add your CV or LinkedIn PDF." : "No sources yet: add a GitHub repo, a file or a page.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            ForEach(sources, id: \.id) { s in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(KnowledgeText.kindName(s.kind)) · \(KnowledgeText.title(s))").lineLimit(1).truncationMode(.middle)
                        Text(KnowledgeText.syncLine(s)).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                            .textSelection(.enabled)
                    }
                    Spacer()
                    ChipView(chip: KnowledgeText.chip(s))
                    Button("Sync") { Task { await store.syncKnowledge(source: s.id) } }.controlSize(.small)
                }
                Divider()
            }
            HStack {
                TextField("Add a GitHub repo, a page or a Docs link", text: $input,
                          prompt: Text("https://github.com/you/repo · https://… · a Docs link"))
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(add)
                Button("Add", action: add).disabled(input.trimmingCharacters(in: .whitespaces).isEmpty)
                Button("Choose a file…") { picking = true }
            }
            Text("Each source is read in the background into unconfirmed facts; you confirm facts before anything is sent.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: knowledgeFileTypes) { result in
            if case let .success(url) = result { Task { await store.addKnowledgeSource(to: project, url.path) } }
        }
    }

    private func add() {
        let value = input
        Task { if await store.addKnowledgeSource(to: project, value) { input = "" } }
    }
}

// MARK: Facts

/// The facts browser: a project's (or the profile's) facts with their status, kind and evidence;
/// Confirm, Edit (saved confirmed, in your words) and Reject.
struct FactsSection: View {
    let store: AppStore
    /// nil: the profile's facts.
    let project: Int64?
    @State private var filter = FactsText.Filter.toConfirm

    var body: some View {
        let all = store.facts[FactsText.ref(project)] ?? []
        let shown = FactsText.shown(all, filter: filter)
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Facts").font(.headline)
                Text(FactsText.counts(all)).font(.callout).foregroundStyle(.secondary)
                Spacer()
                Picker("Show", selection: $filter) {
                    ForEach(FactsText.Filter.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                let open = shown.filter { $0.status == .unconfirmed }.map(\.id)
                if !open.isEmpty {
                    Button("Confirm all \(open.count)") { Task { await store.confirmFacts(open, project: project) } }
                        .help("Every unconfirmed fact shown is true as written")
                }
            }
            if shown.isEmpty {
                Text(filter == .toConfirm ? "Nothing to confirm." : "No facts yet: add a source, or answer the interview.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            ForEach(shown, id: \.id) { fact in
                FactRow(store: store, fact: fact, project: project)
                Divider()
            }
            Text("Extracted facts start unconfirmed; drafts may use them, but nothing unconfirmed is sent. An edit is saved in your words, confirmed.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .task(id: project) { await store.openFacts(project: project) }
        .onChange(of: store.knowledgeProject(project ?? -1)?.factCount) { Task { await store.openFacts(project: project) } }
    }
}

private struct FactRow: View {
    let store: AppStore
    let fact: Fact
    let project: Int64?
    @State private var editing = false
    @State private var text = ""
    @State private var confirmingReject = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                ChipView(chip: FactsText.chip(fact))
                Text(FactsText.kind(fact)).font(.caption).foregroundStyle(.secondary)
                if let origin = FactsText.origin(fact) { Text("· " + origin).font(.caption).foregroundStyle(.secondary) }
                Spacer()
                if fact.status != .rejected && !editing {
                    if fact.status == .unconfirmed {
                        Button("Confirm") { Task { await store.confirmFacts([fact.id], project: project) } }.controlSize(.small)
                    }
                    Button("Edit") { text = fact.text; editing = true }.controlSize(.small)
                    Button("Reject…", role: .destructive) { confirmingReject = true }.controlSize(.small)
                }
            }
            if editing {
                TextField("The fact, in your words", text: $text, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(2 ... 6)
                HStack {
                    Spacer()
                    Button("Cancel") { editing = false }
                    Button("Save, confirmed") {
                        let t = text
                        Task { if await store.editFact(fact.id, text: t, project: project) { editing = false } }
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            } else {
                Text(fact.text).textSelection(.enabled)
                    .foregroundStyle(fact.status == .rejected ? .secondary : .primary)
                    .strikethrough(fact.status == .rejected)
            }
            ForEach(Array(fact.evidence.enumerated()), id: \.offset) { _, e in
                VStack(alignment: .leading, spacing: 1) {
                    Text(FactsText.evidence(e)).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    if e.hasExcerpt {
                        Text("“\(e.excerpt)”").font(.caption).italic().foregroundStyle(.secondary).lineLimit(3)
                    }
                }
            }
        }
        .padding(.vertical, 2)
        .confirmationDialog("Reject this fact?", isPresented: $confirmingReject) {
            Button("Reject", role: .destructive) { Task { await store.rejectFacts([fact.id], project: project) } }
        } message: {
            Text("It won't be used in answers or CVs from now on. Applications already sent keep what they said.")
        }
    }
}

// MARK: Sheets (Settings and the setup's Import step)

struct ProfileSheet: View {
    let store: AppStore
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Profile").font(.title2.bold())
                Spacer()
                Button("Done", action: close).keyboardShortcut(.cancelAction)
            }
            .padding(16)
            ProfileEditor(store: store)
        }
        .frame(minWidth: 560, idealWidth: 620, minHeight: 560, idealHeight: 720)
    }
}

struct ProjectsSheet: View {
    let store: AppStore
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Projects and sources").font(.title2.bold())
                Spacer()
                Button("Done", action: close).keyboardShortcut(.cancelAction)
            }
            .padding(16)
            HSplitView {
                ProjectsList(store: store).frame(minWidth: 240, idealWidth: 280)
                ProjectDetail(store: store).frame(minWidth: 420)
            }
        }
        .frame(minWidth: 800, idealWidth: 900, minHeight: 520, idealHeight: 640)
    }
}
