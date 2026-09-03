import WidgetKit
import SwiftUI

/// The timeline behind the Agent glance widget on both Apple platforms.
///
/// The shape is the same trade the Android widget makes: one request per
/// refresh, the bitmap straight to disk, and the last good card kept so a
/// device with no network paints yesterday's card with an honest timestamp
/// instead of a spinner. WidgetKit decides when to actually run this; the
/// policy below is a request, not a schedule.
struct GlanceProvider: TimelineProvider {
	/// What the system is asked for next. Half an hour matches the Android
	/// WorkManager cadence and the 900 second refresh the Windows widget
	/// declares, so the same number moves at the same speed on every surface.
	static let refreshInterval: TimeInterval = 30 * 60
	/// After a failed refresh, ask sooner: the usual cause is a network that
	/// came back a minute later.
	static let retryInterval: TimeInterval = 15 * 60

	func placeholder(in context: Context) -> GlanceEntry {
		cachedEntry(size: GlanceSize(family: context.family)) ?? .unlinked()
	}

	func getSnapshot(in context: Context, completion: @escaping (GlanceEntry) -> Void) {
		let size = GlanceSize(family: context.family)
		// A gallery preview must never spend the token or the network.
		if context.isPreview {
			completion(cachedEntry(size: size) ?? .unlinked())
			return
		}
		Task { completion(await refresh(size: size).entry) }
	}

	func getTimeline(in context: Context, completion: @escaping (Timeline<GlanceEntry>) -> Void) {
		let size = GlanceSize(family: context.family)
		Task {
			let result = await refresh(size: size)
			let next = Date().addingTimeInterval(result.succeeded ? Self.refreshInterval : Self.retryInterval)
			completion(Timeline(entries: [result.entry], policy: .after(next)))
		}
	}

	// MARK: - Fetching

	private struct Result {
		let entry: GlanceEntry
		let succeeded: Bool
	}

	private func refresh(size: GlanceSize) async -> Result {
		guard let token = GlanceTokenStore.load() else {
			// No credential on this device. Nothing to ask, and nothing stale to
			// keep: the card that gets drawn is the link prompt.
			return Result(entry: .unlinked(), succeeded: true)
		}

		let cache = GlanceCache()
		let client = GlanceClient()
		var cards: [GlanceTheme: GlanceCard] = [:]
		var fetched = false

		for theme in GlanceTheme.allCases {
			do {
				let card = try await client.fetch(size: size, theme: theme, token: token)
				cards[theme] = card
				cache?.write(card, size: size, theme: theme)
				fetched = true
				// A revoked token will never work again, so stop spending
				// requests on it and let the unlinked card the server just sent
				// tell the owner what happened.
				if card.state == .unlinked { break }
			} catch {
				if let cached = cache?.read(size: size, theme: theme) { cards[theme] = cached }
			}
		}

		return Result(
			entry: GlanceEntry(date: Date(), linked: true, offline: !fetched, cards: cards),
			succeeded: fetched
		)
	}

	private func cachedEntry(size: GlanceSize) -> GlanceEntry? {
		guard GlanceTokenStore.load() != nil, let cache = GlanceCache() else { return nil }
		var cards: [GlanceTheme: GlanceCard] = [:]
		for theme in GlanceTheme.allCases {
			if let card = cache.read(size: size, theme: theme) { cards[theme] = card }
		}
		guard !cards.isEmpty else { return nil }
		return GlanceEntry(date: Date(), linked: true, offline: true, cards: cards)
	}
}

extension GlanceSize {
	/// Which rendered card fills which slot. Anything the widget does not
	/// declare support for still resolves, so a future family added by the
	/// system gets the wide card rather than nothing.
	init(family: WidgetFamily) {
		switch family {
		case .systemSmall: self = .small
		case .systemLarge, .systemExtraLarge: self = .large
		default: self = .medium
		}
	}
}
