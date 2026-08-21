import SwiftUI

public struct TagFilterPopoverView: View {
    @Bindable var viewModel: PostListViewModel
    @Environment(\.dismiss) private var dismiss
    
    @State private var searchKeyword: String = ""
    
    public init(viewModel: PostListViewModel) {
        self.viewModel = viewModel
    }
    
    private var filteredTags: [Tag] {
        let kw = searchKeyword.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if kw.isEmpty {
            return viewModel.availableTags
        }
        return viewModel.availableTags.filter { $0.name.lowercased().contains(kw) }
    }
    
    public var body: some View {
        VStack(spacing: 8) {
            // Search Input Header Bar
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.secondary)
                
                TextField("Search tags...", text: $searchKeyword)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12, weight: .regular))
                
                if !searchKeyword.isEmpty {
                    Button {
                        searchKeyword = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 12))
                            .foregroundColor(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(Color.primary.opacity(0.04))
            .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .stroke(LiquidPalette.borderFaint, lineWidth: 0.8)
            )
            
            Divider().opacity(0.6)
            
            // Tags List
            if filteredTags.isEmpty {
                VStack(spacing: 6) {
                    Image(systemName: "tag.slash")
                        .font(.system(size: 22))
                        .foregroundColor(.secondary.opacity(0.6))
                    Text("No Tags Found")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 140)
            } else {
                ScrollView {
                    VStack(spacing: 1) {
                        ForEach(filteredTags) { tag in
                            let isSelected = viewModel.selectedTagIds.contains(tag.id)
                            Button {
                                withAnimation(.spring(response: 0.2, dampingFraction: 0.8)) {
                                    if isSelected {
                                        viewModel.selectedTagIds.remove(tag.id)
                                    } else {
                                        viewModel.selectedTagIds.insert(tag.id)
                                    }
                                }
                                viewModel.applyFilterChange()
                            } label: {
                                HStack(spacing: 8) {
                                    Text("#\(tag.name)")
                                        .font(.system(size: 12, weight: isSelected ? .bold : .medium))
                                        .foregroundColor(isSelected ? .accentColor : .primary)
                                        .lineLimit(1)
                                    
                                    Spacer()
                                    
                                    if let count = tag.post_count, count > 0 {
                                        Text("\(count)")
                                            .font(.system(size: 9.5, weight: .semibold))
                                            .foregroundColor(.secondary)
                                            .padding(.horizontal, 5)
                                            .padding(.vertical, 1.5)
                                            .background(Color.primary.opacity(0.05))
                                            .clipShape(Capsule())
                                    }
                                    
                                    if isSelected {
                                        Image(systemName: "checkmark")
                                            .font(.system(size: 11, weight: .bold))
                                            .foregroundColor(.accentColor)
                                    }
                                }
                                .padding(.horizontal, 8)
                                .padding(.vertical, 5)
                                .background(isSelected ? Color.accentColor.opacity(0.1) : Color.clear)
                                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .frame(maxHeight: 220)
            }
            
            Divider().opacity(0.6)
            
            // Bottom Action Controls
            HStack {
                if !viewModel.selectedTagIds.isEmpty {
                    Button("Clear All (\(viewModel.selectedTagIds.count))") {
                        withAnimation {
                            viewModel.selectedTagIds.removeAll()
                        }
                        viewModel.applyFilterChange()
                    }
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.red)
                    .buttonStyle(.plain)
                }
                
                Spacer()
                
                Button("Done") {
                    dismiss()
                }
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(.accentColor)
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 4)
            .padding(.top, 2)
        }
        .padding(10)
        .frame(width: 240)
    }
}
