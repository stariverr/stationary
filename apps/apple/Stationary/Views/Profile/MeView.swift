import SwiftUI

public struct MeView: View {
    @State private var authManager = AuthManager.shared
    @State private var libraryManager = LibraryManager.shared
    @State private var showingLoginSheet = false
    @State private var showingCreateLibrarySheet = false
    
    public init() {}
    
    public var body: some View {
        List {
            // USER ACCOUNT TILE
            Section("Account") {
                if authManager.isAuthenticated {
                    HStack(spacing: 14) {
                        ZStack {
                            Circle()
                                .fill(Color.accentColor.opacity(0.12))
                                .frame(width: 48, height: 48)
                            Image(systemName: "person.crop.circle.fill")
                                .font(.system(size: 32))
                                .foregroundColor(.accentColor)
                        }
                        
                        VStack(alignment: .leading, spacing: 3) {
                            Text(authManager.currentUser?.name ?? "Account")
                                .font(.system(size: 16, weight: .bold))
                            Text(authManager.currentUser?.email ?? "")
                                .font(.system(size: 12))
                                .foregroundColor(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                    
                    Button(role: .destructive) {
                        Task { await authManager.signOut() }
                    } label: {
                        Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                } else {
                    VStack(alignment: .center, spacing: 10) {
                        Text("Sign in to sync your media libraries across all Apple devices.")
                            .font(.system(size: 13))
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                        
                        Button("Sign In") {
                            showingLoginSheet = true
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity)
                }
            }
            
            // LIBRARIES EXPLORER & MANAGEMENT SECTION
            Section("Media Libraries (Public & Private)") {
                ForEach(libraryManager.libraries) { lib in
                    HStack {
                        Image(systemName: "folder.fill")
                            .foregroundColor(.accentColor)
                        
                        VStack(alignment: .leading, spacing: 1) {
                            Text(lib.name)
                                .font(.system(size: 14, weight: .semibold))
                            Text(lib.description ?? "Private Library")
                                .font(.system(size: 11))
                                .foregroundColor(.secondary)
                        }
                        
                        Spacer()
                        
                        if lib.id == libraryManager.activeLibraryId {
                            Text("Active")
                                .font(.system(size: 10, weight: .bold))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(Color.accentColor.opacity(0.15))
                                .foregroundColor(.accentColor)
                                .clipShape(Capsule())
                        }
                    }
                }
                
                Button {
                    showingCreateLibrarySheet = true
                } label: {
                    Label("Create New Library", systemImage: "plus.circle.fill")
                        .foregroundColor(.accentColor)
                }
            }
            
            // APP PREFERENCES & SETTINGS
            Section("Settings") {
                HStack {
                    Label("Version", systemImage: "info.circle")
                    Spacer()
                    Text("1.0.0 (Stationary)")
                        .foregroundColor(.secondary)
                        .font(.system(size: 12))
                }
            }
        }
        .sheet(isPresented: $showingLoginSheet) {
            LoginView()
        }
        .sheet(isPresented: $showingCreateLibrarySheet) {
            CreateLibrarySheet()
        }
    }
}
