import SwiftUI
import AVKit
import Combine

#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

// MARK: - WebVTT Subtitle Cue Structure & Parser
public struct WebVttCue: Identifiable, Hashable, Sendable {
    public let id = UUID()
    public let startTime: Double
    public let endTime: Double
    public let text: String
}

public enum WebVttParser {
    public static func parse(_ text: String) -> [WebVttCue] {
        var cues: [WebVttCue] = []
        let lines = text.components(separatedBy: .newlines)
        var i = 0
        
        while i < lines.count {
            let line = lines[i].trimmingCharacters(in: .whitespacesAndNewlines)
            if line.contains("-->") {
                let parts = line.components(separatedBy: "-->")
                if parts.count >= 2,
                   let start = parseTimestamp(parts[0].trimmingCharacters(in: .whitespaces)),
                   let end = parseTimestamp(parts[1].trimmingCharacters(in: .whitespaces).components(separatedBy: " ").first ?? "") {
                    i += 1
                    var cueTextLines: [String] = []
                    while i < lines.count && !lines[i].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        let cleaned = lines[i].replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
                        cueTextLines.append(cleaned)
                        i += 1
                    }
                    let cueText = cueTextLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                    if !cueText.isEmpty {
                        cues.append(WebVttCue(startTime: start, endTime: end, text: cueText))
                    }
                }
            }
            i += 1
        }
        return cues
    }
    
    private static func parseTimestamp(_ raw: String) -> Double? {
        let parts = raw.components(separatedBy: ":")
        guard parts.count >= 2 else { return nil }
        
        var hours: Double = 0
        var minutes: Double = 0
        var seconds: Double = 0
        
        if parts.count == 3 {
            hours = Double(parts[0]) ?? 0
            minutes = Double(parts[1]) ?? 0
            seconds = Double(parts[2].replacingOccurrences(of: ",", with: ".")) ?? 0
        } else if parts.count == 2 {
            minutes = Double(parts[0]) ?? 0
            seconds = Double(parts[1].replacingOccurrences(of: ",", with: ".")) ?? 0
        }
        return (hours * 3600) + (minutes * 60) + seconds
    }
}

/// Production-grade video player with quality switching, audio tracks, subtitles, tech info stats, gestures, and audio management
public struct ModernVideoPlayerView: View {
    public let videoUrl: URL
    public var coverUrl: URL? = nil
    public var autoPlay: Bool = true
    public var showControls: Bool = true
    public var enableTapToPause: Bool = true
    public var isFeedMode: Bool = false
    public var isFullscreenPresentation: Bool = false
    public var tracks: [MediaTrackItem]? = nil
    public var playback: PlaybackInfo? = nil
    public var onFullscreenToggle: (() -> Void)? = nil
    
    @State private var currentActiveUrl: URL
    @State private var player: AVPlayer?
    @State private var isPlaying: Bool = false
    @State private var isMuted: Bool = false
    @State private var volume: Float = 1.0
    @State private var isHoveringVolume: Bool = false
    @State private var currentTime: Double = 0
    @State private var duration: Double = 0
    @State private var isDraggingScrubber: Bool = false
    @State private var scrubberDragValue: Double = 0
    @State private var isBuffering: Bool = false
    @State private var showHUD: Bool = true
    @State private var selectedSpeed: Float = 1.0
    @State private var isInternalFullscreen: Bool = false
    
    // Hold to 2x Speed
    @State private var isFastForwarding: Bool = false
    
    // Quick Skip Ripple Animations
    @State private var skipForwardTrigger: Bool = false
    @State private var skipBackwardTrigger: Bool = false
    
    // Settings & Panels
    @State private var showSettingsDrawer: Bool = false
    @State private var showInfoModal: Bool = false
    @State private var selectedVideoTrackId: String? = nil
    @State private var selectedAudioTrackId: String? = nil
    @State private var selectedSubtitleTrackId: String? = nil
    @State private var subtitleCues: [WebVttCue] = []
    
    // Auto-hide HUD timer
    @State private var hudTimer: Timer?
    @State private var timeObserverToken: Any?
    @State private var cancellables = Set<AnyCancellable>()
    
