import SwiftUI

public struct MobileHeaderControlBarView: View {
    @Bindable var viewModel: PostListViewModel
    @State private var libraryManager = LibraryManager.shared
    @State private var authManager = AuthManager.shared
    
    @State private var showingCreateLibrarySheet = false
    @State private var showingFilterSheet = false
    @State private var showingAccountSheet = false
    
    public init(viewModel: PostListViewModel) {
        self.viewModel = viewModel
    }
    
    public var body: some View {
        VStack(spacing: 10) {
            // TOP HEADER ROW: Clean Library Selector Title + Top-Right Avatar Button
            HStack(spacing: 8) {
                // LEFT: CLEAN FLOATING LIBRARY TITLE (Apple Photos Style)
                Menu {
                    Text("ACTIVE LIBRARY")
                        .font(.caption2.bold())
                        .foregroundColor(.secondary)
                    
                    ForEach(libraryManager.libraries) { lib in
                        Button {
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
                            .font(.system(size: 14, weight: .bold))
                            .foregroundColor(.accentColor)
                        
                        Text(libraryManager.activeLibrary?.name ?? "Select Library")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(.primary)
                            .lineLimit(1)
                        
                        Image(systemName: "chevron.down")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundColor(.secondary.opacity(0.8))
                    }
                }
                .buttonStyle(.plain)
                
                Spacer(minLength: 4)
                
                // RIGHT: AVATAR PROFILE BUTTON (Shared across all pages)
                Button {
                    showingAccountSheet = true
                } label: {
                    ZStack {
                        Circle()
                            .fill(LinearGradient(
                                colors: [Color.accentColor.opacity(0.2), Color.accentColor.opacity(0.1)],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            ))
                            .frame(width: 32, height: 32)
                        
                        if authManager.isAuthenticated {
                            Text(String((authManager.currentUser?.name ?? "S").prefix(1)).uppercased())
                                .font(.system(size: 14, weight: .bold))
                                .foregroundColor(.accentColor)
                        } else {
                            Image(systemName: "person.crop.circle.fill")
                                .font(.system(size: 18))
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
            
            // SECOND ROW: 42pt Height Unified Search Bar + 🎛️ Filter Sheet Trigger Button
            HStack(spacing: 8) {
                // SEARCH FIELD (42pt Apple Standard Touch Height)
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(.secondary.opacity(0.8))
                    
                    TextField("Search titles, tags, authors...", text: $viewModel.searchKeyword)
                        .font(.system(size: 13.5, weight: .regular))
                        .textFieldStyle(.plain)
                        .onSubmit { viewModel.applyFilterChange() }
                    
                    if !viewModel.searchKeyword.isEmpty {
                        Button {
                            viewModel.searchKeyword = ""
                            viewModel.applyFilterChange()
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 14))
                                .foregroundColor(.secondary.opacity(0.8))
                        }
                        .tactileIconButton()
                    }
                }
                .frame(height: 40)
                .padding(.horizontal, 12)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.primary.opacity(0.04))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(LiquidPalette.borderFaint, lineWidth: 0.9)
                )
                
                // FILTER BUTTON (42pt Touch Height, opens iOS Filter Sheet)
                Button {
                    showingFilterSheet = true
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "line.3.horizontal.decrease.circle.fill")
                            .font(.system(size: 15, weight: .semibold))
                        
                        if viewModel.activeFilterCount > 0 {
                            Text("\(viewModel.activeFilterCount)")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundColor(.white)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1.5)
                                .background(Color.accentColor)
                                .clipShape(Capsule())
                        } else {
                            Text("Filter")
                                .font(.system(size: 13.5, weight: .semibold))
                        }
                    }
                    .padding(.horizontal, 12)
                    .frame(height: 40)
                    .background(viewModel.activeFilterCount > 0 ? Color.accentColor.opacity(0.12) : Color.primary.opacity(0.04))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(viewModel.activeFilterCount > 0 ? Color.accentColor : LiquidPalette.borderFaint, lineWidth: 0.9)
                    )
                    .foregroundColor(viewModel.activeFilterCount > 0 ? .accentColor : .primary)
                }
                .buttonStyle(.plain)
            }
            
            // ACTIVE FILTER PILLS STRIP
            activeFilterPillsBar
        }
        .sheet(isPresented: $showingCreateLibrarySheet) { CreateLibrarySheet() }
        .sheet(isPresented: $showingFilterSheet) { MobileFilterSheetView(viewModel: viewModel) }
        .sheet(isPresented: $showingAccountSheet) { AccountProfileSheetView() }
    }
    
    @ViewBuilder
    private var activeFilterPillsBar: some View {
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
                        viewModel.resetFilters()
                    } label: {
                        HStack(spacing: 3) {
                            Image(systemName: "xmark.circle.fill")
                            Text("Clear All")
                        }
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundColor(.red.opacity(0.85))
                        .padding(.horizontal, 6)
                    }
                    .tactileIconButton()
                }
                .padding(.vertical, 2)
            }
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }
}
