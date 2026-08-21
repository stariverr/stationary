import SwiftUI

public struct CreateLibrarySheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var libraryManager = LibraryManager.shared
    
    @State private var nameInput: String = ""
    @State private var descriptionInput: String = ""
    
    public init() {}
    
    public var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Library Name")
                        .font(.caption.bold())
                        .foregroundColor(.accentColor)
                    TextField("My Asset Library...", text: $nameInput)
                        .font(.system(size: 13))
                        .padding(10)
                        .background(Color.primary.opacity(0.035))
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Color.primary.opacity(0.08), lineWidth: 1))
                }
                
                VStack(alignment: .leading, spacing: 6) {
                    Text("Description (Optional)")
                        .font(.caption.bold())
                        .foregroundColor(.accentColor)
                    TextField("Library purpose or assets...", text: $descriptionInput)
                        .font(.system(size: 13))
                        .padding(10)
                        .background(Color.primary.opacity(0.035))
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Color.primary.opacity(0.08), lineWidth: 1))
                }
                
                if let error = libraryManager.errorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundColor(.red)
                }
                
                Spacer()
            }
            .padding(22)
            .frame(width: 380, height: 260)
            .background(.regularMaterial)
            .navigationTitle("New Library")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .tactileIconButton()
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        Task {
                            let success = await libraryManager.createLibrary(
                                name: nameInput,
                                description: descriptionInput.isEmpty ? nil : descriptionInput
                            )
                            if success {
                                dismiss()
                            }
                        }
                    }
                    .liquidGlassButton(isSelected: true)
                    .disabled(nameInput.isEmpty || libraryManager.isLoading)
                }
            }
        }
    }
}

