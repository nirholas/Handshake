import WidgetKit
import SwiftUI

/// The widget itself. One definition, three families, both platforms.
///
/// Nothing about the card is configurable from the widget: a home screen slot
/// has no room to pick an agent in, so the server answers "your agent" and the
/// owner repoints it from three.ws/glance, which is also where the token that
/// fetches it can be revoked.
struct AgentGlanceWidget: Widget {
	static let kind = "ws.three.glance.agent"

	var body: some WidgetConfiguration {
		StaticConfiguration(kind: Self.kind, provider: GlanceProvider()) { entry in
			AgentGlanceEntryView(entry: entry)
		}
		.configurationDisplayName("Agent glance")
		.description("Your three.ws agent: its avatar, its name, and how many moves it made today.")
		.supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
		.contentMarginsDisabled()
	}
}

/// The family is a view environment, not something the provider can see, so the
/// size the card was fetched at is resolved here as well as in the timeline.
struct AgentGlanceEntryView: View {
	@Environment(\.widgetFamily) private var family
	let entry: GlanceEntry

	var body: some View {
		GlanceCardView(entry: entry, size: GlanceSize(family: family))
	}
}

@main
struct GlanceWidgetBundle: WidgetBundle {
	var body: some Widget {
		AgentGlanceWidget()
	}
}
