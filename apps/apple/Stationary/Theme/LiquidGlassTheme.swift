import SwiftUI
#if os(iOS)
import UIKit
#endif

// MARK: - App Navigation Tabs (Single Source of Truth across iOS TabView & macOS/iPad Sidebar)
public enum AppTab: Int, CaseIterable, Identifiable {
    case feed = 0
    case posts = 1
    case media = 2
    case drafts = 3
    
    public var id: Int { rawValue }
    
    public var title: String {
        switch self {
        case .feed: return "Feed"
        case .posts: return "Posts"
        case .media: return "Media"
        case .drafts: return "Drafts"
        }
    }
    
    public var icon: String {
        switch self {
        case .feed: return "play.square.stack.fill"
        case .posts: return "doc.text.image.fill"
        case .media: return "photo.stack.fill"
        case .drafts: return "square.and.pencil"
        }
    }
}

// MARK: - Haptic Feedback Manager (Instant Physical Sensation)
@MainActor
public struct HapticManager {
    public enum ImpactStyle: Sendable {
        case light, medium, heavy, rigid, soft
    }
    
    public enum NotificationType: Sendable {
        case success, warning, error
    }
    
    public static func impact(style: ImpactStyle = .light) {
        #if os(iOS)
        let uiStyle: UIImpactFeedbackGenerator.FeedbackStyle
        switch style {
        case .light: uiStyle = .light
        case .medium: uiStyle = .medium
        case .heavy: uiStyle = .heavy
        case .rigid: uiStyle = .rigid
        case .soft: uiStyle = .soft
        }
        let generator = UIImpactFeedbackGenerator(style: uiStyle)
        generator.prepare()
        generator.impactOccurred()
        #endif
    }
    
    public static func selection() {
        #if os(iOS)
        let generator = UISelectionFeedbackGenerator()
        generator.prepare()
        generator.selectionChanged()
        #endif
    }
    
    public static func notification(type: NotificationType) {
        #if os(iOS)
        let uiType: UINotificationFeedbackGenerator.FeedbackType
        switch type {
        case .success: uiType = .success
        case .warning: uiType = .warning
        case .error: uiType = .error
        }
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(uiType)
        #endif
    }
}

// MARK: - Stationary Design System Palette & Tokens (Pure, Crisp Colors & Glass Materials)
public struct LiquidPalette {
    #if os(macOS)
    public static let canvasBg = Color(NSColor.windowBackgroundColor)
    public static let cardBg = Color(NSColor.controlBackgroundColor)
    public static let secondaryCardBg = Color(NSColor.underPageBackgroundColor)
    #else
    public static let canvasBg = Color(UIColor.systemGroupedBackground)
    public static let cardBg = Color(UIColor.secondarySystemGroupedBackground)
    public static let secondaryCardBg = Color(UIColor.tertiarySystemGroupedBackground)
    #endif
    
    public static let accent = Color.accentColor
    
    // Crisp Glass Borders (No muddy grays)
    public static let borderFaint = Color.primary.opacity(0.06)
    public static let borderSubtle = Color.primary.opacity(0.12)
    public static let borderFocus = Color.accentColor.opacity(0.4)
    public static let borderHighlight = Color.white.opacity(0.18)
    
    // Clean Input & Tile Fill Tokens
    public static let tileBg = Color.primary.opacity(0.035)
    public static let tileBgHover = Color.primary.opacity(0.065)
    
    // Vibrant Platform Brand Colors
    public static func platformColor(_ source: SourcePlatform) -> Color {
        switch source {
        case .all: return Color(red: 0.39, green: 0.40, blue: 0.95) // Vibrant Indigo
        case .x: return Color(red: 0.11, green: 0.63, blue: 0.95) // Sky Blue
        case .xhs: return Color(red: 1.00, green: 0.14, blue: 0.26) // Little Red Book Crimson
        case .bilibili: return Color(red: 0.00, green: 0.68, blue: 0.93) // Bilibili Electric Blue
        case .douyin: return Color(red: 0.99, green: 0.17, blue: 0.33) // Douyin Pink Rose
        case .tiktok: return Color(red: 0.94, green: 0.11, blue: 0.32) // TikTok Rose
        case .instagram: return Color(red: 0.89, green: 0.25, blue: 0.55) // Instagram Magenta
        case .unknown: return Color(red: 0.55, green: 0.58, blue: 0.65)
        }
    }
    
