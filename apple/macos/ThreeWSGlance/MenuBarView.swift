import AppKit
import SwiftUI

/// The menu bar companion: the card itself, small, plus the three things worth
/// reaching for without opening a window.
struct MenuBarView: View {
	@ObservedObject var model: GlanceLinkModel
	@Environment(\.openWindow) private var openWindow

	var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			if let card = model.card, let image = GlanceImage.make(card.png) {
				image
					.resizable()
					.aspectRatio(contentMode: .fit)
					.frame(width: 260)
					.clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
					.accessibilityLabel(accessibilityLabel(for: card))
				if card.isStale {
					Text("From \(card.fetchedAt.formatted(date: .omitted, time: .shortened))")
						.font(.system(size: 11))
						.foregroundStyle(.secondary)
				}
			} else {
				VStack(alignment: .leading, spacing: 4) {
					Text(model.isLinked ? "No card yet" : "Not linked")
						.font(.system(size: 13, weight: .semibold))
					Text(model.isLinked
					     ? "Refresh to pull your agent's card."
					     : "Link this Mac to your three.ws account to see your agent here.")
						.font(.system(size: 11.5))
						.foregroundStyle(.secondary)
						.fixedSize(horizontal: false, vertical: true)
				}
				.frame(width: 260, alignment: .leading)
			}

			Divider()

			VStack(alignment: .leading, spacing: 2) {
				if model.isLinked {
					menuButton("Open my agent") { model.openAgent() }
					menuButton("Refresh now") { Task { await model.refresh() } }
				}
				menuButton(model.isLinked ? "Settings" : "Link this Mac") {
					openWindow(id: "glance-link")
					NSApp.activate(ignoringOtherApps: true)
				}
				menuButton("Quit") { NSApp.terminate(nil) }
			}
		}
		.padding(14)
		.frame(width: 292)
	}

	private func menuButton(_ title: String, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			Text(title)
				.font(.system(size: 13))
				.frame(maxWidth: .infinity, alignment: .leading)
				.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.padding(.vertical, 4)
	}

	private func accessibilityLabel(for card: GlanceCard) -> String {
		[card.name, card.metric].filter { !$0.isEmpty }.joined(separator: ", ")
	}
}
