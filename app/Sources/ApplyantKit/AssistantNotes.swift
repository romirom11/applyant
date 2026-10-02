// What an AI assistant already knows about the candidate. People who have used ChatGPT, Claude
// or Gemini for a while have told it a lot: projects, what they built, numbers, what they want
// next. The setup hands them a prompt to paste there; the answer comes back as a knowledge
// source like any other document, so everything in it starts as a fact to confirm.
import Foundation

public enum AssistantNotes {
    /// The prompt to paste into the assistant. It asks only for what the assistant actually
    /// has, in the shape the extractor reads best, and for nothing invented.
    public static let prompt = """
    I'm setting up a tool that helps me apply for jobs. It needs everything you already know about my professional life. Use your memory of me and our past conversations; do not search the web and do not ask me questions.

    Write it as plain text in English, under these headings, in this order:

    1. Who I am: full name, where I live (city, country), email, phone, LinkedIn, GitHub, personal site, the languages I speak and how well.
    2. Work history, newest first: for each job the company, my title, the dates, what the company or product does, what I personally built or did, the technologies or methods I used, the size of the team and my part in it, and any results with their numbers.
    3. Projects outside of jobs (side projects, open source, freelance, studies): the same details.
    4. Skills: what I actually use, grouped, with how deep my experience is where you know it.
    5. Education, courses and certificates, with dates.
    6. Achievements and numbers worth quoting: revenue, users, time saved, costs cut, team sizes, awards.
    7. What I want next: the roles I'm after, seniority, salary expectations, remote or on-site, countries or cities, kinds of company I like, and anything I've said I don't want.
    8. How I work: strengths others would confirm, how I lead or collaborate, anything I've told you matters to me at work.

    Rules:
    - Only what I told you or what you know from our conversations. Never guess and never fill gaps with what is typical for someone like me. Where you know nothing, write "unknown".
    - Keep names, dates and numbers exactly as you know them. If you're unsure of one, say so next to it.
    - Say what I did myself separately from what my team or company did.
    - Be complete rather than brief. Short factual sentences, no praise, no summary at the end.
    """

    /// "assistant-notes-2026-09-30.md": where a pasted answer is kept.
    public static func fileName(_ date: Date, calendar: Calendar = .current) -> String {
        let d = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "assistant-notes-%04d-%02d-%02d.md", d.year ?? 0, d.month ?? 0, d.day ?? 0)
    }

    /// Why a pasted answer can't be used, or nil when it can.
    public static func problem(_ text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return "Paste the assistant's answer first." }
        if t.count < 200 { return "That's very short for everything an assistant knows about you: paste its whole answer." }
        // The prompt itself pasted back by mistake.
        if t.contains("do not search the web and do not ask me questions") && t.count < prompt.count + 200 {
            return "That's the prompt, not the answer: paste what the assistant wrote back."
        }
        return nil
    }

    /// Writes the pasted answer into the imports folder and returns the file.
    public static func save(_ text: String, dataDir: URL, date: Date = Date(), fileManager fm: FileManager = .default) throws -> URL {
        let dir = ImportedFile.folder(dataDir: dataDir)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let name = fileName(date)
        let stem = (name as NSString).deletingPathExtension
        var n = 1
        var target = dir.appendingPathComponent(name)
        while fm.fileExists(atPath: target.path) {
            n += 1
            target = dir.appendingPathComponent("\(stem) \(n).md")
        }
        let body = "# What an AI assistant remembers about me\n\n" + text.trimmingCharacters(in: .whitespacesAndNewlines) + "\n"
        try body.write(to: target, atomically: true, encoding: .utf8)
        try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
        return target
    }
}
