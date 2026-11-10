import 'dart:async';
import 'package:material_ui/material_ui.dart';
import 'package:flutter/services.dart';
import 'package:video_player/video_player.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:http/http.dart' as http;
import '../services/api_service.dart';
import '../models.dart';
import 'premium_image.dart';

/// A production-grade, seamless video player widget for Flutter.
///
/// **Best Practice Patterns Enforced:**
/// 1. **Native GPU Texture Handoff (`_isVideoReadyToPaint`)**: Native video engines
///    (`AVPlayerLayer` / `MediaCodec`) take 16-50ms after initialization to present
///    the first decoded video frame onto Flutter's `Texture(textureId: id)` surface.
/// 2. **Seamless Cover Dissolve**: Keeps the cover image [posterUrl] rendered at 100% opacity
///    until `_isVideoReadyToPaint` confirms active video frame output, then smoothly
///    dissolves the cover via [AnimatedOpacity] (250ms `Curves.easeOut`), eliminating black flashes.
class PremiumVideoPlayer extends StatefulWidget {
  final MediaPlayback playback;
  final String? posterUrl;
  final double? width;
  final double? height;
  final VoidCallback? onFullscreen;
  final bool autoPlay;
  final ValueChanged<bool>? onControlsVisibilityChanged;
  final BorderRadiusGeometry? borderRadius;

  const PremiumVideoPlayer({
    super.key,
    required this.playback,
    this.posterUrl,
    this.width,
    this.height,
    this.onFullscreen,
    this.autoPlay = false,
    this.onControlsVisibilityChanged,
    this.borderRadius,
  });

  @override
  State<PremiumVideoPlayer> createState() => _PremiumVideoPlayerState();
}

class _PremiumVideoPlayerState extends State<PremiumVideoPlayer> {
  VideoPlayerController? _videoPlayerController;
  bool _isInitializing = true;
  bool _isVideoReadyToPaint = false;
  String? _error;

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
  bool _isFullscreen = false;

  // Gesture Ripples
  IconData? _rippleIcon;
  int _rippleId = 0;
  bool? _seekRippleIsLeft;
  int _seekRippleId = 0;

  // Captions: cues of the selected caption, loaded from its WebVTT file.
  List<WebVttCue>? _subtitleCues;
  String? _selectedCaptionId;

  // Audio renditions the platform player reports for the HLS manifest, in
  // manifest order (the order of `playback.audioTracks`).
  List<VideoAudioTrack> _platformAudioTracks = const [];
  String? _selectedAudioTrackId;

  // Settings overlays
  bool _showSettingsMenu = false;
  bool _showInfoMenu = false;

  @override
  void initState() {
    super.initState();
    _checkAndInitPlayer();
  }

  /// iOS/macOS need HLS (AVPlayer has no DASH); Android plays the same
  /// manifest so there is one code path. Media without a manifest play their
  /// original directly (docs/media_refactor §8.3).
  void _checkAndInitPlayer() {
    _initPlayer(_resolveUrl(widget.playback.sourceUrl));
  }

