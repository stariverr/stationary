import Foundation

@MainActor
public final class APIClient: Sendable {
    public static let shared = APIClient()
    
    public let baseURL: URL = URL(string: "http://localhost:9400/api")!
    public var sessionToken: String? = nil
    
    private init() {}
    
    public enum APIError: Error, LocalizedError {
        case invalidURL
        case unauthorized
        case requestFailed(statusCode: Int, message: String)
        case decodingFailed(Error)
        case networkError(Error)
        
        public var errorDescription: String? {
            switch self {
            case .invalidURL:
                return "Invalid URL constructed."
            case .unauthorized:
                return "Unauthorized: Please sign in to access your media libraries."
            case .requestFailed(_, let msg):
                return msg
            case .decodingFailed(let err):
                return "Data decoding failed: \(err.localizedDescription)"
            case .networkError(let err):
                return "Network request failed: \(err.localizedDescription)"
            }
        }
    }
    
    // MARK: - Auth Endpoints
    public func signIn(email: String, password: String, captcha: String? = nil) async throws -> String {
        let url = baseURL.appendingPathComponent("auth/sign-in/email")
        var body: [String: String] = ["email": email, "password": password]
        if let captcha = captcha { body["captcha"] = captcha }
        let jsonData = try JSONEncoder().encode(body)
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let captcha = captcha, !captcha.isEmpty {
            request.setValue(captcha, forHTTPHeaderField: "x-captcha-response")
        }
        request.httpBody = jsonData
        
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.requestFailed(statusCode: 0, message: "Invalid HTTP Response")
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            if httpResponse.statusCode == 401 { throw APIError.unauthorized }
            let msg = parseErrorMessage(data: data, statusCode: httpResponse.statusCode)
            throw APIError.requestFailed(statusCode: httpResponse.statusCode, message: msg)
        }
        
        // Extract session token from cookie header or JSON token payload
        if let tokenHeader = httpResponse.value(forHTTPHeaderField: "Set-Cookie"),
           let tokenRange = tokenHeader.range(of: "better-auth.session_token=") {
            let tokenSubstring = tokenHeader[tokenRange.upperBound...]
            let token = tokenSubstring.components(separatedBy: ";").first ?? ""
            if !token.isEmpty { return token }
        }
        
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let token = json["token"] as? String ?? (json["session"] as? [String: Any])?["token"] as? String {
            return token
        }
        
