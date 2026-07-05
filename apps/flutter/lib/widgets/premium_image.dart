import 'package:flutter/material.dart';
import 'dart:typed_data';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../services/media_decoder.dart';
import '../services/api_service.dart';

class PremiumImage extends StatefulWidget {
  final String imageUrl;
  final BoxFit fit;
  final double? width;
  final double? height;

  const PremiumImage({
    super.key,
    required this.imageUrl,
    this.fit = BoxFit.cover,
    this.width,
    this.height,
  });

  @override
  State<PremiumImage> createState() => _PremiumImageState();
}

class _PremiumImageState extends State<PremiumImage> {
  Uint8List? _decodedBytes;
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
      _loadImage();
    }
  }

  Future<void> _loadImage() async {
    final isJxl = MediaDecoder.isJxl(widget.imageUrl);
    final isHeic = MediaDecoder.isHeic(widget.imageUrl);

    if (!isJxl && !isHeic) {
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
      _decodedBytes = null;
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

    if (_isLoading) {
      return Container(
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

    if (_error != null) {
      return Container(
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
    }

    if (_decodedBytes != null) {
      return Image.memory(
        _decodedBytes!,
        fit: widget.fit,
        width: widget.width,
        height: widget.height,
      );
    }

    // Standard Image
    return Image.network(
      _resolveUrl(widget.imageUrl),
      headers: _getHeaders(),
      fit: widget.fit,
      width: widget.width,
      height: widget.height,
      errorBuilder: (context, error, stackTrace) {
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
  }
}
