import SwiftUI
import Photos

#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

/// Media preview window with zoomable images, custom video player, quick HUD toggle, and native download/save.
public struct MediaLightboxView: View {
    public let mediaItems: [MediaItem]
    @Binding public var selectedIndex: Int
    public var onDismiss: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss

    @State private var isHUDVisible: Bool = true
    @State private var rotationAngle: Double = 0
    @State private var toastMessage: String? = nil
    @State private var showToast: Bool = false
    @State private var isSaving: Bool = false
    @State private var dragOffset: CGSize = .zero
    @State private var isDraggingToDismiss: Bool = false

    public init(
        mediaItems: [MediaItem],
        selectedIndex: Binding<Int>,
        onDismiss: (() -> Void)? = nil
    ) {
        self.mediaItems = mediaItems
        self._selectedIndex = selectedIndex
        self.onDismiss = onDismiss
    }

    private var currentItem: MediaItem? {
        guard selectedIndex >= 0 && selectedIndex < mediaItems.count else { return nil }
        return mediaItems[selectedIndex]
    }

    public var body: some View {
        ZStack {
            Color.black
                .opacity(max(0.4, 1.0 - Double(abs(dragOffset.height)) / 600.0))
                .ignoresSafeArea()

            // Paging Media Stage
            if mediaItems.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "photo.on.rectangle.angled")
                        .font(.system(size: 40, weight: .light))
                        .foregroundColor(.white.opacity(0.4))
                    Text("No Media Assets")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundColor(.white.opacity(0.6))
                }
            } else {
                GeometryReader { lightboxGeo in
                    ScrollViewReader { scrollProxy in
                        ScrollView(.horizontal, showsIndicators: false) {
                            LazyHStack(spacing: 0) {
                                ForEach(Array(mediaItems.enumerated()), id: \.element.id) { index, item in
                                    mediaItemStage(item: item)
                                        .frame(width: lightboxGeo.size.width, height: lightboxGeo.size.height)
                                        .id(index)
                                }
                            }
                            .scrollTargetLayout()
                        }
                        .scrollTargetBehavior(.paging)
                        .onChange(of: selectedIndex) { _, newIndex in
                            HapticManager.selection()
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                                scrollProxy.scrollTo(newIndex, anchor: .center)
                                rotationAngle = 0
                            }
                        }
                    }
                }
            }

            // Top Navigation Bar (Animated HUD)
            VStack {
                topHeader
                    .opacity(isHUDVisible ? 1 : 0)
                    .offset(y: isHUDVisible ? 0 : -30)
                    .allowsHitTesting(isHUDVisible)

                Spacer()
            }
            .animation(.spring(response: 0.28, dampingFraction: 0.82), value: isHUDVisible)
            .ignoresSafeArea(edges: .horizontal)

            // Toast Notification
            if showToast, let toastMessage {
                VStack {
                    Spacer()
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.emeraldGreen)
                        Text(toastMessage)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundColor(.white)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.ultraThinMaterial)
                    .clipShape(Capsule())
                    .overlay(Capsule().stroke(Color.white.opacity(0.2), lineWidth: 0.8))
                    .shadow(color: .black.opacity(0.4), radius: 12)
                    .padding(.bottom, 36)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .animation(.spring(response: 0.28, dampingFraction: 0.82), value: isHUDVisible)
                }
            }
        }
        .offset(y: max(0, dragOffset.height))
        .scaleEffect(max(0.85, 1.0 - (abs(dragOffset.height) / 2000.0)))
        #if os(iOS)
        .simultaneousGesture(
            DragGesture(minimumDistance: 20)
                .onChanged { value in
                    if value.translation.height > 0 && abs(value.translation.width) < value.translation.height {
                        dragOffset = value.translation
                        isDraggingToDismiss = true
                    }
                }
                .onEnded { value in
                    if value.translation.height > 120 {
                        dismissLightbox()
                    } else {
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                            dragOffset = .zero
                            isDraggingToDismiss = false
                        }
                    }
                }
        )
        .statusBar(hidden: true)
        .presentationDragIndicator(.hidden)
        #elseif os(macOS)
        .onKeyPress(.escape) {
            dismissLightbox()
            return .handled
        }
        #endif
    }

    // MARK: - Stage Subviews

    @ViewBuilder
    private func mediaItemStage(item: MediaItem) -> some View {
        switch item.type {
        case .video:
            if let videoUrlString = item.primaryVideoUrl, let url = URL(string: videoUrlString) {
                ModernVideoPlayerView(
                    videoUrl: url,
                    coverUrl: item.primaryCoverUrl.flatMap(URL.init(string:)),
                    autoPlay: true,
                    showControls: isHUDVisible,
                    tracks: item.tracks,
                    playback: item.playback,
                    onFullscreenToggle: {
                        #if os(macOS)
                        MediaWindowManager.shared.toggleWindowFullScreen()
                        #else
                        toggleHUD()
                        #endif
                    }
                )
            } else if let imageUrlString = item.url ?? item.primaryCoverUrl, let url = URL(string: imageUrlString) {
                ZoomableImageView(
                    url: url,
                    rotationAngle: rotationAngle,
                    onDismissRequest: { dismissLightbox() },
                    onTapToggleHUD: { toggleHUD() }
                )
            }

        case .livePhoto:
            LivePhotoLightboxStageView(
                item: item,
                rotationAngle: rotationAngle,
                isHUDVisible: isHUDVisible,
                onDismissRequest: { dismiss() },
                onTapToggleHUD: { toggleHUD() }
            )

        default:
            if let imageUrlString = item.url ?? item.primaryCoverUrl, let url = URL(string: imageUrlString) {
                ZoomableImageView(
                    url: url,
                    rotationAngle: rotationAngle,
                    onDismissRequest: { dismiss() },
                    onTapToggleHUD: { toggleHUD() }
                )
            } else {
                VStack(spacing: 10) {
                    Image(systemName: item.type.iconName)
                        .font(.system(size: 36))
                        .foregroundColor(.white.opacity(0.4))
                    Text(item.type.displayName)
                        .font(.system(size: 13))
                        .foregroundColor(.white.opacity(0.6))
                }
            }
        }
    }

    private func toggleHUD() {
        HapticManager.impact(style: .light)
        withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
            isHUDVisible.toggle()
        }
    }



    // MARK: - Header Bar (Web & Flutter Standard: Close [Left] | Counter [Center] | Actions [Right])

    private var topHeader: some View {
        HStack(spacing: 12) {
            // Dismiss button (Top-Left)
            #if os(iOS)
            Button {
                HapticManager.impact(style: .light)
                onDismiss?()
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundColor(.white)
                    .frame(width: 36, height: 36)
                    .background(.ultraThinMaterial)
                    .clipShape(Circle())
                    .overlay(Circle().stroke(Color.white.opacity(0.2), lineWidth: 0.8))
            }
            .tactileIconButton()
            #else
            // macOS supplies the native traffic-light close button.
            Color.clear
                .frame(width: 36, height: 36)
            #endif

            Spacer()

            // Index counter (Top-Center)
            if mediaItems.count > 1 {
                Text("\(selectedIndex + 1) / \(mediaItems.count)")
                    .font(.system(size: 12.5, weight: .semibold, design: .monospaced))
                    .monospacedDigit()
                    .foregroundColor(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(.ultraThinMaterial)
                    .clipShape(Capsule())
                    .overlay(Capsule().stroke(Color.white.opacity(0.2), lineWidth: 0.8))
            }

            Spacer()

            // Actions (Top-Right): Rotate (images/livephoto), Save/Download, Native Share, Fullscreen Toggle
            HStack(spacing: 8) {
                #if os(macOS)
                // Monitor Fullscreen Toggle Button (macOS)
                Button {
                    HapticManager.impact(style: .light)
                    MediaWindowManager.shared.toggleWindowFullScreen()
                } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(.white)
                        .frame(width: 36, height: 36)
                        .background(.ultraThinMaterial)
                        .clipShape(Circle())
                        .overlay(Circle().stroke(Color.white.opacity(0.2), lineWidth: 0.8))
                }
                .tactileIconButton()
                .help("Toggle Fullscreen")
                #endif

                // Rotate Button (Only for images & live photo)
                if let item = currentItem, item.type == .image || item.type == .livePhoto {
                    Button {
                        HapticManager.impact(style: .light)
                        withAnimation(.spring(response: 0.25, dampingFraction: 0.8)) {
                            rotationAngle += 90
                        }
                    } label: {
                        Image(systemName: "rotate.right")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundColor(.white)
                            .frame(width: 36, height: 36)
                            .background(.ultraThinMaterial)
                            .clipShape(Circle())
                            .overlay(Circle().stroke(Color.white.opacity(0.2), lineWidth: 0.8))
                    }
                    .tactileIconButton()
                }

                // Save / Download to Photos (Images, Live Photos, Videos)
                Button {
                    saveCurrentAsset()
                } label: {
                    ZStack {
                        if isSaving {
                            ProgressView()
                                .controlSize(.small)
                                .tint(.white)
                        } else {
                            Image(systemName: "arrow.down.to.line.compact")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(.white)
                        }
                    }
                    .frame(width: 36, height: 36)
                    .background(.ultraThinMaterial)
                    .clipShape(Circle())
                    .overlay(Circle().stroke(Color.white.opacity(0.2), lineWidth: 0.8))
                }
                .disabled(isSaving)
                .tactileIconButton()

                // Native Share Link
                if let shareURL = currentItemShareURL {
                    ShareLink(item: shareURL) {
                        Image(systemName: "square.and.arrow.up")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundColor(.white)
                            .frame(width: 36, height: 36)
                            .background(.ultraThinMaterial)
                            .clipShape(Circle())
                            .overlay(Circle().stroke(Color.white.opacity(0.2), lineWidth: 0.8))
                    }
                    .tactileIconButton()
                }
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 16)
        .background(
            LinearGradient(colors: [.black.opacity(0.65), .clear], startPoint: .top, endPoint: .bottom)
        )
    }

    private func dismissLightbox() {
        HapticManager.impact(style: .light)
        onDismiss?()
        dismiss()
    }

    private var currentItemShareURL: URL? {
        guard let item = currentItem else { return nil }
        let urlString = item.primaryVideoUrl ?? item.url ?? item.primaryCoverUrl
        return urlString.flatMap(URL.init(string:))
    }

    private func actionIconLabel(icon: String, text: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .semibold))
            Text(text)
                .font(.system(size: 12, weight: .semibold))
        }
        .foregroundColor(.white)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
    }

    // MARK: - Download & Save to Photos

    private func saveCurrentAsset() {
        guard let item = currentItem, !isSaving else { return }
        isSaving = true

        if item.type == .video {
            guard let videoUrlString = item.primaryVideoUrl, let url = URL(string: videoUrlString) else {
                isSaving = false
                triggerToast(message: "Video URL Unavailable")
                return
            }

            URLSession.shared.downloadTask(with: url) { localURL, _, error in
                guard let localURL, error == nil else {
                    DispatchQueue.main.async {
                        isSaving = false
                        triggerToast(message: "Download Failed")
                    }
                    return
                }

                let tempDir = FileManager.default.temporaryDirectory
                let destinationURL = tempDir.appendingPathComponent(UUID().uuidString + ".mp4")
                try? FileManager.default.removeItem(at: destinationURL)

                do {
                    try FileManager.default.moveItem(at: localURL, to: destinationURL)
                    #if os(iOS)
                    UISaveVideoAtPathToSavedPhotosAlbum(destinationURL.path, nil, nil, nil)
                    DispatchQueue.main.async {
                        isSaving = false
                        HapticManager.notification(type: .success)
                        triggerToast(message: "Video Saved to Photos")
                    }
                    #else
                    DispatchQueue.main.async {
                        isSaving = false
                        triggerToast(message: "Video Downloaded")
                    }
                    #endif
                } catch {
                    DispatchQueue.main.async {
                        isSaving = false
                        triggerToast(message: "Save Failed")
                    }
                }
            }.resume()
        } else {
            guard let coverUrl = item.primaryCoverUrl ?? item.url, let url = URL(string: coverUrl) else {
                isSaving = false
                triggerToast(message: "Image URL Unavailable")
                return
            }

            URLSession.shared.dataTask(with: url) { data, _, error in
                #if os(iOS)
                if let data, let image = UIImage(data: data), error == nil {
                    UIImageWriteToSavedPhotosAlbum(image, nil, nil, nil)
                    DispatchQueue.main.async {
                        isSaving = false
                        HapticManager.notification(type: .success)
                        triggerToast(message: "Image Saved to Photos")
                    }
                } else {
                    DispatchQueue.main.async {
                        isSaving = false
                        triggerToast(message: "Download Failed")
                    }
                }
                #else
                DispatchQueue.main.async {
                    isSaving = false
                    triggerToast(message: "Image Downloaded")
                }
                #endif
            }.resume()
        }
    }

    private func triggerToast(message: String) {
        toastMessage = message
        withAnimation(.spring(response: 0.25, dampingFraction: 0.75)) {
            showToast = true
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
            withAnimation(.easeOut(duration: 0.2)) {
                showToast = false
            }
        }
    }
}

