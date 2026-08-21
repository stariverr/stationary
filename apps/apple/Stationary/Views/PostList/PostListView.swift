import SwiftUI

public struct PostListView: View {
    @State private var viewModel = PostListViewModel()
    @State private var authManager = AuthManager.shared
    @State private var libraryManager = LibraryManager.shared
    @ObservedObject private var lightboxManager = LightboxManager.shared
    
    @State private var selectedTab: AppTab = .posts
    @State private var showingLoginSheet = false
    @State private var showingCreateLibrarySheet = false
    @State private var showingFilterSheet = false
    @State private var showingAccountSheet = false
    
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    
    public init() {}
    
    public var body: some View {
        ZStack {
            GeometryReader { geo in
                let isCompactWindow = geo.size.width < 680
                
                if isCompactWindow {
                    compactBottomTabView
                } else {
                    sidebarSplitView
                }
            }
            
            #if os(iOS)
            if lightboxManager.isPresented && !lightboxManager.mediaItems.isEmpty {
                MediaLightboxView(
                    mediaItems: lightboxManager.mediaItems,
                    selectedIndex: $lightboxManager.selectedIndex,
                    onDismiss: {
                        lightboxManager.dismiss()
                    }
                )
                .transition(.opacity)
                .ignoresSafeArea()
                .zIndex(99999)
            }
            #endif
        }
        .sheet(isPresented: $showingLoginSheet) { LoginView() }
        .sheet(isPresented: $showingCreateLibrarySheet) { CreateLibrarySheet() }
        .sheet(isPresented: $showingFilterSheet) { MobileFilterSheetView(viewModel: viewModel) }
        .sheet(isPresented: $showingAccountSheet) { AccountProfileSheetView() }
        .task {
            await authManager.restoreSession()
            await libraryManager.loadLibraries()
            await viewModel.loadPosts(resetPagination: true)
            await viewModel.loadAuthorsAndTags()
        }
        .onChange(of: libraryManager.activeLibraryId) { _, _ in
            Task {
                await viewModel.loadPosts(resetPagination: true)
                await viewModel.loadAuthorsAndTags()
            }
        }
        .onChange(of: authManager.isAuthenticated) { _, isAuthenticated in
            if isAuthenticated {
                Task {
                    await libraryManager.loadLibraries()
                    await viewModel.loadPosts(resetPagination: true)
                    await viewModel.loadAuthorsAndTags()
                }
            }
        }
    }
    
    // MARK: - Native iOS Bottom Tab Navigation (Apple HIG Standard)
    private var compactBottomTabView: some View {
        TabView(selection: $selectedTab) {
            // Tab 0: Feed (Vertical Immersive Media Flow)
            NavigationStack {
                FeedView(viewModel: viewModel)
                    .inlineNavigationBarTitle()
                    .toolbar {
                        ToolbarItem(placement: .leadingPlacement) {
                            librarySelectorHeaderButton
                        }
                        ToolbarItem(placement: .trailingPlacement) {
                            accountAvatarButton
                        }
                    }
                    .navigationDestination(for: String.self) { postId in
                        PostDetailView(postId: postId)
                    }
            }
            .tabItem {
                Label(AppTab.feed.title, systemImage: AppTab.feed.icon)
            }
            .tag(AppTab.feed)
            
            // Tab 1: Posts (Main Card-on-Canvas Grid)
            NavigationStack {
                mediaGridMainView
                    .navigationTitle(libraryManager.activeLibrary?.name ?? "Posts")
                    .inlineNavigationBarTitle()
                    .toolbar {
                        ToolbarItem(placement: .leadingPlacement) {
                            librarySelectorHeaderButton
                        }
                        ToolbarItemGroup(placement: .trailingPlacement) {
                            filterToolbarButton
                            accountAvatarButton
                        }
                    }
                    .searchable(text: $viewModel.searchKeyword, prompt: "Search titles, tags, authors...")
                    .onSubmit(of: .search) {
                        viewModel.applyFilterChange()
                    }
                    .navigationDestination(for: String.self) { postId in
                        PostDetailView(postId: postId)
                    }
            }
            .tabItem {
                Label(AppTab.posts.title, systemImage: AppTab.posts.icon)
            }
            .tag(AppTab.posts)
            
            // Tab 2: Media (Pure Asset Grid)
            NavigationStack {
                MediaGridView(viewModel: viewModel)
                    .navigationTitle("Media Assets")
                    .inlineNavigationBarTitle()
                    .toolbar {
                        ToolbarItem(placement: .leadingPlacement) {
                            librarySelectorHeaderButton
                        }
                        ToolbarItem(placement: .trailingPlacement) {
                            accountAvatarButton
                        }
                    }
                    .navigationDestination(for: String.self) { postId in
                        PostDetailView(postId: postId)
                    }
            }
            .tabItem {
                Label(AppTab.media.title, systemImage: AppTab.media.icon)
            }
            .tag(AppTab.media)
            
            // Tab 3: Drafts (Offline Workspace & Queue)
            NavigationStack {
                DraftsView()
                    .navigationTitle("Drafts")
                    .inlineNavigationBarTitle()
                    .toolbar {
                        ToolbarItem(placement: .leadingPlacement) {
                            librarySelectorHeaderButton
                        }
                        ToolbarItem(placement: .trailingPlacement) {
                            accountAvatarButton
                        }
                    }
            }
            .tabItem {
                Label(AppTab.drafts.title, systemImage: AppTab.drafts.icon)
            }
            .tag(AppTab.drafts)
        }
        .tint(.accentColor)
    }
    
