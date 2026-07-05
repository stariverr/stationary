import 'dart:async';
import 'package:flutter/material.dart';
import 'package:app_links/app_links.dart';
import 'services/api_service.dart';
import 'pages/login_page.dart';
import 'pages/home_page.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Initialize the API Service with stored credentials
  final apiService = ApiService();
  await apiService.init();

  runApp(const MainApp());
}

class MainApp extends StatefulWidget {
  const MainApp({super.key});

  @override
  State<MainApp> createState() => _MainAppState();
}

class _MainAppState extends State<MainApp> {
  final _apiService = ApiService();
  final _appLinks = AppLinks();
  StreamSubscription<Uri>? _linkSubscription;

  bool _isDark = false;
  bool _isAuthenticated = false;
  bool _isInitializing = true;

  @override
  void initState() {
    super.initState();
    _checkAuth();
    _initDeepLinkListener();
  }

  @override
  void dispose() {
    _linkSubscription?.cancel();
    super.dispose();
  }

  void _checkAuth() {
    setState(() {
      _isAuthenticated = _apiService.isAuthenticated;
      _isInitializing = false;
    });
  }

  void _initDeepLinkListener() {
    _linkSubscription = _appLinks.uriLinkStream.listen(
      (uri) async {
        debugPrint(
          '[Deep Link Received] Scheme: ${uri.scheme}, Host: ${uri.host}, Query: ${uri.queryParameters}',
        );
        if (uri.scheme == 'stationary' && uri.host == 'auth') {
          final token = uri.queryParameters['token'];
          if (token != null && token.isNotEmpty) {
            await _apiService.saveToken(token);
            setState(() {
              _isAuthenticated = true;
            });
          }
        }
      },
      onError: (err) {
        debugPrint('[Deep Link Error] $err');
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    // Premium Minimalist Light Theme (matching apps/web exactly)
    final lightTheme = ThemeData(
      brightness: Brightness.light,
      useMaterial3: true,
      scaffoldBackgroundColor: const Color(0xFFFFFFFF),
      dividerColor: const Color(0xFFE5E5E5),
      shadowColor: Colors.transparent,
      colorScheme: const ColorScheme.light(
        primary: Color(0xFF151C27),
        onPrimary: Color(0xFFFFFFFF),
        surface: Color(0xFFFFFFFF),
        onSurface: Color(0xFF151C27),
        surfaceContainerHighest: Color(0xFFF6F6F6),
        onSurfaceVariant: Color(0xFF606060),
        outline: Color(0xFFE5E5E5),
        outlineVariant: Color(0xFFE5E5E5),
        error: Color(0xFFEF4444),
        onError: Color(0xFFFFFFFF),
      ),
      appBarTheme: const AppBarTheme(
        elevation: 0,
        scrolledUnderElevation: 0,
        backgroundColor: Color(0xFFFFFFFF),
        foregroundColor: Color(0xFF151C27),
        surfaceTintColor: Colors.transparent,
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        color: const Color(0xFFFFFFFF),
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          side: const BorderSide(color: Color(0xFFE5E5E5), width: 1.0),
          borderRadius: BorderRadius.circular(8),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: const Color(0xFFFFFFFF),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 14,
          vertical: 12,
        ),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(6),
          borderSide: const BorderSide(color: Color(0xFFE5E5E5), width: 1.0),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(6),
          borderSide: const BorderSide(color: Color(0xFFE5E5E5), width: 1.0),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(6),
          borderSide: const BorderSide(color: Color(0xFF151C27), width: 1.5),
        ),
        labelStyle: const TextStyle(color: Color(0xFF606060), fontSize: 14),
        hintStyle: const TextStyle(color: Color(0xFF808080), fontSize: 14),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          elevation: 0,
          backgroundColor: const Color(0xFF151C27),
          foregroundColor: const Color(0xFFFFFFFF),
          minimumSize: const Size(64, 44),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          elevation: 0,
          foregroundColor: const Color(0xFF151C27),
          side: const BorderSide(color: Color(0xFFE5E5E5), width: 1.0),
          minimumSize: const Size(64, 44),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
        ),
      ),
      dialogTheme: DialogThemeData(
        elevation: 0,
        backgroundColor: const Color(0xFFFFFFFF),
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          side: const BorderSide(color: Color(0xFFE5E5E5), width: 1.0),
          borderRadius: BorderRadius.circular(10),
        ),
      ),
    );

    // Premium Minimalist Dark Theme (shadcn/ui style matching dark mode variables)
    final darkTheme = ThemeData(
      brightness: Brightness.dark,
      useMaterial3: true,
      scaffoldBackgroundColor: const Color(0xFF09090B),
      dividerColor: const Color(0xFF27272A),
      shadowColor: Colors.transparent,
      colorScheme: const ColorScheme.dark(
        primary: Color(0xFFFAFAFA),
        onPrimary: Color(0xFF09090B),
        surface: Color(0xFF09090B),
        onSurface: Color(0xFFFAFAFA),
        surfaceContainerHighest: Color(0xFF18181B),
        onSurfaceVariant: Color(0xFFA1A1AA),
        outline: Color(0xFF27272A),
        outlineVariant: Color(0xFF27272A),
        error: Color(0xFFEF4444),
        onError: Color(0xFFFFFFFF),
      ),
      appBarTheme: const AppBarTheme(
        elevation: 0,
        scrolledUnderElevation: 0,
        backgroundColor: Color(0xFF09090B),
        foregroundColor: Color(0xFFFAFAFA),
        surfaceTintColor: Colors.transparent,
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        color: const Color(0xFF18181B),
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          side: const BorderSide(color: Color(0xFF27272A), width: 1.0),
          borderRadius: BorderRadius.circular(8),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: const Color(0xFF18181B),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 14,
          vertical: 12,
        ),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(6),
          borderSide: const BorderSide(color: Color(0xFF27272A), width: 1.0),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(6),
          borderSide: const BorderSide(color: Color(0xFF27272A), width: 1.0),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(6),
          borderSide: const BorderSide(color: Color(0xFFFAFAFA), width: 1.5),
        ),
        labelStyle: const TextStyle(color: Color(0xFFA1A1AA), fontSize: 14),
        hintStyle: const TextStyle(color: Color(0xFF71717A), fontSize: 14),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          elevation: 0,
          backgroundColor: const Color(0xFFFAFAFA),
          foregroundColor: const Color(0xFF09090B),
          minimumSize: const Size(64, 44),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          elevation: 0,
          foregroundColor: const Color(0xFFFAFAFA),
          side: const BorderSide(color: Color(0xFF27272A), width: 1.0),
          minimumSize: const Size(64, 44),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
        ),
      ),
      dialogTheme: DialogThemeData(
        elevation: 0,
        backgroundColor: const Color(0xFF09090B),
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          side: const BorderSide(color: Color(0xFF27272A), width: 1.0),
          borderRadius: BorderRadius.circular(10),
        ),
      ),
    );

    return MaterialApp(
      debugShowCheckedModeBanner: false,
      themeMode: _isDark ? ThemeMode.dark : ThemeMode.light,
      theme: lightTheme,
      darkTheme: darkTheme,
      home: _isInitializing
          ? const Scaffold(body: Center(child: CircularProgressIndicator()))
          : _isAuthenticated
          ? HomePage(
              isDark: _isDark,
              onToggleTheme: () {
                setState(() {
                  _isDark = !_isDark;
                });
              },
              onLogout: () {
                setState(() {
                  _isAuthenticated = false;
                });
              },
            )
          : LoginPage(
              onLoginSuccess: () {
                setState(() {
                  _isAuthenticated = true;
                });
              },
            ),
    );
  }
}
