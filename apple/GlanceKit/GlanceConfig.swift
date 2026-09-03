import Foundation

/// Where a widget reads its card from, and which containers it shares with its
/// host app.
///
/// Every value is read from the running target's Info.plist rather than hard
/// coded, because the two platforms cannot agree on the strings. An App Group
/// on iOS is `group.ws.three.app`; the same group on a Mac distributed with a
/// Developer ID has to carry the team prefix. Both projects set the build
/// settings `GLANCE_ORIGIN`, `GLANCE_APP_GROUP` and `GLANCE_KEYCHAIN_GROUP`,
/// Xcode expands them into the Info.plist and the entitlements, and this file
/// stays identical on both.
enum GlanceConfig {
	/// The production origin. Used when the Info.plist key is missing, which is
	/// what a bare `swift build` of the sources sees.
	static let defaultOrigin = URL(string: "https://three.ws")!

	static var origin: URL {
		guard let raw = infoString("GlanceOrigin"),
		      let url = URL(string: raw),
		      url.scheme == "https"
		else { return defaultOrigin }
		return url
	}

	/// The App Group container holding the last card. `nil` on a single-target
	/// development run, where the extension falls back to its own container and
	/// simply cannot see what the app cached. A value starting with a dot means
	/// `DEVELOPMENT_TEAM` was not set when the Mac project was built, so the
	/// team prefix expanded to nothing and the identifier is not a real group.
	static var appGroup: String? {
		guard let raw = infoString("GlanceAppGroup"), !raw.hasPrefix(".") else { return nil }
		return raw
	}

	/// The shared keychain group. `nil` when `DEVELOPMENT_TEAM` was not set at
	/// build time, in which case the value expands to a bare `.ws.three.shared`
	/// and the token lives in the target's own keychain instead.
	static var keychainGroup: String? {
		guard let raw = infoString("GlanceKeychainGroup"), !raw.hasPrefix(".") else { return nil }
		return raw
	}

	static let keychainService = "ws.three.glance"
	static let keychainAccount = "widget-token"

	/// The scheme both Apple apps claim, and the one `/api/glance/token` builds
	/// its `links.apple` URL with.
	static let urlScheme = "threews"

	/// The page that mints and revokes widget tokens.
	static var linkPageURL: URL { origin.appendingPathComponent("glance") }

	private static func infoString(_ key: String) -> String? {
		guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return nil }
		let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
		return trimmed.isEmpty ? nil : trimmed
	}
}
