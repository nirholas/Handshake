import SwiftUI

/// The window: what state this Mac is in, and the one action that changes it.
struct LinkView: View {
	@ObservedObject var model: GlanceLinkModel

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 18) {
				header
				statusRow
				if model.isLinked {
					linkedActions
				} else {
					linkSteps
				}
				Divider()
				widgetHelp
			}
			.padding(24)
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.frame(minWidth: 420, minHeight: 460)
	}

	private var header: some View {
		VStack(alignment: .leading, spacing: 6) {
			Text("Agent glance")
				.font(.system(size: 22, weight: .semibold))
			Text("Your three.ws agent in Notification Centre: its avatar, its name, and how many moves it made today.")
				.font(.system(size: 13))
				.foregroundStyle(.secondary)
				.fixedSize(horizontal: false, vertical: true)
		}
	}

	@ViewBuilder
	private var statusRow: some View {
		switch model.status {
		case .idle:
			label("Linked to this Mac.", symbol: "checkmark.circle.fill", tint: .green)
		case .working:
			HStack(spacing: 8) {
				ProgressView().controlSize(.small)
				Text("Checking with three.ws").font(.system(size: 13))
			}
		case .linked(let name, let metric):
			label("\(name). \(metric).", symbol: "checkmark.circle.fill", tint: .green)
		case .needsLink:
			label("Not linked yet.", symbol: "person.crop.circle.badge.plus", tint: .accentColor)
		case .failed(let message):
			label(message, symbol: "exclamationmark.triangle.fill", tint: .orange)
		}
	}

	private func label(_ text: String, symbol: String, tint: Color) -> some View {
		HStack(alignment: .firstTextBaseline, spacing: 8) {
			Image(systemName: symbol).foregroundStyle(tint)
			Text(text).font(.system(size: 13)).fixedSize(horizontal: false, vertical: true)
		}
		.accessibilityElement(children: .combine)
	}

	private var linkSteps: some View {
		VStack(alignment: .leading, spacing: 12) {
			step(1, "Open three.ws/glance in your browser and sign in.")
			step(2, "Press Link this device. If this app does not open by itself, copy the code the page shows.")
			step(3, "Paste it here.")

			Button("Open three.ws/glance") { model.openLinkPage() }
				.buttonStyle(.borderedProminent)
				.keyboardShortcut(.defaultAction)

			HStack(spacing: 8) {
				TextField("glw_", text: $model.pastedCode)
					.textFieldStyle(.roundedBorder)
					.font(.system(size: 13, design: .monospaced))
					.onSubmit { model.linkWithPastedCode() }
					.accessibilityLabel("Widget code from three.ws")
				Button("Link") { model.linkWithPastedCode() }
					.disabled(model.pastedCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
			}

			Text("The code reads one thing: your glance card. It cannot sign in, spend, or change anything, and you can revoke it on three.ws/glance at any time.")
				.font(.system(size: 11.5))
				.foregroundStyle(.secondary)
				.fixedSize(horizontal: false, vertical: true)
		}
	}

	private var linkedActions: some View {
		HStack(spacing: 10) {
			Button("Refresh now") { Task { await model.refresh() } }
			Button("Open my agent") { model.openAgent() }
			Spacer()
			Button("Unlink this Mac", role: .destructive) { model.unlink() }
		}
	}

	private var widgetHelp: some View {
		VStack(alignment: .leading, spacing: 8) {
			Text("Adding the widget")
				.font(.system(size: 14, weight: .semibold))
			step(1, "Click the date in the menu bar to open Notification Centre.")
			step(2, "Scroll down and click Edit Widgets.")
			step(3, "Find three.ws Glance and drag Agent glance out. It comes in small, medium and large.")
			Text("The widget refreshes on the system's own schedule, about every half hour. With no network it keeps the last card it downloaded and says when that was.")
				.font(.system(size: 11.5))
				.foregroundStyle(.secondary)
				.fixedSize(horizontal: false, vertical: true)
		}
	}

	private func step(_ number: Int, _ text: String) -> some View {
		HStack(alignment: .firstTextBaseline, spacing: 8) {
			Text("\(number)")
				.font(.system(size: 11, weight: .bold, design: .rounded))
				.foregroundStyle(.white)
				.frame(width: 18, height: 18)
				.background(Color.accentColor, in: Circle())
			Text(text)
				.font(.system(size: 13))
				.fixedSize(horizontal: false, vertical: true)
		}
		.accessibilityElement(children: .combine)
	}
}
