import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:stationary/services/api_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('ApiService Server URL', () {
    setUp(() {
      SharedPreferences.setMockInitialValues({});
    });

    test('normalizeUrl handles various inputs correctly', () {
      expect(ApiService.normalizeUrl(''), '');
      expect(ApiService.normalizeUrl('   '), '');
      expect(
        ApiService.normalizeUrl('http://192.168.1.100:9400/'),
        'http://192.168.1.100:9400',
      );
      expect(
        ApiService.normalizeUrl('https://my-stationary.internal///'),
        'https://my-stationary.internal',
      );
      expect(
        ApiService.normalizeUrl('192.168.1.50:9400'),
        'http://192.168.1.50:9400',
      );
      expect(
        ApiService.normalizeUrl('  https://stationary.example.com/  '),
        'https://stationary.example.com',
      );
    });

    test('setBaseUrl and resetBaseUrl update state and persistence', () async {
      final api = ApiService();
      await api.init();

      final defaultUrl = api.defaultBaseUrl;
      expect(api.baseUrl, defaultUrl);
      expect(api.isCustomBaseUrl, isFalse);

      // Set custom base url
      String? notifiedValue;
      api.baseUrlNotifier.addListener(() {
        notifiedValue = api.baseUrlNotifier.value;
      });

      await api.setBaseUrl('http://nas.local:9400/');
      expect(api.baseUrl, 'http://nas.local:9400');
      expect(api.isCustomBaseUrl, isTrue);
      expect(notifiedValue, 'http://nas.local:9400');

      // Verify persistence by creating a fresh check
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('stationary_server_url'), 'http://nas.local:9400');

      // Reset
      await api.resetBaseUrl();
      expect(api.baseUrl, defaultUrl);
      expect(api.isCustomBaseUrl, isFalse);
      expect(prefs.getString('stationary_server_url'), isNull);
    });
  });
}
