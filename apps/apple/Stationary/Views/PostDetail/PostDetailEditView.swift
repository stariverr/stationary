import SwiftUI

public struct PostDetailEditView: View {
    @Bindable var viewModel: PostDetailViewModel
    @Environment(\.dismiss) private var dismiss
    
    @State private var newTagInput: String = ""
    
    public init(viewModel: PostDetailViewModel) {
        self.viewModel = viewModel
    }
    
    public var body: some View {
        NavigationStack {
            ZStack {
                LiquidGlassBackgroundView()
                
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        // Title Field
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Post Title")
                                .font(.caption.bold())
                                .foregroundColor(.cyan)
                            TextField("Enter title...", text: $viewModel.editTitle)
                                .padding(12)
                                .background(.thinMaterial)
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        
                        // Description Field
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Description")
                                .font(.caption.bold())
                                .foregroundColor(.cyan)
                            TextEditor(text: $viewModel.editDescription)
                                .frame(minHeight: 120)
                                .padding(6)
                                .background(.thinMaterial)
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        
                        // Published Timestamp Field
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Published Timestamp (ISO 8601)")
                                .font(.caption.bold())
                                .foregroundColor(.cyan)
                            TextField("YYYY-MM-DDTHH:MM:SSZ", text: $viewModel.editPublishedTime)
                                .padding(12)
                                .background(.thinMaterial)
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        
                        // Original Source URL Field
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Original Source URL")
                                .font(.caption.bold())
                                .foregroundColor(.cyan)
                            TextField("https://...", text: $viewModel.editURL)
                                .padding(12)
                                .background(.thinMaterial)
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                                .autocorrectionDisabled()
                        }
                        
                        // Tags Management Section
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Tags Management")
                                .font(.caption.bold())
                                .foregroundColor(.cyan)
                            
                            if let tags = viewModel.detail?.tags {
                                ScrollView(.horizontal, showsIndicators: false) {
                                    HStack(spacing: 8) {
                                        ForEach(tags, id: \.self) { tag in
                                            HStack(spacing: 4) {
                                                Text("#\(tag)")
                                                Button {
                                                    var current = tags
                                                    current.removeAll(where: { $0 == tag })
                                                    Task { await viewModel.replaceTags(current) }
                                                } label: {
                                                    Image(systemName: "xmark")
                                                        .font(.caption2)
                                                }
                                                .buttonStyle(.plain)
                                            }
                                            .font(.caption)
                                            .padding(.horizontal, 10)
                                            .padding(.vertical, 6)
                                            .background(Color.cyan.opacity(0.2))
                                            .foregroundColor(.cyan)
                                            .clipShape(Capsule())
                                        }
                                    }
                                }
                            }
                            
                            // Add New Tag Row
                            HStack {
                                TextField("Add tag...", text: $newTagInput)
                                    .padding(8)
                                    .background(.thinMaterial)
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                                
                                Button("Add Tag") {
                                    guard !newTagInput.isEmpty else { return }
                                    var current = viewModel.detail?.tags ?? []
                                    if !current.contains(newTagInput) {
                                        current.append(newTagInput)
                                        newTagInput = ""
                                        Task { await viewModel.replaceTags(current) }
                                    }
                                }
                                .liquidGlassButton(isSelected: true)
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .padding(20)
                    .liquidGlassCard(cornerRadius: 20)
                    .padding(16)
                }
            }
            .navigationTitle("Edit Post Details")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            let success = await viewModel.saveEdits()
                            if success { dismiss() }
                        }
                    }
                    .font(.body.bold())
                    .disabled(viewModel.isSaving)
                }
            }
        }
    }
}
