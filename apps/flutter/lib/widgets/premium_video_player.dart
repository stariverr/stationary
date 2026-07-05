import 'dart:async';
import 'dart:io';
import 'dart:ui';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:http/http.dart' as http;
import '../services/api_service.dart';
import '../models.dart';

class PremiumVideoPlayer extends StatefulWidget {
  final String videoUrl;
  final String? coverUrl;
  final double? width;
  final double? height;
  final VoidCallback? onFullscreen;
  final bool autoPlay;
  final List<MediaTrack>? tracks;
  final ValueChanged<bool>? onControlsVisibilityChanged;

  const PremiumVideoPlayer({
    super.key,
    required this.videoUrl,
    this.coverUrl,
    this.width,
    this.height,
    this.onFullscreen,
    this.autoPlay = false,
    this.tracks,
    this.onControlsVisibilityChanged,
  });

  @override
  State<PremiumVideoPlayer> createState() => _PremiumVideoPlayerState();
}

class _PremiumVideoPlayerState extends State<PremiumVideoPlayer> {
  VideoPlayerController? _videoPlayerController;
  bool _isInitializing = true;
  String? _error;
  bool _isUnsupportedOnIos = false;

  // Custom Controls State
  bool _showControls = true;
  Timer? _controlsTimer;
  double _playbackSpeed = 1.0;
  bool _isMuted = false;
  double _volumeBeforeMute = 1.0;
  bool _isSeeking = false;
  bool _isLongPressFastForward = false;
  double _preFastForwardSpeed = 1.0;
  bool _showSpeedMenu = false;

  // Gesture Ripples
  IconData? _rippleIcon;
  int _rippleId = 0;
  bool? _seekRippleIsLeft;
  int _seekRippleId = 0;

  // Subtitle cue list & active states
  List<WebVttCue>? _subtitleCues;
  MediaTrack? _activeSubtitleTrack;

  // Track selection state
  String? _selectedVideoTrackId;
  String? _selectedAudioTrackId;

  // Settings overlays
  bool _showSettingsMenu = false;
  bool _showInfoMenu = false;

  @override
  void initState() {
    super.initState();
    _checkAndInitPlayer();
  }

  void _checkAndInitPlayer() {
    final resolvedUrl = _resolveUrl(widget.videoUrl);
    final isIosOrMac = !kIsWeb && (Platform.isIOS || Platform.isMacOS);
    final isDash = resolvedUrl.contains('.mpd') || resolvedUrl.contains('manifest.mpd');

    if (isIosOrMac && isDash) {
      setState(() {
        _isUnsupportedOnIos = true;
        _isInitializing = false;
      });
      return;
    }

    _initPlayer(resolvedUrl);
  }

