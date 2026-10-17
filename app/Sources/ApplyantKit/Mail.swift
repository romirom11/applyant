// How the mailbox reads on screen (phase 13): its connection state, the replies linked to an
// application (Applied · Interviews · Offers) and the "Which application is this?" queue.
import ApplyantAPI
import Foundation

public typealias Mailbox = Applyant_V1_Mailbox
public typealias Email = Applyant_V1_Email
public typealias MailCandidate = Applyant_V1_MailCandidate

public enum MailText {
    /// The daemon's note as a sentence: "a rejection that matches no application" →
    /// "A rejection that matches no application."
    public static func noteSentence(_ note: String) -> String {
        let t = articles(note.trimmingCharacters(in: .whitespacesAndNewlines))
        guard let first = t.first else { return "" }
        let s = first.uppercased() + t.dropFirst()
        return s.hasSuffix(".") || s.hasSuffix("?") ? s : s + "."
    }

    /// "a acknowledgement" → "an acknowledgement" (the daemon builds its notes from labels).
    static func articles(_ text: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: #"\b([Aa]) (?!(?:use|usu|uni|one|eu)\w*)(?=[aeiouAEIOU])"#) else { return text }
        return regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "$1n ")
    }

    /// What's wrong with a mailbox that says it's connected but can't read (Google revoked the
    /// token, a sync failed), as a plain sentence; nil when it reads. The daemon's own words
    /// ("invalid_grant (Token has been expired or revoked.)") stay out of sight.
    public static func problem(_ box: Mailbox?) -> String? {
        guard let box, box.status == "connected", box.hasNote else { return nil }
        let note = box.note.lowercased()
        guard ["invalid_grant", "expired", "revoked", "sync failed"].contains(where: note.contains) else { return nil }
        return box.kind == "gmail"
            ? "Gmail signed Applyant out: replies aren't being read"
            : "The mailbox stopped syncing: replies aren't being read"
    }

    /// "Mailbox: me@gmail.com · synced 14:05" · "Mailbox: waiting for Google consent" · "No mailbox connected".
    public static func connection(_ box: Mailbox?, now: Date = Date()) -> String {
        guard let box else { return "No mailbox connected" }
        let kind = box.kind == "gmail" ? "Gmail" : "IMAP"
        if problem(box) != nil {
            return box.kind == "gmail"
                ? "Google signed Applyant out. Reconnect to keep reading replies."
                : "The mailbox stopped syncing. Reconnect to keep reading replies."
        }
        switch box.status {
        case "connecting":
            return "Mailbox: waiting for Google consent"
        case "failed":
            return "Mailbox failed" + (box.hasNote ? ": \(box.note)" : "")
        default:
            var line = "Mailbox: \(box.address.isEmpty ? kind : box.address)"
            if box.hasNote {
                line += " · \(box.note)"
            } else if box.hasSyncedAt {
                line += " · synced " + synced(box.syncedAt.date, now: now)
            } else {
                line += " · not synced yet"
            }
            return line
        }
    }

    /// The menu bar's line: the state, plus the queue when something's in it.
    public static func menuLine(_ box: Mailbox?, now: Date = Date()) -> String {
        let line = connection(box, now: now)
        guard let box, box.asking > 0 else { return line }
        return line + " · \(box.asking) to sort"
    }

    public static func isConnected(_ box: Mailbox?) -> Bool { box?.status == "connected" }

    static func synced(_ date: Date, now: Date) -> String {
        Calendar.current.isDate(date, inSameDayAs: now)
            ? date.formatted(date: .omitted, time: .shortened)
            : date.formatted(.dateTime.day().month(.abbreviated).hour().minute())
    }

    /// The notification for a status a reply set: "Helix invites you to an interview" with the
    /// role and the email's subject; nil for other stages.
    public static func statusNotification(_ app: Application) -> (title: String, body: String)? {
        let company = app.hasCompany && !app.company.isEmpty ? app.company : "The company"
        let (title, label): (String, String) = switch app.stage {
        case .interview: ("\(company) invites you to an interview", "interview")
        case .offer: ("\(company) made you an offer", "offer")
        case .rejected: ("\(company) isn't moving forward", "rejection")
        default: ("", "")
        }
        guard !title.isEmpty else { return nil }
        let role = app.hasTitle ? app.title : "Application \(app.id)"
        let email = app.emails.first { $0.label == label }
        return (title, email.map { "\(role) · “\($0.subject)”" } ?? role)
    }

    /// Labels the candidate can pick when the classifier couldn't tell.
    public static let pickableLabels = ["rejection", "interview", "offer", "acknowledgement", "other"]

    public static func labelTitle(_ label: String) -> String {
        switch label {
        case "rejection": "Rejection"
        case "interview": "Interview"
        case "offer": "Offer"
        case "acknowledgement": "Received"
        case "security_code": "Security code"
        case "other": "Other"
        default: "Unsure"
        }
    }

    public static func labelChip(_ e: Email) -> Chip {
        let tone: Chip.Tone = switch e.label {
        case "offer", "interview": .good
        case "rejection": .warning
        case "unknown": .neutral
        default: .accent
        }
        var text = labelTitle(e.label)
        if e.hasConfidence, e.label != "unknown" { text += " \(Int((e.confidence * 100).rounded()))%" }
        return Chip(text: text, tone: tone)
    }

    /// "Tallyhall · Founding Engineer": one candidate application in the ask queue.
    public static func candidateTitle(_ c: MailCandidate) -> String {
        let title = c.hasTitle ? c.title : "Application \(c.applicationID)"
        return c.hasCompany ? "\(c.company) · \(title)" : title
    }

    /// Who wrote: "Maria Lopez", or the address when there's no name.
    public static func sender(_ e: Email) -> String {
        let name = e.hasFromName ? e.fromName.trimmingCharacters(in: .whitespaces) : ""
        return name.isEmpty ? e.fromAddress : name
    }

    /// "Maria Lopez <maria@acme.example>" → "Maria Lopez"; a bare address stays itself.
    public static func sender(_ from: String) -> String {
        let t = from.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let open = t.lastIndex(of: "<"), t.hasSuffix(">") else { return t }
        let name = t[..<open].trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: "\"'")))
        return name.isEmpty ? String(t[t.index(after: open)..<t.index(before: t.endIndex)]) : name
    }

    /// An email's text as paragraphs to read: no image links ("[https://…/logo.png]"), a long
    /// tracking link as its host and ↗, the mail client's hard wraps joined, and a paragraph of
    /// its own for a greeting ("Dear Roman,") and a sign-off ("Warm regards," with the name
    /// under it).
    public static func readable(_ body: String) -> [String] {
        var text = body.replacingOccurrences(of: "\r\n", with: "\n")
        text = text.replacingOccurrences(of: #"\[https?://[^\]]*\]"#, with: "", options: .regularExpression)
        text = shortLinks(text)
        var paragraphs: [String] = []
        for block in text.components(separatedBy: "\n").split(whereSeparator: { $0.trimmingCharacters(in: .whitespaces).isEmpty }) {
            var lines: [String] = []
            var afterSignOff = false
            func close() {
                if !lines.isEmpty { paragraphs.append(lines.joined(separator: afterSignOff ? "\n" : " ")) }
                lines = []
                afterSignOff = false
            }
            for raw in block {
                let line = raw.split(whereSeparator: \.isWhitespace).joined(separator: " ")
                if line.isEmpty { continue }
                if isGreeting(line) {
                    close()
                    lines = [line]
                    // "Dear Roman," on its own; "Hi Roman, thanks for…" keeps its sentence.
                    if line.count <= 40 && (line.hasSuffix(",") || line.hasSuffix("!")) { close() }
                } else if isSignOff(line) {
                    close()
                    lines = [line]
                    afterSignOff = true
                } else {
                    lines.append(line)
                }
            }
            close()
        }
        return paragraphs
    }

    /// Bare links longer than 40 characters → "host ↗".
    static func shortLinks(_ text: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: #"https?://[^\s<>\])"]+"#) else { return text }
        var result = text
        for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
            guard let range = Range(match.range, in: text) else { continue }
            let link = String(text[range])
            guard link.count > 40, let host = URL(string: link)?.host() else { continue }
            let short = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
            result.replaceSubrange(Range(match.range, in: result)!, with: short + " ↗")
        }
        return result
    }

    static func isGreeting(_ line: String) -> Bool {
        line.range(of: #"^(dear|hi|hello|hey|good (morning|afternoon|evening)|greetings)\b"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    static func isSignOff(_ line: String) -> Bool {
        line.count <= 32 && line.range(
            of: #"^((best|kind|warm|warmest|many)( regards| wishes| thanks)?|regards|thanks|thank you|cheers|sincerely|all the best|yours( sincerely| truly)?|with (best|kind) regards)[,.!]?$"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil
    }

    /// The calendar line for an interview email: "On your calendar", why not, or nil.
    public static func calendar(_ e: Email) -> String? {
        guard e.hasCalendarStatus else { return nil }
        switch e.calendarStatus {
        case "created": return "On your calendar" + (e.hasInviteStart ? " · \(inviteTime(e))" : "")
        case "cancelled": return "You deleted its calendar event"
        default: return "Not on your calendar" + (e.hasCalendarNote ? ": \(e.calendarNote)" : "")
        }
    }

    /// "2026-10-07T14:00:00" (+ zone) → "7 Oct, 14:00 (Europe/Berlin)"; a date stays a date.
    public static func inviteTime(_ e: Email) -> String {
        let raw = e.inviteStart
        if raw.count == 10 { return raw }
        let parts = raw.replacingOccurrences(of: "Z", with: "").split(separator: "T")
        guard parts.count == 2 else { return raw }
        let day = String(parts[0]), time = String(parts[1].prefix(5))
        let zone = e.hasInviteTimeZone ? " (\(e.inviteTimeZone))" : raw.hasSuffix("Z") ? " UTC" : ""
        return "\(day) \(time)\(zone)"
    }

    /// The application's stage after the mail, as the list chip says it.
    public static func stageChip(_ stage: ApplicationStage) -> Chip? {
        switch stage {
        case .interview: Chip(text: "Interview", tone: .good)
        case .offer: Chip(text: "Offer", tone: .good)
        case .rejected: Chip(text: "Rejected", tone: .warning)
        case .withdrawn: Chip(text: "Withdrawn", tone: .neutral)
        default: nil
        }
    }
}

// MARK: Connecting a mailbox (Settings → Mailbox, setup → Connections)

public typealias MailboxSetup = Applyant_V1_GetMailboxResponse
public typealias ImapSettings = Applyant_V1_ImapSettings

/// Gmail: the owner's Google Cloud "Desktop app" OAuth client. The secret may stay empty when
/// the daemon already has one stored.
public struct GmailForm: Equatable, Sendable {
    public var clientId = ""
    public var clientSecret = ""

    public init(clientId: String = "", clientSecret: String = "") {
        self.clientId = clientId
        self.clientSecret = clientSecret
    }

    /// Why Connect can't be pressed yet, or nil.
    public func problem(secretStored: Bool) -> String? {
        if clientId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Paste the OAuth client ID." }
        if !secretStored, clientSecret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Paste the client secret."
        }
        return nil
    }
}