    // MARK: - iPad / Mac Split View (Driven by selectedTab state)
    private var sidebarSplitView: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            SidebarView(viewModel: viewModel, selectedTab: $selectedTab)
                .navigationTitle("Stationary")
        } detail: {
            NavigationStack {
                Group {
                    switch selectedTab {
                    case .feed:
                        FeedView(viewModel: viewModel)
                    case .posts:
                        mediaGridMainView
                    case .media:
                        MediaGridView(viewModel: viewModel)
                    case .drafts:
                        DraftsView()
                    }
                }
                .navigationTitle(selectedTab.title)
                .navigationDestination(for: String.self) { postId in
                    PostDetailView(postId: postId)
                }
            }
        }
        .navigationSplitViewStyle(.balanced)
    }
}

// MARK: - Navigation Toolbar Components
extension PostListView {
    private var librarySelectorHeaderButton: some View {
        Menu {
            Text("ACTIVE LIBRARY")
                .font(.caption2.bold())
                .foregroundColor(.secondary)
            
            ForEach(libraryManager.libraries) { lib in
                Button {
                    HapticManager.selection()
                    libraryManager.setActiveLibrary(id: lib.id)
                } label: {
                    HStack {
                        Text(lib.name)
                        if lib.id == libraryManager.activeLibraryId {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
            
            Divider()
            
            Button {
                showingCreateLibrarySheet = true
            } label: {
                Label("New Library...", systemImage: "plus.circle")
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "folder.fill")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundColor(.accentColor)
                
                Text(libraryManager.activeLibrary?.name ?? "Select Library")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundColor(.primary)
                    .lineLimit(1)
                
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(.secondary.opacity(0.8))
            }
        }
        .buttonStyle(.plain)
    }
    
    private var accountAvatarButton: some View {
        Button {
            HapticManager.impact(style: .light)
            showingAccountSheet = true
        } label: {
            ZStack {
                Circle()
                    .fill(LinearGradient(
                        colors: [Color.accentColor.opacity(0.2), Color.accentColor.opacity(0.08)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ))
                    .frame(width: 30, height: 30)
                
                if authManager.isAuthenticated {
                    Text(String((authManager.currentUser?.name ?? "S").prefix(1)).uppercased())
                        .font(.system(size: 13, weight: .bold))
                        .foregroundColor(.accentColor)
                } else {
                    Image(systemName: "person.crop.circle.fill")
                        .font(.system(size: 16))
                        .foregroundColor(.accentColor)
                }
            }
            .overlay(
                Circle()
                    .stroke(LiquidPalette.borderFaint, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
    
    private var filterToolbarButton: some View {
        Button {
            HapticManager.impact(style: .light)
            showingFilterSheet = true
        } label: {
            HStack(spacing: 4) {
                Image(systemName: viewModel.activeFilterCount > 0 ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                    .font(.system(size: 17, weight: .medium))
                
                if viewModel.activeFilterCount > 0 {
                    Text("\(viewModel.activeFilterCount)")
                        .font(.system(size: 10, weight: .bold, design: .rounded))
                        .foregroundColor(.white)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1.5)
                        .background(Color.accentColor)
                        .clipShape(Capsule())
                }
            }
            .foregroundColor(viewModel.activeFilterCount > 0 ? .accentColor : .primary)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Media Grid Canvas & Filter Tokens Strip
extension PostListView {
    @ViewBuilder
    private var activeFilterTokenStripView: some View {
        if viewModel.activeFilterCount > 0 {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    Text("ACTIVE:")
                        .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                        .foregroundColor(.secondary.opacity(0.7))
                        .tracking(0.5)
                    
                    if viewModel.selectedSource != .all {
                        let brandColor = LiquidPalette.platformColor(viewModel.selectedSource)
                        Button {
                            HapticManager.selection()
                            viewModel.selectedSource = .all
                            viewModel.applyFilterChange()
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: viewModel.selectedSource.iconName)
                                Text(viewModel.selectedSource.displayName)
                                Image(systemName: "xmark").font(.system(size: 8, weight: .bold))
                            }
                        }
                        .unifiedFilterChip(isSelected: true, tintColor: brandColor)
                    }
                    
                    if let mediaType = viewModel.selectedMediaType {
                        let accentColor = LiquidPalette.mediaTypeColor(mediaType)
                        Button {
                            HapticManager.selection()
                            viewModel.selectedMediaType = nil
                            viewModel.applyFilterChange()
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: mediaType.iconName)
                                Text(mediaType.displayName)
                                Image(systemName: "xmark").font(.system(size: 8, weight: .bold))
                            }
                        }
                        .unifiedFilterChip(isSelected: true, tintColor: accentColor)
                    }
                    
                    ForEach(Array(viewModel.selectedAuthorIds), id: \.self) { authorId in
                        let name = viewModel.availableAuthors.first(where: { $0.id == authorId })?.displayName ?? "Author"
                        Button {
                            HapticManager.selection()
                            viewModel.selectedAuthorIds.remove(authorId)
                            viewModel.applyFilterChange()
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "person.fill")
                                Text(name)
                                Image(systemName: "xmark").font(.system(size: 8, weight: .bold))
                            }
                        }
                        .unifiedFilterChip(isSelected: true)
                    }
                    
                    ForEach(Array(viewModel.selectedTagIds), id: \.self) { tagId in
                        let name = viewModel.availableTags.first(where: { $0.id == tagId })?.name ?? "Tag"
                        Button {
                            HapticManager.selection()
                            viewModel.selectedTagIds.remove(tagId)
                            viewModel.applyFilterChange()
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "tag.fill")
                                Text("#\(name)")
                                Image(systemName: "xmark").font(.system(size: 8, weight: .bold))
                            }
                        }
                        .unifiedFilterChip(isSelected: true)
                    }
                    
                    Button {
                        HapticManager.notification(type: .success)
                        viewModel.resetFilters()
                    } label: {
                        HStack(spacing: 3) {
                            Image(systemName: "xmark.circle.fill")
                            Text("Clear All")
                        }
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(.red.opacity(0.85))
                        .padding(.horizontal, 6)
                    }
                    .tactileIconButton()
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
            }
            .background(LiquidPalette.canvasBg.opacity(0.95))
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }
    
    // MARK: - Main Media Grid Canvas
    private var mediaGridMainView: some View {
        ZStack {
            LiquidGlassBackgroundView()
            
            GeometryReader { geo in
                let containerWidth = geo.size.width
                let isCompactWidth = containerWidth < 640
                let minCardWidth: CGFloat = isCompactWidth ? 150 : 190
                let calculatedColumnsCount = max(2, min(viewModel.gridColumnsCount, Int(containerWidth / minCardWidth)))
                let gridColumns = Array(repeating: GridItem(.flexible(), spacing: isCompactWidth ? 12 : 16), count: calculatedColumnsCount)
                
                VStack(spacing: 0) {
                    // Desktop Wide Modular Filter Bar
                    if !isCompactWidth {
                        ModularFilterBarView(viewModel: viewModel)
                            .padding(.horizontal, 16)
                            .padding(.top, 10)
                            .padding(.bottom, 8)
                        
                        Divider().opacity(0.4)
                    }
                    
                    // Mobile Active Filter Pills Strip
                    activeFilterTokenStripView
                    
                    if viewModel.isLoading && viewModel.posts.isEmpty {
                        Spacer()
                        VStack(spacing: 14) {
                            ProgressView().tint(.accentColor)
                            Text("Loading Media Assets...").font(.system(size: 13, weight: .medium)).foregroundColor(.secondary)
                        }
                        Spacer()
                    } else if libraryManager.libraries.isEmpty || libraryManager.activeLibraryId == nil {
                        Spacer()
                        VStack(spacing: 16) {
                            Image(systemName: "folder.badge.plus").font(.system(size: 44)).foregroundColor(.accentColor)
                            Text("No Media Library Found").font(.system(size: 16, weight: .bold))
                            Text("Create your first media library to start archiving and organizing posts.")
                                .font(.system(size: 13)).foregroundColor(.secondary).multilineTextAlignment(.center)
                            Button("Create Library") { showingCreateLibrarySheet = true }.buttonStyle(.borderedProminent)
                        }.padding(32)
                        Spacer()
                    } else if let error = viewModel.errorMessage, viewModel.posts.isEmpty {
                        Spacer()
                        VStack(spacing: 16) {
                            Image(systemName: error.contains("Unauthorized") || error.contains("sign in") ? "person.crop.circle.badge.exclamationmark" : "exclamationmark.triangle")
                                .font(.system(size: 44)).foregroundColor(error.contains("Unauthorized") ? .accentColor : .orange)
                            Text(error.contains("Unauthorized") ? "Please Sign In to Access Your Media Library" : error)
                                .font(.system(size: 13, weight: .medium)).foregroundColor(.secondary).multilineTextAlignment(.center)
                            if error.contains("Unauthorized") {
                                Button("Sign In") { showingLoginSheet = true }.buttonStyle(.borderedProminent)
                            } else {
                                Button("Retry") { Task { await viewModel.loadPosts(resetPagination: true) } }.buttonStyle(.bordered)
                            }
                        }.padding(32)
                        Spacer()
                    } else if viewModel.posts.isEmpty {
                        Spacer()
                        VStack(spacing: 12) {
                            Image(systemName: "square.stack.3d.up.slash").font(.system(size: 44)).foregroundColor(.secondary.opacity(0.5))
                            Text("No Media Assets Found").font(.system(size: 14, weight: .semibold)).foregroundColor(.secondary)
                        }
                        Spacer()
                    } else {
                        ScrollView {
                            LazyVGrid(columns: gridColumns, spacing: isCompactWidth ? 12 : 16) {
                                ForEach(Array(viewModel.posts.enumerated()), id: \.element.id) { index, post in
                                    NavigationLink(value: post.id) {
                                        PostCardView(post: post, aspectRatio: viewModel.selectedAspectRatioRatio)
                                    }
                                    .buttonStyle(.plain)
                                    .onAppear {
                                        if index >= viewModel.posts.count - 4 {
                                            Task { await viewModel.loadMorePosts() }
                                        }
                                    }
                                }
                            }
                            .padding(isCompactWidth ? 12 : 16)
                            
                            VStack(spacing: 12) {
                                if viewModel.isLoadingMore {
                                    HStack(spacing: 8) {
                                        ProgressView().controlSize(.small)
                                        Text("Loading more assets...").font(.system(size: 12, weight: .medium)).foregroundColor(.secondary)
                                    }.padding(.vertical, 12)
                                } else if viewModel.hasMorePages {
                                    Button { Task { await viewModel.loadMorePosts() } } label: {
                                        HStack(spacing: 6) { Text("Load More Assets"); Image(systemName: "arrow.down") }.font(.system(size: 12, weight: .semibold))
                                    }.liquidGlassButton(isSelected: false).padding(.vertical, 10)
                                } else {
                                    Text("Showing all \(viewModel.posts.count) of \(viewModel.totalItems) assets")
                                        .font(.system(size: 11, weight: .medium, design: .rounded)).foregroundColor(.secondary.opacity(0.8)).padding(.vertical, 16)
                                }
                            }
                        }
                        .refreshable { await viewModel.loadPosts(resetPagination: true) }
                    }
                }
            }
        }
    }
}