        return "session_active"
    }
    
    public func signUp(email: String, password: String, name: String, captcha: String? = nil) async throws -> String {
        let url = baseURL.appendingPathComponent("auth/sign-up/email")
        var body: [String: String] = ["email": email, "password": password, "name": name]
        if let captcha = captcha { body["captcha"] = captcha }
        let jsonData = try JSONEncoder().encode(body)
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let captcha = captcha, !captcha.isEmpty {
            request.setValue(captcha, forHTTPHeaderField: "x-captcha-response")
        }
        request.httpBody = jsonData
        
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, (200...299).contains(httpResponse.statusCode) else {
            let msg = parseErrorMessage(data: data, statusCode: 400)
            throw APIError.requestFailed(statusCode: 0, message: msg)
        }
        
        return try await signIn(email: email, password: password, captcha: captcha)
    }
    
    public func signOut() async throws {
        let url = baseURL.appendingPathComponent("auth/sign-out")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        if let token = sessionToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        _ = try? await URLSession.shared.data(for: request)
    }
    
    public func fetchCurrentUser() async throws -> User {
        let url = baseURL.appendingPathComponent("user")
        return try await Fetch(url: url)
    }
    
    // MARK: - Library Endpoints
    public func fetchLibraries(page: Int = 1, count: Int = 50) async throws -> LibraryListResponse {
        var components = URLComponents(url: baseURL.appendingPathComponent("library/list"), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "page", value: "\(page)"),
            URLQueryItem(name: "count", value: "\(count)")
        ]
        guard let url = components?.url else { throw APIError.invalidURL }
        return try await Fetch(url: url)
    }
    
    public func createLibrary(name: String, description: String?) async throws -> LibraryItem {
        let url = baseURL.appendingPathComponent("library/create")
        var body: [String: String] = ["name": name]
        if let desc = description { body["description"] = desc }
        let jsonData = try JSONEncoder().encode(body)
        return try await Post(url: url, bodyData: jsonData)
    }
    
    // MARK: - Post List
    public func fetchPosts(
        libraryId: String,
        page: Int = 1,
        count: Int = 20,
        keyword: String? = nil,
        source: SourcePlatform? = nil,
        sortBy: String = "published_time",
        sortOrder: String = "desc",
        authorIds: [String] = [],
        mediaType: MediaType? = nil,
        tagIds: [String] = []
    ) async throws -> PaginatedData<PostListItem> {
        var components = URLComponents(url: baseURL.appendingPathComponent("post/list"), resolvingAgainstBaseURL: false)
        var queryItems = [
            URLQueryItem(name: "library_id", value: libraryId),
            URLQueryItem(name: "page", value: "\(page)"),
            URLQueryItem(name: "count", value: "\(count)"),
            URLQueryItem(name: "sort_by", value: sortBy),
            URLQueryItem(name: "sort_order", value: sortOrder)
        ]
        if let kw = keyword, !kw.isEmpty {
            queryItems.append(URLQueryItem(name: "keyword", value: kw))
        }
        if let src = source, src != .all {
            queryItems.append(URLQueryItem(name: "source", value: src.rawValue))
        }
        if let mt = mediaType {
            queryItems.append(URLQueryItem(name: "media_type", value: mt.rawValue))
        }
        if !authorIds.isEmpty {
            queryItems.append(URLQueryItem(name: "author_ids", value: authorIds.joined(separator: ",")))
        }
        if !tagIds.isEmpty {
            queryItems.append(URLQueryItem(name: "tag_ids", value: tagIds.joined(separator: ",")))
        }
        components?.queryItems = queryItems
        
        guard let url = components?.url else { throw APIError.invalidURL }
        return try await Fetch(url: url)
    }
    
    public func fetchPostDetail(id: String) async throws -> PostDetailResponse {
        let url = baseURL.appendingPathComponent("post").appendingPathComponent("detail").appendingPathComponent(id)
        return try await Fetch(url: url)
    }
    
    public func fetchPostMedia(postId: String, page: Int = 1, limit: Int = 50) async throws -> [MediaItem] {
        var components = URLComponents(url: baseURL.appendingPathComponent("post").appendingPathComponent(postId).appendingPathComponent("media"), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "page", value: "\(page)"),
            URLQueryItem(name: "limit", value: "\(limit)")
        ]
        guard let url = components?.url else { throw APIError.invalidURL }
        let res: PaginatedData<MediaItem> = try await Fetch(url: url)
        return res.itemList
    }
    
    public func fetchAuthors(libraryId: String = "", keyword: String? = nil) async throws -> [Author] {
        var components = URLComponents(url: baseURL.appendingPathComponent("post").appendingPathComponent("authors"), resolvingAgainstBaseURL: false)
        var queryItems: [URLQueryItem] = []
        if !libraryId.isEmpty {
            queryItems.append(URLQueryItem(name: "library_id", value: libraryId))
        }
        if let kw = keyword, !kw.isEmpty {
            queryItems.append(URLQueryItem(name: "keyword", value: kw))
        }
        components?.queryItems = queryItems
        guard let url = components?.url else { throw APIError.invalidURL }
        let resp: APIResponse<[Author]> = try await Fetch(url: url)
        return resp.data ?? []
    }
    
    public func fetchTags(libraryId: String) async throws -> [Tag] {
        var components = URLComponents(url: baseURL.appendingPathComponent("tag").appendingPathComponent("list"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "library_id", value: libraryId)]
        guard let url = components?.url else { throw APIError.invalidURL }
        let resp: APIResponse<[Tag]> = try await Fetch(url: url)
        return resp.data ?? []
    }
    
    public func updatePost(id: String, title: String?, originalUrl: String?, authorName: String?) async throws -> PostDetailResponse {
        let url = baseURL.appendingPathComponent("post").appendingPathComponent(id).appendingPathComponent("update")
        var body: [String: String] = [:]
        if let title = title { body["title"] = title }
        if let url = originalUrl { body["original_url"] = url }
        if let author = authorName { body["author_name"] = author }
        let jsonData = try JSONEncoder().encode(body)
        return try await Post(url: url, bodyData: jsonData)
    }
    
    public func updatePostTags(id: String, tags: [String]) async throws -> PostDetailResponse {
        let url = baseURL.appendingPathComponent("post").appendingPathComponent(id).appendingPathComponent("tag").appendingPathComponent("replace")
        let body = ["tags": tags]
        let jsonData = try JSONEncoder().encode(body)
        return try await Post(url: url, bodyData: jsonData)
    }
    
    public func deletePost(id: String) async throws {
        let url = baseURL.appendingPathComponent("post").appendingPathComponent("delete").appendingPathComponent(id)
        let _: APIResponse<String> = try await Post(url: url, bodyData: nil)
    }
    
    // MARK: - Generic Helper Request Methods
    private func Fetch<T: Codable & Sendable>(url: URL) async throws -> T {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = sessionToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw APIError.requestFailed(statusCode: 0, message: "Invalid HTTP Response")
            }
            guard (200...299).contains(httpResponse.statusCode) else {
                if httpResponse.statusCode == 401 { throw APIError.unauthorized }
                let msg = parseErrorMessage(data: data, statusCode: httpResponse.statusCode)
                throw APIError.requestFailed(statusCode: httpResponse.statusCode, message: msg)
            }
            
            let decoder = JSONDecoder()
            if let apiResp = try? decoder.decode(APIResponse<T>.self, from: data) {
                if let payload = apiResp.data {
                    return payload
                } else if apiResp.code == 0, T.self == String.self {
                    return (apiResp.message ?? "OK") as! T
                }
            }
            return try decoder.decode(T.self, from: data)
        } catch let err as APIError {
            throw err
        } catch {
            throw APIError.networkError(error)
        }
    }
    
    private func Post<T: Codable & Sendable>(url: URL, bodyData: Data?) async throws -> T {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = sessionToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = bodyData
        
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw APIError.requestFailed(statusCode: 0, message: "Invalid HTTP Response")
            }
            guard (200...299).contains(httpResponse.statusCode) else {
                if httpResponse.statusCode == 401 { throw APIError.unauthorized }
                let msg = parseErrorMessage(data: data, statusCode: httpResponse.statusCode)
                throw APIError.requestFailed(statusCode: httpResponse.statusCode, message: msg)
            }
            
            let decoder = JSONDecoder()
            if let apiResp = try? decoder.decode(APIResponse<T>.self, from: data) {
                if let payload = apiResp.data {
                    return payload
                } else if apiResp.code == 0, T.self == String.self {
                    return (apiResp.message ?? "OK") as! T
                }
            }
            return try decoder.decode(T.self, from: data)
        } catch let err as APIError {
            throw err
        } catch {
            throw APIError.networkError(error)
        }
    }
    
    private func parseErrorMessage(data: Data, statusCode: Int) -> String {
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let msg = json["message"] as? String { return msg }
        }
        return "Request failed (\(statusCode))"
    }
}
