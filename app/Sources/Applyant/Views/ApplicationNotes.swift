// On an application's screen, at every stage: the candidate's own notes, the company's
// contacts (recruiter, hiring manager…), and at interview or offer the interview prep built
// from the company profile and what the candidate told them.
import ApplyantAPI
import ApplyantKit
import SwiftUI

/// The candidate's notes and the company's contacts. While both are empty they're one quiet
/// row, Add Note and Add Contact…; the cards open with what was asked for.
struct NotesAndContacts: View {
    let store: AppStore
    let app: Application
    @State private var opened: Opened?

    private enum Opened { case note, contact }

    var body: some View {
        let empty = (app.hasNotes ? app.notes : "").isEmpty && app.contacts.isEmpty
        if empty && opened == nil {
            HStack(spacing: 10) {
                MetaLine("No notes or contacts yet", systemImage: "note.text")
                Spacer(minLength: 8)
                Button("Add Note") { withAnimation(Theme.Motion.snappy) { opened = .note } }
                    .fixedSize()
                Button("Add Contact…") { withAnimation(Theme.Motion.snappy) { opened = .contact } }
                    .fixedSize()
            }
            .buttonStyle(.secondary)
            .controlSize(.small)
            .padding(12)
            .glass(radius: Theme.innerRadius + 4)
        } else {
            NotesCard(store: store, app: app, focused: opened == .note)
            ContactsCard(store: store, app: app, startsAdding: opened == .contact)
        }
    }
}

struct NotesCard: View {
    let store: AppStore
    let app: Application
    /// Asked for (Add Note): the editor takes the keyboard. Otherwise it leaves it to the list.
    var focused = false
    @State private var text = ""
    @State private var saving = false
    @FocusState private var editorFocused: Bool

    private var saved: String { app.hasNotes ? app.notes : "" }

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: Theme.rowSpacing) {
                HStack {
                    CardTitle(title: "Notes", systemImage: "note.text")
                    Spacer()
                    if saving { ProgressView().controlSize(.small) }
                    Button("Save") {
                        saving = true
                        Task {
                            await store.setApplicationNotes(application: app.id, notes: text)
                            saving = false
                        }
                    }
                    .buttonStyle(.secondary)
                    .controlSize(.small)
                    .disabled(saving || text == saved)
                }
                TextEditor(text: $text)
                    .textRole(.body)
                    .focused($editorFocused)
                    .frame(minHeight: 70, maxHeight: 160)
                    .scrollContentBackground(.hidden)
                    .padding(6)
                    .overlay(alignment: .topLeading) {
                        if text.isEmpty {
                            Text("Only for you: what was said on a call, what to ask next")
                                .textRole(.body, color: Theme.secondaryText)
                                .padding(.horizontal, 11)
                                .padding(.vertical, 6)
                                .allowsHitTesting(false)
                        }
                    }
                    .insetSurface()
                    .overlay(RoundedRectangle(cornerRadius: Theme.innerRadius, style: .continuous).strokeBorder(Theme.hairline, lineWidth: 0.5))
            }
        }
        .onAppear {
            text = saved
            if focused { editorFocused = true }
        }
        .onChange(of: saved) { _, new in text = new }
    }
}

struct ContactsCard: View {
    let store: AppStore
    let app: Application
    @State private var adding: Bool
    @State private var form = ContactForm()

