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
  final Post? initialPost;

  static final Map<String, Post> detailCache = {};

  const PostDetailPage({
    super.key,
    required this.postId,
    this.initialPost,
  });

  @override
  State<PostDetailPage> createState() => _PostDetailPageState();
}

class _PostDetailPageState extends State<PostDetailPage> {
  final _apiService = ApiService();
  Post? _post;
  bool _isLoading = true;
  String? _errorMessage;
  int _swiperIndex = 0;
  late final PageController _pageController;

  @override
  void initState() {
    super.initState();
    _pageController = PageController(initialPage: 0);
    if (widget.initialPost != null) {
      _post = widget.initialPost;
      _isLoading = false;
      PostDetailPage.detailCache[widget.postId] = widget.initialPost!;
    } else if (PostDetailPage.detailCache.containsKey(widget.postId)) {
      _post = PostDetailPage.detailCache[widget.postId];
      _isLoading = false;
    } else {
      _isLoading = true;
    }
    _loadPostDetail();
  }

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  Future<void> _loadPostDetail() async {
    if (!mounted) return;

    if (_post != null) {
      // Keep existing post rendered while refreshing details in background
      _errorMessage = null;
    } else if (PostDetailPage.detailCache.containsKey(widget.postId)) {
      setState(() {
        _post = PostDetailPage.detailCache[widget.postId];
        _isLoading = false;
        _errorMessage = null;
      });
    } else {
      setState(() {
        _isLoading = true;
        _errorMessage = null;
      });
    }

    try {
      final post = await _apiService.fetchPostDetail(widget.postId);
      PostDetailPage.detailCache[widget.postId] = post;
      if (!mounted) return;
      setState(() {
        _post = post;
        _errorMessage = null;
      });
    } catch (e) {
      if (!mounted) return;
      if (_post == null && !PostDetailPage.detailCache.containsKey(widget.postId)) {
        setState(() {
          _errorMessage = e.toString().replaceAll('Exception: ', '');
        });
      }
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
    final isDark = theme.brightness == Brightness.dark;

    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: Row(
          children: [
            CircleAvatar(
              radius: 14,
              backgroundColor: theme.colorScheme.surfaceContainerHighest,
              backgroundImage: _post?.authorAvatarUrl != null
                  ? NetworkImage(_post!.authorAvatarUrl!)
                  : null,
              child: _post?.authorAvatarUrl == null
                  ? const Icon(LucideIcons.user, size: 14)
                  : null,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text(
                    'Post Details',
                    style: TextStyle(
                      fontSize: 14.5,
                      fontWeight: FontWeight.w600,
                      letterSpacing: -0.2,
                    ),
                  ),
                  if (_post != null && _post!.authorName != null)
                    Text(
                      '${_post!.authorName} · ${_post!.source?.toUpperCase() ?? 'UNKNOWN'}',
                      style: TextStyle(
                        fontSize: 11,
                        color: isDark
                            ? const Color(0xFFA1A1AA)
                            : const Color(0xFF71717A),
                        fontWeight: FontWeight.normal,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                ],
              ),
            ),
          ],
        ),
        leading: IconButton(
          icon: const Icon(LucideIcons.arrowLeft, size: 20),
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
              child: _buildDetailInfoList(theme, post),
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
            child: _buildDetailInfoList(theme, post),
          ),
        ),
      );
    } else {
      // Standard mobile layout: Media on top (full width, no margin), then title and details
      return SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (post.media.isNotEmpty)
              _buildMediaSwiper(theme, post, isWideLayout: false),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24.0, vertical: 20.0),
              child: _buildDetailInfoList(theme, post),
            ),
          ],
        ),
      );
    }
  }

  Widget _buildDetailInfoList(ThemeData theme, Post post) {
    final isDark = theme.brightness == Brightness.dark;
    final media = post.media.isNotEmpty ? post.media.first : null;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Title (Refined 18px font matching Web)
        Text(
          post.title,
          style: TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.bold,
            height: 1.3,
            letterSpacing: -0.3,
            color: isDark ? const Color(0xFFFAFAFA) : const Color(0xFF09090B),
          ),
        ),
        const SizedBox(height: 12),

        // Description Paragraph
        if (post.description != null && post.description!.isNotEmpty) ...[
          Text(
            post.description!,
            style: TextStyle(
              fontSize: 13.5,
              color: isDark ? const Color(0xFFA1A1AA) : const Color(0xFF4B5563),
              height: 1.55,
            ),
          ),
          const SizedBox(height: 20),
        ],

        // Media Assets Swiper Row (Linear/Web style)
        if (post.media.length > 1) ...[
          Row(
            children: [
              const Icon(LucideIcons.layers, size: 13, color: Color(0xFF6B7280)),
              const SizedBox(width: 6),
              const Text(
                'MEDIA ASSETS',
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.bold,
                  letterSpacing: 1.0,
                  color: Color(0xFF6B7280),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                '${_swiperIndex + 1} / ${post.media.length}',
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                  color: Color(0xFF6B7280),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          SizedBox(
            height: 54,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: post.media.length,
              separatorBuilder: (context, index) => const SizedBox(width: 8),
              itemBuilder: (context, idx) {
                final item = post.media[idx];
                final isSelected = idx == _swiperIndex;
                return GestureDetector(
                  onTap: () {
                    setState(() {
                      _swiperIndex = idx;
                    });
                    if (_pageController.hasClients) {
                      _pageController.animateToPage(
                        idx,
                        duration: const Duration(milliseconds: 300),
                        curve: Curves.easeInOut,
                      );
                    }
                  },
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 150),
                    width: 96,
                    decoration: BoxDecoration(
                      color: isDark ? const Color(0xFF18181B) : Colors.white,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(
                        color: isSelected
                            ? const Color(0xFF10B981)
                            : (isDark
                                ? const Color(0xFF27272A)
                                : const Color(0xFFE5E5E5)),
                        width: isSelected ? 1.5 : 1.0,
                      ),
                    ),
                    padding: const EdgeInsets.all(4),
                    child: Row(
                      children: [
                        Container(
                          width: 36,
                          height: 36,
                          decoration: BoxDecoration(
                            color: const Color(0xFF09090B),
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: item.coverUrl != null || item.url != null
                              ? ClipRRect(
                                  borderRadius: BorderRadius.circular(4),
                                  child: Image.network(
                                    item.coverUrl ?? item.url!,
                                    fit: BoxFit.cover,
                                    errorBuilder: (context, error, stackTrace) => Icon(
                                      item.type == 'VIDEO'
                                          ? LucideIcons.film
                                          : LucideIcons.image,
                                      size: 14,
                                      color: Colors.white70,
                                    ),
                                  ),
                                )
                              : Icon(
                                  item.type == 'VIDEO'
                                      ? LucideIcons.film
                                      : LucideIcons.image,
                                  size: 14,
                                  color: Colors.white70,
                                ),
                        ),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                '#${idx + 1}',
                                style: TextStyle(
                                  fontFamily: 'monospace',
                                  fontSize: 10,
                                  fontWeight: FontWeight.bold,
                                  color: isSelected
                                      ? const Color(0xFF10B981)
                                      : (isDark
                                          ? const Color(0xFFA1A1AA)
                                          : const Color(0xFF6B7280)),
                                ),
                              ),
                              Text(
                                item.type,
                                style: const TextStyle(
                                  fontSize: 9,
                                  fontWeight: FontWeight.w600,
                                  color: Color(0xFF9CA3AF),
                                ),
                                overflow: TextOverflow.ellipsis,
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                );
              },
            ),
          ),
          const SizedBox(height: 20),
        ],

        const Divider(height: 1),
        const SizedBox(height: 20),

        // Metadata Grid
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: _buildGridMetadataItem(
                    label: 'Author',
                    isDark: isDark,
                    child: Row(
                      children: [
                        CircleAvatar(
                          radius: 10,
                          backgroundColor:
                              theme.colorScheme.surfaceContainerHighest,
                          backgroundImage: post.authorAvatarUrl != null
                              ? NetworkImage(post.authorAvatarUrl!)
                              : null,
                          child: post.authorAvatarUrl == null
                              ? const Icon(LucideIcons.user, size: 10)
                              : null,
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            post.authorName ?? 'Unknown',
                            style: const TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w500,
                            ),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _buildGridMetadataItem(
                    label: 'Platform',
                    isDark: isDark,
                    child: Row(
                      children: [
                        const Icon(
                          LucideIcons.globe,
                          size: 13,
                          color: Color(0xFF9CA3AF),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            post.source?.toUpperCase() ?? 'UNKNOWN',
                            style: const TextStyle(
                              fontSize: 13,
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
            const SizedBox(height: 12),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: _buildGridMetadataItem(
                    label: 'Created',
                    isDark: isDark,
                    child: Row(
                      children: [
                        const Icon(
                          LucideIcons.calendar,
                          size: 13,
                          color: Color(0xFF9CA3AF),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            post.publishedTime != null
                                ? (post.publishedTime!.length >= 10
                                      ? post.publishedTime!.substring(0, 10)
                                      : post.publishedTime!)
                                : 'Unknown',
                            style: const TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _buildGridMetadataItem(
                    label: 'Dimensions',
                    isDark: isDark,
                    child: Row(
                      children: [
                        const Icon(
                          LucideIcons.image,
                          size: 13,
                          color: Color(0xFF9CA3AF),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            media != null && media.width != null
                                ? '${media.width} x ${media.height}'
                                : '-',
                            style: const TextStyle(
                              fontSize: 13,
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
        const SizedBox(height: 20),

        // EID and Link Rows
        if (post.eid != null && post.eid!.isNotEmpty) ...[
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: isDark ? const Color(0xFF18181B) : const Color(0xFFF9FAFB),
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
                  style: TextStyle(color: Color(0xFF6B7280), fontSize: 13),
                ),
                Text(
                  post.eid!,
                  style: const TextStyle(
                    fontFamily: 'monospace',
                    fontWeight: FontWeight.bold,
                    fontSize: 12.5,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 10),
        ],

        if (post.url != null && post.url!.isNotEmpty) ...[
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: isDark ? const Color(0xFF18181B) : const Color(0xFFF9FAFB),
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
                  style: TextStyle(color: Color(0xFF6B7280), fontSize: 13),
                ),
                GestureDetector(
                  onTap: () {},
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Text(
                        'Link',
                        style: TextStyle(
                          color: Color(0xFF2563EB),
                          fontWeight: FontWeight.w600,
                          fontSize: 13,
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
          const SizedBox(height: 20),
        ],

        const Divider(height: 1),
        const SizedBox(height: 18),

        // Tags Row
        if (post.tags.isNotEmpty) ...[
          const Row(
            children: [
              Icon(LucideIcons.tag, size: 13, color: Color(0xFF6B7280)),
              SizedBox(width: 6),
              Text(
                'TAGS',
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.bold,
                  color: Color(0xFF6B7280),
                  letterSpacing: 1.0,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: post.tags
                .map(
                  (tag) => Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 9,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: isDark
                          ? const Color(0xFF27272A)
                          : const Color(0xFFF1F5F9),
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(
                        color: isDark
                            ? const Color(0xFF3F3F46)
                            : const Color(0xFFE2E8F0),
                        width: 0.5,
                      ),
                    ),
                    child: Text(
                      '#$tag',
                      style: TextStyle(
                        color: isDark
                            ? const Color(0xFFD4D4D8)
                            : const Color(0xFF475569),
                        fontSize: 12,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                )
                .toList(),
          ),
          const SizedBox(height: 20),
        ],
      ],
    );
  }

  Widget _buildGridMetadataItem({
    required String label,
    required Widget child,
    required bool isDark,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: isDark ? const Color(0xFF18181B) : const Color(0xFFF9FAFB),
        border: Border.all(
          color: isDark ? const Color(0xFF27272A) : const Color(0xFFE5E5E5),
        ),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
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
      ),
    );
  }

  Widget _buildMediaSwiper(ThemeData theme, Post post, {bool isWideLayout = false}) {
    if (post.media.isEmpty) return const SizedBox.shrink();

    final isDark = theme.brightness == Brightness.dark;

    Widget swiperWidget = ClipRRect(
      borderRadius: BorderRadius.zero,
      child: Stack(
        children: [
          PageView.builder(
            controller: _pageController,
            itemCount: post.media.length,
            onPageChanged: (idx) {
              setState(() {
                _swiperIndex = idx;
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
              
              if (item.type == 'VIDEO' && (item.playback?.url != null || item.url != null)) {
                return PremiumVideoPlayer(
                  videoUrl: item.playback?.url ?? item.url!,
                  coverUrl: item.coverUrl,
                  autoPlay: idx == _swiperIndex,
                  tracks: item.tracks,
                  playback: item.playback,
                  borderRadius: BorderRadius.zero,
                  onFullscreen: () {
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
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    if (item.type == 'LIVE_PHOTO' && item.url != null && liveTrack != null)
                      PremiumLivePhotoPlayer(
                        imageUrl: item.url!,
                        videoUrl: liveTrack.url,
                        fit: BoxFit.contain,
                      )
                    else if (item.url != null)
                      PremiumImage(
                        imageUrl: item.url!,
                        placeholderUrl: item.coverUrl,
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
          if (post.media.length > 1) ...[
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
            // Left Navigation Button (<)
            if (_swiperIndex > 0)
              Positioned(
                left: 12,
                top: 0,
                bottom: 0,
                child: Center(
                  child: Material(
                    color: Colors.transparent,
                    child: InkWell(
                      onTap: () {
                        if (_pageController.hasClients) {
                          _pageController.previousPage(
                            duration: const Duration(milliseconds: 300),
                            curve: Curves.easeInOut,
                          );
                        }
                      },
                      borderRadius: BorderRadius.circular(20),
                      child: Container(
                        width: 36,
                        height: 36,
                        decoration: BoxDecoration(
                          color: Colors.black.withValues(alpha: 0.5),
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: Colors.white.withValues(alpha: 0.2),
                            width: 1,
                          ),
                        ),
                        child: const Icon(
                          LucideIcons.chevronLeft,
                          color: Colors.white,
                          size: 20,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            // Right Navigation Button (>)
            if (_swiperIndex < post.media.length - 1)
              Positioned(
                right: 12,
                top: 0,
                bottom: 0,
                child: Center(
                  child: Material(
                    color: Colors.transparent,
                    child: InkWell(
                      onTap: () {
                        if (_pageController.hasClients) {
                          _pageController.nextPage(
                            duration: const Duration(milliseconds: 300),
                            curve: Curves.easeInOut,
                          );
                        }
                      },
                      borderRadius: BorderRadius.circular(20),
                      child: Container(
                        width: 36,
                        height: 36,
                        decoration: BoxDecoration(
                          color: Colors.black.withValues(alpha: 0.5),
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: Colors.white.withValues(alpha: 0.2),
                            width: 1,
                          ),
                        ),
                        child: const Icon(
                          LucideIcons.chevronRight,
                          color: Colors.white,
                          size: 20,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          ],
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
      final double swiperWidth = screenWidth; // full screen width without margin
      double swiperHeight = 320.0; // default height

      if (post.media.isNotEmpty) {
        final firstMedia = post.media.first;
        if (firstMedia.width != null &&
            firstMedia.height != null &&
            firstMedia.width! > 0 &&
            firstMedia.height! > 0) {
          final double ar = firstMedia.width! / firstMedia.height!;
          swiperHeight = (swiperWidth / ar).clamp(240.0, 520.0);
        }
      }

      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            height: swiperHeight,
            width: double.infinity,
            color: isDark ? const Color(0xFF18181B) : const Color(0xFFF9FAFB),
            child: swiperWidget,
          ),
          if (post.media.length > 1) ...[
            const SizedBox(height: 10),
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
          const SizedBox(height: 16),
        ],
      );
    }
  }
}
