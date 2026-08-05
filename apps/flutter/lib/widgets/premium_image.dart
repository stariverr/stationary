import 'package:flutter/material.dart';
import 'dart:typed_data';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../services/media_decoder.dart';
import '../services/api_service.dart';

/// A high-performance, seamless media image viewer widget.
///
/// **Best Practice Patterns Enforced:**
/// 1. **Frame 0 Instant Painting**: When [placeholderUrl] (e.g. list cover URL) is provided,
///    it is rendered synchronously on Frame 0 via Flutter's `imageCache` matching with 0ms latency.
/// 2. **Dual-Layer Stack Architecture**: Keeps [placeholderUrl] / previous image rendered
///    at 100% opacity in the bottom layer of a [Stack], ensuring zero black/white flashes
///    while a higher-resolution [imageUrl] is being fetched over HTTP.
/// 3. **Smooth Cross-Fade Dissolve**: Uses [AnimatedOpacity] inside [Image.network]'s `frameBuilder`
///    to smoothly dissolve the high-resolution image over the placeholder image (250ms `Curves.easeOut`).
class PremiumImage extends StatefulWidget {
  /// Target image URL (supports standard formats, HEIC, and JPEG XL / JXL).
  final String imageUrl;

  /// Optional cover/thumbnail placeholder URL passed from list view for 0ms Frame 0 painting.
  final String? placeholderUrl;

  final BoxFit fit;
  final double? width;
  final double? height;
  final BorderRadiusGeometry? borderRadius;

  const PremiumImage({
    super.key,
    required this.imageUrl,
    this.placeholderUrl,
    this.fit = BoxFit.cover,
    this.width,
    this.height,
    this.borderRadius,
  });

  @override
  State<PremiumImage> createState() => _PremiumImageState();
}

