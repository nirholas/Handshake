import Foundation

/// The last card this device successfully downloaded, on disk in the App Group
/// container so the host app and the widget extension read the same copy.
///
/// This is what makes an offline widget show yesterday's card with an honest
/// timestamp instead of a spinner or a broken image. Writes are atomic, so a
/// refresh killed halfway through leaves the previous card intact rather than a
/// truncated PNG.
struct GlanceCache {
	private let directory: URL
	private let fileManager: FileManager

	init?(fileManager: FileManager = .default) {
		self.fileManager = fileManager
		let base: URL?
		if let group = GlanceConfig.appGroup {
			base = fileManager.containerURL(forSecurityApplicationGroupIdentifier: group)
		} else {
			// No App Group (a single-target development run): the extension and
			// the app each keep their own copy. The widget still works; the two
			// simply do not share a cache.
			base = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
		}
		guard let root = base else { return nil }
		directory = root.appendingPathComponent("glance", isDirectory: true)
		try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
	}

	func read(size: GlanceSize, theme: GlanceTheme) -> GlanceCard? {
		guard let data = try? Data(contentsOf: url(size: size, theme: theme)) else { return nil }
		return try? decoder.decode(GlanceCard.self, from: data)
	}

	@discardableResult
	func write(_ card: GlanceCard, size: GlanceSize, theme: GlanceTheme) -> Bool {
		guard let data = try? encoder.encode(card) else { return false }
		do {
			try data.write(to: url(size: size, theme: theme), options: .atomic)
			return true
		} catch {
			return false
		}
	}

	/// Drop every cached card. Called on unlink, so a revoked widget cannot keep
	/// painting the agent it no longer has a credential for.
	func clear() {
		for size in GlanceSize.allCases {
			for theme in GlanceTheme.allCases {
				try? fileManager.removeItem(at: url(size: size, theme: theme))
			}
		}
	}

	private func url(size: GlanceSize, theme: GlanceTheme) -> URL {
		directory.appendingPathComponent("card-\(size.rawValue)-\(theme.rawValue).json")
	}

	private var encoder: JSONEncoder {
		let encoder = JSONEncoder()
		encoder.dateEncodingStrategy = .iso8601
		return encoder
	}

	private var decoder: JSONDecoder {
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		return decoder
	}
}
