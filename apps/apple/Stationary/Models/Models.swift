import Foundation

// MARK: - Source Platform
public enum SourcePlatform: String, Codable, CaseIterable, Identifiable, Sendable {
    case all = "ALL"
    case x = "X"
    case xhs = "XHS"
    case bilibili = "BILIBILI"
    case douyin = "DOUYIN"
    case tiktok = "TIKTOK"
    case instagram = "INSTAGRAM"
    case unknown = "UNKNOWN"
    
    public var id: String { rawValue }
    
    public var displayName: String {
        switch self {
        case .all: return "All Platforms"
        case .x: return "X (Twitter)"
        case .xhs: return "RED (小红书)"
        case .bilibili: return "Bilibili"
        case .douyin: return "Douyin"
        case .tiktok: return "TikTok"
        case .instagram: return "Instagram"
        case .unknown: return "Unknown"
        }
    }
    
    public var iconName: String {
        switch self {
        case .all: return "globe"
        case .x: return "x.circle.fill"
        case .xhs: return "book.closed.fill"
        case .bilibili: return "tv.fill"
        case .douyin: return "music.note"
        case .tiktok: return "play.square.fill"
        case .instagram: return "camera.fill"
        case .unknown: return "questionmark.circle"
        }
    }
}

// MARK: - Media Type
public enum MediaType: String, Codable, CaseIterable, Identifiable, Sendable {
    case image = "IMAGE"
    case video = "VIDEO"
    case livePhoto = "LIVE_PHOTO"
    case audio = "AUDIO"
    case pdf = "PDF"
    
    public var id: String { rawValue }
    
    public var displayName: String {
        switch self {
        case .image: return "Image"
        case .video: return "Video"
        case .livePhoto: return "Live Photo"
        case .audio: return "Audio"
        case .pdf: return "PDF"
        }
    }
    
    public var iconName: String {
        switch self {
        case .image: return "photo.fill"
        case .video: return "video.fill"
        case .livePhoto: return "livephoto"
        case .audio: return "music.quaver"
        case .pdf: return "doc.fill"
        }
    }
}

// MARK: - Post Type
public enum PostType: String, Codable, Sendable {
    case multiMedia = "MULTI_MEDIA"
    case text = "TEXT"
}

// MARK: - Sync Status
public enum SyncStatus: String, Codable, Sendable {
    case pending = "PENDING"
    case inProgress = "IN_PROGRESS"
    case completed = "COMPLETED"
    case failed = "FAILED"
    
    public var displayName: String {
        switch self {
        case .pending: return "Pending"
        case .inProgress: return "In Progress"
        case .completed: return "Completed"
        case .failed: return "Failed"
        }
    }
}

// MARK: - Media Preview Asset
public struct MediaPreviewAsset: Codable, Identifiable, Hashable, Sendable {
    public let quality: String?
    public let url: String
    public let width: Int?
    public let height: Int?
    public let codec: String?
    
    public var id: String { url }
}

// MARK: - Playback Audio Track
public struct PlaybackAudioTrack: Codable, Hashable, Sendable {
    public let id: String?
    public let track_id: String?
    public let url: String?
    public let mime_type: String?
    public let label: String?
    public let language: String?
    public let codec: String?
    public let channels: Int?
    public let is_default: Bool?
}

// MARK: - Playback Subtitle Track
public struct PlaybackSubtitleTrack: Codable, Hashable, Sendable {
    public let id: String?
    public let track_id: String?
    public let url: String?
    public let label: String?
    public let language: String?
    public let format: String?
    public let is_default: Bool?
}

// MARK: - Playback Variant
public struct PlaybackVariant: Codable, Hashable, Sendable {
    public let track_id: String?
    public let url: String
    public let mime_type: String?
    public let quality: String?
    public let label: String?
    public let codec: String?
    public let width: Int?
    public let height: Int?
    public let bandwidth: Int?
    public let frame_rate: Double?
}

// MARK: - Playback Info
public struct PlaybackInfo: Codable, Hashable, Sendable {
    public let format: String?
    public let url: String?
    public let variants: [PlaybackVariant]?
    public let audio_tracks: [PlaybackAudioTrack]?
    public let subtitle_tracks: [PlaybackSubtitleTrack]?
    public let manifest_url: String?
}

// MARK: - Media Track Item
public struct MediaTrackItem: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let file_id: String?
    public let url: String
    public let type: String
    public let purpose: String
    public let quality: String?
    public let is_default: Bool?
    public let is_primary: Bool?
    public let display_name: String?
    public let language: String?
    public let codec: String?
    public let width: Int?
    public let height: Int?
    public let bandwidth: Int?
    public let mime_type: String?
}

