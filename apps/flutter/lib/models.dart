class User {
  final String id;
  final String email;
  final String name;
  final String? image;

  User({required this.id, required this.email, required this.name, this.image});

  factory User.fromJson(Map<String, dynamic> json) {
    return User(
      id: json['id'] as String,
      email: json['email'] as String,
      name: json['name'] as String,
      image: json['image'] as String?,
    );
  }
}

class Session {
  final String token;

  Session({required this.token});

  factory Session.fromJson(Map<String, dynamic> json) {
    return Session(token: json['token'] as String);
  }
}

class LibraryItem {
  final String id;
  final String name;
  final String description;

  LibraryItem({
    required this.id,
    required this.name,
    required this.description,
  });

  factory LibraryItem.fromJson(Map<String, dynamic> json) {
    return LibraryItem(
      id: json['id'] as String,
      name: json['name'] as String,
      description: (json['description'] as String?) ?? '',
    );
  }
}

class MediaTrack {
  final String id;
  final String fileId;
  final String url;
  final String type; // e.g., "IMAGE", "VIDEO", "AUDIO", "SUBTITLE"
  final String purpose; // e.g., "CONTENT", "COVER"
  final bool isOriginal;
  final String? quality;
  final int priority;
  final Map<String, dynamic> metadata;
  final String? variantKey;
  final bool isDefault;
  final String? displayName;
  final String? language;
  final String? codec;
  final bool isStale;

  MediaTrack({
    required this.id,
    required this.fileId,
    required this.url,
    required this.type,
    required this.purpose,
    required this.isOriginal,
    this.quality,
    required this.priority,
    required this.metadata,
    this.variantKey,
    required this.isDefault,
    this.displayName,
    this.language,
    this.codec,
    required this.isStale,
  });

  factory MediaTrack.fromJson(Map<String, dynamic> json) {
    return MediaTrack(
      id: json['id'] as String,
      fileId: (json['file_id'] as String?) ?? '',
      url: (json['url'] as String?) ?? '',
      type: (json['type'] as String?) ?? '',
      purpose: (json['purpose'] as String?) ?? '',
      isOriginal: (json['is_original'] as bool?) ?? false,
      quality: json['quality'] as String?,
      priority: (json['priority'] as int?) ?? 0,
      metadata: (json['metadata'] as Map?)?.map(
            (k, v) => MapEntry(k.toString(), v),
          ) ?? {},
      variantKey: json['variant_key'] as String?,
      isDefault: (json['is_default'] as bool?) ?? false,
      displayName: json['display_name'] as String?,
      language: json['language'] as String?,
      codec: json['codec'] as String?,
      isStale: (json['is_stale'] as bool?) ?? false,
    );
  }
}

class Media {
  final String id;
  final String? eid;
  final String? source;
  final String title;
  final String? description;
  final String type; // e.g., "IMAGE", "VIDEO"
  final int sortOrder;
  final String? createTime;
  final String? publishedTime;
  final String? url;
  final String? coverUrl;
  final int? width;
  final int? height;
  final List<MediaTrack> tracks;

  Media({
    required this.id,
    this.eid,
    this.source,
    required this.title,
    this.description,
    required this.type,
    required this.sortOrder,
    this.createTime,
    this.publishedTime,
    this.url,
    this.coverUrl,
    this.width,
    this.height,
    required this.tracks,
  });

  factory Media.fromJson(Map<String, dynamic> json) {
    var tracksList = <MediaTrack>[];
    if (json['tracks'] is List) {
      tracksList = (json['tracks'] as List)
          .map((t) => MediaTrack.fromJson(Map<String, dynamic>.from(t as Map)))
          .toList();
    }

    return Media(
      id: json['id'] as String,
      eid: json['eid'] as String?,
      source: json['source'] as String?,
      title: (json['title'] as String?) ?? '',
      description: json['description'] as String?,
      type: (json['type'] as String?) ?? 'IMAGE',
      sortOrder: (json['sort_order'] as int?) ?? 0,
      createTime: json['create_time'] as String?,
      publishedTime: json['published_time'] as String?,
      url: json['url'] as String?,
      coverUrl: json['cover_url'] as String?,
      width: json['width'] as int?,
      height: json['height'] as int?,
      tracks: tracksList,
    );
  }
}

class Post {
  final String id;
  final String? eid;
  final String title;
  final String? source;
  final String? authorName;
  final String? createTime;
  final String? publishedTime;
  final String? url;
  final String? syncStatus;
  final String? lastError;
  final String? authorAvatarUrl;
  final String? description;
  final List<String> tags;
  final List<Media> media;

  Post({
    required this.id,
    this.eid,
    required this.title,
    this.source,
    this.authorName,
    this.createTime,
    this.publishedTime,
    this.url,
    this.syncStatus,
    this.lastError,
    this.authorAvatarUrl,
    this.description,
    required this.tags,
    required this.media,
  });

