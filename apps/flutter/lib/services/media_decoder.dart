import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:jxl_coder/jxl_coder.dart';
import 'package:heif_converter/heif_converter.dart';
import 'api_service.dart';

class MediaDecoder {
  static final _apiService = ApiService();

  static bool isHeic(String url) {
    final uri = Uri.tryParse(url);
    if (uri == null) return false;
    final path = uri.path.toLowerCase();
    return path.endsWith('.heic') || path.endsWith('.heif');
  }

  static bool shouldDecodeHeicManually(String url) {
    if (!isHeic(url)) return false;
    if (kIsWeb) return false;
    if (defaultTargetPlatform == TargetPlatform.iOS ||
        defaultTargetPlatform == TargetPlatform.macOS ||
        defaultTargetPlatform == TargetPlatform.android) {
      return false;
    }
    return true;
  }

  static bool isJxl(String url) {
    final uri = Uri.tryParse(url);
    if (uri == null) return false;
    final path = uri.path.toLowerCase();
    return path.endsWith('.jxl');
  }

  static Future<Uint8List> fetchBytes(String url) async {
    final token = _apiService.token;
    final headers = <String, String>{};
    if (token != null) {
      headers['Authorization'] = 'Bearer $token';
    }
    
    // Support relative paths if necessary, otherwise assume absolute
    String absoluteUrl = url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      absoluteUrl = '${_apiService.baseUrl}$url';
    }

    final response = await _apiService.client.get(Uri.parse(absoluteUrl), headers: headers);
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return response.bodyBytes;
    } else {
      throw Exception('Failed to load image from network (status ${response.statusCode})');
    }
  }

  static Future<Uint8List> decodeJxl(Uint8List jxlBytes) async {
    final decoded = await jxlBytesToJpeg(jxlBytes);
    return decoded;
  }

  static Future<Uint8List> decodeHeic(Uint8List heicBytes) async {
    try {
      final tempDir = Directory.systemTemp;
      final tempFile = File('${tempDir.path}/temp_${DateTime.now().microsecondsSinceEpoch}.heic');
      await tempFile.writeAsBytes(heicBytes);
      try {
        final String? jpgPath = await HeifConverter.convert(tempFile.path, format: 'jpg');
        if (jpgPath == null) {
          return heicBytes;
        }
        final jpgFile = File(jpgPath);
        final bytes = await jpgFile.readAsBytes();
        // Clean up
        try {
          await tempFile.delete();
          await jpgFile.delete();
        } catch (_) {}
        return bytes;
      } catch (e) {
        try {
          await tempFile.delete();
        } catch (_) {}
        // Fallback for desktop platforms or when plugin is unavailable (macOS/iOS decode HEIC natively)
        return heicBytes;
      }
    } catch (_) {
      return heicBytes;
    }
  }
}
