import SwiftUI

@Observable
@MainActor
public final class PostDetailViewModel {
    public let postId: String
    
    // State
    public var detail: PostDetailResponse? = nil
    public var mediaItems: [MediaItem] = []
    public var isLoading: Bool = false
    public var errorMessage: String? = nil
    public var selectedMediaIndex: Int = 0
    
    // In-place Editing State
    public var isEditing: Bool = false
    public var editTitle: String = ""
    public var editDescription: String = ""
    public var editURL: String = ""
    public var editPublishedTime: String = ""
    public var isSaving: Bool = false
    public var isDeleted: Bool = false
    
    public init(postId: String) {
        self.postId = postId
    }
    
    public func loadDetail() async {
        isLoading = true
        errorMessage = nil
        
        do {
            async let detailTask = APIClient.shared.fetchPostDetail(id: postId)
            async let mediaTask = APIClient.shared.fetchPostMedia(postId: postId)
            
            let fetchedDetail = try await detailTask
            let fetchedMedia = (try? await mediaTask) ?? fetchedDetail.media ?? []
            
            self.detail = fetchedDetail
            self.mediaItems = fetchedMedia
            
            // Populate edit fields
            self.editTitle = fetchedDetail.title ?? ""
            self.editDescription = fetchedDetail.description ?? ""
            self.editURL = fetchedDetail.url ?? ""
            self.editPublishedTime = fetchedDetail.published_time ?? ""
            
            self.isLoading = false
        } catch {
            self.isLoading = false
            self.errorMessage = error.localizedDescription
        }
    }
    
    public func saveEdits() async -> Bool {
        isSaving = true
        do {
            let updated = try await APIClient.shared.updatePost(
                id: postId,
                title: editTitle,
                originalUrl: editURL,
                authorName: nil
            )
            self.detail = updated
            self.isSaving = false
            self.isEditing = false
            return true
        } catch {
            self.isSaving = false
            self.errorMessage = "Failed to save: \(error.localizedDescription)"
            return false
        }
    }
    
    public func replaceTags(_ newTagIds: [String]) async -> Bool {
        do {
            let updated = try await APIClient.shared.updatePostTags(id: postId, tags: newTagIds)
            self.detail = updated
            return true
        } catch {
            self.errorMessage = "Failed to update tags: \(error.localizedDescription)"
            return false
        }
    }
    
    public func trashPost() async -> Bool {
        do {
            try await APIClient.shared.deletePost(id: postId)
            self.isDeleted = true
            return true
        } catch {
            self.errorMessage = "Failed to move to trash: \(error.localizedDescription)"
            return false
        }
    }
}
