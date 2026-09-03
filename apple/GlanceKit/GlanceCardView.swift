import SwiftUI
import WidgetKit

/// The widget's ink. Every state is drawn, because a widget that renders an
/// error is a widget people remove.
///
/// Three of the four server states arrive as a designed card already (signed
/// out, no agent yet, token revoked), so they need no special case here: the
/// bitmap says the right thing and `x-glance-url` points at the right place.
/// The two the client owns are "no token on this device" and "no card
/// downloaded yet", and they are drawn below.
struct GlanceCardView: View {
	let entry: GlanceEntry
	let size: GlanceSize

	@Environment(\.colorScheme) private var colorScheme

	/// The ground a card sits on. It matches the card's own background, so a
	/// bitmap that does not fill its slot exactly reads as one surface rather
	/// than as an image floating on the system's material.
	static let darkCanvas = Color(red: 0.043, green: 0.043, blue: 0.086)
	static let lightCanvas = Color(red: 0.976, green: 0.976, blue: 0.988)

	private var theme: GlanceTheme { colorScheme == .light ? .light : .dark }
	private var canvas: Color { theme == .light ? Self.lightCanvas : Self.darkCanvas }
	private var ink: Color { theme == .light ? .black : .white }

	var body: some View {
		content
			.containerBackground(canvas, for: .widget)
			.widgetURL(entry.card(for: theme)?.url ?? GlanceConfig.linkPageURL)
	}

	@ViewBuilder
	private var content: some View {
		if let card = entry.card(for: theme), let image = GlanceImage.make(card.png) {
			rendered(image: image, card: card)
		} else if entry.linked {
			GlancePlaceholderView(
				title: "Fetching your agent",
				detail: "The card appears as soon as it downloads.",
				symbol: "arrow.down.circle",
				ink: ink
			)
		} else {
			GlancePlaceholderView(
				title: "Add your agent",
				detail: "Open three.ws and link this widget to your account.",
				symbol: "person.crop.circle.badge.plus",
				ink: ink
			)
		}
	}

	private func rendered(image: Image, card: GlanceCard) -> some View {
		VStack(spacing: 0) {
			image
				.resizable()
				.aspectRatio(contentMode: .fit)
				.frame(maxWidth: .infinity, maxHeight: .infinity)
			if let footer = footer(for: card) {
				Text(footer)
					.font(.system(size: 10, weight: .medium))
					.foregroundStyle(ink.opacity(0.62))
					.lineLimit(1)
					.minimumScaleFactor(0.8)
					.padding(.top, 4)
			}
			if size == .large {
				GlanceActionsRow(ink: ink)
					.padding(.top, 8)
			}
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(accessibilityLabel(for: card))
	}

	/// The honest line under a card that is not current. A widget showing an
	/// hour-old number without saying so is lying about the number.
	private func footer(for card: GlanceCard) -> String? {
		guard entry.offline || card.isStale else { return nil }
		let time = card.fetchedAt.formatted(date: .omitted, time: .shortened)
		return entry.offline ? "From \(time) (offline)" : "From \(time)"
	}

	private func accessibilityLabel(for card: GlanceCard) -> String {
		var parts = [card.name, card.metric].filter { !$0.isEmpty }
		if let footer = footer(for: card) { parts.append(footer) }
		return parts.isEmpty ? "three.ws agent glance" : parts.joined(separator: ", ")
	}
}

/// The two states the server never sends, drawn to the same weight as a real
/// card so an unlinked widget still looks like it belongs on the screen.
struct GlancePlaceholderView: View {
	let title: String
	let detail: String
	let symbol: String
	let ink: Color

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			Image(systemName: symbol)
				.font(.system(size: 22, weight: .regular))
				.foregroundStyle(
					LinearGradient(
						colors: [
							Color(red: 0.31, green: 0.27, blue: 0.9),
							Color(red: 0.49, green: 0.23, blue: 0.93),
						],
						startPoint: .topLeading,
						endPoint: .bottomTrailing
					)
				)
			Spacer(minLength: 0)
			Text(title)
				.font(.system(size: 15, weight: .semibold))
				.foregroundStyle(ink)
			Text(detail)
				.font(.system(size: 11.5))
				.foregroundStyle(ink.opacity(0.62))
				.fixedSize(horizontal: false, vertical: true)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
		.accessibilityElement(children: .combine)
	}
}

/// The large family has room for the two things an owner reaches for next,
/// which is exactly what the Android 4x3 widget offers.
struct GlanceActionsRow: View {
	let ink: Color

	var body: some View {
		HStack(spacing: 8) {
			action(title: "Create", url: GlanceConfig.origin.appendingPathComponent("create"))
			action(title: "My agents", url: GlanceConfig.origin.appendingPathComponent("my-agents"))
		}
	}

	private func action(title: String, url: URL) -> some View {
		Link(destination: url) {
			Text(title)
				.font(.system(size: 12, weight: .semibold))
				.foregroundStyle(ink)
				.frame(maxWidth: .infinity)
				.padding(.vertical, 7)
				.background(ink.opacity(0.1), in: Capsule())
		}
		.accessibilityLabel("Open \(title.lowercased()) on three.ws")
	}
}
