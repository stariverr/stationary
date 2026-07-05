import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../services/api_service.dart';

class LoginPage extends StatefulWidget {
  final VoidCallback onLoginSuccess;

  const LoginPage({super.key, required this.onLoginSuccess});

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _apiService = ApiService();
  bool _isLogin = true;
  bool _isLoading = false;
  String? _errorMessage;

  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  final _nameController = TextEditingController();

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    _nameController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final email = _emailController.text.trim();
    final password = _passwordController.text.trim();
    final name = _nameController.text.trim();

    if (email.isEmpty || password.isEmpty || (!_isLogin && name.isEmpty)) {
      setState(() {
        _errorMessage = 'Please fill out all fields.';
      });
      return;
    }

    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    try {
      if (_isLogin) {
        await _apiService.login(email, password);
      } else {
        await _apiService.signUp(email, password, name);
      }
      widget.onLoginSuccess();
    } catch (e) {
      setState(() {
        _errorMessage = e.toString().replaceAll('Exception: ', '');
      });
    } finally {
      setState(() {
        _isLoading = false;
      });
    }
  }

  Future<void> _loginSocial(String provider) async {
    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    try {
      final callbackUrl = '${_apiService.baseUrl}/api/auth/mobile-callback';
      final authUrl =
          '${_apiService.baseUrl}/api/auth/login/social/$provider?callbackURL=${Uri.encodeComponent(callbackUrl)}';

      final uri = Uri.parse(authUrl);
      if (await canLaunchUrl(uri)) {
        await launchUrl(uri, mode: LaunchMode.externalApplication);
      } else {
        throw Exception('Could not launch browser for social sign in.');
      }
    } catch (e) {
      setState(() {
        _errorMessage = e.toString().replaceAll('Exception: ', '');
      });
    } finally {
      setState(() {
        _isLoading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDark = theme.brightness == Brightness.dark;

    // Viewport backgrounds matching Nuxt app
    final viewportBg = isDark
        ? const Color(0xFF09090B)
        : const Color(0xFFF9FAFB);
    final cardBg = isDark ? const Color(0xFF18181B) : const Color(0xFFFFFFFF);
    final cardBorder = isDark
        ? const Color(0xFF27272A)
        : const Color(0xFFF3F4F6);
    final footerBg = isDark ? const Color(0xFF09090B) : const Color(0xFFF9FAFB);
    final textGray = isDark ? const Color(0xFFA1A1AA) : const Color(0xFF6B7280);

    return Scaffold(
      backgroundColor: viewportBg,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24.0),
            child: Container(
              width: double.infinity,
              constraints: const BoxConstraints(maxWidth: 400),
              decoration: BoxDecoration(
                color: cardBg,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: cardBorder),
                boxShadow: [
                  BoxShadow(
                    color: isDark
                        ? Colors.black.withValues(alpha: 0.3)
                        : Colors.black.withValues(alpha: 0.05),
                    blurRadius: 20,
                    offset: const Offset(0, 8),
                  ),
                ],
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // Inner content (Web aligned p-8)
                  Padding(
                    padding: const EdgeInsets.all(32.0),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.center,
                      children: [
                        // Web 64x64 Logo Replica
                        Container(
                          width: 64,
                          height: 64,
                          decoration: BoxDecoration(
                            color: Colors.black,
                            borderRadius: BorderRadius.circular(16),
                            boxShadow: [
                              BoxShadow(
                                color: Colors.black.withValues(alpha: 0.15),
                                blurRadius: 12,
                                offset: const Offset(0, 4),
                              ),
                            ],
                          ),
                          child: Center(
                            child: Container(
                              width: 28,
                              height: 28,
                              decoration: const BoxDecoration(
                                color: Colors.white,
                                shape: BoxShape.circle,
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(height: 24),
                        Text(
                          _isLogin ? 'Welcome Back' : 'Create Account',
                          style: TextStyle(
                            fontSize: 22,
                            fontWeight: FontWeight.bold,
                            color: isDark
                                ? const Color(0xFFFAFAFA)
                                : const Color(0xFF111827),
                          ),
                          textAlign: TextAlign.center,
                        ),
                        const SizedBox(height: 6),
                        Text(
                          _isLogin
                              ? 'Sign in to your account to continue'
                              : 'Register to start managing your tags and libraries',
                          style: TextStyle(color: textGray, fontSize: 14),
                          textAlign: TextAlign.center,
                        ),
                        const SizedBox(height: 32),

                        // Error Alert
                        if (_errorMessage != null) ...[
                          Container(
                            decoration: BoxDecoration(
                              color: theme.colorScheme.error.withValues(
                                alpha: 0.08,
                              ),
                              border: Border.all(
                                color: theme.colorScheme.error.withValues(
                                  alpha: 0.3,
                                ),
                              ),
                              borderRadius: BorderRadius.circular(8),
                            ),
                            padding: const EdgeInsets.all(12.0),
                            child: Row(
                              children: [
                                Icon(
                                  LucideIcons.alertTriangle,
                                  color: theme.colorScheme.error,
                                  size: 18,
                                ),
                                const SizedBox(width: 10),
                                Expanded(
                                  child: Text(
                                    _errorMessage!,
                                    style: TextStyle(
                                      color: theme.colorScheme.error,
                                      fontSize: 13,
                                      fontWeight: FontWeight.w500,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(height: 20),
                        ],

                        // Inputs (Local Dev Fields)
                        if (!_isLogin) ...[
                          TextField(
                            controller: _nameController,
                            decoration: const InputDecoration(
                              labelText: 'Full Name',
                              hintText: 'John Doe',
                            ),
                          ),
                          const SizedBox(height: 16),
                        ],
                        TextField(
                          controller: _emailController,
                          decoration: const InputDecoration(
                            labelText: 'Email Address',
                            hintText: 'name@example.com',
                          ),
                          keyboardType: TextInputType.emailAddress,
                        ),
                        const SizedBox(height: 16),
                        TextField(
                          controller: _passwordController,
                          decoration: const InputDecoration(
                            labelText: 'Password',
                            hintText: '••••••••',
                          ),
                          obscureText: true,
                        ),
                        const SizedBox(height: 24),

                        // Login Action Button (Flat layout)
                        ElevatedButton(
                          onPressed: _isLoading ? null : _submit,
                          style: ElevatedButton.styleFrom(
                            backgroundColor: isDark
                                ? const Color(0xFFFAFAFA)
                                : const Color(0xFF151C27),
                            foregroundColor: isDark
                                ? const Color(0xFF09090B)
                                : const Color(0xFFFFFFFF),
                            minimumSize: const Size.fromHeight(48),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(12),
                            ),
                          ),
                          child: _isLoading
                              ? SizedBox(
                                  width: 20,
                                  height: 20,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    valueColor: AlwaysStoppedAnimation(
                                      isDark
                                          ? const Color(0xFF09090B)
                                          : Colors.white,
                                    ),
                                  ),
                                )
                              : Text(_isLogin ? 'Sign In' : 'Sign Up'),
                        ),

                        // Divider OR
                        const SizedBox(height: 20),
                        Row(
                          children: [
                            Expanded(child: Divider(color: cardBorder)),
                            Padding(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 10.0,
                              ),
                              child: Text(
                                'OR',
                                style: TextStyle(
                                  fontSize: 11,
                                  fontWeight: FontWeight.bold,
                                  color: textGray,
                                ),
                              ),
                            ),
                            Expanded(child: Divider(color: cardBorder)),
                          ],
                        ),
                        const SizedBox(height: 20),

                        // Social GitHub Button
                        SizedBox(
                          height: 48,
                          child: ElevatedButton.icon(
                            onPressed: _isLoading
                                ? null
                                : () => _loginSocial('github'),
                            icon: const Icon(
                              LucideIcons.code,
                              color: Colors.white,
                              size: 18,
                            ),
                            label: const Text(
                              'Continue with GitHub',
                              style: TextStyle(fontWeight: FontWeight.w500),
                            ),
                            style: ElevatedButton.styleFrom(
                              backgroundColor: Colors.black,
                              foregroundColor: Colors.white,
                              elevation: 0,
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(12),
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(height: 12),

                        // Social Google Button
                        SizedBox(
                          height: 48,
                          child: OutlinedButton.icon(
                            onPressed: _isLoading
                                ? null
                                : () => _loginSocial('google'),
                            icon: const Icon(
                              LucideIcons.mail,
                              color: Color(0xFFEF4444),
                              size: 18,
                            ),
                            label: Text(
                              'Continue with Google',
                              style: TextStyle(
                                color: isDark
                                    ? const Color(0xFFFAFAFA)
                                    : const Color(0xFF374151),
                                fontWeight: FontWeight.w500,
                              ),
                            ),
                            style: OutlinedButton.styleFrom(
                              backgroundColor: cardBg,
                              side: BorderSide(color: cardBorder),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(12),
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),

                  // Footer Section (Web aligned bg-gray-50)
                  Container(
                    decoration: BoxDecoration(
                      color: footerBg,
                      border: Border(top: BorderSide(color: cardBorder)),
                      borderRadius: const BorderRadius.only(
                        bottomLeft: Radius.circular(16),
                        bottomRight: Radius.circular(16),
                      ),
                    ),
                    padding: const EdgeInsets.symmetric(
                      horizontal: 24.0,
                      vertical: 20.0,
                    ),
                    child: Column(
                      children: [
                        Text(
                          'By continuing, you agree to our Terms and Privacy Policy.',
                          style: TextStyle(
                            fontSize: 12,
                            color: textGray,
                            height: 1.4,
                          ),
                          textAlign: TextAlign.center,
                        ),
                        const SizedBox(height: 12),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Text(
                              _isLogin
                                  ? "Don't have an account? "
                                  : 'Already have an account? ',
                              style: TextStyle(color: textGray, fontSize: 13),
                            ),
                            GestureDetector(
                              onTap: () {
                                setState(() {
                                  _isLogin = !_isLogin;
                                  _errorMessage = null;
                                });
                              },
                              child: Text(
                                _isLogin ? 'Sign Up' : 'Sign In',
                                style: TextStyle(
                                  color: isDark
                                      ? const Color(0xFFFAFAFA)
                                      : const Color(0xFF111827),
                                  fontSize: 13,
                                  fontWeight: FontWeight.bold,
                                  decoration: TextDecoration.underline,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
