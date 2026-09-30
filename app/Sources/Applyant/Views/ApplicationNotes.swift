// On an application's screen, at every stage: the candidate's own notes, the company's
// contacts (recruiter, hiring manager…), and at interview or offer the interview prep built
// from the company profile and what the candidate told them.
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct NotesCard: View {
    let store: AppStore
    let app: Application
    @State private var text = ""
    @State private var saving = false

    private var saved: String { app.hasNotes ? app.notes : "" }

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Notes").font(.headline)
                    Spacer()
                    if saving { ProgressView().controlSize(.small) }
                    Button("Save") {
                        saving = true
                        Task {
                            await store.setApplicationNotes(application: app.id, notes: text)
                            saving = false
                        }
                    }
                    .disabled(saving || text == saved)
                }
                TextEditor(text: $text)
                    .font(.body)
                    .frame(minHeight: 70, maxHeight: 160)
                    .scrollContentBackground(.hidden)
                    .padding(4)
                    .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 5))
                    .overlay(RoundedRectangle(cornerRadius: 5).stroke(.separator))
                Text("Only for you: what was said on a call, what to ask next.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
        }
        .onAppear { text = saved }
        .onChange(of: saved) { _, new in text = new }
    }
}

struct ContactsCard: View {
    let store: AppStore
    let app: Application
    @State private var adding = false
    @State private var form = ContactForm()

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Contacts").font(.headline)
                    Spacer()
                    Button(adding ? "Cancel" : "Add contact…") {
                        adding.toggle()
                        form = ContactForm()
                    }
                }
                if app.contacts.isEmpty && !adding {
                    Text("No contacts yet: the recruiter, the hiring manager.").font(.callout).foregroundStyle(.secondary)
                }
                ForEach(app.contacts, id: \.id) { c in
                    ContactRow(contact: c) { Task { await store.deleteApplicationContact(c.id) } }
                    if c.id != app.contacts.last?.id { Divider() }
                }
                if adding { addForm }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
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
                    Text(problem).font(.caption).foregroundStyle(.orange)
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
                Text(ContactText.title(contact)).font(.body.weight(.medium))
                HStack(spacing: 10) {
                    if let mail = ContactText.mailto(contact) { Link(contact.email, destination: mail) }
                    if let url = ContactText.linkedin(contact) { Link("LinkedIn ↗", destination: url) }
                }
                .font(.callout)
                if contact.hasNote, !contact.note.isEmpty {
                    Text(contact.note).font(.callout).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button("Delete", role: .destructive) { confirming = true }
                .buttonStyle(.link)
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
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Interview prep" + (prep.company.map { " · \($0)" } ?? "")).font(.headline)
                    Spacer()
                    if prep.note != nil {
                        Button("Company research") {
                            Task {
                                await store.researchCompany(.posting(app.postingID))
                                await store.openInterviewPrep(posting: app.postingID)
                            }
                        }
                    }
                }
                if let note = prep.note { Text(note).font(.callout).foregroundStyle(.secondary) }
                ForEach(prep.sections) { section in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(section.title).font(.subheadline.weight(.semibold))
                        ForEach(section.items) { item in
                            VStack(alignment: .leading, spacing: 1) {
                                Text(section.items.count > 1 || section.title != "Summary" ? "• " + item.text : item.text)
                                    .textSelection(.enabled)
                                if !item.sources.isEmpty {
                                    HStack(spacing: 8) {
                                        ForEach(item.sources) { s in Link(s.label, destination: s.url) }
                                    }
                                    .font(.caption)
                                    .padding(.leading, 10)
                                }
                            }
                        }
                    }
                }
                if !prep.answers.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("What you told them").font(.subheadline.weight(.semibold))
                        ForEach(prep.answers) { a in
                            VStack(alignment: .leading, spacing: 1) {
                                Text(a.question).font(.callout.weight(.medium))
                                Text(a.answer).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
        }
        .task(id: app.postingID) { await store.openInterviewPrep(posting: app.postingID) }
    }
}