    // Vibrant Media Type Accent Colors
    public static func mediaTypeColor(_ type: MediaType) -> Color {
        switch type {
        case .image: return Color(red: 0.23, green: 0.51, blue: 0.96) // Electric Blue
        case .video: return Color(red: 0.06, green: 0.73, blue: 0.51) // Emerald Green
        case .livePhoto: return Color(red: 0.96, green: 0.62, blue: 0.04) // Amber Gold
        case .audio: return Color(red: 0.63, green: 0.36, blue: 0.95) // Purple Violet
        case .pdf: return Color(red: 0.93, green: 0.27, blue: 0.27) // Crimson Red
        }
    }
}

// MARK: - Card-on-Canvas Modifier (Apple Material Depth & Crisp Light-Catching Borders)
public struct FloatingCardModifier: ViewModifier {
    var cornerRadius: CGFloat
    var isInteractive: Bool
    
    @State private var isHovered = false
    
    public init(cornerRadius: CGFloat = 16, isInteractive: Bool = true) {
        self.cornerRadius = cornerRadius
        self.isInteractive = isInteractive
    }
    
    public func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(LiquidPalette.cardBg)
            )
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(
                        isHovered ? LiquidPalette.borderSubtle : LiquidPalette.borderFaint,
                        lineWidth: 1
                    )
            )
            .shadow(
                color: Color.black.opacity(isHovered ? 0.06 : 0.02),
                radius: isHovered ? 12 : 3,
                x: 0,
                y: isHovered ? 4 : 1
            )
            .scaleEffect(isInteractive && isHovered ? 1.01 : 1.0)
            .animation(.spring(response: 0.25, dampingFraction: 0.8), value: isHovered)
            .onHover { hovering in
                if isInteractive {
                    isHovered = hovering
                }
            }
    }
}

// MARK: - Tactile Spring Button Style (0.96 scale with subtle opacity, Apple HIG Standard)
public struct TactileSpringButtonStyle: ButtonStyle {
    var scale: CGFloat = 0.96
    var opacity: CGFloat = 0.88
    
    public init(scale: CGFloat = 0.96, opacity: CGFloat = 0.88) {
        self.scale = scale
        self.opacity = opacity
    }
    
    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1.0)
            .opacity(configuration.isPressed ? opacity : 1.0)
            .animation(.spring(response: 0.22, dampingFraction: 0.78), value: configuration.isPressed)
    }
}

// MARK: - Linear Style ButtonStyle with Instant Tactile Feedback
public struct LinearButtonStyle: ButtonStyle {
    var isSelected: Bool
    
    public init(isSelected: Bool = false) {
        self.isSelected = isSelected
    }
    
    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12.5, weight: isSelected ? .semibold : .medium))
            .frame(height: 32)
            .padding(.horizontal, 12)
            .background(
                isSelected
                    ? Color.accentColor.opacity(0.12)
                    : Color.primary.opacity(configuration.isPressed ? 0.06 : 0.035)
            )
            .foregroundColor(
                isSelected
                    ? Color.accentColor
                    : (configuration.isPressed ? .primary : .primary.opacity(0.85))
            )
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(
                        isSelected
                            ? Color.accentColor.opacity(0.3)
                            : LiquidPalette.borderFaint,
                        lineWidth: 0.8
                    )
            )
            .scaleEffect(configuration.isPressed ? 0.96 : 1.0)
            .animation(.spring(response: 0.2, dampingFraction: 0.78), value: configuration.isPressed)
    }
}

