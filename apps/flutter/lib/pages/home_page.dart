import 'dart:async';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../services/api_service.dart';
import '../models.dart';
import 'post_detail_page.dart';

class HomePage extends StatefulWidget {
  final VoidCallback onLogout;
  final bool isDark;
  final VoidCallback onToggleTheme;

  const HomePage({
    super.key,
    required this.onLogout,
    required this.isDark,
    required this.onToggleTheme,
  });

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  final _apiService = ApiService();
  final _searchController = TextEditingController();
  final _newLibraryController = TextEditingController();

  List<LibraryItem> _libraries = [];
  LibraryItem? _activeLibrary;
  List<PostListItem> _posts = [];
  bool _isLoading = false;
  String _keyword = '';

  // Tab State: 0 = Posts, 1 = Settings
  int _currentTab = 0;

  // Filtering, Sorting, and Pagination State
  int _page = 1;
  int _pageSize = 20;
  int _total = 0;
  String? _source;
  String _sortBy = 'published_time';
  String _sortOrder = 'desc';

  // New filtering state
  List<String> _selectedAuthorIds = [];
  List<String> _selectedTagIds = [];
  String? _selectedMediaType;

  // Available authors and tags for the active library
  List<Author> _availableAuthors = [];
  List<TagItem> _availableTags = [];

  Timer? _searchDebounce;

  void _triggerSearch() {
    if (_searchDebounce?.isActive ?? false) _searchDebounce!.cancel();
    final currentText = _searchController.text.trim();
    if (currentText != _keyword) {
      setState(() {
        _keyword = currentText;
        _page = 1;
      });
      _loadPosts();
    }
  }

  void _onSearchChanged() {
    setState(() {}); // Rebuild to update suffix X icon visibility

    if (_searchDebounce?.isActive ?? false) _searchDebounce!.cancel();
    _searchDebounce = Timer(const Duration(milliseconds: 300), () {
      final currentText = _searchController.text.trim();
      if (currentText != _keyword) {
        setState(() {
          _keyword = currentText;
          _page = 1;
        });
        _loadPosts();
      }
    });
  }

  @override
  void initState() {
    super.initState();
    _searchController.addListener(_onSearchChanged);
    _loadLibrariesAndPosts();
  }

  @override
  void dispose() {
    _searchController.removeListener(_onSearchChanged);
    _searchController.dispose();
    _newLibraryController.dispose();
    _searchDebounce?.cancel();
    super.dispose();
  }

  Future<void> _loadLibrariesAndPosts() async {
    setState(() {
      _isLoading = true;
    });

    try {
      final libs = await _apiService.fetchLibraries();
      setState(() {
        _libraries = libs;
      });

      if (libs.isNotEmpty) {
        final savedId = await _apiService.getActiveLibraryId();
        final match = libs.firstWhere(
          (l) => l.id == savedId,
          orElse: () => libs.first,
        );
        await _selectLibrary(match);
      } else {
        setState(() {
          _posts = [];
          _isLoading = false;
        });
      }
    } catch (e) {
      _showErrorAlert(e.toString());
      setState(() {
        _isLoading = false;
      });
    }
  }

  Future<void> _selectLibrary(LibraryItem library) async {
    setState(() {
      _activeLibrary = library;
      _page = 1;
      _selectedAuthorIds = [];
      _selectedTagIds = [];
      _selectedMediaType = null;
      _availableAuthors = [];
      _availableTags = [];
    });
    await _apiService.setActiveLibraryId(library.id);
    await _loadPosts();
    await _loadAuthorsAndTags();
  }

  Future<void> _loadPosts() async {
    if (_activeLibrary == null) return;
    setState(() {
      _isLoading = true;
    });

    try {
      final result = await _apiService.fetchPosts(
        _activeLibrary!.id,
        keyword: _keyword,
        source: _source,
        sortBy: _sortBy,
        sortOrder: _sortOrder,
        page: _page,
        count: _pageSize,
        authorIds: _selectedAuthorIds,
        tagIds: _selectedTagIds,
        mediaType: _selectedMediaType,
      );
      setState(() {
        _posts = result.posts;
        _total = result.total;
      });
    } catch (e) {
      _showErrorAlert(e.toString());
    } finally {
      setState(() {
        _isLoading = false;
      });
    }
  }

  Future<void> _loadAuthorsAndTags() async {
    if (_activeLibrary == null) return;
    try {
      final authors = await _apiService.fetchAuthors(_activeLibrary!.id);
      final tags = await _apiService.fetchTags(_activeLibrary!.id);
      setState(() {
        _availableAuthors = authors;
        _availableTags = tags;
      });
    } catch (e) {
      debugPrint('Failed to load authors/tags: $e');
    }
  }

  Future<void> _createNewLibrary() async {
    final name = _newLibraryController.text.trim();
    if (name.isEmpty) return;

    try {
      final newLib = await _apiService.createLibrary(name);
      _newLibraryController.clear();
      if (!mounted) return;
      Navigator.pop(context); // Close switch dialog

      setState(() {
        _libraries.add(newLib);
      });
      await _selectLibrary(newLib);
    } catch (e) {
      _showErrorAlert(e.toString());
    }
  }