    private let playbackSpeeds: [Float] = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0]
    
    public init(
        videoUrl: URL,
        coverUrl: URL? = nil,
        autoPlay: Bool = true,
        showControls: Bool = true,
        enableTapToPause: Bool = true,
        isFeedMode: Bool = false,
        isFullscreenPresentation: Bool = false,
        tracks: [MediaTrackItem]? = nil,
        playback: PlaybackInfo? = nil,
        onFullscreenToggle: (() -> Void)? = nil
    ) {
        self.videoUrl = videoUrl
        self.coverUrl = coverUrl
        self.autoPlay = autoPlay
        self.showControls = showControls
        self.enableTapToPause = enableTapToPause
        self.isFeedMode = isFeedMode
        self.isFullscreenPresentation = isFullscreenPresentation
        self.tracks = tracks
        self.playback = playback
        self.onFullscreenToggle = onFullscreenToggle
        self._currentActiveUrl = State(initialValue: videoUrl)
    }
    
    public var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black
                
                // Video Player Surface
                if let player {
                    VideoLayerRepresentable(player: player)
                        .ignoresSafeArea()
                } else if let coverUrl {
                    AsyncImage(url: coverUrl) { phase in
                        if let image = phase.image {
                            image
                                .resizable()
                                .scaledToFit()
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                    }
                    ProgressView().tint(.white)
                } else {
                    ProgressView().tint(.white)
                }
                
                // Active Subtitle Overlay
                if let activeCue = currentActiveSubtitleCue {
                    VStack {
                        Spacer()
                        Text(activeCue.text)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(.white)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 6)
                            .background(Color.black.opacity(0.75))
                            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(Color.white.opacity(0.15), lineWidth: 0.8))
                            .shadow(color: .black.opacity(0.6), radius: 4)
                            .padding(.bottom, showHUD ? 76 : 28)
                            .animation(.easeInOut(duration: 0.15), value: showHUD)
                    }
                    .padding(.horizontal, 20)
                    .transition(.opacity)
                }
                
                // Gesture Overlay
                if showControls && !isFeedMode {
                    HStack(spacing: 0) {
                        // Left 40%: Double tap rewind 10s
                        Color.clear
                            .contentShape(Rectangle())
                            .onTapGesture(count: 2) {
                                seekRelative(seconds: -10)
                                withAnimation(.easeOut(duration: 0.4)) {
                                    skipBackwardTrigger = true
                                }
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                                    skipBackwardTrigger = false
                                }
                            }
                            .onTapGesture(count: 1) {
                                toggleHUD()
                            }
                        
                        // Center 20%: Play/Pause
                        Color.clear
                            .contentShape(Rectangle())
                            .onTapGesture(count: 2) {
                                togglePlayPause()
                            }
                            .onTapGesture(count: 1) {
                                toggleHUD()
                            }
                        
                        // Right 40%: Double tap forward 10s
                        Color.clear
                            .contentShape(Rectangle())
                            .onTapGesture(count: 2) {
                                seekRelative(seconds: 10)
                                withAnimation(.easeOut(duration: 0.4)) {
                                    skipForwardTrigger = true
                                }
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                                    skipForwardTrigger = false
                                }
                            }
                            .onTapGesture(count: 1) {
                                toggleHUD()
                            }
                    }
                    .simultaneousGesture(
                        LongPressGesture(minimumDuration: 0.35)
                            .onEnded { _ in
                                start2xPlayback()
                            }
                    )
                } else if enableTapToPause {
                    Color.clear
                        .contentShape(Rectangle())
                        .onTapGesture {
                            togglePlayPause()
                        }
                }
                
                // 2X Speed Floating Indicator
                if isFastForwarding {
                    VStack {
                        HStack(spacing: 6) {
                            Image(systemName: "forward.fill")
                                .font(.system(size: 11, weight: .bold))
                            Text("2X SPEED")
                                .font(.system(size: 11.5, weight: .bold, design: .monospaced))
                        }
                        .foregroundColor(.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(.ultraThinMaterial)
                        .clipShape(Capsule())
                        .overlay(Capsule().stroke(Color.white.opacity(0.3), lineWidth: 0.8))
                        .shadow(color: .black.opacity(0.4), radius: 8)
                        .padding(.top, 24)
                        .transition(.scale.combined(with: .opacity))
                        
                        Spacer()
                    }
                }
                
                // Quick Skip Indicators Overlay
                if skipBackwardTrigger {
                    skipBadge(icon: "gobackward.10", text: "-10s")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, 36)
                        .transition(.scale.combined(with: .opacity))
                }
                
                if skipForwardTrigger {
                    skipBadge(icon: "goforward.10", text: "+10s")
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .padding(.trailing, 36)
                        .transition(.scale.combined(with: .opacity))
                }
                
                // Center Buffering Spinner
                if isBuffering {
                    ProgressView()
                        .controlSize(.large)
                        .tint(.white)
                        .padding(20)
                        .background(.ultraThinMaterial)
                        .clipShape(Circle())
                }
                
                // Unified Control HUD Overlay
                if showControls && !isFeedMode {
                    ZStack {
                        // Center Play Button (Paused State)
                        if !isPlaying {
                            Button {
                                togglePlayPause()
                            } label: {
                                Image(systemName: "play.fill")
                                    .font(.system(size: 26, weight: .bold))
                                    .foregroundColor(.white)
                                    .frame(width: 56, height: 56)
                                    .background(.ultraThinMaterial)
                                    .clipShape(Circle())
                                    .overlay(Circle().stroke(Color.white.opacity(0.25), lineWidth: 1))
                                    .shadow(color: .black.opacity(0.35), radius: 10)
                            }
                            .buttonStyle(TactileSpringButtonStyle(scale: 0.92))
                            .transition(.scale.combined(with: .opacity))
                        }
                        
                        // Unified Bottom Controls Bar
                        if showHUD {
                            VStack {
                                Spacer()
                                unifiedBottomControlBar
                            }
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                        }
                    }
                }
                
                // Settings Drawer Overlay (Quality, Audio, Subtitles, Speed)
                if showSettingsDrawer {
                    settingsDrawerOverlay
                        .transition(.opacity.combined(with: .move(edge: .trailing)))
                        .zIndex(200)
                }
                
                // Tech Info Stats Modal Overlay
                if showInfoModal {
                    techInfoModalOverlay
                        .transition(.opacity.combined(with: .scale(scale: 0.95)))
                        .zIndex(300)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipped()
            #if os(macOS)
            .onContinuousHover { _ in
                showHUDTemporarily()
            }
            #endif
            .onAppear {
                setupPlayer()
            }
            .onDisappear {
                cleanupPlayer()
            }
        }
    }
    
    // MARK: - Subtitle Helper
    private var currentActiveSubtitleCue: WebVttCue? {
        guard !subtitleCues.isEmpty else { return nil }
        return subtitleCues.first(where: { currentTime >= $0.startTime && currentTime <= $0.endTime })
    }
    
    // MARK: - Unified Bottom Control Bar
    private var unifiedBottomControlBar: some View {
        VStack(spacing: 8) {
            // 1. Scrubber Track
            GeometryReader { scrubGeo in
                let progress = duration > 0 ? (isDraggingScrubber ? scrubberDragValue : currentTime / duration) : 0
                let clampedProgress = max(0, min(progress, 1.0))
                let thumbX = scrubGeo.size.width * CGFloat(clampedProgress)
                
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.white.opacity(0.25))
                        .frame(height: isDraggingScrubber ? 6 : 4)
                    
                    Capsule()
                        .fill(Color.accentColor)
                        .frame(width: max(0, min(thumbX, scrubGeo.size.width)), height: isDraggingScrubber ? 6 : 4)
                    
                    Circle()
                        .fill(Color.white)
                        .frame(width: isDraggingScrubber ? 14 : 10, height: isDraggingScrubber ? 14 : 10)
                        .shadow(color: .black.opacity(0.5), radius: 3)
                        .offset(x: max(0, min(thumbX - (isDraggingScrubber ? 7 : 5), scrubGeo.size.width - (isDraggingScrubber ? 14 : 10))))
                    
                    if isDraggingScrubber {
                        VStack(spacing: 0) {
                            Text(formatTime(scrubberDragValue * duration))
                                .font(.system(size: 11, weight: .bold, design: .monospaced))
                                .foregroundColor(.white)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(Color.black.opacity(0.85))
                                .clipShape(Capsule())
                                .overlay(Capsule().stroke(Color.white.opacity(0.25), lineWidth: 0.8))
                                .shadow(color: .black.opacity(0.4), radius: 6)
                        }
                        .offset(x: max(0, min(thumbX - 24, scrubGeo.size.width - 48)), y: -26)
                        .transition(.scale.combined(with: .opacity))
                    }
                }
                .frame(maxHeight: .infinity)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            resetHUDTimer()
                            if !isDraggingScrubber {
                                HapticManager.impact(style: .light)
                            }
                            isDraggingScrubber = true
                            let dragFraction = max(0, min(value.location.x / scrubGeo.size.width, 1.0))
                            scrubberDragValue = Double(dragFraction)
                        }
                        .onEnded { value in
                            let dragFraction = max(0, min(value.location.x / scrubGeo.size.width, 1.0))
                            let targetTime = dragFraction * duration
                            seek(to: targetTime)
                            isDraggingScrubber = false
                            resetHUDTimer()
                        }
                )
            }
            .frame(height: 16)
            
            // 2. Control Row
            HStack(spacing: 10) {
                // Play / Pause Button
                Button {
                    togglePlayPause()
                } label: {
                    Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundColor(.white)
                        .frame(width: 28, height: 28)
                        .background(Color.white.opacity(0.12))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
                
                // Time Display
                HStack(spacing: 4) {
                    let displayCurrent = isDraggingScrubber ? (scrubberDragValue * duration) : currentTime
                    Text(formatTime(displayCurrent))
                        .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                    Text("/")
                        .font(.system(size: 10))
                        .foregroundColor(.white.opacity(0.5))
                    Text(formatTime(duration))
                        .font(.system(size: 11.5, weight: .regular, design: .monospaced))
                        .foregroundColor(.white.opacity(0.75))
                }
                .foregroundColor(.white)
                .monospacedDigit()
                
                Spacer()
                
                // Volume Button + Hover Slider (Desktop/Mac)
                HStack(spacing: 6) {
                    Button {
                        toggleMute()
                    } label: {
                        Image(systemName: (isMuted || volume == 0) ? "speaker.slash.fill" : (volume < 0.5 ? "speaker.wave.1.fill" : "speaker.wave.2.fill"))
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(.white)
                            .frame(width: 28, height: 28)
                            .background(Color.white.opacity(0.12))
                            .clipShape(Circle())
                    }
                    .buttonStyle(.plain)
                    
                    #if os(macOS)
                    if isHoveringVolume {
                        Slider(value: Binding(
                            get: { Double(isMuted ? 0 : volume) },
                            set: { val in
                                volume = Float(val)
                                isMuted = val == 0
                                player?.volume = volume
                            }
                        ), in: 0...1)
                        .frame(width: 60)
                        .controlSize(.mini)
                        .transition(.opacity.combined(with: .scale(scale: 0.9)))
                    }
                    #endif
                }
                #if os(macOS)
                .onHover { hovering in
                    withAnimation(.easeInOut(duration: 0.18)) {
                        isHoveringVolume = hovering
                    }
                }
                #endif
                
                // Playback Speed Selector Pill
                Menu {
                    ForEach(playbackSpeeds, id: \.self) { speed in
                        Button {
                            setPlaybackSpeed(speed)
                        } label: {
                            HStack {
                                Text(String(format: "%.2fx", speed).replacingOccurrences(of: ".00", with: ".0"))
                                if selectedSpeed == speed {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                } label: {
                    Text(String(format: "%.2fx", selectedSpeed).replacingOccurrences(of: ".00", with: ".0"))
                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                        .foregroundColor(.white)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Color.white.opacity(0.12))
                        .clipShape(Capsule())
                }
                
                // Tech Info Button (Format, Codec, Bitrate)
                Button {
                    HapticManager.impact(style: .light)
                    withAnimation(.spring(response: 0.25, dampingFraction: 0.8)) {
                        showInfoModal.toggle()
                        if showInfoModal { showSettingsDrawer = false }
                    }
                } label: {
                    Image(systemName: "info.circle")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(showInfoModal ? .accentColor : .white)
                        .frame(width: 28, height: 28)
                        .background(Color.white.opacity(0.12))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
                
                // Settings Drawer Button (Quality, Audio, Subtitles)
                Button {
                    HapticManager.impact(style: .light)
                    withAnimation(.spring(response: 0.25, dampingFraction: 0.8)) {
                        showSettingsDrawer.toggle()
                        if showSettingsDrawer { showInfoModal = false }
                    }
                } label: {
                    Image(systemName: "gearshape.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(showSettingsDrawer ? .accentColor : .white)
                        .frame(width: 28, height: 28)
                        .background(Color.white.opacity(0.12))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
                
                // Fullscreen Button
                Button {
                    HapticManager.impact(style: .light)
                    if let onFullscreenToggle {
                        if !isFullscreenPresentation {
                            player?.pause()
                            isPlaying = false
                        }
                        onFullscreenToggle()
                    } else {
                        #if os(macOS)
                        MediaWindowManager.shared.toggleWindowFullScreen()
                        #else
                        isInternalFullscreen = true
                        #endif
                    }
                } label: {
                    Image(systemName: isFullscreenPresentation ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
                        .font(.system(size: 11.5, weight: .bold))
                        .foregroundColor(.white)
                        .frame(width: 28, height: 28)
                        .background(Color.white.opacity(0.12))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 10)
        .padding(.top, 14)
        .background(
            LinearGradient(
                colors: [.clear, .black.opacity(0.88)],
                startPoint: .top,
                endPoint: .bottom
            )
        )
    }
    
    // MARK: - Settings Drawer Overlay (Quality, Audio, Subtitles)
    private var settingsDrawerOverlay: some View {
        ZStack(alignment: .trailing) {
            Color.black.opacity(0.4)
                .ignoresSafeArea()
                .onTapGesture {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        showSettingsDrawer = false
                    }
                }
            
            VStack(alignment: .leading, spacing: 0) {
                // Header
                HStack {
                    Text("Settings")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundColor(.white)
                    Spacer()
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            showSettingsDrawer = false
                        }
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundColor(.white.opacity(0.7))
                    }
                    .buttonStyle(.plain)
                }
                .padding(16)
                
                Divider().background(Color.white.opacity(0.15))
                
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        // 1. Video Quality Section
                        qualitySection
                        
                        // 2. Audio Tracks Section
                        audioSection
                        
                        // 3. Subtitles Section
                        subtitleSection
                    }
                    .padding(16)
                }
            }
            .frame(width: 280)
            .background(.ultraThinMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(Color.white.opacity(0.15), lineWidth: 1)
            )
            .padding(12)
            .shadow(color: .black.opacity(0.5), radius: 16)
        }
    }
    
    @ViewBuilder
    private var qualitySection: some View {
        let variants = playback?.variants ?? []
        let videoTracks = (tracks ?? []).filter { $0.type.uppercased() == "VIDEO" && $0.purpose.uppercased() == "CONTENT" }
        
        if !variants.isEmpty || !videoTracks.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("VIDEO QUALITY")
                    .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                    .foregroundColor(.white.opacity(0.5))
                
                if !variants.isEmpty {
                    ForEach(variants, id: \.url) { variant in
                        let label = variant.label ?? (variant.height.map { "\($0)p" } ?? "Quality")
                        let isSelected = selectedVideoTrackId == variant.track_id || (selectedVideoTrackId == nil && currentActiveUrl.absoluteString == variant.url)
                        
                        settingsRow(title: label, subtitle: variant.codec?.uppercased(), isSelected: isSelected) {
                            switchQuality(to: variant.url, trackId: variant.track_id)
                        }
                    }
                } else {
                    ForEach(videoTracks, id: \.id) { track in
                        let label = track.display_name ?? (track.height.map { "\($0)p" } ?? "Quality")
                        let isSelected = selectedVideoTrackId == track.id
                        
                        settingsRow(title: label, subtitle: track.codec?.uppercased(), isSelected: isSelected) {
                            switchQuality(to: track.url, trackId: track.id)
                        }
                    }
                }
            }
        }
    }
    
    @ViewBuilder
    private var audioSection: some View {
        let audioTracks = playback?.audio_tracks ?? []
        let contentAudioTracks = (tracks ?? []).filter { $0.type.uppercased() == "AUDIO" && $0.purpose.uppercased() == "CONTENT" }
        
        if !audioTracks.isEmpty || !contentAudioTracks.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("AUDIO TRACK")
                    .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                    .foregroundColor(.white.opacity(0.5))
                
                if !audioTracks.isEmpty {
                    ForEach(audioTracks, id: \.track_id) { track in
                        let title = track.label ?? (track.language ?? "Audio")
                        let isSelected = selectedAudioTrackId == track.track_id || (selectedAudioTrackId == nil && (track.is_default ?? false))
                        
                        settingsRow(title: title, subtitle: track.codec?.uppercased(), isSelected: isSelected) {
                            selectedAudioTrackId = track.track_id
                        }
                    }
                } else {
                    ForEach(contentAudioTracks, id: \.id) { track in
                        let title = track.display_name ?? (track.language ?? "Audio")
                        let isSelected = selectedAudioTrackId == track.id
                        
                        settingsRow(title: title, subtitle: track.codec?.uppercased(), isSelected: isSelected) {
                            selectedAudioTrackId = track.id
                        }
                    }
                }
            }
        }
    }
    
    @ViewBuilder
    private var subtitleSection: some View {
        let subTracks = playback?.subtitle_tracks ?? []
        let contentSubTracks = (tracks ?? []).filter { $0.type.uppercased() == "SUBTITLE" }
        
        VStack(alignment: .leading, spacing: 8) {
            Text("SUBTITLES (CC)")
                .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                .foregroundColor(.white.opacity(0.5))
            
            // Off Option
            settingsRow(title: "Off", subtitle: nil, isSelected: selectedSubtitleTrackId == nil) {
                selectedSubtitleTrackId = nil
                subtitleCues = []
            }
            
            if !subTracks.isEmpty {
                ForEach(subTracks, id: \.track_id) { sub in
                    let label = sub.label ?? (sub.language ?? "Subtitle")
                    let isSelected = selectedSubtitleTrackId == sub.track_id
                    
                    settingsRow(title: label, subtitle: sub.format?.uppercased(), isSelected: isSelected) {
                        selectedSubtitleTrackId = sub.track_id
                        if let urlString = sub.url, let url = URL(string: urlString) {
                            loadSubtitles(from: url)
                        }
                    }
                }
            } else if !contentSubTracks.isEmpty {
                ForEach(contentSubTracks, id: \.id) { sub in
                    let label = sub.display_name ?? (sub.language ?? "Subtitle")
                    let isSelected = selectedSubtitleTrackId == sub.id
                    
                    settingsRow(title: label, subtitle: nil, isSelected: isSelected) {
                        selectedSubtitleTrackId = sub.id
                        if let url = URL(string: sub.url) {
                            loadSubtitles(from: url)
                        }
                    }
                }
            }
        }
    }
    
    private func settingsRow(title: String, subtitle: String?, isSelected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 12.5, weight: isSelected ? .bold : .medium))
                        .foregroundColor(isSelected ? .white : .white.opacity(0.8))
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.system(size: 10))
                            .foregroundColor(isSelected ? .accentColor : .white.opacity(0.4))
                    }
                }
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(.accentColor)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(isSelected ? Color.accentColor.opacity(0.15) : Color.white.opacity(0.04))
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
    }
    
    // MARK: - Tech Info Stats Modal Overlay (Stats for Nerds)
    private var techInfoModalOverlay: some View {
        ZStack {
            Color.black.opacity(0.45)
                .ignoresSafeArea()
                .onTapGesture {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        showInfoModal = false
                    }
                }
            
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Image(systemName: "info.circle.fill")
                        .foregroundColor(.accentColor)
                    Text("Video Information")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(.white)
                    Spacer()
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            showInfoModal = false
                        }
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundColor(.white.opacity(0.6))
                    }
                    .buttonStyle(.plain)
                }
                
                Divider().background(Color.white.opacity(0.15))
                
                VStack(spacing: 8) {
                    infoRow(label: "Format", value: playback?.format?.uppercased() ?? "PROGRESSIVE MP4")
                    infoRow(label: "Resolution", value: "\(Int(player?.currentItem?.presentationSize.width ?? 0))x\(Int(player?.currentItem?.presentationSize.height ?? 0))")
                    infoRow(label: "Duration", value: formatTime(duration))
                    infoRow(label: "Playback Rate", value: String(format: "%.2fx", selectedSpeed))
                    infoRow(label: "Volume", value: "\(Int(volume * 100))%")
                    if let firstVariant = playback?.variants?.first {
                        if let codec = firstVariant.codec {
                            infoRow(label: "Video Codec", value: codec.uppercased())
                        }
                        if let fps = firstVariant.frame_rate {
                            infoRow(label: "Frame Rate", value: String(format: "%.0f fps", fps))
                        }
                        if let bw = firstVariant.bandwidth {
                            infoRow(label: "Bitrate", value: "\(bw / 1000) kbps")
                        }
                    }
                }
            }
            .padding(18)
            .frame(width: 310)
            .background(.ultraThinMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(Color.white.opacity(0.2), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.6), radius: 20)
        }
    }
    
    private func infoRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 11.5))
                .foregroundColor(.white.opacity(0.5))
            Spacer()
            Text(value)
                .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                .foregroundColor(.white.opacity(0.9))
        }
    }
    
    private func skipBadge(icon: String, text: String) -> some View {
        VStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 26, weight: .bold))
            Text(text)
                .font(.system(size: 12, weight: .bold, design: .monospaced))
        }
        .foregroundColor(.white)
        .padding(14)
        .background(.ultraThinMaterial)
        .clipShape(Circle())
        .shadow(color: .black.opacity(0.4), radius: 8)
    }
    
    // MARK: - Player Actions & Lifecycle
    
    private func setupPlayer() {
        guard player == nil else { return }
        
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback, options: [.mixWithOthers])
        #endif
        
        let asset = AVURLAsset(url: currentActiveUrl)
        let playerItem = AVPlayerItem(asset: asset)
        let avPlayer = AVPlayer(playerItem: playerItem)
        avPlayer.actionAtItemEnd = .none
        
        player = avPlayer
        
        // Time Observer (10Hz periodic update)
        let interval = CMTime(seconds: 0.1, preferredTimescale: CMTimeScale(NSEC_PER_SEC))
        timeObserverToken = avPlayer.addPeriodicTimeObserver(forInterval: interval, queue: .main) { time in
            MainActor.assumeIsolated {
                if !self.isDraggingScrubber {
                    self.currentTime = time.seconds
                }
            }
        }
        
        // Item Duration Observation
        playerItem.publisher(for: \.duration)
            .receive(on: DispatchQueue.main)
            .sink { dur in
                let seconds = dur.seconds
                if !seconds.isNaN && !seconds.isInfinite {
                    duration = seconds
                }
            }
            .store(in: &cancellables)
        
        // Buffering / Playback Status Observation
        playerItem.publisher(for: \.isPlaybackBufferEmpty)
            .receive(on: DispatchQueue.main)
            .sink { isBuffering = $0 }
            .store(in: &cancellables)
            
        playerItem.publisher(for: \.isPlaybackLikelyToKeepUp)
            .receive(on: DispatchQueue.main)
            .sink { isBuffering = !$0 }
            .store(in: &cancellables)
        
        // Auto-looping
        NotificationCenter.default.publisher(
            for: .AVPlayerItemDidPlayToEndTime,
            object: playerItem
        )
        .receive(on: DispatchQueue.main)
        .sink { _ in
            avPlayer.seek(to: .zero)
            if self.isPlaying {
                avPlayer.playImmediately(atRate: self.selectedSpeed)
            }
        }
        .store(in: &cancellables)
        
        if autoPlay {
            isPlaying = true
            avPlayer.playImmediately(atRate: selectedSpeed)
            startHUDTimer()
        }
    }
    
    private func cleanupPlayer() {
        if let token = timeObserverToken {
            player?.removeTimeObserver(token)
            timeObserverToken = nil
        }
        hudTimer?.invalidate()
        hudTimer = nil
        player?.pause()
        cancellables.removeAll()
        player = nil
    }
    
    private func switchQuality(to urlString: String, trackId: String?) {
        guard let newUrl = URL(string: urlString) else { return }
        selectedVideoTrackId = trackId
        currentActiveUrl = newUrl
        
        let targetTime = player?.currentTime() ?? .zero
        let wasPlaying = isPlaying
        
        let asset = AVURLAsset(url: newUrl)
        let playerItem = AVPlayerItem(asset: asset)
        player?.replaceCurrentItem(with: playerItem)
        
        player?.seek(to: targetTime, toleranceBefore: .zero, toleranceAfter: .zero) { _ in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    if wasPlaying {
                        self.player?.playImmediately(atRate: self.selectedSpeed)
                    }
                }
            }
        }
        withAnimation {
            showSettingsDrawer = false
        }
    }
    
    private func loadSubtitles(from url: URL) {
        URLSession.shared.dataTask(with: url) { data, _, error in
            guard let data, let string = String(data: data, encoding: .utf8), error == nil else { return }
            let parsed = WebVttParser.parse(string)
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self.subtitleCues = parsed
                }
            }
        }.resume()
    }
    
    private func togglePlayPause() {
        HapticManager.impact(style: .light)
        guard let player else { return }
        if isPlaying {
            player.pause()
            isPlaying = false
            showHUD = true
            hudTimer?.invalidate()
        } else {
            player.playImmediately(atRate: selectedSpeed)
            isPlaying = true
            resetHUDTimer()
        }
    }
    
    private func toggleMute() {
        HapticManager.impact(style: .light)
        isMuted.toggle()
        player?.isMuted = isMuted
    }
    
    private func setPlaybackSpeed(_ speed: Float) {
        HapticManager.selection()
        selectedSpeed = speed
        if isPlaying {
            player?.playImmediately(atRate: speed)
        }
    }
    
    private func start2xPlayback() {
        guard let player, isPlaying else { return }
        HapticManager.impact(style: .medium)
        withAnimation(.spring(response: 0.25, dampingFraction: 0.8)) {
            isFastForwarding = true
        }
        player.playImmediately(atRate: 2.0)
    }
    
    private func stop2xPlayback() {
        guard let player else { return }
        withAnimation(.spring(response: 0.25, dampingFraction: 0.8)) {
            isFastForwarding = false
        }
        if isPlaying {
            player.playImmediately(atRate: selectedSpeed)
        }
    }
    
    private func seek(to seconds: Double) {
        let cmTime = CMTime(seconds: max(0, min(seconds, duration)), preferredTimescale: 600)
        player?.seek(to: cmTime, toleranceBefore: .zero, toleranceAfter: .zero) { _ in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    if self.isPlaying {
                        self.player?.playImmediately(atRate: self.selectedSpeed)
                    }
                }
            }
        }
    }
    
    private func seekRelative(seconds: Double) {
        HapticManager.impact(style: .medium)
        guard let player else { return }
        let target = max(0, min(player.currentTime().seconds + seconds, duration))
        seek(to: target)
        resetHUDTimer()
    }
    
    private func toggleHUD() {
        withAnimation(.easeInOut(duration: 0.2)) {
            showHUD.toggle()
        }
        if showHUD && isPlaying {
            resetHUDTimer()
        }
    }
    
    private func showHUDTemporarily() {
        if !showHUD {
            withAnimation(.easeInOut(duration: 0.2)) {
                showHUD = true
            }
        }
        if isPlaying {
            resetHUDTimer()
        }
    }
    
    private func resetHUDTimer() {
        hudTimer?.invalidate()
        hudTimer = Timer.scheduledTimer(withTimeInterval: 3.5, repeats: false) { _ in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    if self.isPlaying && !self.showSettingsDrawer && !self.showInfoModal {
                        withAnimation(.easeInOut(duration: 0.25)) {
                            self.showHUD = false
                        }
                    }
                }
            }
        }
    }
    
    private func startHUDTimer() {
        resetHUDTimer()
    }
    
    private func formatTime(_ seconds: Double) -> String {
        guard !seconds.isNaN && !seconds.isInfinite && seconds >= 0 else { return "00:00" }
        let totalSeconds = Int(seconds)
        let mins = totalSeconds / 60
        let secs = totalSeconds % 60
        let hours = totalSeconds / 3600
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, mins % 60, secs)
        }
        return String(format: "%02d:%02d", mins, secs)
    }
}

// MARK: - Video Layer Representable
#if os(iOS)
private struct VideoLayerRepresentable: UIViewControllerRepresentable {
    let player: AVPlayer
    
    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = player
        controller.showsPlaybackControls = false
        controller.videoGravity = .resizeAspect
        controller.allowsPictureInPicturePlayback = true
        controller.view.backgroundColor = .clear
        return controller
    }
    
    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
        controller.player = player
    }
}
#elseif os(macOS)
private struct VideoLayerRepresentable: NSViewRepresentable {
    let player: AVPlayer
    
    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.player = player
        view.controlsStyle = .none
        view.videoGravity = .resizeAspect
        view.allowsPictureInPicturePlayback = true
        return view
    }
    
    func updateNSView(_ view: AVPlayerView, context: Context) {
        view.player = player
    }
}
#endif