/// IMAP + SMTP with an app password. Ports are text fields; empty means the default.
public struct ImapForm: Equatable, Sendable {
    public var address = ""
    public var imapHost = ""
    public var imapPort = "993"
    public var smtpHost = ""
    public var smtpPort = "465"
    public var username = ""
    public var password = ""

    public init() {}

    /// What the mailbox was connected with (never the password).
    public init(_ box: Mailbox) {
        address = box.address
        if box.hasImapHost { imapHost = box.imapHost }
        if box.imapPort > 0 { imapPort = String(box.imapPort) }
        if box.hasSmtpHost { smtpHost = box.smtpHost }
        if box.smtpPort > 0 { smtpPort = String(box.smtpPort) }
        if box.hasUsername { username = box.username }
    }

    /// Fills the servers for a known provider when they're still empty.
    public mutating func applyPreset() {
        guard let preset = MailText.imapPreset(for: address) else { return }
        if imapHost.isEmpty { imapHost = preset.imap; imapPort = String(preset.imapPort) }
        if smtpHost.isEmpty { smtpHost = preset.smtp; smtpPort = String(preset.smtpPort) }
    }

    private static func port(_ text: String) -> Int32?? {
        let t = text.trimmingCharacters(in: .whitespaces)
        if t.isEmpty { return .some(nil) }
        guard let n = Int32(t), n > 0, n < 65536 else { return nil }
        return .some(n)
    }