// MARK: - Dedicated Live Photo Lightbox Stage
private struct LivePhotoLightboxStageView: View {
    let item: MediaItem
    let rotationAngle: Double
    let isHUDVisible: Bool
    var onDismissRequest: () -> Void
    var onTapToggleHUD: () -> Void

    @State private var isPlayingLive = false
    @State private var isPressing = false
    @State private var pressStartTime: Date? = nil

    var body: some View {
        ZStack(alignment: .topLeading) {
            // Base Zoomable Static Image
            if let imageUrlString = item.primaryCoverUrl ?? item.url, let url = URL(string: imageUrlString) {
                ZoomableImageView(
                    url: url,
                    rotationAngle: rotationAngle,
                    onDismissRequest: onDismissRequest,
                    onTapToggleHUD: onTapToggleHUD
                )
            }

            // Smooth Live Video Layer when active
            if (isPlayingLive || isPressing),
               let videoURLString = item.primaryVideoUrl,
               let url = URL(string: videoURLString) {
                ModernVideoPlayerView(
                    videoUrl: url,
                    coverUrl: item.primaryCoverUrl.flatMap(URL.init(string:)),
                    autoPlay: true,
                    showControls: false,
                    enableTapToPause: false
                )
                .rotationEffect(.degrees(rotationAngle))
                .transition(.opacity.animation(.easeInOut(duration: 0.18)))
            }

            // Floating Top-Left LIVE Badge (Integrated with Lightbox HUD)
            if isHUDVisible {
                Button {
                    playLiveOneShot()
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "livephoto")
                            .symbolEffect(.pulse, isActive: isPlayingLive || isPressing)
                        Text((isPlayingLive || isPressing) ? "LIVE" : "LIVE PHOTO")
                    }
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundColor(.white)
                    .padding(.horizontal, 11)
                    .padding(.vertical, 6)
                    .background(.ultraThinMaterial)
                    .clipShape(Capsule())
                    .overlay(Capsule().stroke(Color.white.opacity(0.25), lineWidth: 0.8))
                    .shadow(color: .black.opacity(0.35), radius: 6)
                }
                .tactileIconButton()
                .padding(.leading, 18)
                .padding(.top, 64)
                .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .gesture(livePhotoPressGesture)
    }

    private var livePhotoPressGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { _ in
                if pressStartTime == nil {
                    let now = Date()
                    pressStartTime = now
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
                        if let start = pressStartTime, start == now {
                            if !isPressing {
                                HapticManager.impact(style: .medium)
                                withAnimation(.easeInOut(duration: 0.15)) {
                                    isPressing = true
                                }
                            }
                        }
                    }
                }
            }
            .onEnded { _ in
                let duration = pressStartTime.map { Date().timeIntervalSince($0) } ?? 0
                pressStartTime = nil
                if isPressing {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        isPressing = false
                    }
                } else if duration < 0.25 {
                    onTapToggleHUD()
                }
            }
    }

    private func playLiveOneShot() {
        HapticManager.impact(style: .medium)
        withAnimation(.easeInOut(duration: 0.15)) {
            isPlayingLive = true
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.8) {
            withAnimation(.easeInOut(duration: 0.2)) {
                isPlayingLive = false
            }
        }
    }
}