class _PremiumImageState extends State<PremiumImage> {
  Uint8List? _decodedBytes;
  Uint8List? _previousDecodedBytes;
  String? _previousImageUrl;
  bool _isLoading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadImage();
  }

  @override
  void didUpdateWidget(PremiumImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.imageUrl != widget.imageUrl) {
      _previousImageUrl = oldWidget.imageUrl;
      _previousDecodedBytes = _decodedBytes;
      _loadImage();
    }
  }

  Future<void> _loadImage() async {
    final isJxl = MediaDecoder.isJxl(widget.imageUrl);
    final needManualHeic = MediaDecoder.shouldDecodeHeicManually(widget.imageUrl);

    if (!isJxl && !needManualHeic) {
      setState(() {
        _decodedBytes = null;
        _isLoading = false;
        _error = null;
      });
      return;
    }

    setState(() {
      _isLoading = true;
      _error = null;
    });

    try {
      final rawBytes = await MediaDecoder.fetchBytes(widget.imageUrl);
      Uint8List decoded;
      if (isJxl) {
        decoded = await MediaDecoder.decodeJxl(rawBytes);
      } else {
        decoded = await MediaDecoder.decodeHeic(rawBytes);
      }
      if (mounted) {
        setState(() {
          _decodedBytes = decoded;
          _previousDecodedBytes = null;
          _isLoading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _isLoading = false;
        });
      }
    }
  }

  String _resolveUrl(String url) {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    return '${ApiService().baseUrl}$url';
  }

  Map<String, String>? _getHeaders() {
    final token = ApiService().token;
    if (token != null) {
      return {'Authorization': 'Bearer $token'};
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    Widget imageWidget;

    if (_isLoading) {
      final fallbackBytes = _previousDecodedBytes ?? _decodedBytes;
      final fallbackUrl = _previousImageUrl ?? widget.placeholderUrl;

      if (fallbackBytes != null) {
        imageWidget = Stack(
          fit: StackFit.expand,
          children: [
            Image.memory(
              fallbackBytes,
              fit: widget.fit,
              width: widget.width,
              height: widget.height,
            ),
            ColoredBox(
              color: Colors.black26,
              child: const Center(
                child: SizedBox(
                  width: 24,
                  height: 24,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                  ),
                ),
              ),
            ),
          ],
        );
      } else if (fallbackUrl != null && fallbackUrl.isNotEmpty) {
        imageWidget = Stack(
          fit: StackFit.expand,
          children: [
            Image.network(
              _resolveUrl(fallbackUrl),
              headers: _getHeaders(),
              fit: widget.fit,
              width: widget.width,
              height: widget.height,
              errorBuilder: (context, error, stackTrace) => Container(
                width: widget.width,
                height: widget.height,
                color: theme.colorScheme.surfaceContainerHighest,
              ),
            ),
            ColoredBox(
              color: Colors.black26,
              child: const Center(
                child: SizedBox(
                  width: 24,
                  height: 24,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                  ),
                ),
              ),
            ),
          ],
        );
      } else {
        imageWidget = Container(
          width: widget.width,
          height: widget.height,
          color: theme.colorScheme.surfaceContainerHighest,
          child: const Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                SizedBox(
                  width: 24,
                  height: 24,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                SizedBox(height: 8),
                Text(
                  'Decoding image...',
                  style: TextStyle(fontSize: 12, color: Colors.grey),
                ),
              ],
            ),
          ),
        );
      }
    } else if (_error != null) {
      imageWidget = Container(
        width: widget.width,
        height: widget.height,
        color: theme.colorScheme.surfaceContainerHighest,
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(LucideIcons.imageOff, color: theme.colorScheme.error, size: 24),
              const SizedBox(height: 4),
              Text(
                'Failed to load image',
                style: TextStyle(fontSize: 12, color: Colors.grey),
              ),
            ],
          ),
        ),
      );
    } else if (_decodedBytes != null) {
      imageWidget = Image.memory(
        _decodedBytes!,
        fit: widget.fit,
        width: widget.width,
        height: widget.height,
      );
    } else {
      final activeFallbackUrl = _previousImageUrl ?? widget.placeholderUrl;

      final mainImage = Image.network(
        _resolveUrl(widget.imageUrl),
        headers: _getHeaders(),
        fit: widget.fit,
        width: widget.width,
        height: widget.height,
        frameBuilder: (context, child, frame, wasSynchronouslyLoaded) {
          if (wasSynchronouslyLoaded) return child;
          return AnimatedOpacity(
            opacity: frame != null ? 1.0 : 0.0,
            duration: const Duration(milliseconds: 250),
            curve: Curves.easeOut,
            child: child,
          );
        },
        errorBuilder: (context, error, stackTrace) {
          if (activeFallbackUrl != null && activeFallbackUrl.isNotEmpty) {
            return Image.network(
              _resolveUrl(activeFallbackUrl),
              headers: _getHeaders(),
              fit: widget.fit,
              width: widget.width,
              height: widget.height,
              errorBuilder: (context, error, stackTrace) => Container(
                width: widget.width,
                height: widget.height,
                color: theme.colorScheme.surfaceContainerHighest,
                child: Center(
                  child: Icon(
                    LucideIcons.image,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
            );
          }
          return Container(
            width: widget.width,
            height: widget.height,
            color: theme.colorScheme.surfaceContainerHighest,
            child: Center(
              child: Icon(
                LucideIcons.image,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          );
        },
      );

      if (activeFallbackUrl != null && activeFallbackUrl.isNotEmpty) {
        imageWidget = Stack(
          fit: StackFit.expand,
          children: [
            Image.network(
              _resolveUrl(activeFallbackUrl),
              headers: _getHeaders(),
              fit: widget.fit,
              width: widget.width,
              height: widget.height,
              errorBuilder: (context, error, stackTrace) => const SizedBox.shrink(),
            ),
            mainImage,
          ],
        );
      } else {
        imageWidget = mainImage;
      }
    }

    if (widget.borderRadius != null) {
      return ClipRRect(
        borderRadius: widget.borderRadius!,
        child: imageWidget,
      );
    }

    return imageWidget;
  }
}
