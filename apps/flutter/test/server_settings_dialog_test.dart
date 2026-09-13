import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:stationary/services/api_service.dart';
import 'package:stationary/widgets/server_settings_dialog.dart';
import 'package:stationary/pages/login_page.dart';
import 'package:stationary/pages/home_page.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    final api = ApiService();
    await api.init();
    await api.resetBaseUrl();
  });

  testWidgets('ServerSettingsDialog renders and can change baseUrl', (
    tester,
  ) async {
    final api = ApiService();
    await api.init();

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) {
              return ElevatedButton(
                onPressed: () => ServerSettingsDialog.show(context),
                child: const Text('Open Dialog'),
              );
            },
          ),
        ),
      ),
    );

    // Open dialog
    await tester.tap(find.text('Open Dialog'));
    await tester.pumpAndSettle();

    expect(find.text('Server Settings'), findsOneWidget);
    expect(find.byType(TextField), findsOneWidget);

    // Enter a new server URL
    final input = find.byType(TextField);
    await tester.enterText(input, 'https://stationary.my-nas.lan:9400');
    await tester.pump();

    // Tap Save & Apply
    await tester.tap(find.text('Save & Apply'));
    await tester.pumpAndSettle();

    // Verify baseUrl updated
    expect(api.baseUrl, 'https://stationary.my-nas.lan:9400');
    expect(api.isCustomBaseUrl, isTrue);
  });

  testWidgets(
    'LoginPage shows server indicator and opens ServerSettingsDialog',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(home: LoginPage(onLoginSuccess: () {})),
      );

      await tester.pump();

      // Server icon should be visible in login card
      expect(find.byIcon(LucideIcons.server), findsOneWidget);

      // Tap the server button
      await tester.tap(find.byIcon(LucideIcons.server));
      await tester.pumpAndSettle();

      expect(find.text('Server Settings'), findsOneWidget);
    },
  );

  testWidgets('HomePage Settings tab shows Server Instance card', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: HomePage(isDark: false, onLogout: () {}, onToggleTheme: () {}),
      ),
    );

    await tester.pump();
    Object? initialException;
    do {
      initialException = tester.takeException();
    } while (initialException != null);

    // Switch to Settings tab
    final settingsNav = find.text('Settings');
    expect(settingsNav, findsWidgets);
    await tester.tap(settingsNav.first);
    await tester.pumpAndSettle();

    expect(find.text('Server Instance'), findsOneWidget);
    expect(find.text(ApiService().baseUrl), findsOneWidget);
  });
}
