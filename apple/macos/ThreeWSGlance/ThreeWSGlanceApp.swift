import SwiftUI

/// three.ws Glance for the Mac.
///
/// Two surfaces and nothing else: a menu bar item, which is the surface people
/// actually keep, and one window that links the Mac to an account. The widget
/// in Notification Centre is the point; this app exists to feed it a token and
/// to prove the token works.
@main
struct ThreeWSGlanceApp: App {
	@StateObject private var model = GlanceLinkModel()

	var body: some Scene {
		Window("three.ws Glance", id: "glance-link") {
			LinkView(model: model)
				.onOpenURL { model.handle($0) }
				.task { if model.isLinked { await model.refresh() } }
		}
		.defaultSize(width: 460, height: 520)
		.windowResizability(.contentMinSize)

		MenuBarExtra("three.ws Glance", systemImage: "square.grid.2x2") {
			MenuBarView(model: model)
		}
		.menuBarExtraStyle(.window)
	}
}
