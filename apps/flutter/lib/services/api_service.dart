import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../models.dart';

class ApiService {
  static final ApiService _instance = ApiService._internal();
  factory ApiService() => _instance;
  ApiService._internal();

  static const String _tokenKey = 'stationary_session_token';
  static const String _activeLibraryKey = 'stationary_active_library_id';
  static const String _serverUrlKey = 'stationary_server_url';

  String? _token;
  String? _customBaseUrl;

  late final ValueNotifier<String> baseUrlNotifier = ValueNotifier<String>(
    baseUrl,
  );

  String get defaultBaseUrl {
    if (kIsWeb) {
      return Uri.base.origin.contains('localhost')
          ? 'http://localhost:9400'
          : Uri.base.origin;
    }
    if (defaultTargetPlatform == TargetPlatform.android) {
      return 'http://10.0.2.2:9400';
    }
    return 'http://localhost:9400'; // iOS Simulator / macOS desktop / etc.
  }

  String get baseUrl => (_customBaseUrl != null && _customBaseUrl!.isNotEmpty)
      ? _customBaseUrl!
      : defaultBaseUrl;

  bool get isCustomBaseUrl =>
      _customBaseUrl != null && _customBaseUrl!.isNotEmpty;

  static String normalizeUrl(String input) {
    var trimmed = input.trim();
    if (trimmed.isEmpty) return '';
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      trimmed = 'http://$trimmed';
    }
    while (trimmed.endsWith('/')) {
      trimmed = trimmed.substring(0, trimmed.length - 1);
    }
    return trimmed;
  }

  final http.Client _client = http.Client();

  http.Client get client => _client;

  Future<void> init() async {
    final prefs = await SharedPreferences.getInstance();
    _token = prefs.getString(_tokenKey);
    _customBaseUrl = prefs.getString(_serverUrlKey);
    baseUrlNotifier.value = baseUrl;
  }

  Future<void> setBaseUrl(String? url) async {
    final prefs = await SharedPreferences.getInstance();
    if (url == null || url.trim().isEmpty) {
      _customBaseUrl = null;
      await prefs.remove(_serverUrlKey);
    } else {
      final normalized = normalizeUrl(url);
      _customBaseUrl = normalized;
      await prefs.setString(_serverUrlKey, normalized);
    }
    baseUrlNotifier.value = baseUrl;
  }

  Future<void> resetBaseUrl() async {
    await setBaseUrl(null);
  }

  Future<Duration> testConnection([String? targetUrl]) async {
    final urlToTest = (targetUrl != null && targetUrl.trim().isNotEmpty)
        ? normalizeUrl(targetUrl)
        : baseUrl;

    final uri = Uri.parse(urlToTest);
    final stopwatch = Stopwatch()..start();
    try {
      final response = await _client
          .get(uri)
          .timeout(const Duration(seconds: 5));
      stopwatch.stop();
      if (response.statusCode < 500) {
        return stopwatch.elapsed;
      } else {
        throw Exception('Server returned error status: ${response.statusCode}');
      }
    } catch (e) {
      stopwatch.stop();
      if (e is TimeoutException) {
        throw Exception('Connection timed out after 5 seconds');
      }
      throw Exception(
        'Cannot connect to server: ${e.toString().replaceAll('Exception: ', '')}',
      );
    }
  }

  bool get isAuthenticated => _token != null;

  String? get token => _token;

  Future<void> saveToken(String token) async {
    _token = token;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_tokenKey, token);
  }

  Future<void> clearAuth() async {
    _token = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_tokenKey);
    await prefs.remove(_activeLibraryKey);
  }

  Future<String?> getActiveLibraryId() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_activeLibraryKey);
  }

  Future<void> setActiveLibraryId(String libraryId) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_activeLibraryKey, libraryId);
  }

  Map<String, String> get _headers {
    final headers = <String, String>{'Content-Type': 'application/json'};
    if (_token != null) {
      headers['Authorization'] = 'Bearer $_token';
    }
    return headers;
  }

  // --- Auth API ---

  Future<String> getSocialLoginUrl(String provider, String callbackUrl) async {
    final response = await _client.post(
      Uri.parse('$baseUrl/api/auth/sign-in/social'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'provider': provider, 'callbackURL': callbackUrl}),
    );

    if (response.statusCode == 200) {
      final json = jsonDecode(response.body) as Map<String, dynamic>;
      return json['url'] as String;
    } else {
      final json = jsonDecode(response.body) as Map<String, dynamic>;
      throw Exception(json['message'] ?? 'Failed to initiate social login.');
    }
  }

  Future<void> login(
    String email,
    String password, {
    String? captchaToken,
  }) async {
    final headers = <String, String>{
      'Content-Type': 'application/json',
      'x-captcha-response': captchaToken ?? '1x00000000000000000000AA',
    };
    final response = await _client.post(
      Uri.parse('$baseUrl/api/auth/sign-in/email'),
      headers: headers,
      body: jsonEncode({'email': email, 'password': password}),
    );

    if (response.statusCode == 200) {
      final json = jsonDecode(response.body) as Map<String, dynamic>;
      final sessionToken =
          (json['token'] ?? json['session']?['token']) as String;
      await saveToken(sessionToken);
    } else {
      _parseAndThrowAuthError(response);
    }
  }

  Future<void> signUp(
    String email,
    String password,
    String name, {
    String? captchaToken,
  }) async {
    final headers = <String, String>{
      'Content-Type': 'application/json',
      'x-captcha-response': captchaToken ?? '1x00000000000000000000AA',
    };
    final response = await _client.post(
      Uri.parse('$baseUrl/api/auth/sign-up/email'),
      headers: headers,
      body: jsonEncode({'email': email, 'password': password, 'name': name}),
    );

    if (response.statusCode == 200) {
      final json = jsonDecode(response.body) as Map<String, dynamic>;
      final sessionToken =
          (json['token'] ?? json['session']?['token']) as String;
      await saveToken(sessionToken);
    } else {
      _parseAndThrowAuthError(response);
    }
  }

  void _parseAndThrowAuthError(http.Response response) {
    try {
      final json = jsonDecode(response.body) as Map<String, dynamic>;
      throw Exception(json['message'] ?? 'Authentication failed');
    } catch (e) {
      if (e is Exception) rethrow;
      throw Exception('Request failed with status code ${response.statusCode}');
    }
  }

  // --- Library API ---

  Future<List<LibraryItem>> fetchLibraries() async {
    final response = await _client.get(
      Uri.parse('$baseUrl/api/library/list?page=1&count=50'),
      headers: _headers,
    );

    final json = _handleEnvelopeResponse(response);
    final list = json['data']['list'] as List;
    return list
        .map((l) => LibraryItem.fromJson(l as Map<String, dynamic>))
        .toList();
  }

  Future<LibraryItem> createLibrary(
    String name, [
    String description = '',
  ]) async {
    final response = await _client.post(
      Uri.parse('$baseUrl/api/library/create'),
      headers: _headers,
      body: jsonEncode({'name': name, 'description': description}),
    );

    final json = _handleEnvelopeResponse(response);
    return LibraryItem.fromJson(json['data'] as Map<String, dynamic>);
  }

  // --- Post API ---

  Future<PostListResult> fetchPosts(
    String libraryId, {
    String? keyword,
    String? source,
    String? sortBy,
    String? sortOrder,
    int page = 1,
    int count = 20,
    List<String>? authorIds,
    List<String>? tagIds,
    String? mediaType,
  }) async {
    final queryParams = <String, String>{
      'library_id': libraryId,
      'page': page.toString(),
      'count': count.toString(),
      if (keyword != null && keyword.isNotEmpty) 'keyword': keyword,
      if (source != null && source.isNotEmpty) 'source': source,
      if (sortBy != null && sortBy.isNotEmpty) 'sort_by': sortBy,
      if (sortOrder != null && sortOrder.isNotEmpty) 'sort_order': sortOrder,
      if (authorIds != null && authorIds.isNotEmpty)
        'author_ids': authorIds.join(','),
      if (tagIds != null && tagIds.isNotEmpty) 'tag_ids': tagIds.join(','),
      if (mediaType != null && mediaType.isNotEmpty) 'media_type': mediaType,
    };
    final uri = Uri.parse(
      '$baseUrl/api/post/list',
    ).replace(queryParameters: queryParams);

    final response = await _client.get(uri, headers: _headers);
    final json = _handleEnvelopeResponse(response);

    final total = json['data']['total'] as int? ?? 0;
    final list = json['data']['list'] as List? ?? [];

    final posts = list
        .map((p) => PostListItem.fromJson(Map<String, dynamic>.from(p as Map)))
        .toList();

    return PostListResult(posts: posts, total: total);
  }

  Future<Post> fetchPostDetail(String postId) async {
    // Fetch post detail and post media concurrently in parallel
    final detailFuture = _client.get(
      Uri.parse('$baseUrl/api/post/detail/$postId'),
      headers: _headers,
    );
    final mediaFuture = _client.get(
      Uri.parse('$baseUrl/api/post/$postId/media?page=1&limit=100'),
      headers: _headers,
    );

    final results = await Future.wait([detailFuture, mediaFuture]);
    final response = results[0];
    final mediaResponse = results[1];

    final json = _handleEnvelopeResponse(response);
    final postJson = Map<String, dynamic>.from(json['data'] as Map);

    try {
      if (mediaResponse.statusCode >= 200 && mediaResponse.statusCode < 300) {
        final mediaJson = _handleEnvelopeResponse(mediaResponse);
        final mediaData = mediaJson['data'];
        if (mediaData is Map && mediaData['list'] is List) {
          postJson['media'] = mediaData['list'];
        }
      }
    } catch (_) {}

    return Post.fromJson(postJson);
  }

  Future<List<Media>> fetchPostMedia(
    String postId, {
    int page = 1,
    int limit = 50,
  }) async {
    final response = await _client.get(
      Uri.parse('$baseUrl/api/post/$postId/media?page=$page&limit=$limit'),
      headers: _headers,
    );

    final json = _handleEnvelopeResponse(response);
    final list = json['data']?['list'] as List? ?? [];
    return list
        .map((m) => Media.fromJson(Map<String, dynamic>.from(m as Map)))
        .toList();
  }

  Future<List<Author>> fetchAuthors(
    String libraryId, {
    String? keyword,
    String? platform,
  }) async {
    final uri = Uri.parse('$baseUrl/api/post/authors').replace(
      queryParameters: {
        'library_id': libraryId,
        if (keyword != null && keyword.isNotEmpty) 'keyword': keyword,
        if (platform != null && platform.isNotEmpty) 'platform': platform,
      },
    );

    final response = await _client.get(uri, headers: _headers);
    final json = _handleEnvelopeResponse(response);
    final list = json['data'] as List? ?? [];
    return list
        .map((a) => Author.fromJson(Map<String, dynamic>.from(a as Map)))
        .toList();
  }

  Future<List<TagItem>> fetchTags(String libraryId) async {
    final uri = Uri.parse(
      '$baseUrl/api/tag/list',
    ).replace(queryParameters: {'library_id': libraryId});

    final response = await _client.get(uri, headers: _headers);
    final json = _handleEnvelopeResponse(response);
    final list = json['data'] as List? ?? [];
    return list
        .map((t) => TagItem.fromJson(Map<String, dynamic>.from(t as Map)))
        .toList();
  }

  // --- Utility ---

  Map<String, dynamic> _handleEnvelopeResponse(http.Response response) {
    if (response.statusCode >= 200 && response.statusCode < 300) {
      final json = jsonDecode(response.body) as Map<String, dynamic>;
      if (json['success'] == true) {
        return json;
      } else {
        throw Exception(json['message'] ?? 'API operation failed');
      }
    } else if (response.statusCode == 401) {
      clearAuth();
      throw Exception('Session expired, please log in again.');
    } else {
      throw Exception('Server error (${response.statusCode})');
    }
  }
}
