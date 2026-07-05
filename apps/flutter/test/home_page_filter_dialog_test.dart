import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:stationary/pages/home_page.dart';

void main() {
  testWidgets('filter dialog opens without layout exceptions', (tester) async {
    SharedPreferences.setMockInitialValues({});
    await tester.binding.setSurfaceSize(const Size(700, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final theme = ThemeData(
      useMaterial3: true,
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(minimumSize: const Size.fromHeight(44)),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(44)),
      ),
    );

    await tester.pumpWidget(
      MaterialApp(
        theme: theme,
        home: HomePage(isDark: false, onLogout: () {}, onToggleTheme: () {}),
      ),
    );

    await tester.pump();
    Object? initialException;
    do {
      initialException = tester.takeException();
    } while (initialException != null);

    await tester.tap(find.byIcon(LucideIcons.filter));
    await tester.pump();

    expect(tester.takeException(), isNull);
    expect(find.text('Filter & Sort Posts'), findsOneWidget);
  });
}
