import SwiftUI

public struct DraftsView: View {
    @State private var drafts: [DraftItem] = []
    
    public init() {}
    
    public var body: some View {
        ZStack {
            LiquidGlassBackgroundView()
            
            if drafts.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: "doc.badge.plus")
                        .font(.system(size: 48))
                        .foregroundColor(.accentColor)
                    
                    Text("No Pending Drafts")
                        .font(.system(size: 16, weight: .bold))
                    
                    Text("Draft posts and offline media uploads will appear here.")
                        .font(.system(size: 13))
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(32)
            } else {
                List {
                    ForEach(drafts) { draft in
                        HStack(spacing: 12) {
                            Image(systemName: "doc.text.fill")
                                .foregroundColor(.accentColor)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(draft.title)
                                    .font(.system(size: 14, weight: .semibold))
                                Text("Last edited \(draft.formattedDate)")
                                    .font(.system(size: 11))
                                    .foregroundColor(.secondary)
                            }
                        }
                    }
                }
            }
        }
    }
}

public struct DraftItem: Identifiable {
    public let id = UUID()
    public let title: String
    public let formattedDate: String
}