    public var problem: String? {
        let a = address.trimmingCharacters(in: .whitespaces)
        if a.split(separator: "@").count != 2 || a.contains(" ") { return "Enter the mailbox's address." }
        if imapHost.trimmingCharacters(in: .whitespaces).isEmpty { return "Enter the IMAP server." }
        if smtpHost.trimmingCharacters(in: .whitespaces).isEmpty { return "Enter the SMTP server." }
        if Self.port(imapPort) == nil || Self.port(smtpPort) == nil { return "Ports are numbers (993, 465, 587…)." }
        if password.isEmpty { return "Enter the app password." }
        return nil
    }

    /// The request's settings (TLS follows the ports: 993/465 at once, 143/587 STARTTLS).
    public var settings: ImapSettings? {
        guard problem == nil else { return nil }
        return .with {
            $0.imapHost = imapHost.trimmingCharacters(in: .whitespaces)
            $0.imapPort = (Self.port(imapPort) ?? nil) ?? 0
            $0.smtpHost = smtpHost.trimmingCharacters(in: .whitespaces)
            $0.smtpPort = (Self.port(smtpPort) ?? nil) ?? 0
            $0.secure = true
            let user = username.trimmingCharacters(in: .whitespaces)
            if !user.isEmpty { $0.username = user }
            $0.password = password
        }
    }
}

