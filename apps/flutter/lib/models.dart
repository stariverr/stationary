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

List<T> _list<T>(Object? json, T Function(Map<String, dynamic>) parse) {
  if (json is! List) return const [];
  return json.map((e) => parse(Map<String, dynamic>.from(e as Map))).toList();
}

/// A file the media was imported or uploaded with (image, video, audio,
/// cover, PDF or live photo video).
class MediaOriginal {
  final String id;
  final String kind;
  final String? url;
  final String? mimeType;
  final int? size;
  final String status;
  final String? lastError;

  MediaOriginal({
    required this.id,
    required this.kind,
    this.url,
    this.mimeType,
    this.size,
    required this.status,
    this.lastError,
  });

  factory MediaOriginal.fromJson(Map<String, dynamic> json) {
    return MediaOriginal(
      id: json['id'] as String,
      kind: json['kind'] as String,
      url: json['url'] as String?,
      mimeType: json['mime_type'] as String?,
      size: (json['size'] as num?)?.toInt(),
      status: json['status'] as String,
      lastError: json['last_error'] as String?,
    );
  }
}

/// A caption of the media in any state; [vttUrl] is set once it is converted.
class MediaCaption {
  final String id;
  final String origin;
  final String? language;
  final String? label;
  final bool isDefault;
  final String status;
  final String? lastError;
  final String? vttUrl;

  MediaCaption({
    required this.id,
    required this.origin,
    this.language,
    this.label,
    required this.isDefault,
    required this.status,
    this.lastError,
    this.vttUrl,
  });

  factory MediaCaption.fromJson(Map<String, dynamic> json) {
    return MediaCaption(
      id: json['id'] as String,
      origin: json['origin'] as String,
      language: json['language'] as String?,
      label: json['label'] as String?,
      isDefault: json['is_default'] as bool,
      status: json['status'] as String,
      lastError: json['last_error'] as String?,
      vttUrl: json['vtt_url'] as String?,
    );
  }
}

class PlaybackVideo {
  final String id;
  final String codec;
  final String? codecString;
  final int width;
  final int height;
  final int rotation;
  final double? frameRate;

  PlaybackVideo({
    required this.id,
    required this.codec,
    this.codecString,
    required this.width,
    required this.height,
    required this.rotation,
    this.frameRate,
  });

  factory PlaybackVideo.fromJson(Map<String, dynamic> json) {
    return PlaybackVideo(
      id: json['id'] as String,
      codec: json['codec'] as String,
      codecString: json['codec_string'] as String?,
      width: (json['width'] as num).toInt(),
      height: (json['height'] as num).toInt(),
      rotation: (json['rotation'] as num).toInt(),
      frameRate: (json['frame_rate'] as num?)?.toDouble(),
    );
  }
}

class PlaybackAudioTrack {
  final String id;
  final String codec;
  final String? codecString;
  final String? language;
  final String? label;
  final bool isDefault;
  final int channels;

  /// Whether `directUrl` carries this track.
  final bool inDirect;

  /// Whether the HLS and DASH manifests carry this track.
  final bool inManifest;

  PlaybackAudioTrack({
    required this.id,
    required this.codec,
    this.codecString,
    this.language,
    this.label,
    required this.isDefault,
    required this.channels,
    required this.inDirect,
    required this.inManifest,
  });

  factory PlaybackAudioTrack.fromJson(Map<String, dynamic> json) {
    return PlaybackAudioTrack(
      id: json['id'] as String,
      codec: json['codec'] as String,
      codecString: json['codec_string'] as String?,
      language: json['language'] as String?,
      label: json['label'] as String?,
      isDefault: json['is_default'] as bool,
      channels: (json['channels'] as num).toInt(),
      inDirect: json['in_direct'] as bool,
      inManifest: json['in_manifest'] as bool,
    );
  }
}

class PlaybackCaption {
  final String id;
  final String? language;
  final String? label;
  final bool isDefault;
  final String vttUrl;

  PlaybackCaption({
    required this.id,
    this.language,
    this.label,
    required this.isDefault,
    required this.vttUrl,
  });

  factory PlaybackCaption.fromJson(Map<String, dynamic> json) {
    return PlaybackCaption(
      id: json['id'] as String,
      language: json['language'] as String?,
      label: json['label'] as String?,
      isDefault: json['is_default'] as bool,
      vttUrl: json['vtt_url'] as String,
    );
  }
}

