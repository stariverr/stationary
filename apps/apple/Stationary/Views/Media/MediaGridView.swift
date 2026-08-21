import SwiftUI

public struct MediaGridView: View {
    @Bindable var viewModel: PostListViewModel
    @State private var selectedMediaType: MediaType? = nil
    
    public init(viewModel: PostListViewModel) {
        self.viewModel = viewModel
    }
    
    // Extracted physical media items from loaded posts
    private var allMediaItems: [(post: PostListItem, media: MediaItem)] {
        var items: [(PostListItem, MediaItem)] = []
        for post in viewModel.posts {
            if let mediaList = post.media {
                for media in mediaList {
                    if let type = selectedMediaType {
                        if media.type == type {
                            items.append((post, media))
                        }
                    } else {
                        items.append((post, media))
                    }
                }
            }
        }
        return items
    }
    
    public var body: some View {
        ZStack {
            LiquidGlassBackgroundView()
            
            VStack(spacing: 0) {
                // Media Type Filter Selector
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        Button {
                            HapticManager.selection()
                            selectedMediaType = nil
                        } label: {
                            Text("All Assets (\(allMediaItems.count))")
                                .font(.system(size: 12, weight: .semibold))
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                        }
                        .liquidGlassButton(isSelected: selectedMediaType == nil)
                        
                        ForEach(MediaType.allCases) { type in
                            let isSelected = selectedMediaType == type
                            let accentColor = LiquidPalette.mediaTypeColor(type)
                            Button {
                                HapticManager.selection()
                                selectedMediaType = type
                            } label: {
                                HStack(spacing: 5) {
                                    Image(systemName: type.iconName)
                                        .font(.system(size: 11, weight: .semibold))
                                    Text(type.displayName)
                                        .font(.system(size: 12, weight: .semibold))
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(isSelected ? accentColor : Color.primary.opacity(0.04))
                                .foregroundColor(isSelected ? .white : .primary)
                                .clipShape(Capsule())
                                .overlay(Capsule().stroke(isSelected ? Color.white.opacity(0.3) : LiquidPalette.borderFaint, lineWidth: 0.8))
                            }
                            .tactileIconButton()
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                }
                
                Divider().opacity(0.4)
                
                if allMediaItems.isEmpty {
                    Spacer()
                    VStack(spacing: 14) {
                        Image(systemName: "photo.stack.fill")
                            .font(.system(size: 44, weight: .light))
                            .foregroundColor(.secondary.opacity(0.4))
                        Text("No Media Assets Found")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(.secondary)
                    }
                    Spacer()
                } else {
                    ScrollView {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150, maximum: 240), spacing: 12)], spacing: 12) {
                            ForEach(Array(allMediaItems.enumerated()), id: \.offset) { _, pair in
                                NavigationLink(value: pair.post.id) {
                                    MediaAssetCardView(post: pair.post, media: pair.media)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(16)
                    }
                }
            }
        }
    }
}

public struct MediaAssetCardView: View {
    let post: PostListItem
    let media: MediaItem
    @State private var isHovered = false
    
    public var body: some View {
        ZStack(alignment: .bottom) {
            // Media Image Thumbnail
            ZStack {
                LiquidPalette.cardBg
                if let coverUrl = media.primaryCoverUrl ?? post.coverImageUrl, let url = URL(string: coverUrl) {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                                .frame(minWidth: 0, maxWidth: .infinity, minHeight: 160, maxHeight: 160)
                                .clipped()
                        case .empty:
                            ProgressView()
                                .controlSize(.small)
                                .tint(.accentColor)
                        case .failure:
                            Image(systemName: media.type.iconName)
                                .font(.system(size: 28))
                                .foregroundColor(.secondary)
                        @unknown default:
                            EmptyView()
                        }
                    }
                } else {
                    Image(systemName: media.type.iconName)
                        .font(.system(size: 28))
                        .foregroundColor(.secondary)
                }
            }
            .frame(height: 160)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            
            // Top Right Media Type Badge
            VStack {
                HStack {
                    Spacer()
                    HStack(spacing: 4) {
                        Image(systemName: media.type.iconName)
                            .font(.system(size: 8.5, weight: .bold))
                        Text(media.type.displayName)
                            .font(.system(size: 9, weight: .bold))
                    }
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3.5)
                    .background(.ultraThinMaterial)
                    .foregroundColor(.primary)
                    .clipShape(Capsule())
                    .overlay(Capsule().stroke(Color.white.opacity(0.2), lineWidth: 0.8))
                    .padding(8)
                }
                Spacer()
            }
            
            // Bottom Scrim Overlay with Title (Always visible on mobile, elevated on hover)
            VStack(alignment: .leading, spacing: 2) {
                Text(post.title.isEmpty ? "Asset" : post.title)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.white)
                    .lineLimit(1)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                LinearGradient(
                    colors: [.clear, .black.opacity(0.75)],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .liquidGlassCard(cornerRadius: 14, isInteractive: true)
        .contextMenu {
            if let assetUrlString = media.primaryCoverUrl ?? media.primaryVideoUrl, let url = URL(string: assetUrlString) {
                Link(destination: url) {
                    Label("Open Media Asset", systemImage: "arrow.up.right.square")
                }
            }
            
            Button {
                #if os(iOS)
                if let urlString = media.primaryCoverUrl ?? media.primaryVideoUrl {
                    UIPasteboard.general.string = urlString
                    HapticManager.notification(type: .success)
                }
                #endif
            } label: {
                Label("Copy Asset URL", systemImage: "doc.on.doc")
            }
        }
        .onHover { isHovered = $0 }
    }
}