  Future<void> _initPlayer(String resolvedUrl) async {
    setState(() {
      _isInitializing = true;
      _isVideoReadyToPaint = false;
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
      await _loadPlatformAudioTracks();
      final defaultCaption =
          widget.playback.captions.where((c) => c.isDefault).firstOrNull;
      if (defaultCaption != null) _selectCaption(defaultCaption);

      if (widget.autoPlay) {
        await _videoPlayerController!.play();
      } else {
        Future.delayed(const Duration(milliseconds: 150), () {
          if (mounted && !_isVideoReadyToPaint) {
            setState(() {
              _isVideoReadyToPaint = true;
            });
          }
        });
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
      if (!_isVideoReadyToPaint && _videoPlayerController != null) {
        final val = _videoPlayerController!.value;
        if (val.isInitialized && (val.isPlaying || val.position > Duration.zero)) {
          _isVideoReadyToPaint = true;
        }
      }
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
    if (oldWidget.playback.sourceUrl != widget.playback.sourceUrl) {
      _isVideoReadyToPaint = false;
      _controlsTimer?.cancel();
      _videoPlayerController?.removeListener(_onVideoControllerUpdate);
      _videoPlayerController?.dispose();

      // Reset selections for new video
      _platformAudioTracks = const [];
      _selectedAudioTrackId = null;
      _selectedCaptionId = null;
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
    if (!_showControls ||
        _isSeeking ||
        _showSpeedMenu ||
        _showSettingsMenu ||
        _showInfoMenu ||
        !_videoPlayerController!.value.isPlaying) {
      return;
    }
    _controlsTimer = Timer(const Duration(seconds: 3), () {
      if (mounted &&
          _videoPlayerController!.value.isPlaying &&
          !_isSeeking &&
          !_showSpeedMenu &&
          !_showSettingsMenu &&
          !_showInfoMenu) {
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
        _rippleIcon = null;
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
    if (_videoPlayerController == null ||
        !_videoPlayerController!.value.isPlaying) {
      return;
    }
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
        _volumeBeforeMute = _videoPlayerController!.value.volume > 0
            ? _videoPlayerController!.value.volume
            : 1.0;
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

  String _formatLanguageName(String? lang) {
    if (lang == null || lang.trim().isEmpty) return '';
    final code = lang.trim();
    final lower = code.toLowerCase().replaceAll('_', '-');

    const Map<String, String> langMap = {
      'zh-cn': '简体中文 (zh-CN)',
      'zh-hans': '简体中文 (zh-CN)',
      'zh-tw': '繁體中文 (zh-TW)',
      'zh-hant': '繁體中文 (zh-TW)',
      'zh-hk': '繁體中文 (zh-HK)',
      'zh': '中文 (zh)',
      'en-us': 'English (en-US)',
      'en-gb': 'English (en-GB)',
      'en': 'English (en)',
      'ja-jp': '日本語 (ja-JP)',
      'ja': '日本語 (ja)',
      'ko-kr': '한국어 (ko-KR)',
      'ko': '한국어 (ko)',
      'fr-fr': 'Français (fr-FR)',
      'fr': 'Français (fr)',
      'de-de': 'Deutsch (de-DE)',
      'de': 'Deutsch (de)',
      'es-es': 'Español (es-ES)',
      'es': 'Español (es)',
      'ru-ru': 'Русский (ru-RU)',
      'ru': 'Русский (ru)',
      'pt-br': 'Português (pt-BR)',
      'pt': 'Português (pt)',
      'it-it': 'Italiano (it-IT)',
      'it': 'Italiano (it)',
      'vi-vn': 'Tiếng Việt (vi)',
      'vi': 'Tiếng Việt (vi)',
      'th-th': 'ไทย (th)',
      'th': 'ไทย (th)',
      'id-id': 'Bahasa Indonesia (id)',
      'id': 'Bahasa Indonesia (id)',
      'ar': 'العربية (ar)',
      'hi': 'हिन्दी (hi)',
    };

    if (langMap.containsKey(lower)) {
      return langMap[lower]!;
    }

    final primary = lower.split('-').first;
    const Map<String, String> primaryMap = {
      'zh': '中文',
      'en': 'English',
      'ja': '日本語',
      'ko': '한국어',
      'fr': 'Français',
      'de': 'Deutsch',
      'es': 'Español',
      'ru': 'Русский',
      'pt': 'Português',
      'it': 'Italiano',
      'vi': 'Tiếng Việt',
      'th': 'ไทย',
      'id': 'Bahasa Indonesia',
      'ar': 'العربية',
      'hi': 'हिन्दी',
    };

    if (primaryMap.containsKey(primary)) {
      return '${primaryMap[primary]!} ($code)';
    }

    return code;
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

  Future<void> _selectCaption(PlaybackCaption caption) async {
    setState(() => _selectedCaptionId = caption.id);
    try {
      final response = await http.get(Uri.parse(_resolveUrl(caption.vttUrl)));
      if (response.statusCode != 200) {
        throw Exception('HTTP ${response.statusCode}');
      }
      if (mounted && _selectedCaptionId == caption.id) {
        setState(() => _subtitleCues = parseWebVtt(response.body));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to load captions: $e'),
            backgroundColor: Colors.red,
          ),
        );
      }
    }
  }

  /// Audio tracks can only be switched inside the HLS manifest; direct play
  /// carries the default audio alone (docs/media_refactor §8.1).
  Future<void> _loadPlatformAudioTracks() async {
    final controller = _videoPlayerController!;
    if (widget.playback.hlsUrl == null ||
        widget.playback.audioTracks.length < 2 ||
        !controller.isAudioTrackSupportAvailable()) {
      return;
    }
    try {
      _platformAudioTracks = await controller.getAudioTracks();
      // The platform picks a rendition by system language; the media's default
      // track wins instead, so playback matches the menu and the web player.
      if (!_canSwitchAudio) return;
      final index = widget.playback.audioTracks.indexWhere((t) => t.isDefault);
      if (index < 0 || _platformAudioTracks[index].isSelected) return;
      await controller.selectAudioTrack(_platformAudioTracks[index].id);
    } catch (_) {
      _platformAudioTracks = const [];
    }
  }

  /// The manifest lists its renditions in `playback.audioTracks` order, so
  /// the platform tracks map by position once both lists agree in length.
  bool get _canSwitchAudio =>
      _platformAudioTracks.length == widget.playback.audioTracks.length &&
      _platformAudioTracks.length > 1;

  PlaybackAudioTrack? get _activeAudioTrack {
    final tracks = widget.playback.audioTracks;
    if (tracks.isEmpty) return null;
    return tracks.where((t) => t.id == _selectedAudioTrackId).firstOrNull ??
        tracks.where((t) => t.isDefault).firstOrNull ??
        tracks.first;
  }

  Future<void> _selectAudioTrack(PlaybackAudioTrack track) async {
    final index = widget.playback.audioTracks.indexOf(track);
    setState(() => _selectedAudioTrackId = track.id);
    try {
      await _videoPlayerController?.selectAudioTrack(
        _platformAudioTracks[index].id,
      );
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to switch audio: $e'),
            backgroundColor: Colors.red,
          ),
        );
      }
    }
  }

  bool get _hasSettings =>
      _canSwitchAudio || widget.playback.captions.isNotEmpty;

  Widget _buildSettingsTile({
    required String title,
    String? subtitle,
    required bool isActive,
    required VoidCallback onTap,
  }) {
    const activeTextColor = Colors.white;
    const activeAccentColor = Color(0xFF38BDF8); // Vibrant cyan / sky blue
    final activeBgColor = activeAccentColor.withValues(alpha: 0.15);
    final inactiveTextColor = Colors.white.withValues(alpha: 0.7);

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 150),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          margin: const EdgeInsets.symmetric(vertical: 2),
          decoration: BoxDecoration(
            color: isActive ? activeBgColor : Colors.transparent,
            borderRadius: BorderRadius.circular(8),
            border: isActive
                ? Border.all(
                    color: activeAccentColor.withValues(alpha: 0.4),
                    width: 1,
                  )
                : null,
          ),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      title,
                      style: TextStyle(
                        color: isActive ? activeTextColor : inactiveTextColor,
                        fontSize: 13,
                        fontWeight: isActive ? FontWeight.w600 : FontWeight.normal,
                      ),
                    ),
                    if (subtitle != null && subtitle.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(
                        subtitle,
                        style: TextStyle(
                          color: isActive
                              ? activeAccentColor
                              : Colors.white.withValues(alpha: 0.4),
                          fontSize: 11,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              if (isActive)
                const Icon(
                  LucideIcons.check,
                  color: activeAccentColor,
                  size: 16,
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildSettingsContent() {
    final playback = widget.playback;
    final activeAudio = _activeAudioTrack;

    Widget sectionTitle(String title) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 8.0, horizontal: 4),
      child: Text(
        title,
        style: const TextStyle(
          color: Colors.grey,
          fontSize: 12,
          fontWeight: FontWeight.bold,
        ),
      ),
    );

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
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 16,
                  fontWeight: FontWeight.bold,
                ),
              ),
              IconButton(
                icon: const Icon(
                  LucideIcons.x,
                  color: Colors.white70,
                  size: 20,
                ),
                onPressed: () => setState(() => _showSettingsMenu = false),
              ),
            ],
          ),
          const Divider(color: Colors.white10),

          if (_canSwitchAudio) ...[
            sectionTitle('Audio Track'),
            ...playback.audioTracks.indexed.map((entry) {
              final (index, a) = entry;
              final language = _formatLanguageName(a.language);
              final title = a.label ??
                  (language.isNotEmpty ? language : 'Audio ${index + 1}');
              final details = [
                if (language.isNotEmpty && !title.contains(language)) language,
                a.codec.toUpperCase(),
                '${a.channels} ch',
              ];
              return _buildSettingsTile(
                title: title,
                subtitle: details.join(' • '),
                isActive: a.id == activeAudio?.id,
                onTap: () {
                  _selectAudioTrack(a);
                  setState(() => _showSettingsMenu = false);
                },
              );
            }),
            const Divider(color: Colors.white10),
          ],

          if (playback.captions.isNotEmpty) ...[
            sectionTitle('Subtitles'),
            _buildSettingsTile(
              title: 'Off',
              isActive: _selectedCaptionId == null,
              onTap: () {
                setState(() {
                  _selectedCaptionId = null;
                  _subtitleCues = null;
                  _showSettingsMenu = false;
                });
              },
            ),
            ...playback.captions.indexed.map((entry) {
              final (index, c) = entry;
              final language = _formatLanguageName(c.language);
              var title = c.label ??
                  (language.isNotEmpty ? language : 'Caption ${index + 1}');
              if (c.label != null &&
                  language.isNotEmpty &&
                  !title.contains(language)) {
                title = '$title ($language)';
              }
              return _buildSettingsTile(
                title: title,
                isActive: _selectedCaptionId == c.id,
                onTap: () {
                  _selectCaption(c);
                  setState(() => _showSettingsMenu = false);
                },
              );
            }),
          ],
        ],
      ),
    );
  }

  Widget _buildInfoContent() {
    final playback = widget.playback;
    final video = playback.video;
    final activeAudio = _activeAudioTrack;
    final size = _videoPlayerController?.value.size;

    final resolution = video != null
        ? '${video.width}x${video.height}'
        : (size != null && size.width > 0
              ? '${size.width.toInt()}x${size.height.toInt()}'
              : 'Unknown');
    final duration = _videoPlayerController != null
        ? _formatDuration(_videoPlayerController!.value.duration)
        : 'Unknown';
    final formatStr = playback.hlsUrl != null
        ? 'HLS'
        : 'Direct (${playback.directMimeType})';

    Widget infoRow(String label, String value) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 6.0),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 100,
              child: Text(
                label,
                style: const TextStyle(
                  color: Colors.grey,
                  fontSize: 12,
                  decoration: TextDecoration.none,
                ),
              ),
            ),
            Expanded(
              child: Text(
                value,
                style: const TextStyle(
                  color: Colors.white70,
                  fontSize: 12,
                  decoration: TextDecoration.none,
                ),
              ),
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
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 15,
                  fontWeight: FontWeight.bold,
                ),
              ),
              IconButton(
                icon: const Icon(
                  LucideIcons.x,
                  color: Colors.white70,
                  size: 18,
                ),
                onPressed: () => setState(() => _showInfoMenu = false),
              ),
            ],
          ),
          const Divider(color: Colors.white10),
          infoRow('Format', formatStr),
          infoRow('Resolution', resolution),
          infoRow('Duration', duration),
          infoRow('Video Codec', video?.codecString ?? video?.codec ?? 'Unknown'),
          if (video?.frameRate != null)
            infoRow('Frame Rate', '${video!.frameRate!.toStringAsFixed(2)} fps'),
          infoRow(
            'Audio Codec',
            activeAudio?.codecString ?? activeAudio?.codec ?? 'None',
          ),
          if (activeAudio != null)
            infoRow('Audio Channels', '${activeAudio.channels}'),
        ],
      ),
    );
  }

  String _formatSpeedLabel(double speed) {
    return speed == speed.roundToDouble() ? '${speed.toInt()}×' : '$speed×';
  }

  Widget _buildControlButton({
    Key? key,
    required IconData icon,
    required VoidCallback? onPressed,
    String? tooltip,
    bool emphasized = false,
    bool active = false,
    bool isCenterPlay = false,
  }) {
    final double buttonSize = isCenterPlay ? 52 : (emphasized ? 38 : 34);
    final double iconSize = isCenterPlay ? 26 : (emphasized ? 19 : 17);

    final button = Material(
      key: key,
      color: isCenterPlay
          ? Colors.black.withValues(alpha: 0.65)
          : emphasized
          ? Colors.white.withValues(alpha: 0.18)
          : active
          ? Colors.white.withValues(alpha: 0.22)
          : Colors.white.withValues(alpha: 0.08),
      shape: CircleBorder(
        side: (emphasized || isCenterPlay)
            ? BorderSide(
                color: Colors.white.withValues(alpha: isCenterPlay ? 0.3 : 0.22),
                width: 1,
              )
            : BorderSide.none,
      ),
      child: InkWell(
        onTap: onPressed,
        customBorder: const CircleBorder(),
        child: SizedBox(
          width: buttonSize,
          height: buttonSize,
          child: Icon(
            icon,
            color: Colors.white,
            size: iconSize,
          ),
        ),
      ),
    );

    if (tooltip == null) return button;
    return Tooltip(message: tooltip, child: button);
  }

  Widget _buildPlayerState({
    required Widget child,
    EdgeInsetsGeometry? padding,
  }) {
    return SizedBox(
      width: widget.width,
      height: widget.height ?? 200,
      child: ClipRRect(
        borderRadius: widget.borderRadius ?? BorderRadius.zero,
        child: ColoredBox(
          color: const Color(0xFF09090B),
          child: Padding(padding: padding ?? EdgeInsets.zero, child: child),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    if (_error != null) {
      return _buildPlayerState(
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
              OutlinedButton.icon(
                onPressed: _checkAndInitPlayer,
                icon: const Icon(LucideIcons.refreshCw, size: 15),
                label: const Text('Retry'),
              ),
            ],
          ),
        ),
      );
    }

    if (_videoPlayerController == null) {
      return _buildPlayerState(
        child: Stack(
          fit: StackFit.expand,
          children: [
            if (widget.posterUrl != null && widget.posterUrl!.isNotEmpty)
              PremiumImage(
                imageUrl: widget.posterUrl!,
                fit: BoxFit.contain,
              ),
            const Center(
              child: SizedBox(
                width: 28,
                height: 28,
                child: CircularProgressIndicator(
                  strokeWidth: 2.5,
                  valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                ),
              ),
            ),
          ],
        ),
      );
    }

    final controller = _videoPlayerController!;
    final showCoverOverlay = !_isVideoReadyToPaint || _isInitializing || !controller.value.isInitialized;

    return ClipRRect(
      borderRadius: widget.borderRadius ?? BorderRadius.zero,
      child: ColoredBox(
        color: const Color(0xFF050506),
        child: Stack(
          fit: StackFit.expand,
          children: [
            Center(
              child: controller.value.isInitialized
                  ? AspectRatio(
                      aspectRatio: controller.value.aspectRatio,
                      child: VideoPlayer(controller),
                    )
                  : (widget.posterUrl != null && widget.posterUrl!.isNotEmpty
                      ? PremiumImage(
                          imageUrl: widget.posterUrl!,
                          fit: BoxFit.contain,
                        )
                      : Container(color: Colors.black)),
            ),

            if (widget.posterUrl != null && widget.posterUrl!.isNotEmpty)
              Positioned.fill(
                child: AnimatedOpacity(
                  opacity: showCoverOverlay ? 1.0 : 0.0,
                  duration: const Duration(milliseconds: 250),
                  curve: Curves.easeInOut,
                  child: IgnorePointer(
                    ignoring: !showCoverOverlay,
                    child: PremiumImage(
                      imageUrl: widget.posterUrl!,
                      fit: BoxFit.contain,
                    ),
                  ),
                ),
              ),

            GestureDetector(
              behavior: HitTestBehavior.translucent,
              onTap: _toggleControls,
              onDoubleTapDown: (TapDownDetails details) {
                final RenderBox box = context.findRenderObject() as RenderBox;
                if (details.localPosition.dx < box.size.width / 2) {
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

            if (_isInitializing || !controller.value.isInitialized)
              Center(
                child: Container(
                  width: 52,
                  height: 52,
                  decoration: BoxDecoration(
                    color: Colors.black.withValues(alpha: 0.55),
                    shape: BoxShape.circle,
                  ),
                  child: const Center(
                    child: SizedBox(
                      width: 24,
                      height: 24,
                      child: CircularProgressIndicator(
                        strokeWidth: 2.5,
                        valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                      ),
                    ),
                  ),
                ),
              )
            else if (!controller.value.isPlaying && _rippleIcon == null)
              Center(
                child: AnimatedSwitcher(
                  duration: const Duration(milliseconds: 180),
                  child: _buildControlButton(
                    key: const ValueKey('center-play'),
                    icon: LucideIcons.play,
                    tooltip: 'Play',
                    isCenterPlay: true,
                    onPressed: _togglePlay,
                  ),
                ),
              ),

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

            if (_isLongPressFastForward)
              Positioned(
                top: 18,
                left: 0,
                right: 0,
                child: Center(
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: Colors.black.withValues(alpha: 0.72),
                      borderRadius: BorderRadius.circular(999),
                      border: Border.all(
                        color: Colors.white.withValues(alpha: 0.14),
                      ),
                    ),
                    child: const Padding(
                      padding: EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 7,
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            LucideIcons.fastForward,
                            color: Colors.white,
                            size: 14,
                          ),
                          SizedBox(width: 7),
                          Text(
                            '2× speed',
                            style: TextStyle(
                              color: Colors.white,
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),

            Positioned(
              bottom: 0,
              left: 0,
              right: 0,
              child: IgnorePointer(
                ignoring: !_showControls,
                child: AnimatedOpacity(
                  opacity: _showControls ? 1.0 : 0.0,
                  duration: const Duration(milliseconds: 220),
                  curve: Curves.easeOut,
                  child: Container(
                    padding: const EdgeInsets.fromLTRB(14, 34, 14, 14),
                    decoration: const BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [Colors.transparent, Color(0xE6000000)],
                      ),
                    ),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
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
                        const SizedBox(height: 3),
                        LayoutBuilder(
                          builder: (context, constraints) {
                            final isMobile =
                                theme.platform == TargetPlatform.iOS ||
                                theme.platform == TargetPlatform.android;
                            final isCompact = constraints.maxWidth < 430;
                            final isVeryCompact = constraints.maxWidth < 330;
                            final spacing = isVeryCompact ? 5.0 : 8.0;
                            final showVolumeSlider = !isMobile && !isCompact;
                            final showInfoButton = !isVeryCompact;

                            return Row(
                              children: [
                                _buildControlButton(
                                  icon: controller.value.isPlaying
                                      ? LucideIcons.pause
                                      : LucideIcons.play,
                                  tooltip: controller.value.isPlaying
                                      ? 'Pause'
                                      : 'Play',
                                  emphasized: true,
                                  onPressed: _togglePlay,
                                ),
                                SizedBox(width: spacing),
                                _buildControlButton(
                                  icon: _isMuted || controller.value.volume == 0
                                      ? LucideIcons.volumeX
                                      : controller.value.volume < 0.5
                                      ? LucideIcons.volume1
                                      : LucideIcons.volume2,
                                  tooltip: _isMuted ? 'Unmute' : 'Mute',
                                  active: _isMuted,
                                  onPressed: _toggleMute,
                                ),
                                if (showVolumeSlider) ...[
                                  const SizedBox(width: 2),
                                  SizedBox(
                                    width: 56,
                                    child: SliderTheme(
                                      data: SliderTheme.of(context).copyWith(
                                        trackHeight: 3,
                                        activeTrackColor: Colors.white,
                                        inactiveTrackColor: Colors.white24,
                                        thumbColor: Colors.white,
                                        thumbShape: const RoundSliderThumbShape(
                                          enabledThumbRadius: 4,
                                        ),
                                        overlayShape:
                                            const RoundSliderOverlayShape(
                                              overlayRadius: 8,
                                            ),
                                      ),
                                      child: Slider(
                                        value: _isMuted
                                            ? 0.0
                                            : controller.value.volume,
                                        onChanged: _setVolume,
                                      ),
                                    ),
                                  ),
                                ],
                                SizedBox(width: spacing + 2),
                                Text(
                                  '${_formatDuration(controller.value.position)} / ${_formatDuration(controller.value.duration)}',
                                  maxLines: 1,
                                  overflow: TextOverflow.fade,
                                  softWrap: false,
                                  style: TextStyle(
                                    color: Colors.white.withValues(
                                      alpha: 0.9,
                                    ),
                                    fontSize: isCompact ? 10 : 11,
                                    fontWeight: FontWeight.w600,
                                    fontFeatures: const [
                                      FontFeature.tabularFigures(),
                                    ],
                                  ),
                                ),
                                const Spacer(),
                                Material(
                                  color: Colors.white.withValues(alpha: 0.08),
                                  borderRadius: BorderRadius.circular(999),
                                  child: InkWell(
                                    onTap: () {
                                      setState(() {
                                        _showSpeedMenu = !_showSpeedMenu;
                                        _showInfoMenu = false;
                                        _showSettingsMenu = false;
                                      });
                                      if (_showSpeedMenu) {
                                        _cancelControlsTimer();
                                      }
                                    },
                                    borderRadius: BorderRadius.circular(999),
                                    child: Padding(
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 10,
                                        vertical: 8,
                                      ),
                                      child: Text(
                                        _formatSpeedLabel(_playbackSpeed),
                                        style: TextStyle(
                                          color: Colors.white.withValues(
                                            alpha: 0.92,
                                          ),
                                          fontSize: isCompact ? 10 : 11,
                                          fontWeight: FontWeight.w700,
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                                if (showInfoButton) ...[
                                  SizedBox(width: spacing),
                                  _buildControlButton(
                                    icon: LucideIcons.info,
                                    tooltip: 'Video information',
                                    active: _showInfoMenu,
                                    onPressed: () {
                                      setState(() {
                                        _showInfoMenu = !_showInfoMenu;
                                        _showSettingsMenu = false;
                                        _showSpeedMenu = false;
                                      });
                                      _cancelControlsTimer();
                                    },
                                  ),
                                ],
                                if (_hasSettings) ...[
                                  SizedBox(width: spacing),
                                  _buildControlButton(
                                    icon: LucideIcons.settings2,
                                    tooltip: 'Settings',
                                    active: _showSettingsMenu,
                                    onPressed: () {
                                      setState(() {
                                        _showSettingsMenu = !_showSettingsMenu;
                                        _showInfoMenu = false;
                                        _showSpeedMenu = false;
                                      });
                                      _cancelControlsTimer();
                                    },
                                  ),
                                ],
                                SizedBox(width: spacing),
                                _buildControlButton(
                                  icon: _isFullscreen ? LucideIcons.minimize : LucideIcons.maximize,
                                  tooltip: _isFullscreen ? 'Exit Fullscreen' : 'Fullscreen',
                                  onPressed: () {
                                    setState(() {
                                      _isFullscreen = !_isFullscreen;
                                    });
                                    if (widget.onFullscreen != null) {
                                      widget.onFullscreen!();
                                    }
                                    if (_isFullscreen) {
                                      SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
                                    } else {
                                      SystemChrome.setEnabledSystemUIMode(SystemUiMode.manual, overlays: SystemUiOverlay.values);
                                    }
                                  },
                                ),
                              ],
                            );
                          },
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),

            if (_showSpeedMenu && _showControls)
              Positioned(
                bottom: 86,
                right: 14,
                child: Material(
                  color: const Color(0xFF171719),
                  elevation: 12,
                  shadowColor: Colors.black.withValues(alpha: 0.5),
                  borderRadius: BorderRadius.circular(12),
                  clipBehavior: Clip.antiAlias,
                  child: Container(
                    width: 104,
                    decoration: BoxDecoration(
                      border: Border.all(
                        color: Colors.white.withValues(alpha: 0.12),
                      ),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Padding(
                          padding: EdgeInsets.fromLTRB(13, 11, 13, 7),
                          child: Align(
                            alignment: Alignment.centerLeft,
                            child: Text(
                              'Speed',
                              style: TextStyle(
                                color: Colors.white54,
                                fontSize: 10,
                                fontWeight: FontWeight.w700,
                                letterSpacing: 0.4,
                              ),
                            ),
                          ),
                        ),
                        ...[0.5, 0.75, 1.0, 1.25, 1.5, 2.0].map((speed) {
                          final isSelected = _playbackSpeed == speed;
                          return InkWell(
                            onTap: () => _changeSpeed(speed),
                            child: Container(
                              width: double.infinity,
                              padding: const EdgeInsets.symmetric(
                                horizontal: 13,
                                vertical: 9,
                              ),
                              color: isSelected
                                  ? Colors.white.withValues(alpha: 0.1)
                                  : Colors.transparent,
                              child: Row(
                                children: [
                                  Expanded(
                                    child: Text(
                                      _formatSpeedLabel(speed),
                                      style: TextStyle(
                                        color: isSelected
                                            ? Colors.white
                                            : Colors.white70,
                                        fontSize: 12,
                                        fontWeight: isSelected
                                            ? FontWeight.w700
                                            : FontWeight.w500,
                                      ),
                                    ),
                                  ),
                                  if (isSelected)
                                    const Icon(
                                      LucideIcons.check,
                                      color: Colors.white,
                                      size: 14,
                                    ),
                                ],
                              ),
                            ),
                          );
                        }),
                      ],
                    ),
                  ),
                ),
              ),

            if (_subtitleCues != null && _videoPlayerController != null)
              Positioned(
                bottom: _showControls ? 96.0 : 24.0,
                left: 20,
                right: 20,
                child: Center(
                  child: SubtitleText(
                    cues: _subtitleCues!,
                    position: _videoPlayerController!.value.position,
                  ),
                ),
              ),

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
                      child: Container(color: Colors.black26),
                    ),
                    Positioned(
                      right: 0,
                      top: 0,
                      bottom: 0,
                      width: 260,
                      child: Material(
                        color: const Color(0xFF111113),
                        elevation: 18,
                        child: Container(
                          decoration: BoxDecoration(
                            border: Border(
                              left: BorderSide(
                                color: Colors.white.withValues(alpha: 0.12),
                              ),
                            ),
                          ),
                          child: _buildSettingsContent(),
                        ),
                      ),
                    ),
                  ],
                ),
              ),

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
                      child: Container(color: Colors.black26),
                    ),
                    Center(
                      child: Material(
                        color: const Color(0xFF171719),
                        elevation: 20,
                        borderRadius: BorderRadius.circular(16),
                        child: Container(
                          width: 300,
                          padding: const EdgeInsets.fromLTRB(20, 16, 20, 18),
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(16),
                            border: Border.all(
                              color: Colors.white.withValues(alpha: 0.12),
                            ),
                          ),
                          child: _buildInfoContent(),
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

class _PlayPauseRippleState extends State<PlayPauseRipple>
    with SingleTickerProviderStateMixin {
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

    _scaleAnimation = Tween<double>(
      begin: 0.8,
      end: 1.6,
    ).animate(CurvedAnimation(parent: _controller, curve: Curves.easeOut));

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
              child: Icon(widget.icon, color: Colors.white, size: 32),
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

class _DoubleTapSeekIndicatorState extends State<DoubleTapSeekIndicator>
    with SingleTickerProviderStateMixin {
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
        return LayoutBuilder(
          builder: (context, constraints) {
            return Opacity(
              opacity: _opacityAnimation.value,
              child: SizedBox(
                width: constraints.maxWidth.isFinite
                    ? constraints.maxWidth * 0.34
                    : 120,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: RadialGradient(
                      center: widget.isLeft
                          ? const Alignment(-1.0, 0.0)
                          : const Alignment(1.0, 0.0),
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
                          widget.isLeft
                              ? LucideIcons.chevronsLeft
                              : LucideIcons.chevronsRight,
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
              ),
            );
          },
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
    final Paint bgPaint = Paint()
      ..color = sliderTheme.inactiveTrackColor ?? Colors.white24;
    final RRect bgRRect = RRect.fromRectAndRadius(
      trackRect,
      const Radius.circular(1.5),
    );
    canvas.drawRRect(bgRRect, bgPaint);

    // 2. Buffered range
    final duration = value.duration.inMilliseconds;
    if (duration > 0) {
      final Paint bufferPaint = Paint()
        ..color = Colors.white.withValues(alpha: 0.22);
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
    final Paint activePaint = Paint()
      ..color = sliderTheme.activeTrackColor ?? Colors.blue;
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
          cues.add(
            WebVttCue(
              startTime: start,
              endTime: end,
              text: textLines.join('\n'),
            ),
          );
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

  const SubtitleText({super.key, required this.cues, required this.position});

  @override
  Widget build(BuildContext context) {
    final currentCue = cues.firstWhere(
      (cue) => position >= cue.startTime && position <= cue.endTime,
      orElse: () =>
          WebVttCue(startTime: Duration.zero, endTime: Duration.zero, text: ''),
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
