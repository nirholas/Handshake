import Foundation
import WidgetKit

/// One moment in a widget's timeline.
///
/// It carries both themes because the provider cannot see the reader's
/// appearance: `colorScheme` is a view environment, and a timeline is built
/// long before anything is drawn. Fetching both is cheap (the server caches
/// each rendered card in object storage) and it is what lets a Mac in light
/// mode show a light card instead of a dark rectangle.
struct GlanceEntry: TimelineEntry {
	let date: Date
	/// False when this device holds no widget token, which is the one state the
	/// server cannot answer because nothing can be asked of it yet.
	let linked: Bool
	/// True when the last refresh could not reach three.ws, so the card being
	/// drawn came off the disk.
	let offline: Bool

	private let cards: [GlanceTheme: GlanceCard]

	init(date: Date, linked: Bool, offline: Bool, cards: [GlanceTheme: GlanceCard]) {
		self.date = date
		self.linked = linked
		self.offline = offline
		self.cards = cards
	}

	func card(for theme: GlanceTheme) -> GlanceCard? {
		cards[theme] ?? cards[.dark] ?? cards[.light]
	}

	var hasCard: Bool { !cards.isEmpty }

	static func unlinked(date: Date = Date()) -> GlanceEntry {
		GlanceEntry(date: date, linked: false, offline: false, cards: [:])
	}
}
