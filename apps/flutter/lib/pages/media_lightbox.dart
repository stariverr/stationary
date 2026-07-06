import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:photo_view/photo_view.dart';
import 'package:gal/gal.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../models.dart';
import '../services/media_decoder.dart';
import '../widgets/premium_video_player.dart';
import '../widgets/premium_live_photo_player.dart';

class MediaLightbox extends StatefulWidget {
  final List<Media> mediaList;
  final int initialIndex;

  const MediaLightbox({
    super.key,
    required this.mediaList,
    required this.initialIndex,
  });

  @override
  State<MediaLightbox> createState() => _MediaLightboxState();
}

class _MediaLightboxState extends State<MediaLightbox> {
  late PageController _pageController;
  late int _currentIndex;
  bool _isSaving = false;
  bool _showOverlays = true;
  late PhotoViewController _photoViewController;

  @override
  void initState() {
    super.initState();
    _currentIndex = widget.initialIndex;
    _pageController = PageController(initialPage: widget.initialIndex);
    _photoViewController = PhotoViewController();
    _updateSystemUI();
  }

  void _updateSystemUI() {
    if (_showOverlays) {
      SystemChrome.setEnabledSystemUIMode(SystemUiMode.manual, overlays: SystemUiOverlay.values);
    } else {
      SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
    }
  }

