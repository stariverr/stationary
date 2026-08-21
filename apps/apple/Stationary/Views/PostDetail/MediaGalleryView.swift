import SwiftUI
import AVKit

#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

/// Modern, fluid media carousel for social post detail with separated stage layout, gestures, and Live Photo support
public struct MediaGalleryView: View {
    public let mediaItems: [MediaItem]
    @Binding public var selectedIndex: Int
    public var onOpenFullscreen: (() -> Void)? = nil

    @State private var internalFullscreen = false
    @State private var containerWidth: CGFloat = 400

    public init(
        mediaItems: [MediaItem],
        selectedIndex: Binding<Int>,
        onOpenFullscreen: (() -> Void)? = nil
    ) {
        self.mediaItems = mediaItems
        self._selectedIndex = selectedIndex
        self.onOpenFullscreen = onOpenFullscreen
    }

    private var currentMediaItem: MediaItem? {
        guard selectedIndex >= 0 && selectedIndex < mediaItems.count else { return nil }
        return mediaItems[selectedIndex]
    }

    public var body: some View {
        VStack(spacing: 12) {
            // 1. Media Stage View
            mediaStageSection

            // 2. Linear Media Thumbnail Ribbon (Placed strictly below the stage, never overlapping)
            if mediaItems.count > 1 {
                thumbnailRibbon
            }
        }
        #if os(iOS)
        .fullScreenCover(isPresented: $internalFullscreen) {
            MediaLightboxView(mediaItems: mediaItems, selectedIndex: $selectedIndex)
                .presentationDragIndicator(.hidden)
        }
        #endif
    }
    
    private func triggerFullscreen() {
        if let onOpenFullscreen {
            onOpenFullscreen()
        } else {
            LightboxManager.shared.present(items: mediaItems, initialIndex: selectedIndex)
        }
    }

