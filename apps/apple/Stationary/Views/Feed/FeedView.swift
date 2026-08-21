import SwiftUI

public struct FeedView: View {
    @Bindable var viewModel: PostListViewModel
    @State private var currentIndex: Int = 0
    
    public init(viewModel: PostListViewModel) {
        self.viewModel = viewModel
    }
    
    public var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            
            if viewModel.isLoading && viewModel.posts.isEmpty {
                VStack(spacing: 14) {
                    ProgressView().tint(.white)
                    Text("Loading Feed...")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(.white.opacity(0.8))
                }
            } else if viewModel.posts.isEmpty {
                VStack(spacing: 14) {
                    Image(systemName: "play.square.stack")
                        .font(.system(size: 48, weight: .light))
                        .foregroundColor(.white.opacity(0.4))
                    Text("No Recommended Media Posts")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(.white.opacity(0.8))
                }
            } else {
                ScrollView(.vertical, showsIndicators: false) {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(viewModel.posts.enumerated()), id: \.element.id) { index, post in
                            FeedPostCardView(post: post)
                                .containerRelativeFrame([.horizontal, .vertical])
                        }
                    }
                }
                .scrollTargetBehavior(.paging)
                .ignoresSafeArea(edges: .bottom)
            }
        }
    }
}

public struct FeedPostCardView: View {
    let post: PostListItem
    
    @State private var isLiked = false
    @State private var isSaved = false
    @State private var showHeartBurst = false
    @State private var selectedMediaIndex = 0
    
    public var body: some View {
        ZStack(alignment: .bottomLeading) {
            // Stage 1: Full-Bleed Media (Video Player or Carousel / Image)
            mediaStage
                .ignoresSafeArea()
                .onTapGesture(count: 2) {
                    HapticManager.notification(type: .success)
                    if !isLiked {
                        isLiked = true
                    }
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.6)) {
                        showHeartBurst = true
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                        withAnimation(.easeOut(duration: 0.2)) {
                            showHeartBurst = false
                        }
                    }
                }
            
            // Double Tap Heart Burst Animation
            if showHeartBurst {
                Image(systemName: "heart.fill")
                    .font(.system(size: 88))
                    .foregroundColor(.red)
                    .shadow(color: .black.opacity(0.4), radius: 16)
                    .scaleEffect(showHeartBurst ? 1.0 : 0.2)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .transition(.scale.combined(with: .opacity))
            }
            