  Future<void> _initPlayer(String resolvedUrl) async {
    setState(() {
      _isInitializing = true;
      _error = null;
    });

    try {
      final token = ApiService().token;
      final headers = <String, String>{};
      if (token != null) {
        headers['Authorization'] = 'Bearer $token';
      }

      _videoPlayerController = VideoPlayerController.networkUrl(
        Uri.parse(resolvedUrl),
        httpHeaders: headers,
      );

      await _videoPlayerController!.initialize();

      // Listen to events to trigger setState for custom controls updates
      _videoPlayerController!.addListener(_onVideoControllerUpdate);

      if (widget.autoPlay) {
        await _videoPlayerController!.play();
      }

      if (mounted) {
        setState(() {
          _isInitializing = false;
        });
        _startControlsTimer();
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _isInitializing = false;
        });
      }
    }
  }

  void _onVideoControllerUpdate() {
    if (mounted) {
      setState(() {});
    }
  }

  String _resolveUrl(String url) {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    return '${ApiService().baseUrl}$url';
  }

  @override
  void dispose() {
    _controlsTimer?.cancel();
    _videoPlayerController?.removeListener(_onVideoControllerUpdate);
    _videoPlayerController?.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant PremiumVideoPlayer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.videoUrl != widget.videoUrl) {
      _controlsTimer?.cancel();
      _videoPlayerController?.removeListener(_onVideoControllerUpdate);
      _videoPlayerController?.dispose();
      
      // Reset selections for new video
      _selectedVideoTrackId = null;
      _selectedAudioTrackId = null;
      _activeSubtitleTrack = null;
      _subtitleCues = null;
      _showSettingsMenu = false;
      _showInfoMenu = false;
      
      _checkAndInitPlayer();
    } else if (oldWidget.autoPlay != widget.autoPlay) {
      if (widget.autoPlay) {
        _videoPlayerController?.play();
        _startControlsTimer();
      } else {
        _videoPlayerController?.pause();
        _cancelControlsTimer();
      }
    }
  }

  void _setShowControls(bool value) {
    if (_showControls == value) return;
    setState(() {
      _showControls = value;
      if (!value) {
        _showSpeedMenu = false;
      }
    });
    widget.onControlsVisibilityChanged?.call(value);
  }

  // --- Control Actions ---

  void _startControlsTimer() {
    _controlsTimer?.cancel();
    if (!_showControls || _isSeeking || !_videoPlayerController!.value.isPlaying) {
      return;
    }
    _controlsTimer = Timer(const Duration(seconds: 3), () {
      if (mounted && _videoPlayerController!.value.isPlaying && !_isSeeking && !_showSpeedMenu) {
        _setShowControls(false);
      }
    });
  }

  void _cancelControlsTimer() {
    _controlsTimer?.cancel();
  }

  void _toggleControls() {
    _setShowControls(!_showControls);
    if (_showControls) {
      _startControlsTimer();
    } else {
      _cancelControlsTimer();
    }
  }

  void _togglePlay() {
    if (_videoPlayerController == null) return;

    setState(() {
      if (_videoPlayerController!.value.isPlaying) {
        _videoPlayerController!.pause();
        _rippleIcon = LucideIcons.pause;
        _cancelControlsTimer(); // Keep controls visible when paused
      } else {
        _videoPlayerController!.play();
        _rippleIcon = LucideIcons.play;
        _startControlsTimer();
      }
      _rippleId++;
    });
  }

  void _seekRelative(int seconds) {
    if (_videoPlayerController == null) return;
    final currentPos = _videoPlayerController!.value.position;
    final duration = _videoPlayerController!.value.duration;
    Duration targetPos = currentPos + Duration(seconds: seconds);
    
    if (targetPos < Duration.zero) {
      targetPos = Duration.zero;
    } else if (targetPos > duration) {
      targetPos = duration;
    }
    
    _videoPlayerController!.seekTo(targetPos);
    
    _setShowControls(true);
    _startControlsTimer();

    setState(() {
      _seekRippleIsLeft = seconds < 0;
      _seekRippleId++;
    });
  }

  void _startFastForward() {
    if (_videoPlayerController == null || !_videoPlayerController!.value.isPlaying) return;
    _preFastForwardSpeed = _playbackSpeed;
    _videoPlayerController!.setPlaybackSpeed(2.0);
    setState(() {
      _isLongPressFastForward = true;
    });
  }

  void _stopFastForward() {
    if (_videoPlayerController == null || !_isLongPressFastForward) return;
    _videoPlayerController!.setPlaybackSpeed(_preFastForwardSpeed);
    setState(() {
      _isLongPressFastForward = false;
    });
  }

  void _changeSpeed(double speed) {
    if (_videoPlayerController == null) return;
    _videoPlayerController!.setPlaybackSpeed(speed);
    setState(() {
      _playbackSpeed = speed;
      _showSpeedMenu = false;
    });
    _startControlsTimer();
  }

  void _toggleMute() {
    if (_videoPlayerController == null) return;
    setState(() {
      if (_isMuted) {
        _videoPlayerController!.setVolume(_volumeBeforeMute);
        _isMuted = false;
      } else {
        _volumeBeforeMute = _videoPlayerController!.value.volume > 0 ? _videoPlayerController!.value.volume : 1.0;
        _videoPlayerController!.setVolume(0.0);
        _isMuted = true;
      }
    });
  }

  void _setVolume(double val) {
    if (_videoPlayerController == null) return;
    _videoPlayerController!.setVolume(val);
    setState(() {
      _isMuted = val == 0.0;
    });
  }

  String _formatDuration(Duration duration) {
    String twoDigits(int n) => n.toString().padLeft(2, '0');
    final minutes = twoDigits(duration.inMinutes.remainder(60));
    final seconds = twoDigits(duration.inSeconds.remainder(60));
    if (duration.inHours > 0) {
      final hours = twoDigits(duration.inHours);
      return '$hours:$minutes:$seconds';
    }
    return '$minutes:$seconds';
  }

  Future<void> _loadSubtitleTrack(MediaTrack track) async {
    try {
      final token = ApiService().token;
      final headers = <String, String>{};
      if (token != null) {
        headers['Authorization'] = 'Bearer $token';
      }

      final resolvedUrl = _resolveUrl(track.url);
      final response = await http.get(Uri.parse(resolvedUrl), headers: headers);

      if (response.statusCode == 200) {
        setState(() {
          _subtitleCues = parseWebVtt(response.body);
          _activeSubtitleTrack = track;
        });
      } else {
        throw Exception('Failed to load subtitle file (HTTP ${response.statusCode})');
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to load subtitles: $e'),
            backgroundColor: Colors.red,
          ),
        );
      }
    }
  }

  MediaTrack? get _activeVideoTrack {
    final videoTracks = (widget.tracks ?? []).where((t) => t.type == 'VIDEO' && t.purpose == 'CONTENT').toList();
    if (videoTracks.isEmpty) return null;
    if (_selectedVideoTrackId != null) {
      return videoTracks.firstWhere((t) => t.id == _selectedVideoTrackId, orElse: () => videoTracks.first);
    }
    return videoTracks.firstWhere((t) => t.isDefault, orElse: () => videoTracks.first);
  }

  MediaTrack? get _activeAudioTrack {
    final audioTracks = (widget.tracks ?? []).where((t) => t.type == 'AUDIO' && t.purpose == 'CONTENT').toList();
    if (audioTracks.isEmpty) return null;
    if (_selectedAudioTrackId != null) {
      return audioTracks.firstWhere((t) => t.id == _selectedAudioTrackId, orElse: () => audioTracks.first);
    }
    return audioTracks.firstWhere((t) => t.isDefault, orElse: () => audioTracks.first);
  }

  Future<void> _switchTrack({String? videoTrackId, String? audioTrackId}) async {
    if (_videoPlayerController == null) return;

    final currentPos = _videoPlayerController!.value.position;
    final wasPlaying = _videoPlayerController!.value.isPlaying;

    setState(() {
      _isInitializing = true;
      if (videoTrackId != null) _selectedVideoTrackId = videoTrackId;
      if (audioTrackId != null) _selectedAudioTrackId = audioTrackId;
    });

    _controlsTimer?.cancel();
    _videoPlayerController?.removeListener(_onVideoControllerUpdate);
    await _videoPlayerController?.dispose();
    _videoPlayerController = null;

    String newUrl = _resolveUrl(widget.videoUrl);
    final isDash = newUrl.contains('.mpd') || newUrl.contains('manifest.mpd');

    if (isDash) {
      final uri = Uri.parse(newUrl);
      final queryParams = Map<String, String>.from(uri.queryParameters);
      if (_selectedVideoTrackId != null) {
        queryParams['video_track_id'] = _selectedVideoTrackId!;
      }
      if (_selectedAudioTrackId != null) {
        queryParams['audio_track_id'] = _selectedAudioTrackId!;
      }
      newUrl = uri.replace(queryParameters: queryParams).toString();
    } else {
      if (videoTrackId != null && videoTrackId != 'default') {
        final matches = (widget.tracks ?? []).where((t) => t.id == videoTrackId).toList();
        if (matches.isNotEmpty) {
          newUrl = _resolveUrl(matches.first.url);
        }
      }
    }

    try {
      final token = ApiService().token;
      final headers = <String, String>{};
      if (token != null) {
        headers['Authorization'] = 'Bearer $token';
      }

      _videoPlayerController = VideoPlayerController.networkUrl(
        Uri.parse(newUrl),
        httpHeaders: headers,
      );

      await _videoPlayerController!.initialize();
      _videoPlayerController!.addListener(_onVideoControllerUpdate);

      await _videoPlayerController!.seekTo(currentPos);
      if (wasPlaying) {
        await _videoPlayerController!.play();
        _startControlsTimer();
      }

      if (mounted) {
        setState(() {
          _isInitializing = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _isInitializing = false;
        });
      }
    }
  }

  Widget _buildSettingsContent() {
    final videoTracks = (widget.tracks ?? []).where((t) => t.type == 'VIDEO' && t.purpose == 'CONTENT').toList();
    final audioTracks = (widget.tracks ?? []).where((t) => t.type == 'AUDIO' && t.purpose == 'CONTENT').toList();
    final subtitleTracks = (widget.tracks ?? []).where((t) => t.type == 'SUBTITLE' && t.purpose == 'CONTENT').toList();

    return Material(
      color: Colors.transparent,
      child: ListView(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 20),
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text(
                'Settings',
                style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.bold),
              ),
              IconButton(
                icon: const Icon(LucideIcons.x, color: Colors.white70, size: 20),
                onPressed: () => setState(() => _showSettingsMenu = false),
              )
            ],
          ),
          const Divider(color: Colors.white10),
          
          if (videoTracks.isNotEmpty) ...[
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 8.0, horizontal: 4),
              child: Text('Video Quality', style: TextStyle(color: Colors.grey, fontSize: 12, fontWeight: FontWeight.bold)),
            ),
            ...videoTracks.map((t) {
              final isActive = _activeVideoTrack?.id == t.id;
              final width = t.metadata['width'] ?? 0;
              final height = t.metadata['height'] ?? 0;
              final label = t.displayName ?? t.quality ?? (width > 0 && height > 0 ? '${width}x$height' : 'Default');
              return ListTile(
                dense: true,
                visualDensity: VisualDensity.compact,
                title: Text(label, style: TextStyle(color: isActive ? Theme.of(context).colorScheme.primary : Colors.white70)),
                trailing: isActive ? Icon(LucideIcons.check, color: Theme.of(context).colorScheme.primary, size: 16) : null,
                onTap: () {
                  _switchTrack(videoTrackId: t.id);
                  setState(() => _showSettingsMenu = false);
                },
              );
            }),
            const Divider(color: Colors.white10),
          ],

          if (audioTracks.isNotEmpty) ...[
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 8.0, horizontal: 4),
              child: Text('Audio Track', style: TextStyle(color: Colors.grey, fontSize: 12, fontWeight: FontWeight.bold)),
            ),
            ...audioTracks.map((t) {
              final isActive = _activeAudioTrack?.id == t.id;
              final label = t.displayName ?? t.language ?? t.variantKey ?? 'Audio Track';
              return ListTile(
                dense: true,
                visualDensity: VisualDensity.compact,
                title: Text(label, style: TextStyle(color: isActive ? Theme.of(context).colorScheme.primary : Colors.white70)),
                trailing: isActive ? Icon(LucideIcons.check, color: Theme.of(context).colorScheme.primary, size: 16) : null,
                onTap: () {
                  _switchTrack(audioTrackId: t.id);
                  setState(() => _showSettingsMenu = false);
                },
              );
            }),
            const Divider(color: Colors.white10),
          ],

          if (subtitleTracks.isNotEmpty) ...[
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 8.0, horizontal: 4),
              child: Text('Subtitles', style: TextStyle(color: Colors.grey, fontSize: 12, fontWeight: FontWeight.bold)),
            ),
            ListTile(
              dense: true,
              visualDensity: VisualDensity.compact,
              title: Text('Off', style: TextStyle(color: _activeSubtitleTrack == null ? Theme.of(context).colorScheme.primary : Colors.white70)),
              trailing: _activeSubtitleTrack == null ? Icon(LucideIcons.check, color: Theme.of(context).colorScheme.primary, size: 16) : null,
              onTap: () {
                setState(() {
                  _activeSubtitleTrack = null;
                  _subtitleCues = null;
                  _showSettingsMenu = false;
                });
              },
            ),
            ...subtitleTracks.map((t) {
              final isActive = _activeSubtitleTrack?.id == t.id;
              final label = t.displayName ?? t.language ?? 'Subtitle';
              return ListTile(
                dense: true,
                visualDensity: VisualDensity.compact,
                title: Text(label, style: TextStyle(color: isActive ? Theme.of(context).colorScheme.primary : Colors.white70)),
                trailing: isActive ? Icon(LucideIcons.check, color: Theme.of(context).colorScheme.primary, size: 16) : null,
                onTap: () {
                  _loadSubtitleTrack(t);
                  setState(() => _showSettingsMenu = false);
                },
              );
            }),
          ]
        ],
      ),
    );
  }

  Widget _buildInfoContent() {
    final activeVideo = _activeVideoTrack;
    final activeAudio = _activeAudioTrack;
    
    final width = activeVideo?.metadata['width'] ?? _videoPlayerController?.value.size.width.toInt() ?? 0;
    final height = activeVideo?.metadata['height'] ?? _videoPlayerController?.value.size.height.toInt() ?? 0;
    final resolution = width > 0 && height > 0 ? '${width}x$height' : 'Unknown';
    
    final videoCodec = activeVideo?.codec ?? activeVideo?.metadata['codecs'] ?? 'Unknown';
    final audioCodec = activeAudio?.codec ?? activeAudio?.metadata['codecs'] ?? 'Unknown';
    
    final duration = _videoPlayerController != null ? _formatDuration(_videoPlayerController!.value.duration) : 'Unknown';
    final isDash = widget.videoUrl.contains('.mpd') || widget.videoUrl.contains('manifest.mpd');
    
    Widget infoRow(String label, String value) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 6.0),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 100,
              child: Text(label, style: const TextStyle(color: Colors.grey, fontSize: 12, decoration: TextDecoration.none)),
            ),
            Expanded(
              child: Text(value, style: const TextStyle(color: Colors.white70, fontSize: 12, decoration: TextDecoration.none)),
            ),
          ],
        ),
      );
    }

    return Material(
      color: Colors.transparent,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text(
                'Video Information',
                style: TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.bold),
              ),
              IconButton(
                icon: const Icon(LucideIcons.x, color: Colors.white70, size: 18),
                onPressed: () => setState(() => _showInfoMenu = false),
              )
            ],
          ),
          const Divider(color: Colors.white10),
          infoRow('Format', isDash ? 'MPEG-DASH (MPD)' : 'Progressive (MP4)'),
          infoRow('Resolution', resolution),
          infoRow('Duration', duration),
          infoRow('Video Codec', videoCodec),
          infoRow('Audio Codec', audioCodec),
          if (activeVideo != null && activeVideo.metadata['bandwidth'] != null)
            infoRow('Bitrate', '${(activeVideo.metadata['bandwidth'] / 1000).round()} kbps'),
          if (activeAudio != null && activeAudio.metadata['bandwidth'] != null)
            infoRow('Audio Bitrate', '${(activeAudio.metadata['bandwidth'] / 1000).round()} kbps'),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final darkBg = const Color(0xFF09090B);

    if (_isUnsupportedOnIos) {
      return Container(
        height: 200,
        decoration: BoxDecoration(
          color: darkBg,
          borderRadius: BorderRadius.circular(8),
        ),
        padding: const EdgeInsets.all(16),
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                LucideIcons.alertTriangle,
                color: theme.colorScheme.primary,
                size: 36,
              ),
              const SizedBox(height: 12),
              const Text(
                'DASH (.mpd) Unsupported on iOS',
                style: TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.bold,
                  fontSize: 14,
                ),
              ),
              const SizedBox(height: 4),
              const Text(
                'Apple AVPlayer only supports DASH on Android/Web. Use Android emulator to preview this DASH video.',
                style: TextStyle(color: Colors.grey, fontSize: 11),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      );
    }

    if (_isInitializing) {
      return Container(
        height: 200,
        decoration: BoxDecoration(
          color: darkBg,
          borderRadius: BorderRadius.circular(8),
        ),
        child: const Center(
          child: CircularProgressIndicator(),
        ),
      );
    }

    if (_error != null) {
      return Container(
        height: 200,
        decoration: BoxDecoration(
          color: darkBg,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(LucideIcons.videoOff, color: Colors.grey, size: 36),
              const SizedBox(height: 12),
              const Text(
                'Failed to load video',
                style: TextStyle(color: Colors.white, fontSize: 14),
              ),
              const SizedBox(height: 4),
              Text(
                _error!,
                style: const TextStyle(color: Colors.grey, fontSize: 10),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: 8),
              TextButton(
                onPressed: _checkAndInitPlayer,
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
      );
    }

    final controller = _videoPlayerController!;

    return ClipRRect(
      borderRadius: BorderRadius.circular(10),
      child: Container(
        color: Colors.black,
        child: Stack(
          fit: StackFit.expand,
          children: [
            // 1. The Video Player (centered, maintaining aspect ratio)
            Center(
              child: AspectRatio(
                aspectRatio: controller.value.aspectRatio,
                child: VideoPlayer(controller),
              ),
            ),

            // 2. Gesture Overlay Detector
            GestureDetector(
              behavior: HitTestBehavior.translucent,
              onTap: _toggleControls,
              onDoubleTapDown: (TapDownDetails details) {
                final RenderBox box = context.findRenderObject() as RenderBox;
                final width = box.size.width;
                if (details.localPosition.dx < width / 2) {
                  _seekRelative(-10);
                } else {
                  _seekRelative(10);
                }
              },
              onLongPress: _startFastForward,
              onLongPressEnd: (_) => _stopFastForward(),
              onLongPressUp: _stopFastForward,
              child: Container(),
            ),

            // 3. Transient Play/Pause Ripple Overlay
            if (_rippleIcon != null)
              Positioned.fill(
                child: Center(
                  key: ValueKey('ripple_$_rippleId'),
                  child: PlayPauseRipple(
                    icon: _rippleIcon!,
                    onComplete: () {
                      if (mounted) {
                        setState(() {
                          _rippleIcon = null;
                        });
                      }
                    },
                  ),
                ),
              ),

            // 4. Double Tap Seek Overlay
            if (_seekRippleIsLeft != null)
              Positioned(
                left: _seekRippleIsLeft! ? 0 : null,
                right: _seekRippleIsLeft! ? null : 0,
                top: 0,
                bottom: 0,
                child: DoubleTapSeekIndicator(
                  isLeft: _seekRippleIsLeft!,
                  key: ValueKey('seek_ripple_$_seekRippleId'),
                  onComplete: () {
                    if (mounted) {
                      setState(() {
                        _seekRippleIsLeft = null;
                      });
                    }
                  },
                ),
              ),

            // 5. Long Press Fast Forward Status
            if (_isLongPressFastForward)
              Positioned(
                top: 16,
                left: 0,
                right: 0,
                child: Center(
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(20),
                    child: BackdropFilter(
                      filter: ImageFilter.blur(sigmaX: 5, sigmaY: 5),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                        decoration: BoxDecoration(
                          color: Colors.black.withValues(alpha: 0.6),
                          borderRadius: BorderRadius.circular(20),
                          border: Border.all(
                            color: Colors.white.withValues(alpha: 0.1),
                          ),
                        ),
                        child: const Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              LucideIcons.chevronsRight,
                              color: Colors.white,
                              size: 14,
                            ),
                            SizedBox(width: 6),
                            Text(
                              '2.0X Fast Forwarding',
                              style: TextStyle(
                                color: Colors.white,
                                fontSize: 12,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),

            // 6. Glassmorphic Speed Selection Menu
            if (_showSpeedMenu && _showControls)
              Positioned(
                bottom: 66,
                right: widget.onFullscreen != null ? 48 : 12,
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: BackdropFilter(
                    filter: ImageFilter.blur(sigmaX: 10, sigmaY: 10),
                    child: Container(
                      width: 90,
                      decoration: BoxDecoration(
                        color: Colors.black.withValues(alpha: 0.65),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(
                          color: Colors.white.withValues(alpha: 0.15),
                        ),
                      ),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [0.5, 0.75, 1.0, 1.25, 1.5, 2.0].map((speed) {
                          final isSelected = _playbackSpeed == speed;
                          return InkWell(
                            onTap: () => _changeSpeed(speed),
                            child: Container(
                              width: double.infinity,
                              padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 12),
                              alignment: Alignment.center,
                              color: isSelected ? Colors.white.withValues(alpha: 0.1) : Colors.transparent,
                              child: Text(
                                '${speed}x',
                                style: TextStyle(
                                  color: isSelected ? theme.colorScheme.primary : Colors.white,
                                  fontSize: 12,
                                  fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
                                ),
                              ),
                            ),
                          );
                        }).toList(),
                      ),
                    ),
                  ),
                ),
              ),

            // 7. Glassmorphic Controls Bar
            Positioned(
              bottom: 12,
              left: 12,
              right: 12,
              child: AnimatedOpacity(
                opacity: _showControls ? 1.0 : 0.0,
                duration: const Duration(milliseconds: 300),
                curve: Curves.easeInOut,
                child: IgnorePointer(
                  ignoring: !_showControls,
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(12),
                    child: BackdropFilter(
                      filter: ImageFilter.blur(sigmaX: 10, sigmaY: 10),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                        decoration: BoxDecoration(
                          color: Colors.black.withValues(alpha: 0.4),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(
                            color: Colors.white.withValues(alpha: 0.1),
                            width: 1.0,
                          ),
                        ),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            // Scrubber Slider
                            PremiumVideoProgressBar(
                              controller: controller,
                              onDragStart: () {
                                setState(() {
                                  _isSeeking = true;
                                });
                                _cancelControlsTimer();
                              },
                              onDragEnd: () {
                                setState(() {
                                  _isSeeking = false;
                                });
                                _startControlsTimer();
                              },
                            ),
                            const SizedBox(height: 6),
                            // Button controls
                            Row(
                              children: [
                                IconButton(
                                  padding: EdgeInsets.zero,
                                  constraints: const BoxConstraints(),
                                  icon: Icon(
                                    controller.value.isPlaying ? LucideIcons.pause : LucideIcons.play,
                                    color: Colors.white,
                                    size: 18,
                                  ),
                                  onPressed: _togglePlay,
                                ),
                                const SizedBox(width: 12),
                                // Time counter
                                Text(
                                  '${_formatDuration(controller.value.position)} / ${_formatDuration(controller.value.duration)}',
                                  style: const TextStyle(
                                    color: Colors.white,
                                    fontSize: 11,
                                    fontFamily: 'monospace',
                                  ),
                                ),
                                const Spacer(),
                                // Volume Controller
                                GestureDetector(
                                  onTap: _toggleMute,
                                  behavior: HitTestBehavior.opaque,
                                  child: Padding(
                                    padding: const EdgeInsets.symmetric(horizontal: 4.0, vertical: 2.0),
                                    child: Icon(
                                      _isMuted || controller.value.volume == 0
                                          ? LucideIcons.volumeX
                                          : controller.value.volume < 0.5
                                              ? LucideIcons.volume1
                                              : LucideIcons.volume2,
                                      color: Colors.white,
                                      size: 16,
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 4),
                                SizedBox(
                                  width: 50,
                                  child: SliderTheme(
                                    data: SliderTheme.of(context).copyWith(
                                      trackHeight: 2.0,
                                      activeTrackColor: Colors.white,
                                      inactiveTrackColor: Colors.white24,
                                      thumbColor: Colors.white,
                                      thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 4.0),
                                      overlayShape: const RoundSliderOverlayShape(overlayRadius: 8.0),
                                    ),
                                    child: Slider(
                                      value: _isMuted ? 0.0 : controller.value.volume,
                                      onChanged: _setVolume,
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 12),
                                // Speed selector trigger
                                InkWell(
                                  onTap: () {
                                    setState(() {
                                      _showSpeedMenu = !_showSpeedMenu;
                                    });
                                  },
                                  borderRadius: BorderRadius.circular(4),
                                  child: Padding(
                                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                    child: Text(
                                      '${_playbackSpeed}x',
                                      style: const TextStyle(
                                        color: Colors.white,
                                        fontSize: 11,
                                        fontWeight: FontWeight.bold,
                                      ),
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 12),
                                IconButton(
                                  padding: EdgeInsets.zero,
                                  constraints: const BoxConstraints(),
                                  icon: const Icon(
                                    LucideIcons.info,
                                    color: Colors.white,
                                    size: 18,
                                  ),
                                  onPressed: () {
                                    setState(() {
                                      _showInfoMenu = !_showInfoMenu;
                                      _showSettingsMenu = false;
                                    });
                                  },
                                ),
                                const SizedBox(width: 12),
                                IconButton(
                                  padding: EdgeInsets.zero,
                                  constraints: const BoxConstraints(),
                                  icon: const Icon(
                                    LucideIcons.settings,
                                    color: Colors.white,
                                    size: 18,
                                  ),
                                  onPressed: () {
                                    setState(() {
                                      _showSettingsMenu = !_showSettingsMenu;
                                      _showInfoMenu = false;
                                    });
                                  },
                                ),
                                if (widget.onFullscreen != null) ...[
                                  const SizedBox(width: 12),
                                  IconButton(
                                    padding: EdgeInsets.zero,
                                    constraints: const BoxConstraints(),
                                    icon: const Icon(
                                      LucideIcons.maximize,
                                      color: Colors.white,
                                      size: 18,
                                    ),
                                    onPressed: widget.onFullscreen,
                                  ),
                                ],
                              ],
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),

            // 8. Custom Subtitles Overlay
            if (_subtitleCues != null && _videoPlayerController != null)
              Positioned(
                bottom: _showControls ? 76.0 : 24.0,
                left: 20,
                right: 20,
                child: Center(
                  child: SubtitleText(
                    cues: _subtitleCues!,
                    position: _videoPlayerController!.value.position,
                  ),
                ),
              ),

            // 9. Playback Settings Panel Drawer
            if (_showSettingsMenu && _showControls)
              Positioned.fill(
                child: Stack(
                  children: [
                    GestureDetector(
                      onTap: () {
                        setState(() {
                          _showSettingsMenu = false;
                        });
                      },
                      child: Container(
                        color: Colors.black26,
                      ),
                    ),
                    Positioned(
                      right: 0,
                      top: 0,
                      bottom: 0,
                      width: 260,
                      child: ClipRRect(
                        child: BackdropFilter(
                          filter: ImageFilter.blur(sigmaX: 15, sigmaY: 15),
                          child: Container(
                            decoration: BoxDecoration(
                              color: Colors.black.withValues(alpha: 0.75),
                              border: const Border(
                                left: BorderSide(
                                  color: Colors.white10,
                                  width: 1.0,
                                ),
                              ),
                            ),
                            child: _buildSettingsContent(),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),

            // 10. Metadata Info Dialog
            if (_showInfoMenu && _showControls)
              Positioned.fill(
                child: Stack(
                  children: [
                    GestureDetector(
                      onTap: () {
                        setState(() {
                          _showInfoMenu = false;
                        });
                      },
                      child: Container(
                        color: Colors.black26,
                      ),
                    ),
                    Center(
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(16),
                        child: BackdropFilter(
                          filter: ImageFilter.blur(sigmaX: 15, sigmaY: 15),
                          child: Container(
                            width: 300,
                            padding: const EdgeInsets.all(20),
                            decoration: BoxDecoration(
                              color: Colors.black.withValues(alpha: 0.8),
                              borderRadius: BorderRadius.circular(16),
                              border: Border.all(
                                color: Colors.white.withValues(alpha: 0.15),
                                width: 1.0,
                              ),
                            ),
                            child: _buildInfoContent(),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

// --- Helper Custom Widgets & Painters ---

class PlayPauseRipple extends StatefulWidget {
  final IconData icon;
  final VoidCallback onComplete;

  const PlayPauseRipple({
    super.key,
    required this.icon,
    required this.onComplete,
  });

  @override
  State<PlayPauseRipple> createState() => _PlayPauseRippleState();
}

class _PlayPauseRippleState extends State<PlayPauseRipple> with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _scaleAnimation;
  late Animation<double> _opacityAnimation;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 500),
    );

    _scaleAnimation = Tween<double>(begin: 0.8, end: 1.6).animate(
      CurvedAnimation(parent: _controller, curve: Curves.easeOut),
    );

    _opacityAnimation = TweenSequence<double>([
      TweenSequenceItem(tween: Tween<double>(begin: 0.0, end: 0.8), weight: 30),
      TweenSequenceItem(tween: Tween<double>(begin: 0.8, end: 0.8), weight: 40),
      TweenSequenceItem(tween: Tween<double>(begin: 0.8, end: 0.0), weight: 30),
    ]).animate(_controller);

    _controller.forward().then((_) => widget.onComplete());
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) {
        return Opacity(
          opacity: _opacityAnimation.value,
          child: Transform.scale(
            scale: _scaleAnimation.value,
            child: Container(
              padding: const EdgeInsets.all(16),
              decoration: const BoxDecoration(
                color: Colors.black38,
                shape: BoxShape.circle,
              ),
              child: Icon(
                widget.icon,
                color: Colors.white,
                size: 32,
              ),
            ),
          ),
        );
      },
    );
  }
}

class DoubleTapSeekIndicator extends StatefulWidget {
  final bool isLeft;
  final VoidCallback onComplete;

  const DoubleTapSeekIndicator({
    super.key,
    required this.isLeft,
    required this.onComplete,
  });

  @override
  State<DoubleTapSeekIndicator> createState() => _DoubleTapSeekIndicatorState();
}

class _DoubleTapSeekIndicatorState extends State<DoubleTapSeekIndicator> with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _opacityAnimation;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 650),
    );
    _opacityAnimation = TweenSequence<double>([
      TweenSequenceItem(tween: Tween<double>(begin: 0.0, end: 1.0), weight: 20),
      TweenSequenceItem(tween: Tween<double>(begin: 1.0, end: 1.0), weight: 60),
      TweenSequenceItem(tween: Tween<double>(begin: 1.0, end: 0.0), weight: 20),
    ]).animate(_controller);

    _controller.forward().then((_) => widget.onComplete());
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) {
        return Opacity(
          opacity: _opacityAnimation.value,
          child: Container(
            width: MediaQuery.of(context).size.width / 3.5,
            decoration: BoxDecoration(
              gradient: RadialGradient(
                center: widget.isLeft ? const Alignment(-1.0, 0.0) : const Alignment(1.0, 0.0),
                radius: 1.2,
                colors: [
                  Colors.white.withValues(alpha: 0.12),
                  Colors.transparent,
                ],
              ),
            ),
            child: Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    widget.isLeft ? LucideIcons.chevronsLeft : LucideIcons.chevronsRight,
                    color: Colors.white,
                    size: 28,
                  ),
                  const SizedBox(height: 6),
                  Text(
                    widget.isLeft ? '-10s' : '+10s',
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 11,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

class PremiumVideoProgressBar extends StatelessWidget {
  final VideoPlayerController controller;
  final VoidCallback onDragStart;
  final VoidCallback onDragEnd;

  const PremiumVideoProgressBar({
    super.key,
    required this.controller,
    required this.onDragStart,
    required this.onDragEnd,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final value = controller.value;
    final duration = value.duration.inMilliseconds.toDouble();
    final position = value.position.inMilliseconds.toDouble();
    final currentMs = position.clamp(0.0, duration > 0 ? duration : 1.0);
    final totalMs = duration > 0 ? duration : 1.0;

    return SliderTheme(
      data: SliderTheme.of(context).copyWith(
        trackHeight: 3.0,
        activeTrackColor: theme.colorScheme.primary,
        inactiveTrackColor: Colors.white24,
        thumbColor: Colors.white,
        thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 5.0),
        overlayShape: const RoundSliderOverlayShape(overlayRadius: 10.0),
        overlayColor: theme.colorScheme.primary.withValues(alpha: 0.2),
        trackShape: PremiumSliderTrackShape(value),
      ),
      child: Slider(
        value: currentMs,
        min: 0.0,
        max: totalMs,
        onChangeStart: (_) => onDragStart(),
        onChangeEnd: (val) {
          controller.seekTo(Duration(milliseconds: val.toInt()));
          onDragEnd();
        },
        onChanged: (val) {
          controller.seekTo(Duration(milliseconds: val.toInt()));
        },
      ),
    );
  }
}

class PremiumSliderTrackShape extends RectangularSliderTrackShape {
  final VideoPlayerValue value;

  PremiumSliderTrackShape(this.value);

  @override
  void paint(
    PaintingContext context,
    Offset offset, {
    required RenderBox parentBox,
    required SliderThemeData sliderTheme,
    required Animation<double> enableAnimation,
    required TextDirection textDirection,
    required Offset thumbCenter,
    Offset? secondaryOffset,
    bool isEnabled = false,
    bool isDiscrete = false,
  }) {
    final Canvas canvas = context.canvas;

    final Rect trackRect = getPreferredRect(
      parentBox: parentBox,
      sliderTheme: sliderTheme,
      offset: offset,
      isDiscrete: isDiscrete,
      isEnabled: isEnabled,
    );

    // 1. Background
    final Paint bgPaint = Paint()..color = sliderTheme.inactiveTrackColor ?? Colors.white24;
    final RRect bgRRect = RRect.fromRectAndRadius(trackRect, const Radius.circular(1.5));
    canvas.drawRRect(bgRRect, bgPaint);

    // 2. Buffered range
    final duration = value.duration.inMilliseconds;
    if (duration > 0) {
      final Paint bufferPaint = Paint()..color = Colors.white.withValues(alpha: 0.22);
      final double width = trackRect.width;
      
      for (final range in value.buffered) {
        final startPct = range.start.inMilliseconds / duration;
        final endPct = range.end.inMilliseconds / duration;
        
        final left = trackRect.left + startPct * width;
        final right = trackRect.left + endPct * width;
        
        final Rect bufferRect = Rect.fromLTRB(
          left,
          trackRect.top,
          right,
          trackRect.bottom,
        );
        canvas.drawRRect(
          RRect.fromRectAndRadius(bufferRect, const Radius.circular(1.5)),
          bufferPaint,
        );
      }
    }

    // 3. Active played track
    final Paint activePaint = Paint()..color = sliderTheme.activeTrackColor ?? Colors.blue;
    final Rect activeRect = Rect.fromLTRB(
      trackRect.left,
      trackRect.top,
      thumbCenter.dx,
      trackRect.bottom,
    );
    canvas.drawRRect(
      RRect.fromRectAndRadius(activeRect, const Radius.circular(1.5)),
      activePaint,
    );
  }
}

class WebVttCue {
  final Duration startTime;
  final Duration endTime;
  final String text;

  WebVttCue({
    required this.startTime,
    required this.endTime,
    required this.text,
  });
}

List<WebVttCue> parseWebVtt(String vttContent) {
  final List<WebVttCue> cues = [];
  final List<String> lines = vttContent.replaceAll('\r\n', '\n').split('\n');

  Duration? parseVttTime(String timeStr) {
    final parts = timeStr.trim().split(':');
    if (parts.isEmpty) return null;

    double seconds = 0.0;
    int minutes = 0;
    int hours = 0;

    try {
      if (parts.length == 3) {
        hours = int.tryParse(parts[0]) ?? 0;
        minutes = int.tryParse(parts[1]) ?? 0;
        seconds = double.tryParse(parts[2]) ?? 0.0;
      } else if (parts.length == 2) {
        minutes = int.tryParse(parts[0]) ?? 0;
        seconds = double.tryParse(parts[1]) ?? 0.0;
      } else {
        return null;
      }
    } catch (_) {
      return null;
    }

    final int millis = (seconds * 1000).round();
    return Duration(hours: hours, minutes: minutes, milliseconds: millis);
  }

  for (int i = 0; i < lines.length; i++) {
    final line = lines[i].trim();
    if (line.contains('-->')) {
      final parts = line.split('-->');
      if (parts.length == 2) {
        final start = parseVttTime(parts[0]);
        final end = parseVttTime(parts[1]);
        if (start != null && end != null) {
          final List<String> textLines = [];
          int j = i + 1;
          while (j < lines.length &&
              !lines[j].trim().contains('-->') &&
              lines[j].trim().isNotEmpty) {
            textLines.add(lines[j].trim());
            j++;
          }
          cues.add(WebVttCue(
            startTime: start,
            endTime: end,
            text: textLines.join('\n'),
          ));
          i = j - 1;
        }
      }
    }
  }

  return cues;
}

class SubtitleText extends StatelessWidget {
  final List<WebVttCue> cues;
  final Duration position;

  const SubtitleText({
    super.key,
    required this.cues,
    required this.position,
  });

  @override
  Widget build(BuildContext context) {
    final currentCue = cues.firstWhere(
      (cue) => position >= cue.startTime && position <= cue.endTime,
      orElse: () => WebVttCue(
        startTime: Duration.zero,
        endTime: Duration.zero,
        text: '',
      ),
    );

    if (currentCue.text.isEmpty) {
      return const SizedBox.shrink();
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.65),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        currentCue.text,
        textAlign: TextAlign.center,
        style: const TextStyle(
          color: Colors.white,
          fontSize: 13,
          fontWeight: FontWeight.w500,
        ),
      ),
    );
  }
}