    // MARK: - Media Stage Section
    private var mediaStageSection: some View {
        GeometryReader { geo in
            let availableWidth = geo.size.width
            let itemRatio = currentMediaItem?.aspectRatio ?? 1.0
            let calculatedHeight = min(max(availableWidth / max(itemRatio, 0.65), 300), 540)

            ZStack {
                // Background backplate
                Color.black.opacity(0.95)

                // Paging Stage
                if mediaItems.isEmpty {
                    placeholderEmptyMedia
                } else {
                    ScrollViewReader { scrollProxy in
                        ScrollView(.horizontal, showsIndicators: false) {
                            LazyHStack(spacing: 0) {
                                ForEach(Array(mediaItems.enumerated()), id: \.element.id) { index, item in
                                    MediaGalleryStageItemView(
                                        item: item,
                                        isCurrentItem: index == selectedIndex,
                                        onOpenFullscreen: {
                                            triggerFullscreen()
                                        }
                                    )
                                    .frame(width: availableWidth, height: calculatedHeight)
                                    .id(index)
                                }
                            }
                            .scrollTargetLayout()
                        }
                        .scrollTargetBehavior(.paging)
                        .onChange(of: selectedIndex) { _, newIndex in
                            withAnimation(.spring(response: 0.32, dampingFraction: 0.82)) {
                                scrollProxy.scrollTo(newIndex, anchor: .center)
                            }
                        }
                    }
                }

                // Top-Right Floating Control (Page counter)
                VStack {
                    HStack(spacing: 8) {
                        Spacer()
                        if mediaItems.count > 1 {
                            Text("\(selectedIndex + 1) / \(mediaItems.count)")
                                .font(.system(size: 11.5, weight: .bold, design: .monospaced))
                                .monospacedDigit()
                                .foregroundColor(.white)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 5)
                                .background(.ultraThinMaterial)
                                .clipShape(Capsule())
                                .overlay(Capsule().stroke(Color.white.opacity(0.25), lineWidth: 0.8))
                                .shadow(color: .black.opacity(0.35), radius: 6)
                        }

                    }
                    .padding(12)
                    Spacer()
                }

                // Left / Right Navigation Chevrons
                if mediaItems.count > 1 {
                    HStack {
                        if selectedIndex > 0 {
                            Button {
                                HapticManager.impact(style: .light)
                                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                                    selectedIndex -= 1
                                }
                            } label: {
                                Image(systemName: "chevron.left")
                                    .font(.system(size: 13, weight: .bold))
                                    .foregroundColor(.white)
                                    .frame(width: 34, height: 34)
                                    .background(.ultraThinMaterial)
                                    .clipShape(Circle())
                                    .overlay(Circle().stroke(Color.white.opacity(0.25), lineWidth: 0.8))
                                    .shadow(color: .black.opacity(0.35), radius: 6)
                            }
                            .buttonStyle(.plain)
                            .padding(.leading, 12)
                        }

                        Spacer()

                        if selectedIndex < mediaItems.count - 1 {
                            Button {
                                HapticManager.impact(style: .light)
                                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                                    selectedIndex += 1
                                }
                            } label: {
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 13, weight: .bold))
                                    .foregroundColor(.white)
                                    .frame(width: 34, height: 34)
                                    .background(.ultraThinMaterial)
                                    .clipShape(Circle())
                                    .overlay(Circle().stroke(Color.white.opacity(0.25), lineWidth: 0.8))
                                    .shadow(color: .black.opacity(0.35), radius: 6)
                            }
                            .buttonStyle(.plain)
                            .padding(.trailing, 12)
                        }
                    }
                }

                // Bottom Center Pagination Dots
                if mediaItems.count > 1 && mediaItems.count <= 10 {
                    VStack {
                        Spacer()
                        HStack(spacing: 5) {
                            ForEach(0..<mediaItems.count, id: \.self) { idx in
                                Button {
                                    HapticManager.selection()
                                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                                        selectedIndex = idx
                                    }
                                } label: {
                                    Capsule()
                                        .fill(idx == selectedIndex ? Color.white : Color.white.opacity(0.4))
                                        .frame(
                                            width: idx == selectedIndex ? 16 : 5,
                                            height: 5
                                        )
                                        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: selectedIndex)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5.5)
                        .background(Color.black.opacity(0.45))
                        .clipShape(Capsule())
                        .padding(.bottom, 12)
                    }
                }
            }
            .frame(width: availableWidth, height: calculatedHeight)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(LiquidPalette.borderSubtle, lineWidth: 1)
            )
            .preference(key: StageWidthPreferenceKey.self, value: availableWidth)
        }
        .frame(height: stageCalculatedHeight)
        .onPreferenceChange(StageWidthPreferenceKey.self) { width in
            if width > 0 { containerWidth = width }
        }
    }

    private var stageCalculatedHeight: CGFloat {
        let ratio = currentMediaItem?.aspectRatio ?? 1.0
        return min(max(containerWidth / max(ratio, 0.65), 300), 540)
    }

    // MARK: - Thumbnail Ribbon Strip
    private var thumbnailRibbon: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Array(mediaItems.enumerated()), id: \.element.id) { index, item in
                        let isSelected = index == selectedIndex
                        Button {
                            HapticManager.selection()
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                                selectedIndex = index
                            }
                        } label: {
                            HStack(spacing: 6) {
                                ZStack {
                                    Color.black.opacity(0.3)
                                    if let coverString = item.primaryCoverUrl ?? item.url, let url = URL(string: coverString) {
                                        AsyncImage(url: url) { phase in
                                            if let img = phase.image {
                                                img.resizable().scaledToFill()
                                            } else {
                                                Image(systemName: item.type.iconName)
                                                    .font(.system(size: 14))
                                                    .foregroundColor(.white.opacity(0.5))
                                            }
                                        }
                                    } else {
                                        Image(systemName: item.type.iconName)
                                            .font(.system(size: 14))
                                            .foregroundColor(.white.opacity(0.5))
                                    }
                                }
                                .frame(width: 36, height: 36)
                                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))

                                VStack(alignment: .leading, spacing: 2) {
                                    Text("#\(index + 1)")
                                        .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                                        .foregroundColor(isSelected ? .emeraldGreen : .primary)
                                    Text(item.type.displayName)
                                        .font(.system(size: 9, weight: .semibold))
                                        .foregroundColor(.secondary)
                                }
                                .padding(.trailing, 6)
                            }
                            .padding(4)
                            .background(
                                isSelected
                                    ? Color.emeraldGreen.opacity(0.12)
                                    : LiquidPalette.tileBg
                            )
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .stroke(
                                        isSelected
                                            ? Color.emeraldGreen
                                            : LiquidPalette.borderFaint,
                                        lineWidth: isSelected ? 1.5 : 1
                                    )
                            )
                        }
                        .buttonStyle(TactileSpringButtonStyle(scale: 0.96))
                        .id(index)
                    }
                }
                .padding(.vertical, 2)
            }
            .onChange(of: selectedIndex) { _, newIndex in
                withAnimation {
                    proxy.scrollTo(newIndex, anchor: .center)
                }
            }
        }
    }

    private var placeholderEmptyMedia: some View {
        VStack(spacing: 12) {
            Image(systemName: "photo.on.rectangle.angled")
                .font(.system(size: 38, weight: .light))
                .foregroundColor(.white.opacity(0.4))
            Text("No media assets")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(.white.opacity(0.6))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(32)
    }
}

// MARK: - Width Preference Key
private struct StageWidthPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 400
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

// MARK: - Individual Stage Item
private struct MediaGalleryStageItemView: View {
    let item: MediaItem
    let isCurrentItem: Bool
    var onOpenFullscreen: () -> Void

    // Live Photo State Tracker
    @State private var isPressingLivePhoto = false
    @State private var pressStartTime: Date? = nil
    @State private var hasTriggeredLivePlayback = false

