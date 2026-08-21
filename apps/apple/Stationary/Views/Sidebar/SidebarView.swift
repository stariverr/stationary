import SwiftUI

public struct SidebarView: View {
    @Bindable var viewModel: PostListViewModel
    @Binding var selectedTab: AppTab
    
    public init(viewModel: PostListViewModel, selectedTab: Binding<AppTab>) {
        self.viewModel = viewModel
        self._selectedTab = selectedTab
    }
    
    public var body: some View {
        List {
            // WORKSPACE & ACCOUNT HEADER
            Section {
                SidebarWorkspaceHeaderView(viewModel: viewModel)
            }
            .listRowInsets(EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10))
            .listRowBackground(Color.clear)
            
            // NAVIGATION SECTION
            Section("WORKSPACE") {
                sidebarNavigationRow(
                    tab: .feed,
                    title: "Feed",
                    subtitle: "推荐信息流",
                    icon: AppTab.feed.icon,
                    color: Color(red: 0.99, green: 0.17, blue: 0.33)
                )
                
                sidebarNavigationRow(
                    tab: .posts,
                    title: "Posts",
                    subtitle: "帖子画板",
                    icon: AppTab.posts.icon,
                    color: Color(red: 0.39, green: 0.40, blue: 0.95)
                )
                
                sidebarNavigationRow(
                    tab: .media,
                    title: "Media",
                    subtitle: "全部媒体资产",
                    icon: AppTab.media.icon,
                    color: Color(red: 0.06, green: 0.73, blue: 0.51)
                )
                
                sidebarNavigationRow(
                    tab: .drafts,
                    title: "Drafts",
                    subtitle: "草稿与队列",
                    icon: AppTab.drafts.icon,
                    color: Color(red: 0.96, green: 0.62, blue: 0.04)
                )
            }
        }
        .listStyle(.sidebar)
    }
    
    private func sidebarNavigationRow(tab: AppTab, title: String, subtitle: String, icon: String, color: Color) -> some View {
        let isSelected = selectedTab == tab
        
        return Button {
            HapticManager.selection()
            withAnimation(.spring(response: 0.25, dampingFraction: 0.8)) {
                selectedTab = tab
            }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 15, weight: isSelected ? .bold : .medium))
                    .foregroundColor(isSelected ? .white : color)
                    .frame(width: 26, height: 26)
                    .background(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(isSelected ? color : color.opacity(0.12))
                    )
                
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.system(size: 13, weight: isSelected ? .semibold : .medium))
                        .foregroundColor(isSelected ? .primary : .primary.opacity(0.85))
                }
                
                Spacer()
                
                if isSelected {
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 6, height: 6)
                }
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}



