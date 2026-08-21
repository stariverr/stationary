import SwiftUI

public struct LoginView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var isSignUpMode = false
    
    @State private var emailInput: String = ""
    @State private var passwordInput: String = ""
    @State private var nameInput: String = ""
    @State private var captchaToken: String? = nil
    
    @State private var turnstileSiteKey: String = "1x00000000000000000000BB" // Official CF Turnstile pass test key
    @State private var authManager = AuthManager.shared
    
    public init() {}
    
    public var body: some View {
        VStack(spacing: 18) {
            // Header Logo & Title
            VStack(spacing: 6) {
                Image(systemName: "lock.shield")
                    .font(.system(size: 38))
                    .foregroundColor(.accentColor)
                
                Text(isSignUpMode ? "Create Account" : "Sign In to Stationary")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundColor(.primary)
            }
            .padding(.top, 12)
            
            // Account Mode Segmented Control
            Picker("Account Mode", selection: $isSignUpMode) {
                Text("Sign In").tag(false)
                Text("Sign Up").tag(true)
            }
            .pickerStyle(.segmented)
            
            // Input Fields
            VStack(spacing: 10) {
                if isSignUpMode {
                    HStack(spacing: 8) {
                        Image(systemName: "person")
                            .font(.system(size: 13))
                            .foregroundColor(.secondary)
                        TextField("Full Name", text: $nameInput)
                            .font(.system(size: 13))
                            .textFieldStyle(.plain)
                    }
                    .padding(11)
                    .background(Color.primary.opacity(0.035))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Color.primary.opacity(0.08), lineWidth: 1))
                }
                
                HStack(spacing: 8) {
                    Image(systemName: "envelope")
                        .font(.system(size: 13))
                        .foregroundColor(.secondary)
                    TextField("Email Address", text: $emailInput)
                        .font(.system(size: 13))
                        .textFieldStyle(.plain)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        #endif
                }
                .padding(11)
                .background(Color.primary.opacity(0.035))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Color.primary.opacity(0.08), lineWidth: 1))
                
                HStack(spacing: 8) {
                    Image(systemName: "key")
                        .font(.system(size: 13))
                        .foregroundColor(.secondary)
                    SecureField("Password", text: $passwordInput)
                        .font(.system(size: 13))
                        .textFieldStyle(.plain)
                }
                .padding(11)
                .background(Color.primary.opacity(0.035))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Color.primary.opacity(0.08), lineWidth: 1))
            }
            
            // Inline Cloudflare Turnstile Captcha Widget
            VStack(spacing: 4) {
                TurnstileWebView(siteKey: turnstileSiteKey) { token in
                    self.captchaToken = token
                }
                .frame(height: 65)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                
                if let _ = captchaToken {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.green)
                        Text("Turnstile Security Verified")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
            }
            
            // Error Alert Banner
            if let error = authManager.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundColor(.red)
                    .multilineTextAlignment(.center)
            }
            
            // Submit Action Button
            Button {
                performAuth()
            } label: {
                HStack {
                    if authManager.isLoading {
                        ProgressView().tint(.white)
                    } else {
                        Text(isSignUpMode ? "Create Account" : "Sign In")
                            .font(.system(size: 14, weight: .bold))
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            }
            .liquidGlassButton(isSelected: true)
            .disabled(authManager.isLoading || emailInput.isEmpty || passwordInput.isEmpty)
            
            // Cancel Button
            Button("Cancel") {
                dismiss()
            }
            .font(.subheadline)
            .foregroundColor(.secondary)
            .tactileIconButton()
        }
        .padding(26)
        .frame(width: 360)
        .background(.regularMaterial)
    }
    
    private func performAuth() {
        Task {
            let success: Bool
            if isSignUpMode {
                success = await authManager.signUp(email: emailInput, password: passwordInput, name: nameInput, captcha: captchaToken)
            } else {
                success = await authManager.signIn(email: emailInput, password: passwordInput, captcha: captchaToken)
            }
            if success {
                dismiss()
            }
        }
    }
}
