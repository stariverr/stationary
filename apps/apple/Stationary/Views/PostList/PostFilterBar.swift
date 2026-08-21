import SwiftUI

public struct PostFilterBar: View {
    @Bindable var viewModel: PostListViewModel
    
    public init(viewModel: PostListViewModel) {
        self.viewModel = viewModel
    }
    
    public var body: some View {
        VStack(spacing: 12) {
            // Search Bar Input Row
            HStack(spacing: 12) {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(LiquidPalette.accent)
                    
                    TextField("Search posts by keyword, author, or title...", text: $viewModel.searchKeyword)
                        .font(.system(size: 13, design: .rounded))
                        .textFieldStyle(.plain)
                        .autocorrectionDisabled()
                    
                    if !viewModel.searchKeyword.isEmpty {
                        Button {
                            viewModel.searchKeyword = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundColor(.white.opacity(0.5))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(.thinMaterial)
                .clipShape(Capsule())
                .overlay(Capsule().stroke(LiquidPalette.accent.opacity(0.3), lineWidth: 1))
                
                Button {
                    viewModel.resetFilters()
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.counterclockwise")
                            .font(.system(size: 12, weight: .bold))
                        Text("Reset")
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                    }
                }
                .liquidGlassButton(isSelected: false)
                .buttonStyle(.plain)
            }
            
            // Platform Chips Scroll Row
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(SourcePlatform.allCases) { platform in
                        Button {
                            viewModel.selectedSource = platform
                            viewModel.applyFilterChange()
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: platform.iconName)
                                    .font(.system(size: 11, weight: .bold))
                                Text(platform.displayName)
                                    .font(.system(size: 12, weight: .bold, design: .rounded))
                            }
                            .foregroundColor(viewModel.selectedSource == platform ? .white : Color.white.opacity(0.85))
                        }
                        .liquidGlassButton(isSelected: viewModel.selectedSource == platform)
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 2)
            }
            
            // Secondary Filter Options Row
            HStack(spacing: 12) {
                Menu {
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
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: viewModel.selectedMediaType?.iconName ?? "square.stack.3d.up.fill")
                            .font(.system(size: 11))
                        Text(viewModel.selectedMediaType?.displayName ?? "Media Type")
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                        Image(systemName: "chevron.down")
                            .font(.system(size: 9, weight: .bold))
                    }
                    .liquidGlassButton(isSelected: viewModel.selectedMediaType != nil)
                }
                .buttonStyle(.plain)
                
                Menu {
                    Button("Published Time (Newest)") {
                        viewModel.selectedSortBy = "published_time"
                        viewModel.selectedSortOrder = "desc"
                        viewModel.applyFilterChange()
                    }
                    Button("Published Time (Oldest)") {
                        viewModel.selectedSortBy = "published_time"
                        viewModel.selectedSortOrder = "asc"
                        viewModel.applyFilterChange()
                    }
                    Divider()
                    Button("Import Time (Newest)") {
                        viewModel.selectedSortBy = "create_time"
                        viewModel.selectedSortOrder = "desc"
                        viewModel.applyFilterChange()
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.up.arrow.down")
                            .font(.system(size: 11))
                        Text(viewModel.selectedSortBy == "published_time" ? "Published" : "Imported")
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                        Image(systemName: "chevron.down")
                            .font(.system(size: 9, weight: .bold))
                    }
                    .liquidGlassButton(isSelected: false)
                }
                .buttonStyle(.plain)
                
                Spacer()
                
                Menu {
                    Button("4:3") { viewModel.selectedAspectRatioRatio = 4.0 / 3.0 }
                    Button("16:9") { viewModel.selectedAspectRatioRatio = 16.0 / 9.0 }
                    Button("1:1") { viewModel.selectedAspectRatioRatio = 1.0 }
                    Button("3:4") { viewModel.selectedAspectRatioRatio = 3.0 / 4.0 }
                    Button("9:16") { viewModel.selectedAspectRatioRatio = 9.0 / 16.0 }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "aspectratio")
                            .font(.system(size: 11))
                        Text("Ratio")
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                        Image(systemName: "chevron.down")
                            .font(.system(size: 9, weight: .bold))
                    }
                    .liquidGlassButton(isSelected: false)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(14)
        .liquidGlassCard(cornerRadius: 22, isInteractive: false)
    }
}
