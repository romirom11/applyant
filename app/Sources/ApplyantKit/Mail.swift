// How the mailbox reads on screen (phase 13): its connection state, the replies linked to an
// application (Applied · Interviews · Offers) and the "Which application is this?" queue.
import ApplyantAPI
import Foundation

public typealias Mailbox = Applyant_V1_Mailbox
public typealias Email = Applyant_V1_Email
public typealias MailCandidate = Applyant_V1_MailCandidate

public enum MailText {
    /// "Mailbox: me@gmail.com · synced 14:05" · "Mailbox: waiting for Google consent" · "No mailbox connected".
    public static func connection(_ box: Mailbox?, now: Date = Date()) -> String {
        guard let box else { return "No mailbox connected" }
        let kind = box.kind == "gmail" ? "Gmail" : "IMAP"
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

    /// "Maria Lopez <maria@acme.example>" or the address.
    public static func sender(_ e: Email) -> String {
        e.hasFromName ? "\(e.fromName) <\(e.fromAddress)>" : e.fromAddress
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
        default: nil
        }
    }
}