/// Lyrics as LRC. [timing] is `NONE` (plain lines without timestamps),
/// `LINE` or `WORD` (docs/media_refactor 3.9).
class PlaybackLyrics {
  final String id;
  final String? language;
  final String? label;
  final bool isDefault;
  final String timing;
  final String lrcUrl;

  PlaybackLyrics({
    required this.id,
    this.language,
    this.label,
    required this.isDefault,
    required this.timing,
    required this.lrcUrl,
  });

  factory PlaybackLyrics.fromJson(Map<String, dynamic> json) {
    return PlaybackLyrics(
      id: json['id'] as String,
      language: json['language'] as String?,
      label: json['label'] as String?,
      isDefault: json['is_default'] as bool,
      timing: json['timing'] as String,
      lrcUrl: json['lrc_url'] as String,
    );
  }
}

/// How a VIDEO, AUDIO or LIVE_PHOTO media plays (docs/media_refactor §7–8).
///
/// [hlsUrl] and [dashUrl] are signed API paths, set only when the media needs
/// a manifest (separate video and audio originals, or several audio tracks).
/// Otherwise [directUrl] plays the main original as is, with its default audio.
class MediaPlayback {
  final String directUrl;
  final String directMimeType;
  final String? hlsUrl;
  final String? dashUrl;
  final double? duration;
  final PlaybackVideo? video;
  final List<PlaybackAudioTrack> audioTracks;
  final List<PlaybackCaption> captions;
  final List<PlaybackLyrics> lyrics;

  MediaPlayback({
    required this.directUrl,
    required this.directMimeType,
    this.hlsUrl,
    this.dashUrl,
    this.duration,
    this.video,
    required this.audioTracks,
    required this.captions,
    required this.lyrics,
  });

  factory MediaPlayback.fromJson(Map<String, dynamic> json) {
    return MediaPlayback(
      directUrl: json['direct_url'] as String,
      directMimeType: json['direct_mime_type'] as String,
      hlsUrl: json['hls_url'] as String?,
      dashUrl: json['dash_url'] as String?,
      duration: (json['duration'] as num?)?.toDouble(),
      video: json['video'] is Map
          ? PlaybackVideo.fromJson(
              Map<String, dynamic>.from(json['video'] as Map),
            )
          : null,
      audioTracks: _list(json['audio_tracks'], PlaybackAudioTrack.fromJson),
      captions: _list(json['captions'], PlaybackCaption.fromJson),
      lyrics: _list(json['lyrics'], PlaybackLyrics.fromJson),
    );
  }

  /// Whether the player streams the HLS manifest (AVPlayer has no DASH):
  /// only when the original lacks an audio track, i.e. the media has another
  /// original. Several tracks inside the original play directly and switch in
  /// the player (docs/media_refactor 8.1).
  bool get usesManifest =>
      hlsUrl != null && audioTracks.any((track) => !track.inDirect);

  String get sourceUrl => usesManifest ? hlsUrl! : directUrl;

  /// The audio tracks the played source carries, in the order the platform
  /// player lists them.
  List<PlaybackAudioTrack> get playableAudioTracks => audioTracks
      .where((track) => usesManifest ? track.inManifest : track.inDirect)
      .toList();

  /// Tracks the played source cannot carry, e.g. an external MP3 the
  /// manifests cannot hold (docs/media_refactor 16).
  List<PlaybackAudioTrack> get unavailableAudioTracks => audioTracks
      .where((track) => !(usesManifest ? track.inManifest : track.inDirect))
      .toList();
}

class Media {
  final String id;
  final String? eid;
  final String? postId;
  final String? source;
  final String title;
  final String? description;
  final String type; // e.g., "IMAGE", "VIDEO"
  final int sortOrder;
  final String? createTime;
  final String? publishedTime;
  final String? url;
  final int? width;
  final int? height;
  final double? duration;
  final MediaPreviews previews;
  final MediaCover? cover;
  final MediaPlayback? playback;
  final List<MediaOriginal> originals;
  final List<MediaCaption> captions;

  Media({
    required this.id,
    this.eid,
    this.postId,
    this.source,
    required this.title,
    this.description,
    required this.type,
    required this.sortOrder,
    this.createTime,
    this.publishedTime,
    this.url,
    this.width,
    this.height,
    this.duration,
    required this.previews,
    this.cover,
    this.playback,
    this.originals = const [],
    this.captions = const [],
  });