public extension MailText {
    /// Where to create the Google OAuth client, and Google's own steps.
    static let googleCredentialsURL = URL(string: "https://console.cloud.google.com/apis/credentials")!
    /// Where the consent screen is published or test users are added ("Access blocked … 403").
    static let googleAudienceURL = URL(string: "https://console.cloud.google.com/auth/audience")!
    static let googleBlockedHint = "If Google says \"Access blocked: … has not completed the Google verification process\" (Error 403: access_denied), the client is still in Testing: open Audience and press Publish app (it stays unverified, which is fine for your own use), or add your address under Test users. Published is better: in Testing, Google signs the mailbox out every 7 days."
    static let googleGuideURL = URL(string: "https://developers.google.com/workspace/guides/create-credentials#desktop-app")!
    static let gmailHint = "In Google Cloud, enable the Gmail and Calendar APIs, then Credentials → Create credentials → OAuth client ID → Desktop app, and paste its ID and secret here."
    static let imapHint = "Use an app password, not your account password (iCloud: appleid.apple.com → App-Specific Passwords; Gmail: myaccount.google.com/apppasswords). Ports 993/465 use TLS, 143/587 STARTTLS."

    /// IMAP/SMTP servers for common providers, by the address's domain.
    static func imapPreset(for address: String) -> (imap: String, imapPort: Int32, smtp: String, smtpPort: Int32)? {
        guard let domain = address.split(separator: "@").last?.lowercased(), address.contains("@") else { return nil }
        switch domain {
        case "icloud.com", "me.com", "mac.com": return ("imap.mail.me.com", 993, "smtp.mail.me.com", 587)
        case "gmail.com", "googlemail.com": return ("imap.gmail.com", 993, "smtp.gmail.com", 465)
        case "outlook.com", "hotmail.com", "live.com": return ("outlook.office365.com", 993, "smtp-mail.outlook.com", 587)
        case "yahoo.com": return ("imap.mail.yahoo.com", 993, "smtp.mail.yahoo.com", 465)
        case "fastmail.com": return ("imap.fastmail.com", 993, "smtp.fastmail.com", 465)
        default: return nil
        }
    }

    /// The Mailbox section's chip.
    static func chip(_ box: Mailbox?) -> Chip {
        if problem(box) != nil { return Chip(text: box?.kind == "gmail" ? "Signed out" : "Not syncing", tone: .warning) }
        return switch box?.status {
        case "connected"?: Chip(text: "Connected", tone: .good)
        case "connecting"?: Chip(text: "Waiting for Google", tone: .accent)
        case "failed"?: Chip(text: "Failed", tone: .warning)
        default: Chip(text: "Not connected", tone: .neutral)
        }
    }

    /// "Gmail · me@gmail.com" · "IMAP · me@icloud.com (imap.mail.me.com)".
    static func account(_ box: Mailbox) -> String {
        if box.kind == "gmail" { return "Gmail · " + (box.address.isEmpty ? "not signed in yet" : box.address) }
        return "IMAP · \(box.address)" + (box.hasImapHost ? " (\(box.imapHost))" : "")
    }
}