    var body: some View {
        ZStack {
            switch item.type {
            case .video:
                if let videoURLString = item.primaryVideoUrl,
                   let url = URL(string: videoURLString) {
                    ModernVideoPlayerView(
                        videoUrl: url,
                        coverUrl: item.primaryCoverUrl.flatMap(URL.init(string:)),
                        autoPlay: isCurrentItem,
                        showControls: true,
                        tracks: item.tracks,
                        playback: item.playback,
                        onFullscreenToggle: onOpenFullscreen
                    )
                } else if let imageUrlString = item.url ?? item.primaryCoverUrl,
                          let url = URL(string: imageUrlString) {
                    staticImageButton(url: url)
                } else {
                    placeholderView
                }

            case .livePhoto:
                livePhotoStageView

            default:
                if let imageURLString = item.url ?? item.primaryCoverUrl,
                   let url = URL(string: imageURLString) {
                    staticImageButton(url: url)
                } else {
                    placeholderView
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
    }

    // MARK: - Live Photo Stage with Decoupled Long-Press vs Tap
    @ViewBuilder
    private var livePhotoStageView: some View {
        ZStack(alignment: .topLeading) {
            // Base Static Image
            if let imageUrlString = item.primaryCoverUrl ?? item.url,
               let url = URL(string: imageUrlString) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    case .failure:
                        VStack(spacing: 8) {
                            Image(systemName: "exclamationmark.triangle")
                                .font(.system(size: 26))
                            Text("Failed to load Live Photo")
                                .font(.system(size: 11))
                        }
                        .foregroundColor(.white.opacity(0.6))
                    case .empty:
                        ProgressView().tint(.white)
                    @unknown default:
                        EmptyView()
                    }
                }
            } else {
                placeholderView
            }

            // Live Photo Dynamic Video Layer (Smoothly fades in while holding)
            if isPressingLivePhoto,
               let videoURLString = item.primaryVideoUrl,
               let url = URL(string: videoURLString) {
                ModernVideoPlayerView(
                    videoUrl: url,
                    coverUrl: item.primaryCoverUrl.flatMap(URL.init(string:)),
                    autoPlay: true,
                    showControls: false,
                    enableTapToPause: false
                )
                .transition(.opacity.animation(.easeInOut(duration: 0.15)))
            }

            // Apple Style Top-Left LIVE Badge
            Button {
                toggleLivePlayOneShot()
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "livephoto")
                        .symbolEffect(.pulse, isActive: isPressingLivePhoto)
                    Text(isPressingLivePhoto ? "LIVE" : "LIVE PHOTO")
                }
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundColor(.white)
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(isPressingLivePhoto ? Color.accentColor.opacity(0.85) : Color.black.opacity(0.6))
                .clipShape(Capsule())
                .overlay(Capsule().stroke(Color.white.opacity(0.25), lineWidth: 0.8))
                .shadow(color: .black.opacity(0.3), radius: 4)
            }
            .buttonStyle(.plain)
            .padding(12)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .gesture(livePhotoTouchGesture)
    }

    // Gesture State Machine: Decouples Tap (<200ms) from Press & Hold (>=200ms)
    private var livePhotoTouchGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { _ in
                if pressStartTime == nil {
                    let now = Date()
                    pressStartTime = now

                    // Schedule playback after long press threshold
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
                        if let start = pressStartTime, start == now {
                            if !isPressingLivePhoto {
                                HapticManager.impact(style: .medium)
                                withAnimation(.easeInOut(duration: 0.12)) {
                                    isPressingLivePhoto = true
                                    hasTriggeredLivePlayback = true
                                }
                            }
                        }
                    }
                }
            }
            .onEnded { _ in
                let duration = pressStartTime.map { Date().timeIntervalSince($0) } ?? 0
                pressStartTime = nil

                if isPressingLivePhoto || hasTriggeredLivePlayback {
                    // Released after long press: Stop Live playback smoothly, strictly prevent opening Lightbox
                    withAnimation(.easeInOut(duration: 0.15)) {
                        isPressingLivePhoto = false
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
                        hasTriggeredLivePlayback = false
                    }
                } else if duration < 0.25 {
                    // Fast tap: Trigger Fullscreen Lightbox
                    HapticManager.impact(style: .light)
                    onOpenFullscreen()
                }
            }
    }

    private func toggleLivePlayOneShot() {
        HapticManager.impact(style: .medium)
        withAnimation(.easeInOut(duration: 0.15)) {
            isPressingLivePhoto = true
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            withAnimation(.easeInOut(duration: 0.2)) {
                isPressingLivePhoto = false
            }
        }
    }

    private func staticImageButton(url: URL) -> some View {
        Button(action: {
            HapticManager.impact(style: .light)
            onOpenFullscreen()
        }) {
            ZStack {
                Color.black.opacity(0.4)

                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    case .failure:
                        VStack(spacing: 8) {
                            Image(systemName: "exclamationmark.triangle")
                                .font(.system(size: 26))
                            Text("Failed to load image")
                                .font(.system(size: 11))
                        }
                        .foregroundColor(.white.opacity(0.6))
                    case .empty:
                        ProgressView().tint(.white)
                    @unknown default:
                        EmptyView()
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .buttonStyle(.plain)
    }

    private var placeholderView: some View {
        VStack(spacing: 8) {
            Image(systemName: item.type.iconName)
                .font(.system(size: 28))
                .foregroundColor(.white.opacity(0.4))
            Text(item.type.displayName)
                .font(.system(size: 12))
                .foregroundColor(.white.opacity(0.6))
        }
    }
}