  @override
  void dispose() {
    _pageController.dispose();
    _photoViewController.dispose();
    // Restore default system UI
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.manual, overlays: SystemUiOverlay.values);
    super.dispose();
  }

  Future<void> _saveCurrentImage() async {
    final media = widget.mediaList[_currentIndex];
    if (media.url == null || media.type == 'VIDEO') return;

    setState(() {
      _isSaving = true;
    });

    try {
      final isJxl = MediaDecoder.isJxl(media.url!);
      final isHeic = MediaDecoder.isHeic(media.url!);

      final rawBytes = await MediaDecoder.fetchBytes(media.url!);
      Uint8List finalBytes = rawBytes;
      if (isJxl) {
        finalBytes = await MediaDecoder.decodeJxl(rawBytes);
      } else if (isHeic) {
        finalBytes = await MediaDecoder.decodeHeic(rawBytes);
      }

      await Gal.putImageBytes(finalBytes);

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Image saved successfully to gallery.'),
            backgroundColor: Colors.green,
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to save image: $e'),
            backgroundColor: Colors.red,
          ),
        );
      }
    } finally {
      if (mounted) {
        setState(() {
          _isSaving = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final media = widget.mediaList[_currentIndex];
    final isImage = media.type != 'VIDEO';

    return Scaffold(
      backgroundColor: Colors.black,
      body: SafeArea(
        child: Stack(
          children: [
            // Media Swipe Content
            Positioned.fill(
              child: PageView.builder(
                controller: _pageController,
                itemCount: widget.mediaList.length,
                onPageChanged: (index) {
                  setState(() {
                    _currentIndex = index;
                    _showOverlays = true;
                  });
                  _updateSystemUI();
                  _photoViewController.scale = 1.0;
                  _photoViewController.position = Offset.zero;
                },
                itemBuilder: (context, index) {
                  final item = widget.mediaList[index];
                  MediaTrack? liveTrack;
                  if (item.type == 'LIVE_PHOTO') {
                    for (final t in item.tracks) {
                      if (t.type == 'VIDEO' && t.purpose == 'CONTENT') {
                        liveTrack = t;
                        break;
                      }
                    }
                  }

                  if (item.type == 'VIDEO' && item.url != null) {
                    return Center(
                      child: PremiumVideoPlayer(
                        videoUrl: item.url!,
                        coverUrl: item.coverUrl,
                        autoPlay: index == _currentIndex,
                        tracks: item.tracks,
                        onControlsVisibilityChanged: (visible) {
                          setState(() {
                            _showOverlays = visible;
                          });
                          _updateSystemUI();
                        },
                      ),
                    );
                  } else if (item.type == 'LIVE_PHOTO' && item.url != null && liveTrack != null) {
                    return Center(
                      child: PremiumLivePhotoPlayer(
                        imageUrl: item.url!,
                        videoUrl: liveTrack.url,
                        fit: BoxFit.contain,
                      ),
                    );
                  } else if (item.url != null) {
                    return LightboxImage(
                      url: item.url!,
                      controller: _photoViewController,
                      onTap: () {
                        setState(() {
                          _showOverlays = !_showOverlays;
                        });
                        _updateSystemUI();
                      },
                    );
                  }
                  return const Center(
                    child: Text(
                      'Unsupported media type',
                      style: TextStyle(color: Colors.white),
                    ),
                  );
                },
              ),
            ),

            // Animated Top Action Bar
            AnimatedPositioned(
              duration: const Duration(milliseconds: 300),
              curve: Curves.easeInOut,
              top: _showOverlays ? 0 : -80,
              left: 0,
              right: 0,
              child: AnimatedOpacity(
                duration: const Duration(milliseconds: 300),
                opacity: _showOverlays ? 1.0 : 0.0,
                child: IgnorePointer(
                  ignoring: !_showOverlays,
                  child: Container(
                    color: Colors.black.withValues(alpha: 0.5),
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        // Close button
                        IconButton(
                          icon: const Icon(LucideIcons.x, color: Colors.white),
                          onPressed: () => Navigator.pop(context),
                        ),

                        // Counter
                        Text(
                          '${_currentIndex + 1} / ${widget.mediaList.length}',
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 16,
                            fontWeight: FontWeight.bold,
                            fontFamily: 'monospace',
                          ),
                        ),

                        // Save / Download button
                        if (isImage)
                          _isSaving
                              ? const SizedBox(
                                  width: 24,
                                  height: 24,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                    valueColor: AlwaysStoppedAnimation(Colors.white),
                                  ),
                                )
                              : IconButton(
                                  icon: const Icon(LucideIcons.download, color: Colors.white),
                                  onPressed: _saveCurrentImage,
                                )
                        else
                          const SizedBox(width: 48), // Spacer placeholder
                      ],
                    ),
                  ),
                ),
              ),
            ),

            // Image Zoom Controls Overlay (Only for images, when overlays are visible)
            if (isImage && _showOverlays)
              Positioned(
                right: 16,
                top: MediaQuery.of(context).size.height / 2 - 80,
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(20),
                  child: BackdropFilter(
                    filter: ImageFilter.blur(sigmaX: 10, sigmaY: 10),
                    child: Container(
                      padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 4),
                      decoration: BoxDecoration(
                        color: Colors.black.withValues(alpha: 0.4),
                        borderRadius: BorderRadius.circular(20),
                        border: Border.all(
                          color: Colors.white.withValues(alpha: 0.1),
                          width: 1.0,
                        ),
                      ),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          IconButton(
                            icon: const Icon(LucideIcons.zoomIn, color: Colors.white, size: 20),
                            onPressed: () {
                              final currentScale = _photoViewController.scale ?? 1.0;
                              _photoViewController.scale = (currentScale * 1.4).clamp(0.2, 8.0);
                            },
                          ),
                          IconButton(
                            icon: const Icon(LucideIcons.zoomOut, color: Colors.white, size: 20),
                            onPressed: () {
                              final currentScale = _photoViewController.scale ?? 1.0;
                              _photoViewController.scale = (currentScale / 1.4).clamp(0.2, 8.0);
                            },
                          ),
                          IconButton(
                            icon: const Icon(LucideIcons.refreshCw, color: Colors.white, size: 16),
                            onPressed: () {
                              _photoViewController.scale = 1.0;
                              _photoViewController.position = Offset.zero;
                            },
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class LightboxImage extends StatefulWidget {
  final String url;
  final PhotoViewController controller;
  final VoidCallback? onTap;
  const LightboxImage({super.key, required this.url, required this.controller, this.onTap});

  @override
  State<LightboxImage> createState() => _LightboxImageState();
}

class _LightboxImageState extends State<LightboxImage> {
  Uint8List? _bytes;
  bool _isLoading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadImage();
  }

  @override
  void didUpdateWidget(LightboxImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.url != widget.url) {
      _loadImage();
    }
  }

  Future<void> _loadImage() async {
    setState(() {
      _isLoading = true;
      _error = null;
      _bytes = null;
    });

    try {
      final isJxl = MediaDecoder.isJxl(widget.url);
      final isHeic = MediaDecoder.isHeic(widget.url);

      final rawBytes = await MediaDecoder.fetchBytes(widget.url);
      Uint8List finalBytes = rawBytes;
      if (isJxl) {
        finalBytes = await MediaDecoder.decodeJxl(rawBytes);
      } else if (isHeic) {
        finalBytes = await MediaDecoder.decodeHeic(rawBytes);
      }

      if (mounted) {
        setState(() {
          _bytes = finalBytes;
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

  @override
  Widget build(BuildContext context) {
    if (_isLoading) {
      return const Center(
        child: CircularProgressIndicator(
          valueColor: AlwaysStoppedAnimation(Colors.white),
        ),
      );
    }

    if (_error != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(LucideIcons.imageOff, color: Colors.grey, size: 48),
            const SizedBox(height: 12),
            Text(
              'Failed to load image: $_error',
              style: const TextStyle(color: Colors.white, fontSize: 12),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      );
    }

    return PhotoView(
      controller: widget.controller,
      imageProvider: MemoryImage(_bytes!),
      minScale: PhotoViewComputedScale.contained,
      maxScale: PhotoViewComputedScale.covered * 3.0,
      backgroundDecoration: const BoxDecoration(color: Colors.black),
      onTapUp: (context, details, controllerValue) {
        widget.onTap?.call();
      },
      loadingBuilder: (context, event) => const Center(
        child: CircularProgressIndicator(
          valueColor: AlwaysStoppedAnimation(Colors.white),
        ),
      ),
    );
  }
}