    init(store: AppStore, app: Application, startsAdding: Bool = false) {
        self.store = store
        self.app = app
        _adding = State(initialValue: startsAdding)
    }

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: Theme.rowSpacing) {
                HStack {
                    CardTitle(title: "Contacts", systemImage: "person.2")
                    Spacer()
                    Button(adding ? "Cancel" : "Add Contact…") {
                        adding.toggle()
                        form = ContactForm()
                    }
                    .buttonStyle(.secondary)
                    .controlSize(.small)
                }
                if app.contacts.isEmpty && !adding {
                    MetaLine("No contacts yet: the recruiter, the hiring manager")
                }
                ForEach(app.contacts, id: \.id) { c in
                    ContactRow(contact: c) { Task { await store.deleteApplicationContact(c.id) } }
                    if c.id != app.contacts.last?.id { Divider() }
                }
                if adding { addForm.transition(.opacity.combined(with: .move(edge: .top))) }
            }
            .animation(Theme.Motion.snappy, value: adding)
        }
    }

    private var addForm: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                TextField("Name", text: $form.name)
                TextField("Role (recruiter, hiring manager…)", text: $form.role)
            }
            HStack {
                TextField("Email", text: $form.email)
                TextField("LinkedIn", text: $form.linkedin)
            }
            TextField("Note", text: $form.note)
            HStack {
                if let problem = form.problem, form != ContactForm() {
                    MetaLine(problem, systemImage: "exclamationmark.triangle.fill", tone: .warning)
                }
                Spacer()
                Button("Add") {
                    let f = form
                    Task {
                        if await store.addApplicationContact(application: app.id, f) {
                            adding = false
                            form = ContactForm()
                        }
                    }
                }
                .buttonStyle(.primary)
                .keyboardShortcut(.defaultAction)
                .disabled(form.problem != nil)
            }
        }
        .textFieldStyle(.roundedBorder)
        .padding(.top, 4)
    }
}

struct ContactRow: View {
    let contact: ApplicationContact
    let delete: () -> Void
    @State private var confirming = false

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(ContactText.title(contact)).textRole(.itemTitle)
                HStack(spacing: 10) {
                    if let mail = ContactText.mailto(contact) { Link(contact.email, destination: mail) }
                    if let url = ContactText.linkedin(contact) { Link("LinkedIn ↗", destination: url) }
                }
                .font(.system(size: 12))
                .foregroundStyle(Theme.accent)
                if contact.hasNote, !contact.note.isEmpty {
                    Text(contact.note).textRole(.body, color: Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer()
            Button("Delete", role: .destructive) { confirming = true }
                .buttonStyle(.link)
                .foregroundStyle(Theme.bad)
        }
        .confirmationDialog("Delete \(ContactText.title(contact))?", isPresented: $confirming) {
            Button("Delete", role: .destructive, action: delete)
        }
    }
}

struct InterviewPrepCard: View {
    let store: AppStore
    let app: Application

    var body: some View {
        let prep = store.interviewPrep(app)
        Card {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    CardTitle(title: "Interview Prep" + (prep.company.map { " · \($0)" } ?? ""), systemImage: "person.wave.2")
                    Spacer()
                    if prep.note != nil {
                        Button("Research Company") {
                            Task {
                                await store.researchCompany(.posting(app.postingID))
                                await store.openInterviewPrep(posting: app.postingID)
                            }
                        }
                    }
                }
                if let note = prep.note { Text(note).textRole(.body, color: Theme.secondaryText).fixedSize(horizontal: false, vertical: true) }
                ForEach(prep.sections) { section in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(section.title).textRole(.itemTitle)
                        ForEach(section.items) { item in
                            VStack(alignment: .leading, spacing: 1) {
                                Text(section.items.count > 1 || section.title != "Summary" ? "• " + item.text : item.text)
                                    .textRole(.body)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .textSelection(.enabled)
                                if !item.sources.isEmpty {
                                    HStack(spacing: 8) {
                                        ForEach(item.sources) { s in Link(s.label, destination: s.url) }
                                    }
                                    .font(.system(size: 12))
                                    .foregroundStyle(Theme.accent)
                                    .padding(.leading, 10)
                                }
                            }
                        }
                    }
                }
                if !prep.answers.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("What you told them").textRole(.itemTitle)
                        ForEach(prep.answers) { a in
                            VStack(alignment: .leading, spacing: 1) {
                                Text(a.question).textRole(.body).fontWeight(.medium)
                                Text(a.answer).textRole(.body, color: Theme.secondaryText).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                            }
                        }
                    }
                }
            }
        }
        .task(id: app.postingID) { await store.openInterviewPrep(posting: app.postingID) }
    }
}
