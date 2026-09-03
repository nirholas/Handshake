import AppKit
import Foundation
import SwiftUI

/// The host app's whole job: hold the widget token, prove it works, and give
/// the owner a way to drop it.
///
/// The Mac never sees a password. Signing in happens on three.ws in the
/// browser, exactly as it does on the phone, and the page hands back a token
/// through `threews://glance/link` or as a code to paste. Everything after that
/// is one read-only endpoint.
@MainActor
final class GlanceLinkModel: ObservableObject {
	enum Status: Equatable {
		case idle
		case working
		case linked(name: String, metric: String)
		case needsLink
		case failed(String)
	}

	@Published private(set) var status: Status = .idle
	@Published private(set) var card: GlanceCard?
	@Published var pastedCode: String = ""

	private let client = GlanceClient()
	private let cache = GlanceCache()

	var isLinked: Bool { GlanceTokenStore.load() != nil }

	init() {
		card = cache?.read(size: .medium, theme: .dark)
		status = isLinked ? .idle : .needsLink
	}

	/// Open the page that mints a token. It is also where tokens are revoked,
	/// which is why the app links to it rather than reimplementing the list.
	func openLinkPage() {
		var components = URLComponents(url: GlanceConfig.linkPageURL, resolvingAgainstBaseURL: false)
		components?.queryItems = [URLQueryItem(name: "link", value: "apple")]
		guard let url = components?.url else { return }
		NSWorkspace.shared.open(url)
	}

	func openAgent() {
		NSWorkspace.shared.open(card?.url ?? GlanceConfig.origin)
	}

	/// The deep link half of the hand-off.
	func handle(_ url: URL) {
		switch GlanceLink.claim(url) {
		case .linked:
			pastedCode = ""
			Task { await refresh() }
		case .malformedToken:
			status = .failed("That link did not carry a usable code. Press Link this device on three.ws/glance again.")
		case .keychainRefused:
			status = .failed("macOS refused to store the code in the keychain.")
		case .notALinkURL:
			break
		}
	}

	/// The paste half. A Mac whose browser is signed in on another machine has
	/// no URL to follow, so the code on the page is the path that always works.
	func linkWithPastedCode() {
		let code = pastedCode.trimmingCharacters(in: .whitespacesAndNewlines)
		guard GlanceTokenStore.isWellFormed(code) else {
			status = .failed("A widget code looks like glw_ followed by 32 characters.")
			return
		}
		guard GlanceTokenStore.save(code) else {
			status = .failed("macOS refused to store the code in the keychain.")
			return
		}
		cache?.clear()
		GlanceLink.reloadWidgets()
		pastedCode = ""
		Task { await refresh() }
	}

	/// Prove the token works and give the menu bar something live to show. The
	/// widget does the same fetch on its own schedule; this one exists so a
	/// person who just linked sees their agent immediately.
	func refresh() async {
		guard let token = GlanceTokenStore.load() else {
			card = nil
			status = .needsLink
			return
		}
		status = .working
		do {
			let fresh = try await client.fetch(size: .medium, theme: .dark, token: token)
			cache?.write(fresh, size: .medium, theme: .dark)
			card = fresh
			GlanceLink.reloadWidgets()
			switch fresh.state {
			case .agent:
				status = .linked(name: fresh.name, metric: fresh.metric)
			case .unlinked:
				// The server says this credential is gone. Drop it rather than
				// retrying it every half hour forever.
				GlanceLink.unlink()
				card = nil
				status = .failed("This code was revoked on three.ws/glance. Link this device again.")
			case .noAgent:
				status = .failed("This account has no agent yet. Create one on three.ws and the widget fills in.")
			case .signedOut:
				status = .failed("three.ws did not recognise this code. Link this device again.")
			}
		} catch {
			status = .failed(error.localizedDescription)
		}
	}

	func unlink() {
		GlanceLink.unlink()
		card = nil
		status = .needsLink
	}
}