// MARK: - Unified Filter Chip Style for Pixel-Perfect Consistency
public struct UnifiedFilterChipStyle: ButtonStyle {
    var isSelected: Bool
    var tintColor: Color?
    
    public init(isSelected: Bool = false, tintColor: Color? = nil) {
        self.isSelected = isSelected
        self.tintColor = tintColor
    }
    
    public func makeBody(configuration: Configuration) -> some View {
        let accent = tintColor ?? Color.accentColor
        
        configuration.label
            .font(.system(size: 11.5, weight: isSelected ? .semibold : .medium))
            .frame(height: 28)
            .padding(.horizontal, 10)
            .background(
                isSelected
                    ? accent.opacity(0.14)
                    : Color.primary.opacity(configuration.isPressed ? 0.06 : 0.035)
            )
            .foregroundColor(
                isSelected
                    ? accent
                    : (configuration.isPressed ? .primary : .primary.opacity(0.85))
            )
            .clipShape(Capsule())
            .overlay(
                Capsule()
                    .stroke(
                        isSelected
                            ? accent.opacity(0.35)
                            : LiquidPalette.borderFaint,
                        lineWidth: 0.8
                    )
            )
            .scaleEffect(configuration.isPressed ? 0.96 : 1.0)
            .animation(.spring(response: 0.2, dampingFraction: 0.78), value: configuration.isPressed)
    }
}

// MARK: - Tactile Icon Button Modifier
public struct TactileIconButtonModifier: ViewModifier {
    public func body(content: Content) -> some View {
        content
            .buttonStyle(TactileSpringButtonStyle(scale: 0.92, opacity: 0.75))
    }
}

extension ToolbarItemPlacement {
    public static var leadingPlacement: ToolbarItemPlacement {
        #if os(iOS)
        return .topBarLeading
        #else
        return .navigation
        #endif
    }
    
    public static var trailingPlacement: ToolbarItemPlacement {
        #if os(iOS)
        return .topBarTrailing
        #else
        return .primaryAction
        #endif
    }
}

extension View {
    public func liquidGlassCard(cornerRadius: CGFloat = 16, isInteractive: Bool = true) -> some View {
        self.modifier(FloatingCardModifier(cornerRadius: cornerRadius, isInteractive: isInteractive))
    }
    
    @ViewBuilder
    public func pagingTabViewStyle() -> some View {
        #if os(iOS)
        self.tabViewStyle(.page(indexDisplayMode: .never))
        #else
        self.tabViewStyle(.automatic)
        #endif
    }
    
    @ViewBuilder
    public func hiddenPagingTabViewStyle() -> some View {
        #if os(iOS)
        self.tabViewStyle(.page(indexDisplayMode: .never))
        #else
        self.tabViewStyle(.automatic)
        #endif
    }
    
    public func liquidGlassButton(isSelected: Bool = false) -> some View {
        self.buttonStyle(LinearButtonStyle(isSelected: isSelected))
    }
    
    public func unifiedFilterChip(isSelected: Bool = false, tintColor: Color? = nil) -> some View {
        self.buttonStyle(UnifiedFilterChipStyle(isSelected: isSelected, tintColor: tintColor))
    }
    
    public func tactileIconButton() -> some View {
        self.modifier(TactileIconButtonModifier())
    }
    
    public func tactileSpring() -> some View {
        self.buttonStyle(TactileSpringButtonStyle())
    }
    
    public func inlineNavigationBarTitle() -> some View {
        #if os(iOS)
        return self.navigationBarTitleDisplayMode(.inline)
        #else
        return self
        #endif
    }
}

// MARK: - Clean Non-Muddy Canvas Backdrop
public struct LiquidGlassBackgroundView: View {
    public init() {}
    
    public var body: some View {
        ZStack {
            LiquidPalette.canvasBg
        }
        .ignoresSafeArea()
    }
}

extension Color {
    public static let emeraldGreen = Color(red: 16 / 255, green: 185 / 255, blue: 129 / 255)
}



