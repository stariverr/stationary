import SwiftUI

#if os(macOS)
import AppKit

@MainActor
public final class MediaWindowManager: NSObject, NSWindowDelegate {
    public static let shared = MediaWindowManager()

    private var lightboxController: NSWindowController?

    public func presentLightbox(items: [MediaItem], initialIndex: Int) {
        dismissLightbox()

        let screen = NSApp.keyWindow?.screen ?? NSScreen.main ?? NSScreen.screens.first
        let screenFrame = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
        let width = min(1280, max(800, screenFrame.width * 0.85))
        let height = min(900, max(600, screenFrame.height * 0.85))
        let contentRect = NSRect(
            x: screenFrame.midX - (width / 2),
            y: screenFrame.midY - (height / 2),
            width: width,
            height: height
        )

        let selectedIndex = Binding<Int>(
            get: { LightboxManager.shared.selectedIndex },
            set: { LightboxManager.shared.selectedIndex = $0 }
        )

        let window = NSWindow(
            contentRect: contentRect,
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.delegate = self
        window.title = "Media Viewer"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.collectionBehavior = [.fullScreenPrimary, .fullScreenAllowsTiling]
        window.isOpaque = false
        window.backgroundColor = .black
        window.hasShadow = true
        window.minSize = NSSize(width: 600, height: 450)
        window.contentView = NSHostingView(
            rootView: MediaLightboxView(
                mediaItems: items,
                selectedIndex: selectedIndex,
                onDismiss: {
                    LightboxManager.shared.dismiss()
                }
            )
        )
        configureWindowButtons(window)

        let controller = NSWindowController(window: window)
        lightboxController = controller
        controller.showWindow(nil)
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    public func dismissLightbox() {
        guard let controller = lightboxController else { return }
        lightboxController = nil
        controller.window?.delegate = nil
        controller.close()
    }

    public func toggleWindowFullScreen() {
        guard let window = lightboxController?.window ?? NSApp.keyWindow else { return }
        window.collectionBehavior.insert([.fullScreenPrimary, .fullScreenAllowsTiling])
        window.toggleFullScreen(nil)
    }

    public func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow else { return }
        if let lightboxWindow = lightboxController?.window, window === lightboxWindow {
            lightboxController = nil
            LightboxManager.shared.isPresented = false
        }
    }

    private func configureWindowButtons(_ window: NSWindow) {
        window.standardWindowButton(.miniaturizeButton)?.isHidden = true
        window.standardWindowButton(.zoomButton)?.isHidden = true
    }
}
#endif

/// Global manager for media preview and player presentation across iOS, iPadOS, and macOS.
@MainActor
public final class LightboxManager: ObservableObject {
    public static let shared = LightboxManager()
    
    @Published public var isPresented: Bool = false
    @Published public var mediaItems: [MediaItem] = []
    @Published public var selectedIndex: Int = 0
    
    public init() {}
    
    public func present(items: [MediaItem], initialIndex: Int = 0) {
        guard !items.isEmpty else { return }
        self.mediaItems = items
        self.selectedIndex = max(0, min(initialIndex, items.count - 1))
        self.isPresented = true
        
        #if os(macOS)
        MediaWindowManager.shared.presentLightbox(items: items, initialIndex: self.selectedIndex)
        #endif
    }
    
    public func dismiss() {
        self.isPresented = false
        #if os(macOS)
        MediaWindowManager.shared.dismissLightbox()
        #endif
    }
}
