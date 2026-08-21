import SwiftUI

public struct AccountProfileSheetView: View {
    @State private var authManager = AuthManager.shared
    @State private var libraryManager = LibraryManager.shared
    @Environment(\.dismiss) private var dismiss
    
    @State private var showingCreateLibrarySheet = false
    @State private var showingLoginSheet = false
    
    public init() {}
    
    public var body: some View {
        NavigationStack {
            List {
                // USER PROFILE HEADER
                Section {
                    HStack(spacing: 14) {
                        ZStack {
                            Circle()
                                .fill(LinearGradient(
                                    colors: [Color.accentColor.opacity(0.2), Color.accentColor.opacity(0.08)],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                ))
                                .frame(width: 50, height: 50)
                            
                            if authManager.isAuthenticated {
                                Text(String((authManager.currentUser?.name ?? "S").prefix(1)).uppercased())
                                    .font(.system(size: 20, weight: .bold))
                                    .foregroundColor(.accentColor)
                            } else {
                                Image(systemName: "person.crop.circle.fill")
                                    .font(.system(size: 28))
                                    .foregroundColor(.accentColor)
                            }
                        }
                        
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 6) {
                                Text(authManager.currentUser?.name ?? "Guest User")
                                    .font(.system(size: 16, weight: .bold))
                                
                                Text("PRO")
                                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                                    .foregroundColor(.white)
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 2)
                                    .background(Color.accentColor)
                                    .clipShape(Capsule())
                            }
                            
                            Text(authManager.currentUser?.email ?? "Sign in to sync your libraries")
                                .font(.system(size: 12))
                                .foregroundColor(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }
                
                // LIBRARIES SECTION
                Section("MY LIBRARIES") {
                    ForEach(libraryManager.libraries) { lib in
                        Button {
                            libraryManager.setActiveLibrary(id: lib.id)
                            dismiss()
                        } label: {
                            HStack {
                                Label(lib.name, systemImage: "folder.fill")
                                    .font(.system(size: 14, weight: .medium))
                                Spacer()
                                if lib.id == libraryManager.activeLibraryId {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 13, weight: .bold))
                                        .foregroundColor(.accentColor)
                                }
                            }
                        }
                        .foregroundColor(.primary)
                    }
                    
                    Button {
                        showingCreateLibrarySheet = true
                    } label: {
                        Label("New Library...", systemImage: "plus.circle.fill")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(.accentColor)
                    }
                }
                
                // ACTIONS & SETTINGS
                Section {
                    Button {
                        // Public Libraries
                    } label: {
                        Label("Explore Public Libraries", systemImage: "globe")
                            .font(.system(size: 14))
                    }
                    
                    if authManager.isAuthenticated {
                        Button(role: .destructive) {
                            Task {
                                await authManager.signOut()
                                dismiss()
                            }
                        } label: {
                            Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                                .font(.system(size: 14, weight: .semibold))
                        }
                    } else {
                        Button {
                            showingLoginSheet = true
                        } label: {
                            Label("Sign In to Stationary", systemImage: "person.badge.key")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundColor(.accentColor)
                        }
                    }
                }
            }
            #if os(iOS)
            .listStyle(.insetGrouped)
            #else
            .listStyle(.sidebar)
            #endif
            .navigationTitle("Account & Workspaces")
            .inlineNavigationBarTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .font(.system(size: 15, weight: .bold))
                }
            }
        }
        .sheet(isPresented: $showingCreateLibrarySheet) { CreateLibrarySheet() }
        .sheet(isPresented: $showingLoginSheet) { LoginView() }
    }
}
