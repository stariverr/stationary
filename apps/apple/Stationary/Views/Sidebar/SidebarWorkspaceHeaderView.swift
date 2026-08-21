import SwiftUI

public struct SidebarWorkspaceHeaderView: View {
    @Bindable var viewModel: PostListViewModel
    @State private var libraryManager = LibraryManager.shared
    @State private var authManager = AuthManager.shared
    
    @State private var showingCreateLibrary = false
    @State private var showingLoginSheet = false
    
    public init(viewModel: PostListViewModel) {
        self.viewModel = viewModel
    }
    
    public var body: some View {
        Menu {
            // ACCOUNT SECTION
            if authManager.isAuthenticated {
                Section {
                    HStack(spacing: 8) {
                        Image(systemName: "person.crop.circle.fill")
                            .foregroundColor(.accentColor)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(authManager.currentUser?.name ?? "User")
                                .font(.system(size: 13, weight: .bold))
                            Text(authManager.currentUser?.email ?? "")
                                .font(.system(size: 11))
                                .foregroundColor(.secondary)
                        }
                    }
                }
            }
            
            // LIBRARIES SECTION
            Section("MY LIBRARIES") {
                ForEach(libraryManager.libraries) { lib in
                    Button {
                        libraryManager.setActiveLibrary(id: lib.id)
                    } label: {
                        HStack {
                            Label(lib.name, systemImage: "folder.fill")
                            if lib.id == libraryManager.activeLibraryId {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
                
                Button {
                    showingCreateLibrary = true
                } label: {
                    Label("New Library...", systemImage: "plus.circle")
                }
            }
            
            // ACTIONS SECTION
            Section {
                if authManager.isAuthenticated {
                    Button(role: .destructive) {
                        Task { await authManager.signOut() }
                    } label: {
                        Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                } else {
                    Button {
                        showingLoginSheet = true
                    } label: {
                        Label("Sign In", systemImage: "person.badge.key")
                    }
                }
            }
        } label: {
            HStack(spacing: 10) {
                // AVATAR / ICON TILE
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(LinearGradient(
                            colors: [Color.accentColor.opacity(0.18), Color.accentColor.opacity(0.08)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ))
                        .frame(width: 34, height: 34)
                    
                    if authManager.isAuthenticated {
                        Text(String((authManager.currentUser?.name ?? "S").prefix(1)).uppercased())
                            .font(.system(size: 15, weight: .bold))
                            .foregroundColor(.accentColor)
                    } else {
                        Image(systemName: "folder.fill")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundColor(.accentColor)
                    }
                }
                
                // WORKSPACE & USER INFO
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(libraryManager.activeLibrary?.name ?? "Select Library")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundColor(.primary)
                            .lineLimit(1)
                        
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundColor(.secondary.opacity(0.7))
                    }
                    
                    Text(authManager.currentUser?.email ?? "\(libraryManager.libraries.count) Libraries")
                        .font(.system(size: 10.5, weight: .medium))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
                
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.primary.opacity(0.038))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(LiquidPalette.borderFaint, lineWidth: 0.9)
            )
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $showingCreateLibrary) { CreateLibrarySheet() }
        .sheet(isPresented: $showingLoginSheet) { LoginView() }
    }
}
