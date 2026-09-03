import Foundation

enum GlanceClientError: Error, LocalizedError {
	case noToken
	case badStatus(Int)
	case notAnImage(String)
	case empty

	var errorDescription: String? {
		switch self {
		case .noToken:
			return "This widget is not linked to a three.ws account yet."
		case .badStatus(let code):
			return "three.ws answered \(code)."
		case .notAnImage(let type):
			return "three.ws answered \(type) instead of a card."
		case .empty:
			return "three.ws answered an empty card."
		}
	}
}

/// One request per card: `GET /api/glance/mine?format=png`, the widget token as
/// a bearer, the bitmap in the body and the card's facts in the headers.
///
/// The endpoint answers 200 for every state, including a revoked token and a
/// signed-out account, so anything other than 200 here is a transport problem
/// and the caller falls back to the cached card.
struct GlanceClient {
	/// A card is at most a few hundred kilobytes; past this it is not a card.
	static let maxBytes = 4 * 1024 * 1024

	var origin: URL = GlanceConfig.origin
	var session: URLSession = {
		let config = URLSessionConfiguration.ephemeral
		config.timeoutIntervalForRequest = 20
		config.timeoutIntervalForResource = 30
		// A widget refresh has a hard deadline: failing fast and painting the
		// cached card beats waiting for a network that is not there.
		config.waitsForConnectivity = false
		config.requestCachePolicy = .reloadIgnoringLocalCacheData
		return URLSession(configuration: config)
	}()

	func fetch(size: GlanceSize, theme: GlanceTheme, token: String) async throws -> GlanceCard {
		guard GlanceTokenStore.isWellFormed(token) else { throw GlanceClientError.noToken }

		var components = URLComponents(url: origin.appendingPathComponent("api/glance/mine"),
		                               resolvingAgainstBaseURL: false)
		components?.queryItems = [
			URLQueryItem(name: "format", value: "png"),
			URLQueryItem(name: "size", value: size.rawValue),
			URLQueryItem(name: "theme", value: theme.rawValue),
			URLQueryItem(name: "scale", value: String(size.scale)),
		]
		guard let url = components?.url else { throw GlanceClientError.badStatus(0) }

		var request = URLRequest(url: url)
		request.setValue("image/png", forHTTPHeaderField: "Accept")
		request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
		request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")

		let (data, response) = try await session.data(for: request)
		guard let http = response as? HTTPURLResponse else { throw GlanceClientError.badStatus(0) }
		guard http.statusCode == 200 else { throw GlanceClientError.badStatus(http.statusCode) }

		let type = http.value(forHTTPHeaderField: "Content-Type") ?? ""
		guard type.hasPrefix("image/png") else { throw GlanceClientError.notAnImage(type) }
		guard !data.isEmpty, data.count <= Self.maxBytes else { throw GlanceClientError.empty }

		let tap = http.value(forHTTPHeaderField: "x-glance-url").flatMap(URL.init(string:))
		return GlanceCard(
			png: data,
			state: GlanceState(header: http.value(forHTTPHeaderField: "x-glance-state")),
			url: tap ?? GlanceConfig.linkPageURL,
			name: http.value(forHTTPHeaderField: "x-glance-name") ?? "",
			metric: http.value(forHTTPHeaderField: "x-glance-metric") ?? "",
			agentID: http.value(forHTTPHeaderField: "x-glance-agent") ?? "",
			updatedAt: Self.parseDate(http.value(forHTTPHeaderField: "x-glance-updated")),
			fetchedAt: Date()
		)
	}

	static let userAgent: String = {
		let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
		#if os(macOS)
		return "three.ws-macos-widget/\(version)"
		#else
		return "three.ws-ios-widget/\(version)"
		#endif
	}()

	private static func parseDate(_ raw: String?) -> Date? {
		guard let raw, !raw.isEmpty else { return nil }
		let withFraction = ISO8601DateFormatter()
		withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		if let date = withFraction.date(from: raw) { return date }
		return ISO8601DateFormatter().date(from: raw)
	}
}
