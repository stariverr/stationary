import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'premium_image.dart';

class PremiumLivePhotoPlayer extends StatefulWidget {
  final String imageUrl;
  final String videoUrl;
  final BoxFit fit;
  final double? width;
  final double? height;

  const PremiumLivePhotoPlayer({
    super.key,
    required this.imageUrl,
    required this.videoUrl,
    this.fit = BoxFit.cover,
    this.width,
    this.height,
  });

  @override
  State<PremiumLivePhotoPlayer> createState() => _PremiumLivePhotoPlayerState();
}

class _PremiumLivePhotoPlayerState extends State<PremiumLivePhotoPlayer> {
  VideoPlayerController? _controller;
  bool _isInitialized = false;
  bool _isPlaying = false;
  bool _isLoading = false;
  String? _error;

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  Future<void> _startPlayback() async {
    setState(() {
      _isPlaying = true;
    });

    if (_controller == null) {
      setState(() {
        _isLoading = true;
        _error = null;
      });

      try {
        final uri = Uri.parse(widget.videoUrl);
        _controller = VideoPlayerController.networkUrl(uri);
        await _controller!.initialize();
        await _controller!.setLooping(true);
        if (mounted && _isPlaying) {
          setState(() {
            _isInitialized = true;
            _isLoading = false;
          });
          await _controller!.play();
        } else {
          // If the user released the hold before initialization completed
          _controller?.dispose();
          _controller = null;
          setState(() {
            _isInitialized = false;
            _isLoading = false;
          });
        }
      } catch (e) {
        if (mounted) {
          setState(() {
            _error = e.toString();
            _isLoading = false;
            _isPlaying = false;
          });
        }
      }
    } else if (_isInitialized) {
      await _controller!.play();
    }
  }

  Future<void> _stopPlayback() async {
    setState(() {
      _isPlaying = false;
    });

    if (_controller != null && _isInitialized) {
      await _controller!.pause();
      await _controller!.seekTo(Duration.zero);
    }
  }

  @override
  Widget build(BuildContext context) {
    final showVideo = _isInitialized && _isPlaying && !_isLoading;

    return GestureDetector(
      onLongPressStart: (_) => _startPlayback(),
      onLongPressEnd: (_) => _stopPlayback(),
      onLongPressUp: () => _stopPlayback(),
      onLongPressCancel: () => _stopPlayback(),
      behavior: HitTestBehavior.opaque,
      child: Stack(
        fit: StackFit.expand,
        children: [
          // 1. Static Image (Fallback/Default)
          PremiumImage(
            imageUrl: widget.imageUrl,
            fit: widget.fit,
            width: widget.width,
            height: widget.height,
          ),

          // 2. Video Player Overlay
          if (showVideo && _controller != null)
            Center(
              child: FittedBox(
                fit: widget.fit,
                clipBehavior: Clip.hardEdge,
                child: SizedBox(
                  width: _controller!.value.size.width,
                  height: _controller!.value.size.height,
                  child: VideoPlayer(_controller!),
                ),
              ),
            ),

          // 3. Elegant "LIVE" Badge (Fades out when playing)
          Positioned(
            top: 10,
            left: 10,
            child: AnimatedOpacity(
              opacity: _isPlaying ? 0.0 : 1.0,
              duration: const Duration(milliseconds: 250),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(20),
                child: BackdropFilter(
                  filter: ImageFilter.blur(sigmaX: 5, sigmaY: 5),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: Colors.black.withValues(alpha: 0.4),
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(
                        color: Colors.white.withValues(alpha: 0.1),
                        width: 1.0,
                      ),
                    ),
                    child: const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          LucideIcons.aperture,
                          color: Colors.white,
                          size: 12,
                        ),
                        SizedBox(width: 4),
                        Text(
                          'LIVE',
                          style: TextStyle(
                            color: Colors.white,
                            fontSize: 10,
                            fontWeight: FontWeight.bold,
                            letterSpacing: 1.0,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),

          // 4. Subtle Loading Indicator (Centered when long pressing and video is loading)
          if (_isLoading)
            Center(
              child: Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.black.withValues(alpha: 0.5),
                  shape: BoxShape.circle,
                ),
                child: const SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                  ),
                ),
              ),
            ),

          // 5. Error Indicator (If video failed to load, display in corner)
          if (_error != null)
            Positioned(
              bottom: 10,
              right: 10,
              child: Container(
                padding: const EdgeInsets.all(4),
                decoration: BoxDecoration(
                  color: Colors.black54,
                  borderRadius: BorderRadius.circular(4),
                ),
                child: const Icon(
                  LucideIcons.alertCircle,
                  color: Colors.red,
                  size: 16,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