            // Stage 2: Apple Non-Linear Scrim Gradient (Smooth bottom fade)
            LinearGradient(
                stops: [
                    .init(color: .clear, location: 0.0),
                    .init(color: .clear, location: 0.5),
                    .init(color: .black.opacity(0.4), location: 0.75),
                    .init(color: .black.opacity(0.85), location: 1.0)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()
            .allowsHitTesting(false)
            
            // Stage 3: Left Overlay - Metadata
            VStack(alignment: .leading, spacing: 10) {
                // Author Row
                HStack(spacing: 9) {
                    if let avatar = post.author_avatar_url, let url = URL(string: avatar) {
                        AsyncImage(url: url) { img in
                            img.resizable().scaledToFill()
                        } placeholder: {
                            Circle().fill(Color.white.opacity(0.2))
                        }
                        .frame(width: 36, height: 36)
                        .clipShape(Circle())
                        .overlay(Circle().stroke(Color.white.opacity(0.7), lineWidth: 1))
                    } else {
                        Image(systemName: "person.circle.fill")
                            .font(.system(size: 36))
                            .foregroundColor(.white.opacity(0.8))
                    }
                    
                    VStack(alignment: .leading, spacing: 2) {
                        Text(post.author_name.isEmpty ? "Creator" : post.author_name)
                            .font(.system(size: 14, weight: .bold))
                            .foregroundColor(.white)
                        
                        HStack(spacing: 5) {
                            Image(systemName: post.source.iconName)
                                .font(.system(size: 8.5, weight: .bold))
                            Text(post.source.displayName)
                                .font(.system(size: 9.5, weight: .semibold))
                        }
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2.5)
                        .background(LiquidPalette.platformColor(post.source).opacity(0.9))
                        .foregroundColor(.white)
                        .clipShape(Capsule())
                    }
                }
                
                // Title
                Text(post.title)
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundColor(.white)
                    .lineLimit(3)
                    .lineSpacing(2.5)
                    .shadow(color: .black.opacity(0.6), radius: 4, x: 0, y: 1)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 38)
            
            // Stage 4: Right Action Controls
            VStack(spacing: 18) {
                Spacer()
                
                // Like Button
                Button {
                    HapticManager.impact(style: .medium)
                    withAnimation(.spring(response: 0.25, dampingFraction: 0.65)) {
                        isLiked.toggle()
                    }
                } label: {
                    ZStack {
                        Circle()
                            .fill(.ultraThinMaterial)
                            .frame(width: 44, height: 44)
                            .overlay(Circle().stroke(Color.white.opacity(0.2), lineWidth: 1))
                        
                        Image(systemName: isLiked ? "heart.fill" : "heart")
                            .font(.system(size: 22, weight: .semibold))
                            .foregroundColor(isLiked ? .red : .white)
                            .scaleEffect(isLiked ? 1.15 : 1.0)
                    }
                }
                .tactileIconButton()
                
                // Save / Bookmark Button
                Button {
                    HapticManager.impact(style: .medium)
                    withAnimation(.spring(response: 0.25, dampingFraction: 0.65)) {
                        isSaved.toggle()
                    }
                } label: {
                    ZStack {
                        Circle()
                            .fill(.ultraThinMaterial)
                            .frame(width: 44, height: 44)
                            .overlay(Circle().stroke(Color.white.opacity(0.2), lineWidth: 1))
                        
                        Image(systemName: isSaved ? "bookmark.fill" : "bookmark")
                            .font(.system(size: 20, weight: .semibold))
                            .foregroundColor(isSaved ? .yellow : .white)
                            .scaleEffect(isSaved ? 1.15 : 1.0)
                    }
                }
                .tactileIconButton()
                
                // Detail Navigation Link
                NavigationLink(value: post.id) {
                    ZStack {
                        Circle()
                            .fill(.ultraThinMaterial)
                            .frame(width: 44, height: 44)
                            .overlay(Circle().stroke(Color.white.opacity(0.2), lineWidth: 1))
                        
                        Image(systemName: "arrow.up.right")
                            .font(.system(size: 18, weight: .bold))
                            .foregroundColor(.white)
                    }
                }
                .tactileIconButton()
            }
            .padding(.trailing, 16)
            .padding(.bottom, 42)
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
    }
    
    @ViewBuilder
    private var mediaStage: some View {
        if let mediaList = post.media, !mediaList.isEmpty {
            if let firstVideo = mediaList.first(where: { $0.type == .video }),
               let videoUrlString = firstVideo.primaryVideoUrl,
               let url = URL(string: videoUrlString) {
                ModernVideoPlayerView(
                    videoUrl: url,
                    coverUrl: firstVideo.primaryCoverUrl.flatMap(URL.init(string:)),
                    autoPlay: true,
                    showControls: false,
                    enableTapToPause: true,
                    isFeedMode: true
                )
            } else if mediaList.count > 1 {
                TabView(selection: $selectedMediaIndex) {
                    ForEach(Array(mediaList.enumerated()), id: \.element.id) { index, item in
                        ZStack {
                            Color.black
                            if let coverUrl = item.primaryCoverUrl ?? item.url ?? post.coverImageUrl, let url = URL(string: coverUrl) {
                                AsyncImage(url: url) { image in
                                    image
                                        .resizable()
                                        .scaledToFit()
                                } placeholder: {
                                    ProgressView().tint(.white)
                                }
                            }
                        }
                        .tag(index)
                    }
                }
                .pagingTabViewStyle()
            } else {
                singleImageStage(url: mediaList[0].primaryCoverUrl ?? mediaList[0].url ?? post.coverImageUrl)
            }
        } else {
            singleImageStage(url: post.coverImageUrl)
        }
    }
    
    private func singleImageStage(url: String?) -> some View {
        ZStack {
            Color.black
            if let urlString = url, let imgUrl = URL(string: urlString) {
                AsyncImage(url: imgUrl) { image in
                    image
                        .resizable()
                        .scaledToFit()
                } placeholder: {
                    ProgressView().tint(.white)
                }
            } else {
                Image(systemName: "photo.fill")
                    .font(.system(size: 64))
                    .foregroundColor(.white.opacity(0.3))
            }
        }
    }
}

