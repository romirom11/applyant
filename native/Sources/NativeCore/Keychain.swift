// Applyant's secrets as generic passwords in the login keychain: service "com.applyant",
// account = the secret's name ("jev", "capmonster", …). Nothing outside that service is read
// or written.
import Foundation
import Security

public struct Keychain {
    public let service: String

    public init(service: String = "com.applyant") {
        self.service = service
    }

    private func base(_ name: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: name,
        ]
    }

    public func get(_ name: String) throws -> String? {
        var query = base(name)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        try check(status, "read", name)
        guard let data = out as? Data, let value = String(data: data, encoding: .utf8) else {
            throw RequestError("keychain item \(name) is not UTF-8 text")
        }
        return value
    }

    public func set(_ name: String, value: String) throws {
        let data = Data(value.utf8)
        let update = SecItemUpdate(base(name) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        if update != errSecItemNotFound { try check(update, "update", name) }
        var add = base(name)
        add[kSecValueData as String] = data
        add[kSecAttrLabel as String] = "Applyant: \(name)"
        add[kSecAttrDescription as String] = "Applyant secret"
        try check(SecItemAdd(add as CFDictionary, nil), "store", name)
    }

    public func delete(_ name: String) throws -> Bool {
        let status = SecItemDelete(base(name) as CFDictionary)
        if status == errSecItemNotFound { return false }
        try check(status, "delete", name)
        return true
    }

    /// Names only; values are never listed.
    public func list() throws -> [String] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        if status == errSecItemNotFound { return [] }
        try check(status, "list", service)
        let items = out as? [[String: Any]] ?? []
        return items.compactMap { $0[kSecAttrAccount as String] as? String }.sorted()
    }

    private func check(_ status: OSStatus, _ action: String, _ name: String) throws {
        guard status != errSecSuccess else { return }
        let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
        throw RequestError("keychain: could not \(action) \(name): \(message)")
    }
}
