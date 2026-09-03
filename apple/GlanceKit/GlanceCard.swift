import Foundation

/// The states `/api/glance/mine` answers with, plus the one the client owns.
///
/// The server never returns an error status for a widget: every situation is a
/// designed card, and the state travels beside the bitmap in `x-glance-state`.
/// `.unlinked` here covers both halves of the same problem, a token that was
/// revoked and a device that never had one, because the card and the tap
/// target are identical either way.
enum GlanceState: String, Codable {
	case agent
	case unlinked
	case noAgent = "no-agent"
	case signedOut = "signed-out"

	init(header: String?) {
		self = GlanceState(rawValue: header ?? "") ?? .agent
	}
}

/// The three card sizes the server renders, mapped to the widget families that
/// want them. Pinned in specs/GLANCE_CARD.md.
enum GlanceSize: String, Codable, CaseIterable {
	case small
	case medium
	case large

	/// Pixel density to ask for. Large is the biggest canvas, so it asks for
	/// less density to keep the decoded bitmap inside a widget's memory budget.
	var scale: Int { self == .large ? 2 : 3 }

	/// The card's aspect ratio, used to lay the bitmap out before it arrives.
	var aspectRatio: Double {
		switch self {
		case .small: return 1
		case .medium: return 480.0 / 200.0
		case .large: return 480.0 / 300.0
		}
	}
}

enum GlanceTheme: String, Codable, CaseIterable {
	case dark
	case light
}

/// One rendered card: the bitmap, plus the facts the server puts in headers so
/// a native widget learns everything it needs from the request that fetched
/// the image and never needs a JSON parser.
struct GlanceCard: Codable, Equatable {
	var png: Data
	var state: GlanceState
	/// Where a tap goes. Always an absolute https URL on the platform origin.
	var url: URL
	var name: String
	var metric: String
	var agentID: String
	/// When the server computed the card.
	var updatedAt: Date?
	/// When this device last got a fresh copy. Drives the offline footer.
	var fetchedAt: Date

	/// A card older than this is stale enough that the widget says so rather
	/// than presenting yesterday's number as today's.
	static let staleAfter: TimeInterval = 60 * 90

	var isStale: Bool { Date().timeIntervalSince(fetchedAt) > Self.staleAfter }
}
