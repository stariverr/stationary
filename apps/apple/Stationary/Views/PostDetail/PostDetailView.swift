import SwiftUI

public struct PostDetailView: View {
    @State private var viewModel: PostDetailViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var showingEditSheet = false
    @State private var showingDeleteAlert = false
    @State private var copiedToast = false
    @State private var isShowingTechDetails = false
    @State private var isFullscreenLightbox = false

    public init(postId: String) {
        self._viewModel = State(initialValue: PostDetailViewModel(postId: postId))
    }

    public var body: some View {
        ZStack {
            LiquidGlassBackgroundView()

            if viewModel.isLoading {
                loadingView
            } else if let error = viewModel.errorMessage {
                errorView(error: error)
            } else if let detail = viewModel.detail {
                detailContentView(detail: detail)
            }
        }
        .navigationTitle(navigationTitle)
        .inlineNavigationBarTitle()
        .toolbar {
            ToolbarItemGroup(placement: .trailingPlacement) {
                if let urlString = viewModel.detail?.url, !urlString.isEmpty {
                    Button {
                        copyOriginalLink(urlString)
                    } label: {
                        Image(systemName: copiedToast ? "checkmark" : "doc.on.doc")
                            .foregroundColor(copiedToast ? .emeraldGreen : .accentColor)
                    }
                    .accessibilityLabel(copiedToast ? "Copied" : "Copy Link")
                }

                Button {
                    showingEditSheet = true
                } label: {
                    Image(systemName: "square.and.pencil")
                }
                .accessibilityLabel("Edit post")

                Button(role: .destructive) {
                    showingDeleteAlert = true
                } label: {
                    Image(systemName: "trash")
                        .foregroundColor(.red)
                }
                .accessibilityLabel("Delete post")
            }
        }
        .task {
            await viewModel.loadDetail()
        }
        .sheet(isPresented: $showingEditSheet) {
            PostDetailEditView(viewModel: viewModel)
        }
        .alert("Move to Trash?", isPresented: $showingDeleteAlert) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) {
                Task {
                    let success = await viewModel.trashPost()
                    if success { dismiss() }
                }
            }
        } message: {
            Text("This post asset will be moved to the recycle bin.")
        }
        #if os(iOS)
        .presentationDragIndicator(.hidden)
        #endif
    }

    private var navigationTitle: String {
        guard let title = viewModel.detail?.title, !title.isEmpty else {
            return "Post Detail"
        }
        return title
    }

    private var selectedIndexBinding: Binding<Int> {
        Binding(
            get: { viewModel.selectedMediaIndex },
            set: { viewModel.selectedMediaIndex = $0 }
        )
    }

    // MARK: - Main Content Layout
    
    @ViewBuilder
    private func detailContentView(detail: PostDetailResponse) -> some View {
        GeometryReader { proxy in
            let isWideScreen = proxy.size.width >= 768

            if isWideScreen {
                let sidebarWidth = min(max(proxy.size.width * 0.38, 360), 480)

                HStack(alignment: .top, spacing: 20) {
                    // Left Media Stage
                    mediaStage
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .frame(minHeight: 460)

                    // Right Info Inspector
                    ScrollView {
                        postMainInfoFlow(detail: detail)
                            .padding(24)
                    }
                    .frame(width: sidebarWidth)
                    .background(LiquidPalette.cardBg)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .stroke(LiquidPalette.borderFaint, lineWidth: 1)
                    )
                }
                .padding(20)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        // Media Stage
                        if !viewModel.mediaItems.isEmpty {
                            mediaStage
                        }

                        // Post Metadata & Content Card
                        postMainInfoFlow(detail: detail)
                            .padding(18)
                            .background(LiquidPalette.cardBg)
                            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 18, style: .continuous)
                                    .stroke(LiquidPalette.borderFaint, lineWidth: 1)
                            )
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 14)
                }
            }
        }
    }

    private var mediaStage: some View {
        MediaGalleryView(
            mediaItems: viewModel.mediaItems,
            selectedIndex: selectedIndexBinding,
            onOpenFullscreen: {
                LightboxManager.shared.present(
                    items: viewModel.mediaItems,
                    initialIndex: viewModel.selectedMediaIndex
                )
            }
        )
    }

    // MARK: - Post Main Info Flow
    
    @ViewBuilder
    private func postMainInfoFlow(detail: PostDetailResponse) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            // 1. Platform & Author Header
            HStack(spacing: 12) {
                // Author Avatar
                if let avatarString = detail.author_avatar_url, let avatarURL = URL(string: avatarString) {
                    AsyncImage(url: avatarURL) { phase in
                        if let image = phase.image {
                            image
                                .resizable()
                                .scaledToFill()
                        } else {
                            authorPlaceholder
                        }
                    }
                    .frame(width: 44, height: 44)
                    .clipShape(Circle())
                } else {
                    authorPlaceholder
                }

                // Author Name & Published Date
                VStack(alignment: .leading, spacing: 3) {
                    Text(detail.author_name?.isEmpty == false ? detail.author_name! : "Creator")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundColor(.primary)
                        .lineLimit(1)

                    HStack(spacing: 6) {
                        // Platform Badge
                        HStack(spacing: 3.5) {
                            Image(systemName: detail.source.iconName)
                                .font(.system(size: 8.5, weight: .bold))
                            Text(detail.source.displayName)
                                .font(.system(size: 9.5, weight: .bold))
                        }
                        .foregroundColor(.white)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2.5)
                        .background(LiquidPalette.platformColor(detail.source))
                        .clipShape(Capsule())

                        if let published = detail.published_time {
                            Text("•")
                                .foregroundColor(.secondary.opacity(0.4))
                            Text(formatDate(published))
                                .font(.system(size: 11.5, weight: .medium))
                                .monospacedDigit()
                                .foregroundColor(.secondary)
                        }
                    }
                }

                Spacer()

                // Original Post Link Button
                if let originalURL = detail.url, let url = URL(string: originalURL) {
                    Link(destination: url) {
                        Image(systemName: "safari")
                            .font(.system(size: 18, weight: .medium))
                            .foregroundColor(.accentColor)
                            .padding(8)
                            .background(Color.accentColor.opacity(0.1))
                            .clipShape(Circle())
                    }
                }
            }

            Divider().opacity(0.4)

            // 2. Post Title
            if let title = detail.title, !title.isEmpty {
                Text(title)
                    .font(.system(size: 20, weight: .bold))
                    .foregroundColor(.primary)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // 3. Post Description / Body Text
            if let description = detail.description, !description.isEmpty {
                Text(description)
                    .font(.system(size: 14.5, weight: .regular))
                    .foregroundColor(.primary.opacity(0.9))
                    .lineSpacing(5)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // 4. Tags
            if !detail.tags.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("TAGS")
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .foregroundColor(.secondary)
                        .tracking(0.6)

                    FlowLayout(spacing: 8) {
                        ForEach(detail.tags, id: \.self) { tag in
                            Text("#\(tag)")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundColor(.accentColor)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 5)
                                .background(Color.accentColor.opacity(0.1))
                                .clipShape(Capsule())
                        }
                    }
                }
            }

            // 5. Storage & Tech Details Section
            DisclosureGroup(isExpanded: $isShowingTechDetails) {
                VStack(spacing: 8) {
                    techRow(label: "Post ID", value: detail.id)
                    techRow(label: "Sync Status", value: detail.sync_status.displayName)
                    techRow(label: "Library ID", value: detail.library_id)
                    techRow(label: "Imported At", value: formatDate(detail.create_time))
                }
                .padding(.top, 8)
            } label: {
                Text("Technical & Storage Info")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.secondary)
            }
            .tint(.secondary)
        }
    }

    private func techRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(.secondary)
            Spacer()
            Text(value)
                .font(.system(size: 11, weight: .regular, design: .monospaced))
                .foregroundColor(.primary)
                .lineLimit(1)
        }
        .padding(.vertical, 2)
    }

    private func thumbnailImage(item: MediaItem) -> some View {
        ZStack {
            LiquidPalette.cardBg
            if let cover = item.primaryCoverUrl, let url = URL(string: cover) {
                AsyncImage(url: url) { phase in
                    if let img = phase.image {
                        img.resizable().scaledToFill()
                    } else {
                        ProgressView().controlSize(.small)
                    }
                }
            } else {
                Image(systemName: item.type.iconName)
                    .font(.system(size: 18))
                    .foregroundColor(.secondary)
            }
        }
    }

    private var authorPlaceholder: some View {
        ZStack {
            Circle().fill(Color.primary.opacity(0.08))
            Image(systemName: "person.fill")
                .font(.system(size: 18, weight: .medium))
                .foregroundColor(.secondary)
        }
        .frame(width: 44, height: 44)
    }

    private func copyOriginalLink(_ urlString: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(urlString, forType: .string)
        #elseif os(iOS)
        UIPasteboard.general.string = urlString
        #endif

        HapticManager.notification(type: .success)
        withAnimation(.easeOut(duration: 0.15)) {
            copiedToast = true
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            withAnimation(.easeOut(duration: 0.15)) {
                copiedToast = false
            }
        }
    }

    private var loadingView: some View {
        VStack(spacing: 14) {
            ProgressView()
                .tint(.accentColor)
            Text("Loading post…")
                .font(.system(size: 14, weight: .medium))
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorView(error: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 40))
                .foregroundColor(.orange)

            Text(error)
                .font(.system(size: 14, weight: .medium))
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            Button("Retry") {
                Task { await viewModel.loadDetail() }
            }
            .liquidGlassButton(isSelected: true)
        }
        .padding(28)
    }

    private func formatDate(_ isoString: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        if let date = formatter.date(from: isoString) {
            let relativeFormatter = RelativeDateTimeFormatter()
            relativeFormatter.unitsStyle = .short
            return relativeFormatter.localizedString(for: date, relativeTo: Date())
        }

        return isoString.prefix(10).description
    }
}

// MARK: - Lightweight Flow Layout for Tags
private struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var currentX: CGFloat = 0
        var currentY: CGFloat = 0
        var lineHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if currentX + size.width > width && currentX > 0 {
                currentX = 0
                currentY += lineHeight + spacing
                lineHeight = 0
            }
            lineHeight = max(lineHeight, size.height)
            currentX += size.width + spacing
        }

        return CGSize(width: width, height: currentY + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var currentX = bounds.minX
        var currentY = bounds.minY
        var lineHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if currentX + size.width > bounds.maxX && currentX > bounds.minX {
                currentX = bounds.minX
                currentY += lineHeight + spacing
                lineHeight = 0
            }
            subview.place(at: CGPoint(x: currentX, y: currentY), proposal: ProposedViewSize(size))
            lineHeight = max(lineHeight, size.height)
            currentX += size.width + spacing
        }
    }
}
