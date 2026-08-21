import SwiftUI

@Observable
@MainActor
public final class LibraryManager {
    public static let shared = LibraryManager()
    
    private let activeLibraryStorageKey = "stationary-active-library"
    
    public var libraries: [LibraryItem] = []
    public var activeLibraryId: String? = nil
    public var isLoading: Bool = false
    public var errorMessage: String? = nil
    
    public var activeLibrary: LibraryItem? {
        libraries.first(where: { $0.id == activeLibraryId })
    }
    
    private init() {
        if let storedId = UserDefaults.standard.string(forKey: activeLibraryStorageKey) {
            self.activeLibraryId = storedId
        }
    }
    
    public func loadLibraries() async {
        isLoading = true
        errorMessage = nil
        do {
            let res = try await APIClient.shared.fetchLibraries()
            self.libraries = res.list
            
            // Auto select first library if active library not set or invalid
            if activeLibraryId == nil || !libraries.contains(where: { $0.id == activeLibraryId }) {
                if let firstId = libraries.first?.id {
                    self.setActiveLibrary(id: firstId)
                }
            }
            self.isLoading = false
        } catch {
            self.isLoading = false
            self.errorMessage = error.localizedDescription
        }
    }
    
    public func setActiveLibrary(id: String) {
        self.activeLibraryId = id
        UserDefaults.standard.set(id, forKey: activeLibraryStorageKey)
    }
    
    public func createLibrary(name: String, description: String? = nil) async -> Bool {
        isLoading = true
        errorMessage = nil
        do {
            let newLib = try await APIClient.shared.createLibrary(name: name, description: description)
            self.libraries.append(newLib)
            self.setActiveLibrary(id: newLib.id)
            self.isLoading = false
            return true
        } catch {
            self.isLoading = false
            self.errorMessage = error.localizedDescription
            return false
        }
    }
}
