import SwiftUI

public struct ModularFilterBarView: View {
    @Bindable var viewModel: PostListViewModel
    
    @State private var showingAuthorPopover = false
    @State private var showingTagPopover = false
    
    public init(viewModel: PostListViewModel) {
        self.viewModel = viewModel
    }
    
    public var body: some View {
        VStack(spacing: 8) {
            // PRIMARY TOOLBAR ROW (Horizontal Scrollable Filter Strip: Search + Filter + Sort + View Options)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    searchFieldView
                        .frame(width: 175)
                    
                    filterAddMenu
                        .fixedSize()
                    
                    sortOrderMenu
                        .fixedSize()
                    
                    viewOptionsMenu
                        .fixedSize()
                }
                .padding(.horizontal, 2)
            }
            
            // ACTIVE FILTER PILLS STRIP (Notion / Placify Modular Filter Row)
            activeFilterPillsBar
        }
        .popover(isPresented: $showingAuthorPopover) {
            AuthorFilterPopoverView(viewModel: viewModel)
        }
        .popover(isPresented: $showingTagPopover) {
            TagFilterPopoverView(viewModel: viewModel)
        }
    }
    
    // MARK: - Search Field
    private var searchFieldView: some View {
        HStack(spacing: 7) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(.secondary.opacity(0.8))
            
            TextField("Search titles or keywords...", text: $viewModel.searchKeyword)
                .font(.system(size: 12, weight: .regular))
                .textFieldStyle(.plain)
                .onSubmit { viewModel.applyFilterChange() }
            
            if !viewModel.searchKeyword.isEmpty {
                Button {
                    viewModel.searchKeyword = ""
                    viewModel.applyFilterChange()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary.opacity(0.8))
                }
                .tactileIconButton()
            }
        }
        .frame(height: 32)
        .padding(.horizontal, 10)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.primary.opacity(0.038))
        )
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(LiquidPalette.borderFaint, lineWidth: 0.9)
        )
    }
    
    // MARK: - Add Filter Menu
    private var filterAddMenu: some View {
        Menu {
            Section("FILTER DIMENSIONS") {
                Menu("🌐 Platform") {
                    Button("All Platforms") {
                        viewModel.selectedSource = .all
                        viewModel.applyFilterChange()
                    }
                    Divider()
                    ForEach(SourcePlatform.allCases.filter { $0 != .all }) { platform in
                        Button {
                            viewModel.selectedSource = platform
                            viewModel.applyFilterChange()
                        } label: {
                            Label(platform.displayName, systemImage: platform.iconName)
                        }
                    }
                }
                
                Menu("🎞️ Media Type") {
                    Button("All Media Types") {
                        viewModel.selectedMediaType = nil
                        viewModel.applyFilterChange()
                    }
                    Divider()
                    ForEach(MediaType.allCases) { type in
                        Button {
                            viewModel.selectedMediaType = type
                            viewModel.applyFilterChange()
                        } label: {
                            Label(type.displayName, systemImage: type.iconName)
                        }
                    }
                }
                
                Button {
                    showingAuthorPopover = true
                } label: {
                    Label("👤 Authors", systemImage: "person.2")
                }
                
                Button {
                    showingTagPopover = true
                } label: {
                    Label("🏷️ Tags", systemImage: "tag")
                }
            }
            
            Section("PLANNED EXTENSIONS") {
                Label("📅 Date Range (Coming Soon)", systemImage: "calendar")
                    .disabled(true)
                Label("⭐ Favorites Only (Coming Soon)", systemImage: "star")
                    .disabled(true)
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "line.3.horizontal.decrease.circle")
                    .font(.system(size: 12, weight: .semibold))
                Text(viewModel.activeFilterCount == 0 ? "Filter" : "Filter (\(viewModel.activeFilterCount))")
                    .font(.system(size: 12, weight: .semibold))
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .bold))
            }
        }
        .liquidGlassButton(isSelected: viewModel.activeFilterCount > 0)
    }
    
    // MARK: - Active Filter Pills Bar (Notion / Placify Style)
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
                    
                    // Notion style "+ Add Filter" quick pill
                    Menu {
                        Button("🌐 Platform") { /* Menu triggered */ }
                        Button("🎞️ Media Type") { /* Menu triggered */ }
                        Button("👤 Author") { showingAuthorPopover = true }
                        Button("🏷️ Tag") { showingTagPopover = true }
                    } label: {
                        HStack(spacing: 3) {
                            Image(systemName: "plus")
                                .font(.system(size: 9, weight: .bold))
                            Text("Add Filter")
                                .font(.system(size: 10.5, weight: .semibold))
                        }
                        .foregroundColor(.accentColor)
                    }
                    .unifiedFilterChip(isSelected: false)
                    
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
    
    // MARK: - Sort Order Menu
    private var sortOrderMenu: some View {
        Menu {
            Button {
                viewModel.selectedSortBy = "published_time"
                viewModel.selectedSortOrder = "desc"
                viewModel.applyFilterChange()
            } label: {
                Label("Published Time (Newest)", systemImage: "clock.arrow.circlepath")
            }
            Button {
                viewModel.selectedSortBy = "published_time"
                viewModel.selectedSortOrder = "asc"
                viewModel.applyFilterChange()
            } label: {
                Label("Published Time (Oldest)", systemImage: "clock")
            }
            Divider()
            Button {
                viewModel.selectedSortBy = "create_time"
                viewModel.selectedSortOrder = "desc"
                viewModel.applyFilterChange()
            } label: {
                Label("Import Time (Newest)", systemImage: "arrow.down.doc")
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "arrow.up.arrow.down")
                Text("Sort")
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .bold))
            }
            .font(.system(size: 12, weight: .semibold))
        }
        .liquidGlassButton(isSelected: false)
    }
    
    // MARK: - View Options Menu
    private var viewOptionsMenu: some View {
        Menu {
            Section("Aspect Ratio") {
                Button("4:3 Standard") { viewModel.selectedAspectRatioRatio = 4.0 / 3.0 }
                Button("16:9 Widescreen") { viewModel.selectedAspectRatioRatio = 16.0 / 9.0 }
                Button("1:1 Square") { viewModel.selectedAspectRatioRatio = 1.0 }
                Button("3:4 Portrait") { viewModel.selectedAspectRatioRatio = 3.0 / 4.0 }
                Button("9:16 Vertical") { viewModel.selectedAspectRatioRatio = 9.0 / 16.0 }
            }
            
            Section("Grid Columns") {
                Button("2 Columns (Compact)") { viewModel.gridColumnsCount = 2 }
                Button("3 Columns") { viewModel.gridColumnsCount = 3 }
                Button("4 Columns") { viewModel.gridColumnsCount = 4 }
                Button("5 Columns") { viewModel.gridColumnsCount = 5 }
                Button("6 Columns") { viewModel.gridColumnsCount = 6 }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "square.grid.3x3")
                Text("View")
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .bold))
            }
            .font(.system(size: 12, weight: .semibold))
        }
        .liquidGlassButton(isSelected: false)
    }
}