  void _showErrorAlert(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message.replaceAll('Exception: ', '')),
        backgroundColor: Theme.of(context).colorScheme.error,
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
      ),
    );
  }

  void _showLibrarySwitcher() {
    showDialog(
      context: context,
      builder: (context) {
        final theme = Theme.of(context);
        return StatefulBuilder(
          builder: (context, setDialogState) {
            return AlertDialog(
              backgroundColor: theme.colorScheme.surface,
              shape: RoundedRectangleBorder(
                side: BorderSide(color: theme.colorScheme.outline),
                borderRadius: BorderRadius.circular(10),
              ),
              content: SizedBox(
                width: 320,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(
                          'Switch Library',
                          style: theme.textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        IconButton(
                          icon: const Icon(LucideIcons.x, size: 18),
                          onPressed: () => Navigator.pop(context),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxHeight: 200),
                      child: ListView.builder(
                        shrinkWrap: true,
                        itemCount: _libraries.length,
                        itemBuilder: (context, index) {
                          final lib = _libraries[index];
                          final isSelected = lib.id == _activeLibrary?.id;
                          return Padding(
                            padding: const EdgeInsets.only(bottom: 8.0),
                            child: GestureDetector(
                              onTap: () {
                                _selectLibrary(lib);
                                Navigator.pop(context);
                              },
                              child: Container(
                                decoration: BoxDecoration(
                                  color: isSelected
                                      ? theme
                                            .colorScheme
                                            .surfaceContainerHighest
                                      : theme.colorScheme.surface,
                                  border: Border.all(
                                    color: isSelected
                                        ? theme.colorScheme.primary
                                        : theme.colorScheme.outlineVariant,
                                  ),
                                  borderRadius: BorderRadius.circular(6),
                                ),
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 12,
                                  vertical: 12,
                                ),
                                child: Row(
                                  children: [
                                    Icon(
                                      LucideIcons.folder,
                                      size: 18,
                                      color: isSelected
                                          ? theme.colorScheme.primary
                                          : theme.colorScheme.onSurfaceVariant,
                                    ),
                                    const SizedBox(width: 12),
                                    Expanded(
                                      child: Text(
                                        lib.name,
                                        style: TextStyle(
                                          color: theme.colorScheme.onSurface,
                                          fontWeight: isSelected
                                              ? FontWeight.bold
                                              : FontWeight.normal,
                                        ),
                                      ),
                                    ),
                                    if (isSelected)
                                      Icon(
                                        LucideIcons.check,
                                        color: theme.colorScheme.primary,
                                        size: 16,
                                      ),
                                  ],
                                ),
                              ),
                            ),
                          );
                        },
                      ),
                    ),
                    const Divider(height: 32),
                    Text(
                      'Create New Library',
                      style: theme.textTheme.bodyMedium?.copyWith(
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    const SizedBox(height: 8),
                    TextField(
                      controller: _newLibraryController,
                      decoration: const InputDecoration(
                        hintText: 'Library name...',
                        contentPadding: EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 8,
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                    ElevatedButton(
                      onPressed: _createNewLibrary,
                      style: ElevatedButton.styleFrom(
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(6),
                        ),
                      ),
                      child: const Text('Create'),
                    ),
                  ],
                ),
              ),
            );
          },
        );
      },
    );
  }

  Widget _buildLeftSidebar(ThemeData theme) {
    final isDark = theme.brightness == Brightness.dark;
    final sidebarBgColor = isDark
        ? const Color(0xFF18181B)
        : const Color(0xFFF6F6F6);
    final sidebarBorderColor = isDark
        ? const Color(0xFF27272A)
        : const Color(0xFFE5E5E5);

    final String displayName = 'User';
    final String firstLetter = displayName.isNotEmpty
        ? displayName[0].toUpperCase()
        : 'U';

    return Container(
      width: 240,
      decoration: BoxDecoration(
        color: sidebarBgColor,
        border: Border(
          right: BorderSide(color: sidebarBorderColor, width: 1.0),
        ),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 16),
      child: Material(
        color: Colors.transparent,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Top: LibrarySwitcher Replica
            InkWell(
              onTap: _showLibrarySwitcher,
              borderRadius: BorderRadius.circular(6),
              hoverColor: isDark
                  ? const Color(0xFF27272A)
                  : const Color(0xFFE8E8E8),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Row(
                  children: [
                    CircleAvatar(
                      radius: 16,
                      backgroundColor: const Color(0xFFEFF6FF),
                      child: Text(
                        firstLetter,
                        style: const TextStyle(
                          color: Color(0xFF2563EB),
                          fontSize: 12,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            _activeLibrary?.name ?? 'Loading...',
                            style: TextStyle(
                              color: isDark
                                  ? const Color(0xFFFAFAFA)
                                  : const Color(0xFF111827),
                              fontSize: 14,
                              fontWeight: FontWeight.w600,
                              height: 1.2,
                            ),
                            overflow: TextOverflow.ellipsis,
                          ),
                          const SizedBox(height: 2),
                          Text(
                            displayName,
                            style: const TextStyle(
                              color: Color(0xFF6B7280),
                              fontSize: 12,
                              height: 1.2,
                            ),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ],
                      ),
                    ),
                    Icon(
                      LucideIcons.chevronDown,
                      color: const Color(0xFF808080),
                      size: 16,
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 24),
            // Menu Items
            _buildSidebarItem(
              theme: theme,
              icon: LucideIcons.fileText,
              label: 'Post Collections',
              isActive: _currentTab == 0,
              onTap: () {
                setState(() {
                  _currentTab = 0;
                });
              },
            ),
            const SizedBox(height: 4),
            _buildSidebarItem(
              theme: theme,
              icon: LucideIcons.settings,
              label: 'Settings',
              isActive: _currentTab == 1,
              onTap: () {
                setState(() {
                  _currentTab = 1;
                });
              },
            ),
            const Spacer(),
            // Bottom: Theme and Log Out
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: widget.onToggleTheme,
                    style: OutlinedButton.styleFrom(
                      padding: EdgeInsets.zero,
                      side: BorderSide(color: sidebarBorderColor),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(6),
                      ),
                    ),
                    child: Icon(
                      widget.isDark ? LucideIcons.sun : LucideIcons.moon,
                      color: theme.colorScheme.onSurface,
                      size: 18,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: OutlinedButton(
                    onPressed: () async {
                      await _apiService.clearAuth();
                      widget.onLogout();
                    },
                    style: OutlinedButton.styleFrom(
                      padding: EdgeInsets.zero,
                      side: BorderSide(color: sidebarBorderColor),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(6),
                      ),
                    ),
                    child: Icon(
                      LucideIcons.logOut,
                      color: theme.colorScheme.error,
                      size: 18,
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSidebarItem({
    required ThemeData theme,
    required IconData icon,
    required String label,
    required bool isActive,
    required VoidCallback onTap,
  }) {
    final isDark = theme.brightness == Brightness.dark;

    final activeBg = isDark ? const Color(0xFF27272A) : const Color(0xFFDCDCDC);
    final activeText = isDark
        ? const Color(0xFFFAFAFA)
        : const Color(0xFF000000);
    final inactiveText = isDark
        ? const Color(0xFFA1A1AA)
        : const Color(0xFF606060);
    final hoverBg = isDark ? const Color(0xFF1F1F23) : const Color(0xFFE8E8E8);

    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      hoverColor: hoverBg,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: isActive ? activeBg : Colors.transparent,
          borderRadius: BorderRadius.circular(6),
        ),
        child: Row(
          children: [
            Icon(icon, color: isActive ? activeText : inactiveText, size: 16),
            const SizedBox(width: 12),
            Text(
              label,
              style: TextStyle(
                color: isActive ? activeText : inactiveText,
                fontWeight: isActive ? FontWeight.bold : FontWeight.normal,
                fontSize: 14,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildFiltersPanel(ThemeData theme) {
    final hasActiveFilters =
        _source != null ||
        _selectedAuthorIds.isNotEmpty ||
        _selectedTagIds.isNotEmpty ||
        _selectedMediaType != null;

    if (!hasActiveFilters) return const SizedBox.shrink();

    final isDark = theme.brightness == Brightness.dark;
    final rowBgColor = isDark
        ? const Color(0xFF0C0C0E)
        : const Color(0xFFF9F9FF);

    return Container(
      height: 44,
      decoration: BoxDecoration(
        color: rowBgColor,
        border: Border(
          bottom: BorderSide(
            color: theme.colorScheme.outlineVariant,
            width: 1.0,
          ),
        ),
      ),
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 6.0),
        children: [
          if (_source != null)
            Padding(
              padding: const EdgeInsets.only(right: 8.0),
              child: InputChip(
                label: Text(
                  'Platform: $_source',
                  style: const TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                onDeleted: () {
                  setState(() {
                    _source = null;
                    _page = 1;
                  });
                  _loadPosts();
                },
                visualDensity: VisualDensity.compact,
              ),
            ),
          if (_selectedMediaType != null)
            Padding(
              padding: const EdgeInsets.only(right: 8.0),
              child: InputChip(
                label: Text(
                  'Type: $_selectedMediaType',
                  style: const TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                onDeleted: () {
                  setState(() {
                    _selectedMediaType = null;
                    _page = 1;
                  });
                  _loadPosts();
                },
                visualDensity: VisualDensity.compact,
              ),
            ),
          if (_selectedAuthorIds.isNotEmpty)
            ..._selectedAuthorIds.map((id) {
              final auth = _availableAuthors.firstWhere(
                (a) => a.id == id,
                orElse: () =>
                    Author(id: id, nickname: 'Unknown', platform: 'UNKNOWN'),
              );
              return Padding(
                padding: const EdgeInsets.only(right: 8.0),
                child: InputChip(
                  label: Text(
                    'Author: ${auth.nickname}',
                    style: const TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  onDeleted: () {
                    setState(() {
                      _selectedAuthorIds.remove(id);
                      _page = 1;
                    });
                    _loadPosts();
                  },
                  visualDensity: VisualDensity.compact,
                ),
              );
            }),
          if (_selectedTagIds.isNotEmpty)
            ..._selectedTagIds.map((id) {
              final tag = _availableTags.firstWhere(
                (t) => t.id == id,
                orElse: () => TagItem(id: id, name: 'Unknown', postCount: 0),
              );
              return Padding(
                padding: const EdgeInsets.only(right: 8.0),
                child: InputChip(
                  label: Text(
                    'Tag: ${tag.name}',
                    style: const TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  onDeleted: () {
                    setState(() {
                      _selectedTagIds.remove(id);
                      _page = 1;
                    });
                    _loadPosts();
                  },
                  visualDensity: VisualDensity.compact,
                ),
              );
            }),
          TextButton.icon(
            onPressed: () {
              setState(() {
                _source = null;
                _selectedMediaType = null;
                _selectedAuthorIds = [];
                _selectedTagIds = [];
                _page = 1;
              });
              _loadPosts();
            },
            icon: const Icon(LucideIcons.x, size: 12),
            label: const Text(
              'Clear All',
              style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold),
            ),
            style: TextButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              visualDensity: VisualDensity.compact,
            ),
          ),
        ],
      ),
    );
  }

  void _showFiltersDialog() {
    String? tempSource = _source;
    String tempSortBy = _sortBy;
    String tempSortOrder = _sortOrder;
    String? tempMediaType = _selectedMediaType;
    int tempPageSize = _pageSize;
    List<String> tempAuthorIds = List.from(_selectedAuthorIds);
    List<String> tempTagIds = List.from(_selectedTagIds);

    showDialog(
      context: context,
      builder: (context) {
        final theme = Theme.of(context);
        final isDark = theme.brightness == Brightness.dark;

        final platforms = [
          {'label': 'All', 'value': null},
          {'label': 'Douyin', 'value': 'DOUYIN'},
          {'label': 'XHS', 'value': 'XHS'},
          {'label': 'Bilibili', 'value': 'BILIBILI'},
          {'label': 'X', 'value': 'X'},
          {'label': 'TikTok', 'value': 'TIKTOK'},
          {'label': 'Instagram', 'value': 'INSTAGRAM'},
          {'label': 'Youtube', 'value': 'YOUTUBE'},
        ];

        return StatefulBuilder(
          builder: (context, setDialogState) {
            final dialogOutlinedButtonStyle = OutlinedButton.styleFrom(
              minimumSize: const Size(64, 36),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            );
            final dialogElevatedButtonStyle = ElevatedButton.styleFrom(
              minimumSize: const Size(64, 36),
            );

            return AlertDialog(
              backgroundColor: theme.colorScheme.surface,
              title: const Text(
                'Filter & Sort Posts',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
              ),
              content: SizedBox(
                width: 480,
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Platform',
                        style: TextStyle(
                          fontWeight: FontWeight.bold,
                          fontSize: 13,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: platforms.map((p) {
                          final isSelected = tempSource == p['value'];
                          return ChoiceChip(
                            label: Text(p['label'] as String),
                            selected: isSelected,
                            onSelected: (selected) {
                              setDialogState(() {
                                tempSource = selected ? p['value'] : null;
                              });
                            },
                          );
                        }).toList(),
                      ),
                      const SizedBox(height: 16),
                      Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const Text(
                                  'Sort By',
                                  style: TextStyle(
                                    fontWeight: FontWeight.bold,
                                    fontSize: 13,
                                  ),
                                ),
                                const SizedBox(height: 6),
                                Container(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 10,
                                  ),
                                  decoration: BoxDecoration(
                                    border: Border.all(
                                      color: theme.colorScheme.outlineVariant,
                                    ),
                                    borderRadius: BorderRadius.circular(6),
                                  ),
                                  child: DropdownButtonHideUnderline(
                                    child: DropdownButton<String>(
                                      value: '${tempSortBy}_$tempSortOrder',
                                      isExpanded: true,
                                      dropdownColor: isDark
                                          ? const Color(0xFF09090B)
                                          : const Color(0xFFFFFFFF),
                                      style: TextStyle(
                                        color: theme.colorScheme.onSurface,
                                        fontSize: 13,
                                      ),
                                      items: const [
                                        DropdownMenuItem(
                                          value: 'published_time_desc',
                                          child: Text('Creation (New -> Old)'),
                                        ),
                                        DropdownMenuItem(
                                          value: 'published_time_asc',
                                          child: Text('Creation (Old -> New)'),
                                        ),
                                        DropdownMenuItem(
                                          value: 'import_time_desc',
                                          child: Text('Import (New -> Old)'),
                                        ),
                                        DropdownMenuItem(
                                          value: 'import_time_asc',
                                          child: Text('Import (Old -> New)'),
                                        ),
                                      ],
                                      onChanged: (val) {
                                        if (val != null) {
                                          final parts = val.split('_');
                                          final order = parts.removeLast();
                                          final by = parts.join('_');
                                          setDialogState(() {
                                            tempSortBy = by;
                                            tempSortOrder = order;
                                          });
                                        }
                                      },
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(width: 16),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const Text(
                                  'Media Type',
                                  style: TextStyle(
                                    fontWeight: FontWeight.bold,
                                    fontSize: 13,
                                  ),
                                ),
                                const SizedBox(height: 6),
                                Container(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 10,
                                  ),
                                  decoration: BoxDecoration(
                                    border: Border.all(
                                      color: theme.colorScheme.outlineVariant,
                                    ),
                                    borderRadius: BorderRadius.circular(6),
                                  ),
                                  child: DropdownButtonHideUnderline(
                                    child: DropdownButton<String?>(
                                      value: tempMediaType,
                                      isExpanded: true,
                                      dropdownColor: isDark
                                          ? const Color(0xFF09090B)
                                          : const Color(0xFFFFFFFF),
                                      style: TextStyle(
                                        color: theme.colorScheme.onSurface,
                                        fontSize: 13,
                                      ),
                                      items: const [
                                        DropdownMenuItem(
                                          value: null,
                                          child: Text('All Types'),
                                        ),
                                        DropdownMenuItem(
                                          value: 'IMAGE',
                                          child: Text('Image'),
                                        ),
                                        DropdownMenuItem(
                                          value: 'VIDEO',
                                          child: Text('Video'),
                                        ),
                                        DropdownMenuItem(
                                          value: 'LIVE_PHOTO',
                                          child: Text('Live Photo'),
                                        ),
                                        DropdownMenuItem(
                                          value: 'AUDIO',
                                          child: Text('Audio'),
                                        ),
                                        DropdownMenuItem(
                                          value: 'PDF',
                                          child: Text('PDF'),
                                        ),
                                      ],
                                      onChanged: (val) {
                                        setDialogState(() {
                                          tempMediaType = val;
                                        });
                                      },
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 16),
                      Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const Text(
                                  'Page Size',
                                  style: TextStyle(
                                    fontWeight: FontWeight.bold,
                                    fontSize: 13,
                                  ),
                                ),
                                const SizedBox(height: 6),
                                Container(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 10,
                                  ),
                                  decoration: BoxDecoration(
                                    border: Border.all(
                                      color: theme.colorScheme.outlineVariant,
                                    ),
                                    borderRadius: BorderRadius.circular(6),
                                  ),
                                  child: DropdownButtonHideUnderline(
                                    child: DropdownButton<int>(
                                      value: tempPageSize,
                                      isExpanded: true,
                                      dropdownColor: isDark
                                          ? const Color(0xFF09090B)
                                          : const Color(0xFFFFFFFF),
                                      style: TextStyle(
                                        color: theme.colorScheme.onSurface,
                                        fontSize: 13,
                                      ),
                                      items: const [
                                        DropdownMenuItem(
                                          value: 20,
                                          child: Text('20'),
                                        ),
                                        DropdownMenuItem(
                                          value: 50,
                                          child: Text('50'),
                                        ),
                                        DropdownMenuItem(
                                          value: 100,
                                          child: Text('100'),
                                        ),
                                      ],
                                      onChanged: (val) {
                                        if (val != null) {
                                          setDialogState(() {
                                            tempPageSize = val;
                                          });
                                        }
                                      },
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(width: 16),
                          const Spacer(),
                        ],
                      ),
                      const SizedBox(height: 20),
                      const Text(
                        'Authors & Tags',
                        style: TextStyle(
                          fontWeight: FontWeight.bold,
                          fontSize: 13,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          OutlinedButton.icon(
                            onPressed: () async {
                              final result =
                                  await _showAuthorSelectDialogHelper(
                                    tempAuthorIds,
                                  );
                              if (result != null) {
                                setDialogState(() {
                                  tempAuthorIds = result;
                                });
                              }
                            },
                            icon: const Icon(LucideIcons.user, size: 14),
                            label: Text(
                              tempAuthorIds.isEmpty
                                  ? 'Select Authors'
                                  : '${tempAuthorIds.length} Selected',
                              style: const TextStyle(fontSize: 12),
                            ),
                            style: dialogOutlinedButtonStyle,
                          ),
                          const SizedBox(width: 12),
                          OutlinedButton.icon(
                            onPressed: () async {
                              final result = await _showTagSelectDialogHelper(
                                tempTagIds,
                              );
                              if (result != null) {
                                setDialogState(() {
                                  tempTagIds = result;
                                });
                              }
                            },
                            icon: const Icon(LucideIcons.tag, size: 14),
                            label: Text(
                              tempTagIds.isEmpty
                                  ? 'Select Tags'
                                  : '${tempTagIds.length} Selected',
                              style: const TextStyle(fontSize: 12),
                            ),
                            style: dialogOutlinedButtonStyle,
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
              actions: [
                TextButton(
                  onPressed: () {
                    setDialogState(() {
                      tempSource = null;
                      tempSortBy = 'published_time';
                      tempSortOrder = 'desc';
                      tempMediaType = null;
                      tempPageSize = 20;
                      tempAuthorIds.clear();
                      tempTagIds.clear();
                    });
                  },
                  child: const Text('Reset All'),
                ),
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('Cancel'),
                ),
                ElevatedButton(
                  onPressed: () {
                    setState(() {
                      _source = tempSource;
                      _sortBy = tempSortBy;
                      _sortOrder = tempSortOrder;
                      _selectedMediaType = tempMediaType;
                      _pageSize = tempPageSize;
                      _selectedAuthorIds = tempAuthorIds;
                      _selectedTagIds = tempTagIds;
                      _page = 1;
                    });
                    _loadPosts();
                    Navigator.pop(context);
                  },
                  style: dialogElevatedButtonStyle,
                  child: const Text('Apply'),
                ),
              ],
            );
          },
        );
      },
    );
  }

  Future<List<String>?> _showAuthorSelectDialogHelper(
    List<String> initialSelected,
  ) async {
    List<String> tempSelected = List.from(initialSelected);
    String searchKeyword = "";

    return showDialog<List<String>>(
      context: context,
      builder: (context) {
        final theme = Theme.of(context);
        return StatefulBuilder(
          builder: (context, setDialogState) {
            final filteredAuthors = _availableAuthors.where((author) {
              return author.nickname.toLowerCase().contains(
                    searchKeyword.toLowerCase(),
                  ) ||
                  author.platform.toLowerCase().contains(
                    searchKeyword.toLowerCase(),
                  );
            }).toList();

            return AlertDialog(
              backgroundColor: theme.colorScheme.surface,
              title: const Text(
                'Select Authors',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
              ),
              content: SizedBox(
                width: 360,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    TextField(
                      decoration: InputDecoration(
                        hintText: 'Search authors...',
                        prefixIcon: const Icon(LucideIcons.search, size: 16),
                        contentPadding: const EdgeInsets.symmetric(vertical: 8),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(8),
                          borderSide: BorderSide(
                            color: theme.colorScheme.outlineVariant,
                          ),
                        ),
                      ),
                      style: const TextStyle(fontSize: 13),
                      onChanged: (val) {
                        setDialogState(() {
                          searchKeyword = val;
                        });
                      },
                    ),
                    const SizedBox(height: 12),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxHeight: 240),
                      child: filteredAuthors.isEmpty
                          ? const Center(
                              child: Padding(
                                padding: EdgeInsets.all(24.0),
                                child: Text(
                                  'No authors found',
                                  style: TextStyle(
                                    color: Colors.grey,
                                    fontSize: 13,
                                  ),
                                ),
                              ),
                            )
                          : ListView.builder(
                              shrinkWrap: true,
                              itemCount: filteredAuthors.length,
                              itemBuilder: (context, index) {
                                final author = filteredAuthors[index];
                                final isChecked = tempSelected.contains(
                                  author.id,
                                );
                                return CheckboxListTile(
                                  title: Row(
                                    children: [
                                      Text(
                                        author.nickname,
                                        style: const TextStyle(
                                          fontSize: 13,
                                          fontWeight: FontWeight.bold,
                                        ),
                                      ),
                                      const SizedBox(width: 8),
                                      Container(
                                        padding: const EdgeInsets.symmetric(
                                          horizontal: 6,
                                          vertical: 2,
                                        ),
                                        decoration: BoxDecoration(
                                          color: theme
                                              .colorScheme
                                              .secondaryContainer,
                                          borderRadius: BorderRadius.circular(
                                            4,
                                          ),
                                        ),
                                        child: Text(
                                          author.platform,
                                          style: TextStyle(
                                            fontSize: 9,
                                            fontWeight: FontWeight.bold,
                                            color: theme
                                                .colorScheme
                                                .onSecondaryContainer,
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                  value: isChecked,
                                  onChanged: (checked) {
                                    setDialogState(() {
                                      if (checked == true) {
                                        tempSelected.add(author.id);
                                      } else {
                                        tempSelected.remove(author.id);
                                      }
                                    });
                                  },
                                  controlAffinity:
                                      ListTileControlAffinity.leading,
                                  dense: true,
                                );
                              },
                            ),
                    ),
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed: () {
                    setDialogState(() {
                      tempSelected.clear();
                    });
                  },
                  child: const Text('Clear All'),
                ),
                TextButton(
                  onPressed: () => Navigator.pop(context, null),
                  child: const Text('Cancel'),
                ),
                ElevatedButton(
                  onPressed: () {
                    Navigator.pop(context, tempSelected);
                  },
                  child: const Text('Apply'),
                ),
              ],
            );
          },
        );
      },
    );
  }

  Future<List<String>?> _showTagSelectDialogHelper(
    List<String> initialSelected,
  ) async {
    List<String> tempSelected = List.from(initialSelected);
    String searchKeyword = "";

    return showDialog<List<String>>(
      context: context,
      builder: (context) {
        final theme = Theme.of(context);
        return StatefulBuilder(
          builder: (context, setDialogState) {
            final filteredTags = _availableTags.where((tag) {
              return tag.name.toLowerCase().contains(
                searchKeyword.toLowerCase(),
              );
            }).toList();

            return AlertDialog(
              backgroundColor: theme.colorScheme.surface,
              title: const Text(
                'Select Tags',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
              ),
              content: SizedBox(
                width: 360,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    TextField(
                      decoration: InputDecoration(
                        hintText: 'Search tags...',
                        prefixIcon: const Icon(LucideIcons.search, size: 16),
                        contentPadding: const EdgeInsets.symmetric(vertical: 8),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(8),
                          borderSide: BorderSide(
                            color: theme.colorScheme.outlineVariant,
                          ),
                        ),
                      ),
                      style: const TextStyle(fontSize: 13),
                      onChanged: (val) {
                        setDialogState(() {
                          searchKeyword = val;
                        });
                      },
                    ),
                    const SizedBox(height: 12),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxHeight: 240),
                      child: filteredTags.isEmpty
                          ? const Center(
                              child: Padding(
                                padding: EdgeInsets.all(24.0),
                                child: Text(
                                  'No tags found',
                                  style: TextStyle(
                                    color: Colors.grey,
                                    fontSize: 13,
                                  ),
                                ),
                              ),
                            )
                          : ListView.builder(
                              shrinkWrap: true,
                              itemCount: filteredTags.length,
                              itemBuilder: (context, index) {
                                final tag = filteredTags[index];
                                final isChecked = tempSelected.contains(tag.id);
                                return CheckboxListTile(
                                  title: Row(
                                    children: [
                                      Text(
                                        tag.name,
                                        style: const TextStyle(
                                          fontSize: 13,
                                          fontWeight: FontWeight.bold,
                                        ),
                                      ),
                                      const SizedBox(width: 8),
                                      Text(
                                        '(${tag.postCount})',
                                        style: const TextStyle(
                                          fontSize: 11,
                                          color: Colors.grey,
                                        ),
                                      ),
                                    ],
                                  ),
                                  value: isChecked,
                                  onChanged: (checked) {
                                    setDialogState(() {
                                      if (checked == true) {
                                        tempSelected.add(tag.id);
                                      } else {
                                        tempSelected.remove(tag.id);
                                      }
                                    });
                                  },
                                  controlAffinity:
                                      ListTileControlAffinity.leading,
                                  dense: true,
                                );
                              },
                            ),
                    ),
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed: () {
                    setDialogState(() {
                      tempSelected.clear();
                    });
                  },
                  child: const Text('Clear All'),
                ),
                TextButton(
                  onPressed: () => Navigator.pop(context, null),
                  child: const Text('Cancel'),
                ),
                ElevatedButton(
                  onPressed: () {
                    Navigator.pop(context, tempSelected);
                  },
                  child: const Text('Apply'),
                ),
              ],
            );
          },
        );
      },
    );
  }

  Widget _buildPaginationToolbar(ThemeData theme) {
    final totalPages = (_total / _pageSize).ceil();
    final displayPages = totalPages == 0 ? 1 : totalPages;
    final isPrevDisabled = _page <= 1 || _isLoading;
    final isNextDisabled = _page >= displayPages || _isLoading;

    return Container(
      height: 48,
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        border: Border(
          top: BorderSide(color: theme.colorScheme.outlineVariant, width: 1.0),
        ),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 16.0),
      child: Row(
        children: [
          // Total Count
          Text(
            'Total: $_total posts',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
              fontWeight: FontWeight.w500,
            ),
          ),
          const Spacer(),
          // Prev button
          IconButton(
            icon: const Icon(LucideIcons.chevronLeft, size: 20),
            onPressed: isPrevDisabled
                ? null
                : () {
                    setState(() {
                      _page--;
                    });
                    _loadPosts();
                  },
          ),
          const SizedBox(width: 8),
          // Page indicator
          Text(
            'Page $_page of $displayPages',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurface,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(width: 8),
          // Next button
          IconButton(
            icon: const Icon(LucideIcons.chevronRight, size: 20),
            onPressed: isNextDisabled
                ? null
                : () {
                    setState(() {
                      _page++;
                    });
                    _loadPosts();
                  },
          ),
        ],
      ),
    );
  }

  Widget _buildSettingsTab(ThemeData theme) {
    final isDark = theme.brightness == Brightness.dark;
    final cardBg = isDark ? const Color(0xFF18181B) : const Color(0xFFFFFFFF);
    final cardBorder = isDark
        ? const Color(0xFF27272A)
        : const Color(0xFFE5E5E5);
    final String displayName = 'User';
    final String firstLetter = displayName.isNotEmpty
        ? displayName[0].toUpperCase()
        : 'U';

    return Padding(
      padding: const EdgeInsets.all(24.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'Settings',
            style: TextStyle(
              fontSize: 20,
              fontWeight: FontWeight.bold,
              color: isDark ? const Color(0xFFFAFAFA) : const Color(0xFF111827),
            ),
          ),
          const SizedBox(height: 20),
          Container(
            decoration: BoxDecoration(
              color: cardBg,
              border: Border.all(color: cardBorder),
              borderRadius: BorderRadius.circular(12),
            ),
            padding: const EdgeInsets.all(16),
            child: Column(
              children: [
                Row(
                  children: [
                    CircleAvatar(
                      radius: 20,
                      backgroundColor: const Color(0xFFEFF6FF),
                      child: Text(
                        firstLetter,
                        style: const TextStyle(
                          color: Color(0xFF2563EB),
                          fontSize: 16,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            displayName,
                            style: TextStyle(
                              fontSize: 15,
                              fontWeight: FontWeight.w600,
                              color: isDark
                                  ? const Color(0xFFFAFAFA)
                                  : const Color(0xFF111827),
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            'Authenticated via Token Session',
                            style: TextStyle(
                              fontSize: 12,
                              color: isDark
                                  ? const Color(0xFFA1A1AA)
                                  : const Color(0xFF6B7280),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 16.0),
                  child: Divider(height: 1),
                ),
                Row(
                  children: [
                    Icon(
                      widget.isDark ? LucideIcons.sun : LucideIcons.moon,
                      color: isDark
                          ? const Color(0xFFA1A1AA)
                          : const Color(0xFF606060),
                      size: 20,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        'Dark Mode Theme',
                        style: TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w500,
                          color: isDark
                              ? const Color(0xFFFAFAFA)
                              : const Color(0xFF111827),
                        ),
                      ),
                    ),
                    // Premium Custom Flat Toggle Switch
                    GestureDetector(
                      onTap: widget.onToggleTheme,
                      child: Container(
                        width: 44,
                        height: 24,
                        decoration: BoxDecoration(
                          color: widget.isDark
                              ? const Color(0xFF2563EB)
                              : const Color(0xFFD1D5DB),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: AnimatedAlign(
                          duration: const Duration(milliseconds: 150),
                          alignment: widget.isDark
                              ? Alignment.centerRight
                              : Alignment.centerLeft,
                          child: Padding(
                            padding: const EdgeInsets.all(2.0),
                            child: Container(
                              width: 20,
                              height: 20,
                              decoration: const BoxDecoration(
                                color: Colors.white,
                                shape: BoxShape.circle,
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
          OutlinedButton.icon(
            onPressed: () async {
              await _apiService.clearAuth();
              widget.onLogout();
            },
            icon: const Icon(LucideIcons.logOut, size: 16),
            label: const Text('Sign Out from Account'),
            style: OutlinedButton.styleFrom(
              backgroundColor: isDark
                  ? const Color(0xFF1A1313)
                  : const Color(0xFFFEF2F2),
              foregroundColor: const Color(0xFFEF4444),
              side: BorderSide(
                color: isDark
                    ? const Color(0xFF452323)
                    : const Color(0xFFFCA5A5),
              ),
              padding: const EdgeInsets.symmetric(vertical: 14),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(8),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildPostListTab(ThemeData theme, bool isMobile) {
    final isDark = theme.brightness == Brightness.dark;
    return Column(
      children: [
        // Header bar (Mobile only)
        if (isMobile)
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: 16.0,
              vertical: 8.0,
            ),
            child: Row(
              children: [
                GestureDetector(
                  onTap: _showLibrarySwitcher,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        LucideIcons.folder,
                        color: theme.colorScheme.primary,
                        size: 18,
                      ),
                      const SizedBox(width: 8),
                      ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 180),
                        child: Text(
                          _activeLibrary?.name ?? 'No Library',
                          style: theme.textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.bold,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      Icon(
                        LucideIcons.chevronDown,
                        color: theme.colorScheme.onSurfaceVariant,
                        size: 16,
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),

        // Search input & Filter toggle
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 8.0),
          child: Row(
            children: [
              Expanded(
                child: SizedBox(
                  height: 38,
                  child: TextField(
                    controller: _searchController,
                    onSubmitted: (_) => _triggerSearch(),
                    style: TextStyle(
                      fontSize: 14,
                      color: isDark
                          ? const Color(0xFFFAFAFA)
                          : const Color(0xFF09090B),
                    ),
                    decoration: InputDecoration(
                      hintText: 'Search posts...',
                      hintStyle: TextStyle(
                        fontSize: 14,
                        color: isDark
                            ? const Color(0xFF71717A)
                            : const Color(0xFF94A3B8),
                      ),
                      prefixIcon: Icon(
                        LucideIcons.search,
                        size: 16,
                        color: isDark
                            ? const Color(0xFF71717A)
                            : const Color(0xFF94A3B8),
                      ),
                      prefixIconConstraints: const BoxConstraints(
                        minWidth: 36,
                        minHeight: 38,
                      ),
                      suffixIcon: _searchController.text.isNotEmpty
                          ? IconButton(
                              icon: const Icon(LucideIcons.x, size: 16),
                              padding: EdgeInsets.zero,
                              constraints: const BoxConstraints(),
                              onPressed: () {
                                _searchController.clear();
                                _triggerSearch();
                              },
                              color: isDark
                                  ? const Color(0xFF71717A)
                                  : const Color(0xFF94A3B8),
                            )
                          : null,
                      suffixIconConstraints: const BoxConstraints(
                        minWidth: 32,
                        minHeight: 38,
                      ),
                      filled: true,
                      fillColor: isDark
                          ? const Color(0xFF18181B)
                          : const Color(0xFFF8FAFC),
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 0,
                      ),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(9999),
                        borderSide: BorderSide(
                          color: isDark
                              ? const Color(0xFF27272A)
                              : const Color(0xFFE2E8F0),
                          width: 1.0,
                        ),
                      ),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(9999),
                        borderSide: BorderSide(
                          color: isDark
                              ? const Color(0xFF27272A)
                              : const Color(0xFFE2E8F0),
                          width: 1.0,
                        ),
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(9999),
                        borderSide: BorderSide(
                          color: isDark
                              ? const Color(0xFF38BDF8)
                              : const Color(0xFF3B82F6),
                          width: 1.5,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              _buildFilterToggleButton(theme),
            ],
          ),
        ),

        // Filters Panel
        _buildFiltersPanel(theme),

        // Post list or Loading / Empty state
        Expanded(
          child: _isLoading
              ? const Center(child: CircularProgressIndicator())
              : _posts.isEmpty
              ? Center(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        LucideIcons.inbox,
                        size: 48,
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                      const SizedBox(height: 16),
                      Text(
                        'No posts found.',
                        style: theme.textTheme.titleMedium?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                          fontWeight: FontWeight.bold,
                          decoration: TextDecoration.underline,
                        ),
                      ),
                    ],
                  ),
                )
              : LayoutBuilder(
                  builder: (context, constraints) {
                    // Dynamically compute columns to fit min 200px width cards
                    final cols = (constraints.maxWidth / 220).floor().clamp(
                      1,
                      6,
                    );

                    return GridView.builder(
                      padding: const EdgeInsets.all(24.0),
                      gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                        crossAxisCount: cols,
                        crossAxisSpacing: 16,
                        mainAxisSpacing: 16,
                        childAspectRatio:
                            0.8, // Adjust child aspect ratio to accommodate content below cover image
                      ),
                      itemCount: _posts.length,
                      itemBuilder: (context, index) {
                        final post = _posts[index];
                        return PostCardItem(post: post);
                      },
                    );
                  },
                ),
        ),

        // Pagination toolbar
        _buildPaginationToolbar(theme),
      ],
    );
  }

  Widget _buildFilterToggleButton(ThemeData theme) {
    final isDark = theme.brightness == Brightness.dark;
    final isActive =
        _source != null ||
        _selectedAuthorIds.isNotEmpty ||
        _selectedTagIds.isNotEmpty ||
        _selectedMediaType != null;

    // Match active filter toggle colors from apps/web
    final Color bg = isActive
        ? (isDark ? const Color(0xFF1E293B) : const Color(0xFFEFF6FF))
        : (isDark ? const Color(0xFF18181B) : const Color(0xFFFFFFFF));
    final Color border = isActive
        ? (isDark ? const Color(0xFF334155) : const Color(0xFFBFDBFE))
        : (isDark ? const Color(0xFF27272A) : const Color(0xFFE2E8F0));
    final Color iconColor = isActive
        ? (isDark ? const Color(0xFF38BDF8) : const Color(0xFF1D4ED8))
        : (isDark ? const Color(0xFFA1A1AA) : const Color(0xFF475569));

    return SizedBox(
      height: 38,
      width: 38,
      child: OutlinedButton(
        onPressed: _showFiltersDialog,
        style: OutlinedButton.styleFrom(
          elevation: 0,
          backgroundColor: bg,
          foregroundColor: iconColor,
          side: BorderSide(color: border, width: 1.0),
          minimumSize: Size.zero,
          padding: EdgeInsets.zero,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(9999),
          ),
        ),
        child: Icon(LucideIcons.filter, size: 18, color: iconColor),
      ),
    );
  }

  Widget _buildMobileNavItem({
    required ThemeData theme,
    required IconData icon,
    required IconData activeIcon,
    required String label,
    required bool isActive,
    required VoidCallback onTap,
  }) {
    final color = isActive
        ? theme.colorScheme.primary
        : theme.colorScheme.onSurfaceVariant;
    return Expanded(
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(isActive ? activeIcon : icon, color: color, size: 20),
            const SizedBox(height: 4),
            Text(
              label,
              style: TextStyle(
                color: color,
                fontSize: 11,
                fontWeight: isActive ? FontWeight.bold : FontWeight.normal,
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isWide = MediaQuery.of(context).size.width >= 768;

    if (isWide) {
      // Desktop / Wide Layout with Left Sidebar
      return Scaffold(
        body: SafeArea(
          child: Row(
            children: [
              _buildLeftSidebar(theme),
              Expanded(
                child: Column(
                  children: [
                    // Pixel Perfect Header
                    Container(
                      height: 56,
                      decoration: BoxDecoration(
                        color: Colors.white,
                        border: Border(
                          bottom: BorderSide(
                            color: theme.colorScheme.outlineVariant,
                            width: 1.0,
                          ),
                        ),
                      ),
                      padding: const EdgeInsets.symmetric(horizontal: 24.0),
                      child: Row(
                        children: [
                          if (_currentTab == 0) ...[
                            const Text(
                              'Post Collections',
                              style: TextStyle(
                                fontSize: 16,
                                fontWeight: FontWeight.bold,
                                color: Color(0xFF111827),
                              ),
                            ),
                            const SizedBox(width: 8),
                            if (_total > 0)
                              Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 8,
                                  vertical: 2,
                                ),
                                decoration: BoxDecoration(
                                  color: const Color(0xFFF3F4F6),
                                  borderRadius: BorderRadius.circular(10),
                                ),
                                child: Text(
                                  '$_total',
                                  style: const TextStyle(
                                    fontSize: 11,
                                    fontFamily: 'monospace',
                                    color: Color(0xFF6B7280),
                                    fontWeight: FontWeight.normal,
                                  ),
                                ),
                              ),
                          ] else
                            const Text(
                              'Settings',
                              style: TextStyle(
                                fontSize: 16,
                                fontWeight: FontWeight.bold,
                                color: Color(0xFF111827),
                              ),
                            ),
                        ],
                      ),
                    ),
                    Expanded(
                      child: _currentTab == 0
                          ? _buildPostListTab(theme, false)
                          : _buildSettingsTab(theme),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      );
    } else {
      // Mobile Layout with Custom Flat Bottom Bar
      return Scaffold(
        bottomNavigationBar: Container(
          height: 56 + MediaQuery.of(context).padding.bottom,
          decoration: BoxDecoration(
            color: theme.colorScheme.surface,
            border: Border(
              top: BorderSide(
                color: theme.colorScheme.outlineVariant,
                width: 1.0,
              ),
            ),
          ),
          padding: EdgeInsets.only(
            bottom: MediaQuery.of(context).padding.bottom,
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceAround,
            children: [
              _buildMobileNavItem(
                theme: theme,
                icon: LucideIcons.fileText,
                activeIcon: LucideIcons.fileText,
                label: 'Posts',
                isActive: _currentTab == 0,
                onTap: () => setState(() => _currentTab = 0),
              ),
              _buildMobileNavItem(
                theme: theme,
                icon: LucideIcons.settings,
                activeIcon: LucideIcons.settings,
                label: 'Settings',
                isActive: _currentTab == 1,
                onTap: () => setState(() => _currentTab = 1),
              ),
            ],
          ),
        ),
        body: SafeArea(
          child: _currentTab == 0
              ? _buildPostListTab(theme, true)
              : _buildSettingsTab(theme),
        ),
      );
    }
  }
}

class PostCardItem extends StatefulWidget {
  final PostListItem post;

  const PostCardItem({super.key, required this.post});

  @override
  State<PostCardItem> createState() => _PostCardItemState();
}

class _PostCardItemState extends State<PostCardItem> {
  bool _isHovered = false;

  Widget _buildPlatformBadge(bool isDark, String platform) {
    Color bg = const Color(0xFFF9FAFB);
    Color text = const Color(0xFF4B5563);
    Color border = const Color(0xFFE5E7EB);

    if (platform == 'XHS') {
      bg = const Color(0xFFFEF2F2);
      text = const Color(0xFFDC2626);
      border = const Color(0xFFFECACA);
    } else if (platform == 'BILIBILI') {
      bg = const Color(0xFFFDF2F8);
      text = const Color(0xFFDB2777);
      border = const Color(0xFFFBCFE8);
    } else if (platform == 'DOUYIN' || platform == 'TIKTOK') {
      bg = const Color(0xFF0F172A);
      text = const Color(0xFFF8FAFC);
      border = const Color(0xFF1E293B);
    } else if (platform == 'YOUTUBE') {
      bg = const Color(0xFFFFF1F2);
      text = const Color(0xFFE11D48);
      border = const Color(0xFFFECDD3);
    } else if (platform == 'INSTAGRAM') {
      bg = const Color(0xFFFAF5FF);
      text = const Color(0xFF9333EA);
      border = const Color(0xFFE9D5FF);
    } else if (platform == 'X') {
      bg = const Color(0xFF0F172A);
      text = const Color(0xFFF8FAFC);
      border = const Color(0xFF1E293B);
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: border),
      ),
      child: Text(
        platform.toUpperCase(),
        style: TextStyle(fontSize: 9, color: text, fontWeight: FontWeight.bold),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDark = theme.brightness == Brightness.dark;
    final post = widget.post;

    Color cardBg = Colors.transparent;
    if (_isHovered) {
      cardBg = isDark ? const Color(0xFF1F1F23) : const Color(0xFFF4F4F5);
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        String? coverUrl;
        if (post.media.isNotEmpty) {
          coverUrl = post.media.first.getImageUrlForWidth(constraints.maxWidth);
        }

        return MouseRegion(
          onEnter: (_) => setState(() => _isHovered = true),
          onExit: (_) => setState(() => _isHovered = false),
          child: GestureDetector(
            onTap: () {
              Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (context) => PostDetailPage(postId: post.id),
                ),
              );
            },
            child: Container(
              decoration: BoxDecoration(
                color: cardBg,
                borderRadius: BorderRadius.circular(12),
              ),
              padding: const EdgeInsets.all(8.0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  AspectRatio(
                    aspectRatio: 4 / 3,
                    child: Container(
                      decoration: BoxDecoration(
                        color: isDark
                            ? const Color(0xFF1F1F23)
                            : const Color(0xFFF9FAFB),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(
                          color: isDark
                              ? const Color(0xFF27272A)
                              : const Color(0xFFF3F4F6),
                        ),
                      ),
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(8),
                        child: coverUrl != null
                            ? Image.network(
                                coverUrl,
                                fit: BoxFit.cover,
                                errorBuilder: (context, error, stackTrace) =>
                                    Center(
                                      child: Icon(
                                        LucideIcons.image,
                                        color: theme.colorScheme.onSurfaceVariant,
                                        size: 24,
                                      ),
                                    ),
                              )
                            : Center(
                                child: Icon(
                                  LucideIcons.fileText,
                                  color: theme.colorScheme.onSurfaceVariant,
                                  size: 24,
                                ),
                              ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      CircleAvatar(
                        radius: 10,
                        backgroundColor: theme.colorScheme.surfaceContainerHighest,
                        backgroundImage: post.authorAvatarUrl != null
                            ? NetworkImage(post.authorAvatarUrl!)
                            : null,
                        child: post.authorAvatarUrl == null
                            ? Text(
                                (post.authorName ?? 'U')
                                    .substring(0, 1)
                                    .toUpperCase(),
                                style: TextStyle(
                                  fontSize: 9,
                                  fontWeight: FontWeight.bold,
                                  color: theme.colorScheme.onSurfaceVariant,
                                ),
                              )
                            : null,
                      ),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          post.authorName ?? 'Unknown',
                          style: TextStyle(
                            fontSize: 12,
                            color: isDark
                                ? const Color(0xFFA1A1AA)
                                : const Color(0xFF4B5563),
                            fontWeight: FontWeight.w500,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      if (post.source != null)
                        _buildPlatformBadge(isDark, post.source!),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(
                    post.title,
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: isDark
                          ? const Color(0xFFFAFAFA)
                          : const Color(0xFF111827),
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 4),
                  Text(
                    post.publishedTime != null
                        ? post.publishedTime!.substring(0, 10)
                        : (post.media.isNotEmpty && post.media.first.width != null
                              ? '${post.media.first.width}x${post.media.first.height}'
                              : ''),
                    style: const TextStyle(fontSize: 11, color: Color(0xFF6B7280)),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}
