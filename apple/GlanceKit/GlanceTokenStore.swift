import Foundation
import Security

/// The widget token, in the keychain, shared between the host app that mints
/// it and the widget extension that spends it.
///
/// A home screen widget outlives every browser session and runs in a process
/// with no cookie jar, so it carries `glw_…`, a credential that is accepted by
/// exactly one endpoint and reads exactly one thing: the owner's own card. The
/// item is `kSecAttrAccessibleAfterFirstUnlock` because WidgetKit refreshes
/// timelines while the device is locked, and a token the widget cannot read
/// then would show a stale card until the next unlock.
enum GlanceTokenStore {
	/// The shape `/api/_lib/glance-tokens.js` mints and validates.
	static let pattern = "^glw_[A-Za-z0-9_-]{32}$"

	static func isWellFormed(_ token: String) -> Bool {
		token.range(of: pattern, options: .regularExpression) != nil
	}

	static func load() -> String? {
		var query = baseQuery()
		query[kSecReturnData as String] = true
		query[kSecMatchLimit as String] = kSecMatchLimitOne

		var item: CFTypeRef?
		guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
		      let data = item as? Data,
		      let token = String(data: data, encoding: .utf8)
		else { return nil }
		return token
	}

	/// Replace whatever is stored. Returns false only when the keychain itself
	/// refuses, which the caller surfaces rather than silently dropping the
	/// token and leaving the widget stuck on "link this widget".
	@discardableResult
	static func save(_ token: String) -> Bool {
		guard isWellFormed(token) else { return false }
		let data = Data(token.utf8)
		let query = baseQuery()

		let update: [String: Any] = [kSecValueData as String: data]
		let updated = SecItemUpdate(query as CFDictionary, update as CFDictionary)
		if updated == errSecSuccess { return true }
		if updated != errSecItemNotFound { return false }

		var insert = query
		insert[kSecValueData as String] = data
		insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
		return SecItemAdd(insert as CFDictionary, nil) == errSecSuccess
	}

	/// Forget the token. Called when the owner unlinks from the app, and when
	/// the server answers `unlinked`, which means the token was revoked from
	/// three.ws/glance and will never work again.
	static func clear() {
		SecItemDelete(baseQuery() as CFDictionary)
	}

	private static func baseQuery() -> [String: Any] {
		var query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: GlanceConfig.keychainService,
			kSecAttrAccount as String: GlanceConfig.keychainAccount,
		]
		if let group = GlanceConfig.keychainGroup {
			query[kSecAttrAccessGroup as String] = group
		}
		#if os(macOS)
		// Without this a Mac keychain item is invisible to the other target
		// even with the access group set, because macOS defaults generic
		// passwords to the legacy file keychain.
		query[kSecUseDataProtectionKeychain as String] = true
		#endif
		return query
	}
}
