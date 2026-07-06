import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../services/api_service.dart';
import '../models.dart';
import '../widgets/premium_image.dart';
import '../widgets/premium_video_player.dart';
import '../widgets/premium_live_photo_player.dart';
import 'media_lightbox.dart';

class PostDetailPage extends StatefulWidget {
  final String postId;

  const PostDetailPage({super.key, required this.postId});

  @override
  State<PostDetailPage> createState() => _PostDetailPageState();
}

class _PostDetailPageState extends State<PostDetailPage> {
  final _apiService = ApiService();
  Post? _post;
  bool _isLoading = true;
  String? _errorMessage;
  int _swiperIndex = 0;
  int? _playingInlineIndex;

  @override
  void initState() {
    super.initState();
    _loadPostDetail();
  }

  Future<void> _loadPostDetail() async {
    if (!mounted) return;
    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    try {
      final post = await _apiService.fetchPostDetail(widget.postId);
      if (!mounted) return;
      setState(() {
        _post = post;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _errorMessage = e.toString().replaceAll('Exception: ', '');
      });
    } finally {
      if (mounted) {
        setState(() {
          _isLoading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Post Details'),
        leading: IconButton(
          icon: const Icon(LucideIcons.arrowLeft),
          onPressed: () => Navigator.pop(context),
        ),
      ),
      body: SafeArea(
        child: Column(
          children: [
            // Content
            Expanded(
              child: _isLoading
                  ? const Center(child: CircularProgressIndicator())
                  : _errorMessage != null
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24.0),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              LucideIcons.alertCircle,
                              size: 48,
                              color: theme.colorScheme.error,
                            ),
                            const SizedBox(height: 16),
                            Text(
                              _errorMessage!,
                              style: TextStyle(
                                color: theme.colorScheme.onSurface,
                                fontSize: 16,
                              ),
                              textAlign: TextAlign.center,
                            ),
                            const SizedBox(height: 24),
                            ElevatedButton(
                              onPressed: _loadPostDetail,
                              style: ElevatedButton.styleFrom(
                                backgroundColor: theme.colorScheme.primary,
                                foregroundColor: theme.colorScheme.onPrimary,
                                shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(6),
                                ),
                              ),
                              child: const Text('Retry'),
                            ),
                          ],
                        ),
                      ),
                    )
                  : _buildPostContent(theme),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildPostContent(ThemeData theme) {
    final post = _post!;
    final isDark = theme.brightness == Brightness.dark;
    final isWide = MediaQuery.of(context).size.width >= 768;

    if (isWide && post.media.isNotEmpty) {
      return Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Left: Media Swiper (fills the remaining space)
          Expanded(
            child: Container(
              color: isDark ? const Color(0xFF09090B) : const Color(0xFFF9FAFB),
              child: _buildMediaSwiper(theme, post, isWideLayout: true),
            ),
          ),
          // Vertical divider
          VerticalDivider(
            width: 1,
            thickness: 1,
            color: isDark ? const Color(0xFF27272A) : const Color(0xFFE5E5E5),
          ),
          // Right: Content Details (fixed width)
          SizedBox(
            width: 420,
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 24.0, vertical: 20.0),
              child: _buildDetailInfoList(theme, post, showMedia: false),
            ),
          ),
        ],
      );
    } else if (isWide) {
      // Wide text-only layout: Centered single column with maximum width of 680
      return Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 680),
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24.0, vertical: 20.0),
            child: _buildDetailInfoList(theme, post, showMedia: false),
          ),
        ),
      );
    } else {
      // Standard mobile layout
      return SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 24.0, vertical: 20.0),
        child: _buildDetailInfoList(theme, post, showMedia: true),
      );
    }
  }

  Widget _buildDetailInfoList(ThemeData theme, Post post, {required bool showMedia}) {
    final isDark = theme.brightness == Brightness.dark;
    final media = post.media.isNotEmpty ? post.media.first : null;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Title
        Text(
          post.title,
          style: theme.textTheme.headlineSmall?.copyWith(
            fontWeight: FontWeight.bold,
            color: isDark ? const Color(0xFFFAFAFA) : const Color(0xFF09090B),
          ),
        ),
        const SizedBox(height: 16),

        // Description Paragraph
        if (post.description != null && post.description!.isNotEmpty) ...[
          Text(
            post.description!,
            style: TextStyle(
              fontSize: 14,
              color: isDark
                  ? const Color(0xFFA1A1AA)
                  : const Color(0xFF4B5563),
              height: 1.5,
            ),
          ),
          const SizedBox(height: 24),
        ],

        // Swiper Carousel
        if (showMedia) _buildMediaSwiper(theme, post, isWideLayout: false),

        const Divider(height: 1),
        const SizedBox(height: 20),

        // Metadata Grid (Replicating grid grid-cols-2 gap-4 from PostDetailInfo.vue)
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: _buildGridMetadataItem(
                    label: 'Author',
                    child: Row(
                      children: [
                        CircleAvatar(
                          radius: 12,
                          backgroundColor:
                              theme.colorScheme.surfaceContainerHighest,
                          backgroundImage: post.authorAvatarUrl != null
                              ? NetworkImage(post.authorAvatarUrl!)
                              : null,
                          child: post.authorAvatarUrl == null
                              ? const Icon(LucideIcons.user, size: 12)
                              : null,
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            post.authorName ?? 'Unknown',
                            style: const TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w500,
                            ),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: _buildGridMetadataItem(
                    label: 'Platform',
                    child: Row(
                      children: [
                        const Icon(
                          LucideIcons.globe,
                          size: 14,
                          color: Color(0xFF9CA3AF),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            post.source?.toUpperCase() ?? 'UNKNOWN',
                            style: const TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: _buildGridMetadataItem(
                    label: 'Created',
                    child: Row(
                      children: [
                        const Icon(
                          LucideIcons.calendar,
                          size: 14,
                          color: Color(0xFF9CA3AF),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            post.publishedTime != null
                                ? post.publishedTime!.substring(0, 10)
                                : 'Unknown',
                            style: const TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: _buildGridMetadataItem(
                    label: 'Dimensions',
                    child: Row(
                      children: [
                        const Icon(
                          LucideIcons.image,
                          size: 14,
                          color: Color(0xFF9CA3AF),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            media != null && media.width != null
                                ? '${media.width} x ${media.height}'
                                : '-',
                            style: const TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
        const SizedBox(height: 24),

        // EID and Link Rows (Full-width containers)
        if (post.eid != null && post.eid!.isNotEmpty) ...[
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: isDark ? const Color(0xFF18181B) : Colors.white,
              border: Border.all(
                color: isDark
                    ? const Color(0xFF27272A)
                    : const Color(0xFFE5E5E5),
              ),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text(
                  'EID',
                  style: TextStyle(color: Color(0xFF6B7280), fontSize: 14),
                ),
                Text(
                  post.eid!,
                  style: const TextStyle(
                    fontFamily: 'monospace',
                    fontWeight: FontWeight.bold,
                    fontSize: 13,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
        ],

        if (post.url != null && post.url!.isNotEmpty) ...[
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: isDark ? const Color(0xFF18181B) : Colors.white,
              border: Border.all(
                color: isDark
                    ? const Color(0xFF27272A)
                    : const Color(0xFFE5E5E5),
              ),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text(
                  'Source',
                  style: TextStyle(color: Color(0xFF6B7280), fontSize: 14),
                ),
                GestureDetector(
                  onTap: () {}, // Handled by standard link clicks
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Text(
                        'Link',
                        style: TextStyle(
                          color: Color(0xFF2563EB),
                          fontWeight: FontWeight.w600,
                          fontSize: 14,
                          decoration: TextDecoration.underline,
                        ),
                      ),
                      const SizedBox(width: 4),
                      Icon(
                        LucideIcons.link,
                        size: 12,
                        color: const Color(0xFF2563EB),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
        ],

        const Divider(height: 1),
        const SizedBox(height: 20),

        // Tags Row
        if (post.tags.isNotEmpty) ...[
          const Row(
            children: [
              Icon(LucideIcons.tag, size: 14, color: Color(0xFF6B7280)),
              SizedBox(width: 8),
              Text(
                'TAGS',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.bold,
                  color: Color(0xFF6B7280),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: post.tags
                .map(
                  (tag) => Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: theme.colorScheme.surfaceContainerHighest,
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      tag,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                )
                .toList(),
          ),
          const SizedBox(height: 24),
        ],
      ],
    );
  }

  Widget _buildGridMetadataItem({
    required String label,
    required Widget child,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          label.toUpperCase(),
          style: const TextStyle(
            color: Color(0xFF9CA3AF),
            fontSize: 10,
            fontWeight: FontWeight.bold,
            letterSpacing: 1.1,
          ),
        ),
        const SizedBox(height: 6),
        child,
      ],
    );
  }

  Widget _buildMediaSwiper(ThemeData theme, Post post, {bool isWideLayout = false}) {
    if (post.media.isEmpty) return const SizedBox.shrink();

    final isDark = theme.brightness == Brightness.dark;

    Widget swiperWidget = ClipRRect(
      borderRadius: BorderRadius.circular(isWideLayout ? 0 : 10),
      child: Stack(
        children: [
          PageView.builder(
            itemCount: post.media.length,
            onPageChanged: (idx) {
              setState(() {
                _swiperIndex = idx;
                _playingInlineIndex = null;
              });
            },
            itemBuilder: (context, idx) {
              final item = post.media[idx];
              MediaTrack? liveTrack;
              if (item.type == 'LIVE_PHOTO') {
                for (final t in item.tracks) {
                  if (t.type == 'VIDEO' && t.purpose == 'CONTENT') {
                    liveTrack = t;
                    break;
                  }
                }
              }
              
              if (item.type == 'VIDEO' && _playingInlineIndex == idx && item.url != null) {
                return PremiumVideoPlayer(
                  videoUrl: item.url!,
                  coverUrl: item.coverUrl,
                  autoPlay: true,
                  tracks: item.tracks,
                  onFullscreen: () {
                    setState(() {
                      _playingInlineIndex = null;
                    });
                    Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (context) => MediaLightbox(
                          mediaList: post.media,
                          initialIndex: idx,
                        ),
                      ),
                    );
                  },
                );
              }

              return GestureDetector(
                onTap: () {
                  if (item.type == 'VIDEO') {
                    setState(() {
                      _playingInlineIndex = idx;
                    });
                  } else {
                    Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (context) => MediaLightbox(
                          mediaList: post.media,
                          initialIndex: idx,
                        ),
                      ),
                    );
                  }
                },
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    if (item.type == 'VIDEO')
                      Stack(
                        fit: StackFit.expand,
                        children: [
                          if (item.coverUrl != null && item.coverUrl!.isNotEmpty)
                            PremiumImage(
                              imageUrl: item.coverUrl!,
                              fit: BoxFit.contain,
                            )
                          else
                            Container(
                              color: Colors.black.withValues(alpha: 0.1),
                              child: Icon(
                                LucideIcons.video,
                                size: 48,
                                color: theme.colorScheme.onSurfaceVariant,
                              ),
                            ),
                          Center(
                            child: Container(
                              padding: const EdgeInsets.all(12),
                              decoration: BoxDecoration(
                                color: Colors.black.withValues(alpha: 0.6),
                                shape: BoxShape.circle,
                              ),
                              child: const Icon(
                                LucideIcons.play,
                                color: Colors.white,
                                size: 32,
                              ),
                            ),
                          ),
                        ],
                      )
                    else if (item.type == 'LIVE_PHOTO' && item.url != null && liveTrack != null)
                      PremiumLivePhotoPlayer(
                        imageUrl: item.url!,
                        videoUrl: liveTrack.url,
                        fit: BoxFit.contain,
                      )
                    else if (item.url != null)
                      PremiumImage(
                        imageUrl: item.url!,
                        fit: BoxFit.contain,
                      )
                    else
                      const Center(child: Text('Unsupported Media')),
                    
                    Positioned(
                      bottom: 0,
                      left: 0,
                      right: 0,
                      child: Container(
                        decoration: BoxDecoration(
                          gradient: LinearGradient(
                            begin: Alignment.bottomCenter,
                            end: Alignment.topCenter,
                            colors: [
                              Colors.black.withValues(alpha: 0.7),
                              Colors.transparent,
                            ],
                          ),
                        ),
                        padding: const EdgeInsets.fromLTRB(16, 24, 16, 12),
                        child: Text(
                          item.title,
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 14,
                            fontWeight: FontWeight.w600,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ),
                  ],
                ),
              );
            },
          ),
          if (post.media.length > 1)
            Positioned(
              top: 12,
              right: 12,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: Colors.black.withValues(alpha: 0.6),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Text(
                  '${_swiperIndex + 1} / ${post.media.length}',
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 11,
                    fontWeight: FontWeight.bold,
                    fontFamily: 'monospace',
                  ),
                ),
              ),
            ),
        ],
      ),
    );

    if (isWideLayout) {
      return Stack(
        children: [
          Positioned.fill(child: swiperWidget),
          if (post.media.length > 1)
            Positioned(
              bottom: 16,
              left: 0,
              right: 0,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: List.generate(
                  post.media.length,
                  (idx) => Container(
                    width: 6,
                    height: 6,
                    margin: const EdgeInsets.symmetric(horizontal: 3),
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: _swiperIndex == idx
                          ? theme.colorScheme.primary
                          : theme.colorScheme.outlineVariant.withValues(alpha: 0.6),
                    ),
                  ),
                ),
              ),
            ),
        ],
      );
    } else {
      final double screenWidth = MediaQuery.of(context).size.width;
      final double swiperWidth = screenWidth - 48; // padding is 24 on each side
      double swiperHeight = 320.0; // larger default

      if (post.media.isNotEmpty) {
        final firstMedia = post.media.first;
        if (firstMedia.width != null &&
            firstMedia.height != null &&
            firstMedia.width! > 0 &&
            firstMedia.height! > 0) {
          final double ar = firstMedia.width! / firstMedia.height!;
          swiperHeight = (swiperWidth / ar).clamp(240.0, 480.0);
        }
      }

      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            height: swiperHeight,
            decoration: BoxDecoration(
              color: isDark ? const Color(0xFF18181B) : const Color(0xFFF9FAFB),
              border: Border.all(
                color: isDark ? const Color(0xFF27272A) : const Color(0xFFE5E5E5),
              ),
              borderRadius: BorderRadius.circular(10),
            ),
            child: swiperWidget,
          ),
          if (post.media.length > 1) ...[
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: List.generate(
                post.media.length,
                (idx) => Container(
                  width: 6,
                  height: 6,
                  margin: const EdgeInsets.symmetric(horizontal: 3),
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: _swiperIndex == idx
                        ? theme.colorScheme.primary
                        : theme.colorScheme.outlineVariant,
                  ),
                ),
              ),
            ),
          ],
          const SizedBox(height: 24),
        ],
      );
    }
  }
}