  factory Post.fromJson(Map<String, dynamic> json) {
    var tagsList = <String>[];
    if (json['tags'] is List) {
      tagsList = (json['tags'] as List).map((t) => t.toString()).toList();
    }

    var mediaList = <Media>[];
    if (json['media'] is List) {
      mediaList = (json['media'] as List)
          .map((m) => Media.fromJson(Map<String, dynamic>.from(m as Map)))
          .toList();
    }

    return Post(
      id: json['id'] as String,
      eid: json['eid'] as String?,
      title: (json['title'] as String?) ?? 'Untitled',
      source: json['source'] as String?,
      authorName: json['author_name'] as String?,
      createTime: json['create_time'] as String?,
      publishedTime: json['published_time'] as String?,
      url: json['url'] as String?,
      syncStatus: json['sync_status'] as String?,
      lastError: json['last_error'] as String?,
      authorAvatarUrl: json['author_avatar_url'] as String?,
      description: json['description'] as String?,
      tags: tagsList,
      media: mediaList,
    );
  }
}
class MediaPreviewItem {
  final String? url;
  final String type; // e.g., "VIDEO", "IMAGE", "AUDIO"
  final String quality; // e.g., "LOW", "MEDIUM", "HIGH", "ORIGINAL"
  final String? codec;

  MediaPreviewItem({
    this.url,
    required this.type,
    required this.quality,
    this.codec,
  });

  factory MediaPreviewItem.fromJson(Map<String, dynamic> json) {
    return MediaPreviewItem(
      url: json['url'] as String?,
      type: (json['type'] as String?) ?? 'IMAGE',
      quality: (json['quality'] as String?) ?? 'ORIGINAL',
      codec: json['codec'] as String?,
    );
  }
}

class MediaPreview {
  final String id;
  final String? eid;
  final String? source;
  final String title;
  final String? description;
  final String type;
  final int sortOrder;
  final String? createTime;
  final String? publishedTime;
  final String? url;
  final String? coverUrl;
  final int? width;
  final int? height;
  final List<MediaPreviewItem> covers;
  final List<MediaPreviewItem> videos;
  final List<MediaPreviewItem> audios;

  MediaPreview({
    required this.id,
    this.eid,
    this.source,
    required this.title,
    this.description,
    required this.type,
    required this.sortOrder,
    this.createTime,
    this.publishedTime,
    this.url,
    this.coverUrl,
    this.width,
    this.height,
    required this.covers,
    required this.videos,
    required this.audios,
  });

  factory MediaPreview.fromJson(Map<String, dynamic> json) {
    var coversList = <MediaPreviewItem>[];
    if (json['covers'] is List) {
      coversList = (json['covers'] as List)
          .map((c) => MediaPreviewItem.fromJson(Map<String, dynamic>.from(c as Map)))
          .toList();
    }

    var videosList = <MediaPreviewItem>[];
    if (json['videos'] is List) {
      videosList = (json['videos'] as List)
          .map((v) => MediaPreviewItem.fromJson(Map<String, dynamic>.from(v as Map)))
          .toList();
    }

    var audiosList = <MediaPreviewItem>[];
    if (json['audios'] is List) {
      audiosList = (json['audios'] as List)
          .map((a) => MediaPreviewItem.fromJson(Map<String, dynamic>.from(a as Map)))
          .toList();
    }

    // Resolve coverUrl
    String? resolvedCoverUrl;
    final mediumCover = coversList.firstWhere(
      (c) => c.quality.toUpperCase() == 'MEDIUM',
      orElse: () => MediaPreviewItem(type: 'IMAGE', quality: ''),
    );
    if (mediumCover.url != null) {
      resolvedCoverUrl = mediumCover.url;
    } else {
      final lowCover = coversList.firstWhere(
        (c) => c.quality.toUpperCase() == 'LOW',
        orElse: () => MediaPreviewItem(type: 'IMAGE', quality: ''),
      );
      if (lowCover.url != null) {
        resolvedCoverUrl = lowCover.url;
      } else {
        final highCover = coversList.firstWhere(
          (c) => c.quality.toUpperCase() == 'HIGH',
          orElse: () => MediaPreviewItem(type: 'IMAGE', quality: ''),
        );
        if (highCover.url != null) {
          resolvedCoverUrl = highCover.url;
        } else {
          final originalCover = coversList.firstWhere(
            (c) => c.quality.toUpperCase() == 'ORIGINAL',
            orElse: () => MediaPreviewItem(type: 'IMAGE', quality: ''),
          );
          resolvedCoverUrl = originalCover.url ?? json['cover_url'] as String? ?? json['url'] as String?;
        }
      }
    }

    // Resolve url
    String? resolvedUrl;
    if (json['type'] == 'VIDEO') {
      final originalVideo = videosList.firstWhere(
        (v) => v.quality.toUpperCase() == 'ORIGINAL',
        orElse: () => MediaPreviewItem(type: 'VIDEO', quality: ''),
      );
      resolvedUrl = originalVideo.url ?? (videosList.isNotEmpty ? videosList.first.url : null) ?? json['url'] as String?;
    } else {
      final originalCover = coversList.firstWhere(
        (c) => c.quality.toUpperCase() == 'ORIGINAL',
        orElse: () => MediaPreviewItem(type: 'IMAGE', quality: ''),
      );
      resolvedUrl = originalCover.url ?? resolvedCoverUrl ?? json['url'] as String?;
    }

    return MediaPreview(
      id: json['id'] as String,
      eid: json['eid'] as String?,
      source: json['source'] as String?,
      title: (json['title'] as String?) ?? '',
      description: json['description'] as String?,
      type: (json['type'] as String?) ?? 'IMAGE',
      sortOrder: (json['sort_order'] as int?) ?? 0,
      createTime: json['create_time'] as String?,
      publishedTime: json['published_time'] as String?,
      url: resolvedUrl,
      coverUrl: resolvedCoverUrl,
      width: json['width'] as int?,
      height: json['height'] as int?,
      covers: coversList,
      videos: videosList,
      audios: audiosList,
    );
  }

