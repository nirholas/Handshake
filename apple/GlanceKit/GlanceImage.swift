import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// One PNG, decoded into a SwiftUI `Image` on whichever platform is asking.
///
/// The card is a server-rendered bitmap on every platform for the same reason:
/// no widget host anywhere can run WebGL, so the 3D agent stays one tap away on
/// its page and the slot gets a picture.
enum GlanceImage {
	static func make(_ data: Data) -> Image? {
		#if canImport(UIKit)
		guard let image = UIImage(data: data) else { return nil }
		return Image(uiImage: image)
		#elseif canImport(AppKit)
		guard let image = NSImage(data: data) else { return nil }
		return Image(nsImage: image)
		#else
		return nil
		#endif
	}
}
