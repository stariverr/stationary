import SwiftUI

@Observable
@MainActor
public final class PostListViewModel {
    // State
    public var posts: [PostListItem] = []
    public var isLoading: Bool = false
    public var isLoadingMore: Bool = false
    public var errorMessage: String? = nil
    
    // Pagination State
    public var currentPage: Int = 1
    public var itemsPerPage: Int = 24
    public var totalItems: Int = 0
    
    public var totalPages: Int {
        max(1, Int(ceil(Double(totalItems) / Double(itemsPerPage))))
    }
    
    public var hasMorePages: Bool {
        currentPage < totalPages
    }
    
    // Advanced Filter Bar Toggle
    public var isFilterPanelExpanded: Bool = false
    
    // Filter State
    public var searchKeyword: String = ""
    public var selectedSource: SourcePlatform = .all
    public var selectedSortBy: String = "published_time"
    public var selectedSortOrder: String = "desc"
    public var selectedMediaType: MediaType? = nil
    public var selectedAuthorIds: Set<String> = []
    public var selectedTagIds: Set<String> = []
    
    public var activeFilterCount: Int {
        var count = 0
        if selectedSource != .all { count += 1 }
        if selectedMediaType != nil { count += 1 }
        if !selectedAuthorIds.isEmpty { count += 1 }
        if !selectedTagIds.isEmpty { count += 1 }
        if !searchKeyword.isEmpty { count += 1 }
        return count
    }
    
    // UI Layout Preferences
    public var gridColumnsCount: Int = 4
    public var selectedAspectRatioRatio: Double = 4.0 / 3.0
    
    // Authors & Tags Cache
    public var availableAuthors: [Author] = []
    public var availableTags: [Tag] = []
    
    public init() {}
    
    public func loadPosts(resetPagination: Bool = true) async {
        if resetPagination {
            currentPage = 1
            isLoading = true
            posts = [] // Instantly clear old posts so real-time filter feedback is explicit
        } else {
            isLoadingMore = true
        }
        errorMessage = nil
        
        let libManager = LibraryManager.shared
        if libManager.libraries.isEmpty || libManager.activeLibraryId == nil {
            await libManager.loadLibraries()
        }
        
        guard let activeLibId = libManager.activeLibraryId, !activeLibId.isEmpty else {
            self.posts = []
            self.totalItems = 0
            self.isLoading = false
            self.isLoadingMore = false
            self.errorMessage = "No active library selected. Please select or create a library."
            return
        }
        
        do {
            let result = try await APIClient.shared.fetchPosts(
                libraryId: activeLibId,
                page: currentPage,
                count: itemsPerPage,
                keyword: searchKeyword,
                source: selectedSource,
                sortBy: selectedSortBy,
                sortOrder: selectedSortOrder,
                authorIds: Array(selectedAuthorIds),
                mediaType: selectedMediaType,
                tagIds: Array(selectedTagIds)
            )
            
            if resetPagination {
                self.posts = result.itemList
            } else {
                let existingIds = Set(self.posts.map { $0.id })
                let newItems = result.itemList.filter { !existingIds.contains($0.id) }
                self.posts.append(contentsOf: newItems)
            }
            
            self.totalItems = result.itemTotal
            self.isLoading = false
            self.isLoadingMore = false
        } catch {
            self.isLoading = false
            self.isLoadingMore = false
            self.errorMessage = error.localizedDescription
        }
    }
    
    public func loadMorePosts() async {
        guard !isLoading && !isLoadingMore && hasMorePages else { return }
        currentPage += 1
        await loadPosts(resetPagination: false)
    }
    
    public func loadAuthorsAndTags() async {
        let activeLibId = LibraryManager.shared.activeLibraryId ?? ""
        guard !activeLibId.isEmpty else { return }
        do {
            async let authorsTask = APIClient.shared.fetchAuthors(libraryId: activeLibId)
            async let tagsTask = APIClient.shared.fetchTags(libraryId: activeLibId)
            self.availableAuthors = try await authorsTask
            self.availableTags = try await tagsTask
        } catch {
            print("Failed to load authors or tags: \(error)")
        }
    }
    
    public func applyFilterChange() {
        self.currentPage = 1
        self.isLoading = true
        self.posts = []
        Task {
            await loadPosts(resetPagination: true)
        }
    }
    
    public func resetFilters() {
        searchKeyword = ""
        selectedSource = .all
        selectedSortBy = "published_time"
        selectedSortOrder = "desc"
        selectedMediaType = nil
        selectedAuthorIds.removeAll()
        selectedTagIds.removeAll()
        applyFilterChange()
    }
}
