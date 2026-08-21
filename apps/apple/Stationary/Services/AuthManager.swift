import SwiftUI

@Observable
@MainActor
public final class AuthManager {
    public static let shared = AuthManager()
    
    private let tokenStorageKey = "stationary-session-token"
    
    public var currentUser: User? = nil
    public var sessionToken: String? = nil {
        didSet {
            APIClient.shared.sessionToken = sessionToken
            if let token = sessionToken {
                UserDefaults.standard.set(token, forKey: tokenStorageKey)
            } else {
                UserDefaults.standard.removeObject(forKey: tokenStorageKey)
            }
        }
    }
    
    public var isAuthenticated: Bool {
        currentUser != nil || sessionToken != nil
    }
    
    public var isLoading: Bool = false
    public var errorMessage: String? = nil
    
    private init() {
        if let storedToken = UserDefaults.standard.string(forKey: tokenStorageKey) {
            self.sessionToken = storedToken
            APIClient.shared.sessionToken = storedToken
        }
    }
    
    public func restoreSession() async {
        guard sessionToken != nil else { return }
        isLoading = true
        do {
            let profile = try await APIClient.shared.fetchCurrentUser()
            self.currentUser = profile
            self.isLoading = false
        } catch {
            print("Session restoration failed: \(error)")
            self.isLoading = false
        }
    }
    
    public func signIn(email: String, password: String, captcha: String? = nil) async -> Bool {
        isLoading = true
        errorMessage = nil
        do {
            let token = try await APIClient.shared.signIn(email: email, password: password, captcha: captcha)
            self.sessionToken = token
            await restoreSession()
            self.isLoading = false
            return true
        } catch {
            self.isLoading = false
            self.errorMessage = error.localizedDescription
            return false
        }
    }
    
    public func signUp(email: String, password: String, name: String, captcha: String? = nil) async -> Bool {
        isLoading = true
        errorMessage = nil
        do {
            let token = try await APIClient.shared.signUp(email: email, password: password, name: name, captcha: captcha)
            self.sessionToken = token
            await restoreSession()
            self.isLoading = false
            return true
        } catch {
            self.isLoading = false
            self.errorMessage = error.localizedDescription
            return false
        }
    }
    
    public func signOut() async {
        isLoading = true
        try? await APIClient.shared.signOut()
        self.currentUser = nil
        self.sessionToken = nil
        self.isLoading = false
    }
}