  /// Helper to dynamically pick the closest image quality URL to the requested width.
  String getImageUrlForWidth(double width, {double devicePixelRatio = 2.0}) {
    if (covers.isEmpty) return coverUrl ?? url ?? '';

    // Use target width multiplied by the actual device pixel ratio to get required physical pixels.
    double targetWidth = width * devicePixelRatio;

    // Cloudflare uses "scale-down" fit mode with square bounding boxes (360x360, 720x720, etc.).
    // For vertical (portrait) images, this scale-down reduces the actual physical width of the image.
    // We adjust targetWidth upwards to compensate for the aspect ratio.
    if (this.width != null && this.height != null && this.height! > this.width!) {
      final double aspectRatio = this.width! / this.height!;
      if (aspectRatio > 0) {
        targetWidth = targetWidth / aspectRatio;
      }
    }

    int getWidthOfQuality(String q) {
      switch (q.toUpperCase()) {
        case 'LOW':
          return 360;
        case 'MEDIUM':
          return 720;
        case 'HIGH':
          return 1440;
        case 'ORIGINAL':
          return 3840;
        default:
          return 0;
      }
    }

    final sortedCovers = List<MediaPreviewItem>.from(covers)
      ..sort((a, b) => getWidthOfQuality(a.quality).compareTo(getWidthOfQuality(b.quality)));

    for (var c in sortedCovers) {
      if (getWidthOfQuality(c.quality) >= targetWidth) {
        return c.url ?? '';
      }
    }
    return sortedCovers.isNotEmpty ? (sortedCovers.last.url ?? '') : (coverUrl ?? url ?? '');
  }
}

class PostListItem {
  final String id;
  final String? eid;
  final String title;
  final String? source;
  final String? authorName;
  final String? createTime;
  final String? publishedTime;
  final String? url;
  final String? syncStatus;
  final String? lastError;
  final String? authorAvatarUrl;
  final String? description;
  final List<String> tags;
  final List<MediaPreview> media;

  PostListItem({
    required this.id,
    this.eid,
    required this.title,
    this.source,
    this.authorName,
    this.createTime,
    this.publishedTime,
    this.url,
    this.syncStatus,
    this.lastError,
    this.authorAvatarUrl,
    this.description,
    required this.tags,
    required this.media,
  });

  factory PostListItem.fromJson(Map<String, dynamic> json) {
    var tagsList = <String>[];
    if (json['tags'] is List) {
      tagsList = (json['tags'] as List).map((t) => t.toString()).toList();
    }

    var mediaList = <MediaPreview>[];
    if (json['media'] is List) {
      mediaList = (json['media'] as List)
          .map((m) => MediaPreview.fromJson(Map<String, dynamic>.from(m as Map)))
          .toList();
    }

    return PostListItem(
      id: json['id'] as String,
      eid: json['eid'] as String?,
      title: (json['title'] as String?) ?? 'Untitled',
      source: json['source'] as String?,
      authorName: json['author_name'] as String?,
      createTime: json['create_time'] as String?,
      publishedTime: json['published_time'] as String?,
      url: json['url'] as String?,
      syncStatus: json['sync_status'] as String?,
      lastError: json['last_error'] as String?,
      authorAvatarUrl: json['author_avatar_url'] as String?,
      description: json['description'] as String?,
      tags: tagsList,
      media: mediaList,
    );
  }
}

class PostListResult {
  final List<PostListItem> posts;
  final int total;

  PostListResult({required this.posts, required this.total});
}

class Author {
  final String id;
  final String nickname;
  final String platform;
  final String? avatarUrl;

  Author({
    required this.id,
    required this.nickname,
    required this.platform,
    this.avatarUrl,
  });

  factory Author.fromJson(Map<String, dynamic> json) {
    return Author(
      id: json['id'] as String,
      nickname: json['nickname'] as String,
      platform: json['platform'] as String,
      avatarUrl: json['avatar_url'] as String?,
    );
  }
}

class TagItem {
  final String id;
  final String name;
  final String? color;
  final int postCount;

  TagItem({
    required this.id,
    required this.name,
    this.color,
    required this.postCount,
  });

  factory TagItem.fromJson(Map<String, dynamic> json) {
    return TagItem(
      id: json['id'] as String,
      name: json['name'] as String,
      color: json['color'] as String?,
      postCount: (json['post_count'] as num?)?.toInt() ?? 0,
    );
  }
}

