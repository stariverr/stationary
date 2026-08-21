import SwiftUI

#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        if let window = NSApp.windows.first {
            window.makeKeyAndOrderFront(nil)
        }
    }
}
#endif

@main
struct StationaryApp: App {
    #if os(macOS)
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    #endif

    public init() {
        #if os(iOS)
        UIPageControl.appearance().isHidden = true
        UIPageControl.appearance().alpha = 0
        UIPageControl.appearance().currentPageIndicatorTintColor = .clear
        UIPageControl.appearance().pageIndicatorTintColor = .clear
        #endif
    }

    var body: some Scene {
        WindowGroup {
            PostListView()
        }
        #if os(macOS)
        .windowStyle(.titleBar)
        .defaultSize(width: 1200, height: 800)
        #endif
    }
}