  factory Media.fromJson(Map<String, dynamic> json) {
    return Media(
      id: json['id'] as String,
      eid: json['eid'] as String?,
      postId: json['post_id'] as String?,
      source: json['source'] as String?,
      title: (json['title'] as String?) ?? '',
      description: json['description'] as String?,
      type: (json['type'] as String?) ?? 'IMAGE',
      sortOrder: (json['sort_order'] as int?) ?? 0,
      createTime: json['create_time'] as String?,
      publishedTime: json['published_time'] as String?,
      url: json['url'] as String?,
      width: (json['width'] as num?)?.toInt(),
      height: (json['height'] as num?)?.toInt(),
      duration: (json['duration'] as num?)?.toDouble(),
      previews: MediaPreviews.fromJson(json['previews']),
      cover: json['cover'] is Map
          ? MediaCover.fromJson(Map<String, dynamic>.from(json['cover'] as Map))
          : null,
      playback: json['playback'] is Map
          ? MediaPlayback.fromJson(
              Map<String, dynamic>.from(json['playback'] as Map),
            )
          : null,
      originals: _list(json['originals'], MediaOriginal.fromJson),
      captions: _list(json['captions'], MediaCaption.fromJson),
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

/// One system-generated AVIF preview tier.
class PreviewImage {
  final String url;
  final int width;
  final int height;

  PreviewImage({required this.url, required this.width, required this.height});

  factory PreviewImage.fromJson(Map<String, dynamic> json) {
    return PreviewImage(
      url: json['url'] as String,
      width: (json['width'] as num).toInt(),
      height: (json['height'] as num).toInt(),
    );
  }
}

/// SMALL, MEDIUM and LARGE previews (longest edge 360, 720, 1440).
/// A tier is null when it has not been generated yet, failed, or the media
/// has no preview source.
class MediaPreviews {
  final PreviewImage? small;
  final PreviewImage? medium;
  final PreviewImage? large;

  const MediaPreviews({this.small, this.medium, this.large});

  factory MediaPreviews.fromJson(Object? json) {
    if (json is! Map) return const MediaPreviews();
    PreviewImage? tier(String key) => json[key] is Map
        ? PreviewImage.fromJson(Map<String, dynamic>.from(json[key] as Map))
        : null;
    return MediaPreviews(
      small: tier('small'),
      medium: tier('medium'),
      large: tier('large'),
    );
  }

  /// For list rows and grid cards.
  PreviewImage? get thumbnail => medium ?? small ?? large;

  /// For detail views and video posters.
  PreviewImage? get poster => large ?? medium ?? small;
}

/// The original cover (uploaded or imported). Only media detail carries it.
class MediaCover {
  final String url;

  MediaCover({required this.url});

  factory MediaCover.fromJson(Map<String, dynamic> json) {
    return MediaCover(url: json['url'] as String);
  }
}

/// Post list summary of a media item.
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
  final int? width;
  final int? height;
  final double? duration;
  final MediaPreviews previews;

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
    this.width,
    this.height,
    this.duration,
    required this.previews,
  });

  factory MediaPreview.fromJson(Map<String, dynamic> json) {
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
      url: json['url'] as String?,
      width: (json['width'] as num?)?.toInt(),
      height: (json['height'] as num?)?.toInt(),
      duration: (json['duration'] as num?)?.toDouble(),
      previews: MediaPreviews.fromJson(json['previews']),
    );
  }

  Media toMedia() {
    return Media(
      id: id,
      eid: eid,
      source: source,
      title: title,
      description: description,
      type: type,
      sortOrder: sortOrder,
      createTime: createTime,
      publishedTime: publishedTime,
      url: url,
      width: width,
      height: height,
      duration: duration,
      previews: previews,
    );
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
          .map(
            (m) => MediaPreview.fromJson(Map<String, dynamic>.from(m as Map)),
          )
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

  Post toPost() {
    return Post(
      id: id,
      eid: eid,
      title: title,
      source: source,
      authorName: authorName,
      createTime: createTime,
      publishedTime: publishedTime,
      url: url,
      syncStatus: syncStatus,
      lastError: lastError,
      authorAvatarUrl: authorAvatarUrl,
      description: description,
      tags: tags,
      media: media.map((m) => m.toMedia()).toList(),
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
