import SwiftUI

public struct LibraryPickerMenu: View {
    @State private var libraryManager = LibraryManager.shared
    @State private var showingCreateSheet = false
    
    public init() {}
    
    public var body: some View {
        Menu {
            Section("Select Library") {
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
            }
            
            Divider()
            
            Button {
                showingCreateSheet = true
            } label: {
                Label("Create New Library", systemImage: "plus.circle")
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "folder.fill")
                    .foregroundColor(.cyan)
                Text(libraryManager.activeLibrary?.name ?? "Select Library")
                    .font(.subheadline.bold())
                Image(systemName: "chevron.down")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
            .liquidGlassButton(isSelected: false)
        }
        .sheet(isPresented: $showingCreateSheet) {
            CreateLibrarySheet()
        }
    }
}
