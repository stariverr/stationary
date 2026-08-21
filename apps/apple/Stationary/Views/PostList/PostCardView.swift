import SwiftUI

public struct PostCardView: View {
    public let post: PostListItem
    public let aspectRatio: Double
    
    @State private var isHovered = false
    
    public init(post: PostListItem, aspectRatio: Double = 4.0 / 3.0) {
        self.post = post
        self.aspectRatio = aspectRatio
    }
    
    public var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            // Apple Photos Style Clean Thumbnail with Concentric Glass Border
            ZStack(alignment: .topTrailing) {
                GeometryReader { geo in
                    ZStack(alignment: .bottom) {
                        if let coverUrl = post.coverImageUrl, let url = URL(string: coverUrl) {
                            AsyncImage(url: url) { phase in
                                switch phase {
                                case .success(let image):
                                    image
                                        .resizable()
                                        .scaledToFill()
                                        .frame(width: geo.size.width, height: geo.size.height)
                                        .clipped()
                                        .transition(.opacity.combined(with: .scale(scale: 1.02)))
                                case .failure:
                                    fallbackPlaceholder(width: geo.size.width, height: geo.size.height)
                                case .empty:
                                    ZStack {
                                        LiquidPalette.cardBg
                                        ProgressView()
                                            .controlSize(.small)
                                            .tint(.accentColor)
                                    }
                                @unknown default:
                                    EmptyView()
                                }
                            }
                        } else {
                            fallbackPlaceholder(width: geo.size.width, height: geo.size.height)
                        }
                    }
                }
                .aspectRatio(aspectRatio, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(
                            isHovered ? LiquidPalette.borderSubtle : LiquidPalette.borderFaint,
                            lineWidth: 1
                        )
                )
                .shadow(
                    color: Color.black.opacity(isHovered ? 0.08 : 0.025),
                    radius: isHovered ? 10 : 3,
                    x: 0,
                    y: isHovered ? 4 : 1
                )
                
                // Platform Badge (Top-Right Glass Material with Brand Tint)
                HStack(spacing: 3.5) {
                    Image(systemName: post.source.iconName)
                        .font(.system(size: 8.5, weight: .bold))
                    Text(post.source.displayName)
                        .font(.system(size: 9, weight: .semibold))
                }
                .foregroundColor(.white)
                .padding(.horizontal, 7)
                .padding(.vertical, 3.5)
                .background(
                    ZStack {
                        Capsule().fill(.ultraThinMaterial)
                        LiquidPalette.platformColor(post.source).opacity(0.85)
                    }
                )
                .clipShape(Capsule())
                .overlay(Capsule().stroke(Color.white.opacity(0.25), lineWidth: 0.7))
                .padding(7)
                
                // Bottom-Right Media Count Badge (If multiple items or video)
                if let mediaList = post.media, mediaList.count > 1 {
                    VStack {
                        Spacer()
                        HStack {
                            Spacer()
                            HStack(spacing: 3) {
                                Image(systemName: "square.stack.fill")
                                    .font(.system(size: 8))
                                Text("\(mediaList.count)")
                                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                            }
                            .foregroundColor(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 3)
                            .background(Color.black.opacity(0.65))
                            .clipShape(Capsule())
                            .padding(6)
                        }
                    }
                }
            }
            
            // Clean Typography (Apple News & Photos Inspired)
            VStack(alignment: .leading, spacing: 4) {
                Text(post.title.isEmpty ? "Untitled Asset" : post.title)
                    .font(.system(size: 13, weight: .semibold))
                    .lineSpacing(2)
                    .foregroundColor(.primary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                
                HStack(spacing: 5) {
                    if let avatar = post.author_avatar_url, let url = URL(string: avatar) {
                        AsyncImage(url: url) { img in
                            img.resizable().scaledToFill()
                        } placeholder: {
                            Circle().fill(Color.primary.opacity(0.08))
                        }
                        .frame(width: 14, height: 14)
                        .clipShape(Circle())
                    }
                    
                    Text(post.author_name.isEmpty ? "Unknown" : post.author_name)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                    
                    Spacer()
                    
                    if let published = post.published_time {
                        Text(formatDate(published))
                            .font(.system(size: 10.5, weight: .regular))
                            .monospacedDigit()
                            .foregroundColor(.secondary.opacity(0.8))
                    }
                }
            }
            .padding(.horizontal, 2)
        }
        .scaleEffect(isHovered ? 1.015 : 1.0)
        .animation(.spring(response: 0.25, dampingFraction: 0.8), value: isHovered)
        .onHover { hovering in
            isHovered = hovering
        }
    }
    
    private func fallbackPlaceholder(width: CGFloat, height: CGFloat) -> some View {
        ZStack {
            Color.primary.opacity(0.03)
            Image(systemName: "photo")
                .font(.system(size: 24, weight: .light))
                .foregroundColor(.secondary.opacity(0.4))
        }
        .frame(width: width, height: height)
    }
    
    private func formatDate(_ isoString: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: isoString) {
            let relativeFormatter = RelativeDateTimeFormatter()
            relativeFormatter.unitsStyle = .short
            return relativeFormatter.localizedString(for: date, relativeTo: Date())
        }
        return isoString.prefix(10).description
    }
}


