import Foundation
import WidgetKit

/// The `threews://glance/link?token=glw_…` hand-off, on both Apple platforms.
///
/// This is the same trade the Android app makes with its `intent://` URL: the
/// page mints the token against the session, and the operating system hands it
/// to the one app that claims the scheme, so the credential never touches a web
/// page or a pasteboard unless the owner asks for the code instead.
///
/// A custom scheme is an entry point any app can call, so nothing here trusts
/// the payload: the token has to match the minted shape before it is stored,
/// and anything else is refused without a trace of it reaching the keychain.
enum GlanceLink {
	static let host = "glance"
	static let path = "/link"

	enum Outcome: Equatable {
		case linked
		case notALinkURL
		case malformedToken
		case keychainRefused
	}

	static func isLinkURL(_ url: URL) -> Bool {
		guard url.scheme?.lowercased() == GlanceConfig.urlScheme else { return false }
		// threews://glance/link puts "glance" in the host and "/link" in the path.
		return url.host?.lowercased() == host && url.path == path
	}

	/// Claim a URL. Returns `.notALinkURL` for anything else, which is the
	/// caller's signal to pass it on to whatever normally handles deep links.
	@discardableResult
	static func claim(_ url: URL) -> Outcome {
		guard isLinkURL(url) else { return .notALinkURL }
		let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
		guard let token = items.first(where: { $0.name == "token" })?.value,
		      GlanceTokenStore.isWellFormed(token)
		else { return .malformedToken }

		guard GlanceTokenStore.save(token) else { return .keychainRefused }
		// The previous account's card must not survive a relink.
		GlanceCache()?.clear()
		reloadWidgets()
		return .linked
	}

	/// Forget the token and everything drawn from it. The token itself stays
	/// live on the server until it is revoked from three.ws/glance, which is
	/// why the app sends the owner there rather than pretending otherwise.
	static func unlink() {
		GlanceTokenStore.clear()
		GlanceCache()?.clear()
		reloadWidgets()
	}

	static func reloadWidgets() {
		WidgetCenter.shared.reloadAllTimelines()
	}
}