// MARK: - Media Item
public struct MediaItem: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let eid: String?
    public let post_id: String?
    public let type: MediaType
    public let sort_order: Int?
    public let title: String?
    public let description: String?
    public let sync_status: SyncStatus?
    public let last_error: String?
    public let url: String?
    public let cover_url: String?
    public let covers: [MediaPreviewAsset]?
    public let width: Int?
    public let height: Int?
    public let playback: PlaybackInfo?
    public let tracks: [MediaTrackItem]?
    
    public var primaryCoverUrl: String? {
        if let cover_url, !cover_url.isEmpty { return cover_url }
        if let firstCover = covers?.first?.url, !firstCover.isEmpty { return firstCover }
        if let imageTrack = tracks?.first(where: { $0.type.uppercased() == "IMAGE" || $0.purpose.uppercased() == "COVER" }), !imageTrack.url.isEmpty {
            return imageTrack.url
        }
        if (type == .image || type == .livePhoto), let url, !url.isEmpty { return url }
        return nil
    }
    
    public var primaryVideoUrl: String? {
        if let playbackUrl = playback?.url, !playbackUrl.isEmpty { return playbackUrl }
        if let firstVariant = playback?.variants?.first?.url, !firstVariant.isEmpty { return firstVariant }
        if let videoTrack = tracks?.first(where: { $0.type.uppercased() == "VIDEO" && !$0.url.isEmpty }) {
            return videoTrack.url
        }
        if (type == .video || type == .livePhoto), let url, !url.isEmpty {
            return url
        }
        return nil
    }
    
    public var aspectRatio: CGFloat {
        if let w = width, let h = height, w > 0, h > 0 {
            return CGFloat(w) / CGFloat(h)
        }
        return 1.0
    }
}

// MARK: - Post List Item
public struct PostListItem: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let library_id: String
    public let type: PostType
    public let title: String
    public let source: SourcePlatform
    public let tags: [String]
    public let author_name: String
    public let author_avatar_url: String?
    public let create_time: String
    public let published_time: String?
    public let sync_status: SyncStatus
    public let last_error: String?
    public let media: [MediaItem]?
    
    public var coverImageUrl: String? {
        media?.first?.primaryCoverUrl ?? media?.first?.url
    }
}

// MARK: - Post Detail Response
public struct PostDetailResponse: Codable, Identifiable, Sendable {
    public let id: String
    public let library_id: String
    public let source: SourcePlatform
    public let eid: String?
    public let title: String?
    public let description: String?
    public let tags: [String]
    public let author_name: String?
    public let author_avatar_url: String?
    public let author_external_id: String?
    public let create_time: String
    public let published_time: String?
    public let media_count: Int?
    public let type: PostType
    public let url: String?
    public let sync_status: SyncStatus
    public let last_error: String?
    public let media: [MediaItem]?
}

// MARK: - Author (Matches Server nickname field)
public struct Author: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let nickname: String?
    public let name: String?
    public let avatar_url: String?
    public let platform: SourcePlatform?
    
    public var displayName: String {
        if let nick = nickname, !nick.isEmpty {
            return nick
        }
        if let n = name, !n.isEmpty {
            return n
        }
        return "Author"
    }
}

// MARK: - Tag
public struct Tag: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let color: String?
    public let post_count: Int?
    public let media_count: Int?
}

// MARK: - User & Auth Models
public struct User: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let email: String
    public let name: String?
    public let avatar: String?
}

public struct LibraryItem: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let description: String?
    public let is_default: Bool?
    public let create_time: String?
}

public struct LibraryListResponse: Codable, Sendable {
    public let list: [LibraryItem]
    public let total: Int?
}

// MARK: - Robust Paginated API Wrapper (Supports list/items & total/total_items)
public struct PaginatedData<T: Codable & Sendable>: Codable, Sendable {
    public let list: [T]?
    public let items: [T]?
    public let total: Int?
    public let total_items: Int?
    public let page: Int?
    public let count: Int?
    public let total_pages: Int?
    
    public var itemList: [T] {
        list ?? items ?? []
    }
    
    public var itemTotal: Int {
        total ?? total_items ?? itemList.count
    }
}

public struct APIResponse<T: Codable & Sendable>: Codable, Sendable {
    public let code: Int
    public let message: String?
    public let data: T?
}
