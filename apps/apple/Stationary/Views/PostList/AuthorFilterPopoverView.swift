import SwiftUI

public struct AuthorFilterPopoverView: View {
    @Bindable var viewModel: PostListViewModel
    @Environment(\.dismiss) private var dismiss
    
    @State private var searchKeyword: String = ""
    @State private var isSearching: Bool = false
    
    public init(viewModel: PostListViewModel) {
        self.viewModel = viewModel
    }
    
    public var body: some View {
        VStack(spacing: 8) {
            // Search Input Header Bar
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.secondary)
                
                TextField("Search authors...", text: $searchKeyword)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12, weight: .regular))
                    .onChange(of: searchKeyword) { _, newValue in
                        Task {
                            await searchAuthors(query: newValue)
                        }
                    }
                
                if !searchKeyword.isEmpty {
                    Button {
                        searchKeyword = ""
                        Task { await searchAuthors(query: "") }
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
            
            // Authors List
            if isSearching {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, minHeight: 140)
            } else if viewModel.availableAuthors.isEmpty {
                VStack(spacing: 6) {
                    Image(systemName: "person.slash")
                        .font(.system(size: 22))
                        .foregroundColor(.secondary.opacity(0.6))
                    Text("No Authors Found")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 140)
            } else {
                ScrollView {
                    VStack(spacing: 1) {
                        ForEach(viewModel.availableAuthors) { author in
                            let isSelected = viewModel.selectedAuthorIds.contains(author.id)
                            Button {
                                withAnimation(.spring(response: 0.2, dampingFraction: 0.8)) {
                                    if isSelected {
                                        viewModel.selectedAuthorIds.remove(author.id)
                                    } else {
                                        viewModel.selectedAuthorIds.insert(author.id)
                                    }
                                }
                                viewModel.applyFilterChange()
                            } label: {
                                HStack(spacing: 8) {
                                    if let avatarStr = author.avatar_url, let avatarUrl = URL(string: avatarStr) {
                                        AsyncImage(url: avatarUrl) { phase in
                                            if let img = phase.image {
                                                img.resizable().scaledToFill()
                                            } else {
                                                Image(systemName: "person.circle.fill")
                                            }
                                        }
                                        .frame(width: 20, height: 20)
                                        .clipShape(Circle())
                                    } else {
                                        Image(systemName: "person.circle.fill")
                                            .font(.system(size: 20))
                                            .foregroundColor(.secondary.opacity(0.7))
                                    }
                                    
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(author.displayName)
                                            .font(.system(size: 12, weight: isSelected ? .bold : .medium))
                                            .foregroundColor(isSelected ? .accentColor : .primary)
                                            .lineLimit(1)
                                        
                                        if let platform = author.platform {
                                            Text(platform.displayName)
                                                .font(.system(size: 9.5))
                                                .foregroundColor(.secondary)
                                        }
                                    }
                                    
                                    Spacer()
                                    
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
                if !viewModel.selectedAuthorIds.isEmpty {
                    Button("Clear All (\(viewModel.selectedAuthorIds.count))") {
                        withAnimation {
                            viewModel.selectedAuthorIds.removeAll()
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
        .frame(width: 260)
    }
    
    private func searchAuthors(query: String) async {
        isSearching = true
        let libId = LibraryManager.shared.activeLibraryId ?? ""
        if let authors = try? await APIClient.shared.fetchAuthors(libraryId: libId, keyword: query) {
            viewModel.availableAuthors = authors
        }
        isSearching = false
    }
}
