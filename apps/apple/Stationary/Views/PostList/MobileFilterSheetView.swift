import SwiftUI

public struct MobileFilterSheetView: View {
    @Bindable var viewModel: PostListViewModel
    @Environment(\.dismiss) private var dismiss
    
    @State private var showingAuthorPopover = false
    @State private var showingTagPopover = false
    
    public init(viewModel: PostListViewModel) {
        self.viewModel = viewModel
    }
    
    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    // 1. PLATFORM SELECTION
                    VStack(alignment: .leading, spacing: 10) {
                        Text("PLATFORM")
                            .font(.system(size: 11, weight: .bold, design: .monospaced))
                            .foregroundColor(.secondary)
                            .tracking(0.6)
                        
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                filterChip(title: "All", icon: "square.grid.2x2", isSelected: viewModel.selectedSource == .all) {
                                    viewModel.selectedSource = .all
                                    viewModel.applyFilterChange()
                                }
                                
                                ForEach(SourcePlatform.allCases.filter { $0 != .all }) { platform in
                                    let isSelected = viewModel.selectedSource == platform
                                    filterChip(
                                        title: platform.displayName,
                                        icon: platform.iconName,
                                        isSelected: isSelected,
                                        tintColor: LiquidPalette.platformColor(platform)
                                    ) {
                                        viewModel.selectedSource = platform
                                        viewModel.applyFilterChange()
                                    }
                                }
                            }
                        }
                    }
                    
                    Divider().opacity(0.5)
                    
                    // 2. MEDIA TYPE SELECTION
                    VStack(alignment: .leading, spacing: 10) {
                        Text("MEDIA TYPE")
                            .font(.system(size: 11, weight: .bold, design: .monospaced))
                            .foregroundColor(.secondary)
                            .tracking(0.6)
                        
                        HStack(spacing: 8) {
                            filterChip(title: "All Types", icon: "photo.stack", isSelected: viewModel.selectedMediaType == nil) {
                                viewModel.selectedMediaType = nil
                                viewModel.applyFilterChange()
                            }
                            
                            ForEach(MediaType.allCases) { type in
                                let isSelected = viewModel.selectedMediaType == type
                                filterChip(
                                    title: type.displayName,
                                    icon: type.iconName,
                                    isSelected: isSelected,
                                    tintColor: LiquidPalette.mediaTypeColor(type)
                                ) {
                                    viewModel.selectedMediaType = type
                                    viewModel.applyFilterChange()
                                }
                            }
                        }
                    }
                    
                    Divider().opacity(0.5)
                    
                    // 3. AUTHORS & TAGS
                    VStack(alignment: .leading, spacing: 10) {
                        Text("PEOPLE & TAGS")
                            .font(.system(size: 11, weight: .bold, design: .monospaced))
                            .foregroundColor(.secondary)
                            .tracking(0.6)
                        
                        HStack(spacing: 12) {
                            Button {
                                showingAuthorPopover = true
                            } label: {
                                HStack {
                                    Image(systemName: "person.2.fill")
                                    Text(viewModel.selectedAuthorIds.isEmpty ? "Select Authors" : "Authors (\(viewModel.selectedAuthorIds.count))")
                                        .font(.system(size: 13, weight: .semibold))
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 11, weight: .bold))
                                        .foregroundColor(.secondary)
                                }
                                .padding(12)
                                .background(Color.primary.opacity(0.04))
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            }
                            .buttonStyle(.plain)
                            
                            Button {
                                showingTagPopover = true
                            } label: {
                                HStack {
                                    Image(systemName: "tag.fill")
                                    Text(viewModel.selectedTagIds.isEmpty ? "Select Tags" : "Tags (\(viewModel.selectedTagIds.count))")
                                        .font(.system(size: 13, weight: .semibold))
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 11, weight: .bold))
                                        .foregroundColor(.secondary)
                                }
                                .padding(12)
                                .background(Color.primary.opacity(0.04))
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    
                    Divider().opacity(0.5)
                    
                    // 4. SORT ORDER
                    VStack(alignment: .leading, spacing: 10) {
                        Text("SORT BY")
                            .font(.system(size: 11, weight: .bold, design: .monospaced))
                            .foregroundColor(.secondary)
                            .tracking(0.6)
                        
                        VStack(spacing: 8) {
                            sortRow(title: "Published Time (Newest First)", isSelected: viewModel.selectedSortBy == "published_time" && viewModel.selectedSortOrder == "desc") {
                                viewModel.selectedSortBy = "published_time"
                                viewModel.selectedSortOrder = "desc"
                                viewModel.applyFilterChange()
                            }
                            sortRow(title: "Published Time (Oldest First)", isSelected: viewModel.selectedSortBy == "published_time" && viewModel.selectedSortOrder == "asc") {
                                viewModel.selectedSortBy = "published_time"
                                viewModel.selectedSortOrder = "asc"
                                viewModel.applyFilterChange()
                            }
                            sortRow(title: "Import Time (Newest First)", isSelected: viewModel.selectedSortBy == "create_time" && viewModel.selectedSortOrder == "desc") {
                                viewModel.selectedSortBy = "create_time"
                                viewModel.selectedSortOrder = "desc"
                                viewModel.applyFilterChange()
                            }
                        }
                    }
                    
                    Divider().opacity(0.5)
                    
                    // 5. GRID LAYOUT
                    VStack(alignment: .leading, spacing: 10) {
                        Text("GRID COLUMNS")
                            .font(.system(size: 11, weight: .bold, design: .monospaced))
                            .foregroundColor(.secondary)
                            .tracking(0.6)
                        
                        Picker("Grid Columns", selection: $viewModel.gridColumnsCount) {
                            Text("2 Columns").tag(2)
                            Text("3 Columns").tag(3)
                            Text("4 Columns").tag(4)
                        }
                        .pickerStyle(.segmented)
                    }
                }
                .padding(20)
            }
            .navigationTitle("Filter & View Options")
            .inlineNavigationBarTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if viewModel.activeFilterCount > 0 {
                        Button("Reset All") {
                            viewModel.resetFilters()
                        }
                        .foregroundColor(.red)
                    }
                }
                
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        dismiss()
                    }
                    .font(.system(size: 15, weight: .bold))
                }
            }
        }
        .popover(isPresented: $showingAuthorPopover) { AuthorFilterPopoverView(viewModel: viewModel) }
        .popover(isPresented: $showingTagPopover) { TagFilterPopoverView(viewModel: viewModel) }
    }
    
    private func filterChip(title: String, icon: String, isSelected: Bool, tintColor: Color? = nil, action: @escaping () -> Void) -> some View {
        Button {
            HapticManager.selection()
            action()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .semibold))
                Text(title)
                    .font(.system(size: 13, weight: isSelected ? .bold : .medium))
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 38)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(isSelected ? (tintColor ?? Color.accentColor).opacity(0.16) : Color.primary.opacity(0.04))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(isSelected ? (tintColor ?? Color.accentColor) : LiquidPalette.borderFaint, lineWidth: isSelected ? 1.5 : 0.8)
            )
            .foregroundColor(isSelected ? (tintColor ?? Color.accentColor) : .primary)
        }
        .buttonStyle(TactileSpringButtonStyle(scale: 0.96))
    }
    
    private func sortRow(title: String, isSelected: Bool, action: @escaping () -> Void) -> some View {
        Button {
            HapticManager.selection()
            action()
        } label: {
            HStack {
                Text(title)
                    .font(.system(size: 13.5, weight: isSelected ? .bold : .medium))
                    .foregroundColor(isSelected ? .accentColor : .primary)
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(.accentColor)
                }
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(Color.primary.opacity(isSelected ? 0.06 : 0.03))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(TactileSpringButtonStyle(scale: 0.98))
    }
}
