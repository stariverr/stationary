import 'package:material_ui/material_ui.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../services/api_service.dart';

class ServerSettingsDialog extends StatefulWidget {
  final bool isLoggedIn;
  final ValueChanged<String>? onServerChanged;

  const ServerSettingsDialog({
    super.key,
    this.isLoggedIn = false,
    this.onServerChanged,
  });

  static Future<bool?> show(
    BuildContext context, {
    bool isLoggedIn = false,
    ValueChanged<String>? onServerChanged,
  }) {
    return showDialog<bool>(
      context: context,
      barrierDismissible: true,
      builder: (context) => ServerSettingsDialog(
        isLoggedIn: isLoggedIn,
        onServerChanged: onServerChanged,
      ),
    );
  }

  @override
  State<ServerSettingsDialog> createState() => _ServerSettingsDialogState();
}

class _ServerSettingsDialogState extends State<ServerSettingsDialog> {
  final _apiService = ApiService();
  late final TextEditingController _urlController;

  bool _isTesting = false;
  bool _isSaving = false;
  String? _testResultSuccess;
  String? _testResultError;

  @override
  void initState() {
    super.initState();
    _urlController = TextEditingController(text: _apiService.baseUrl);
  }

  @override
  void dispose() {
    _urlController.dispose();
    super.dispose();
  }

  Future<void> _runConnectionTest() async {
    final rawUrl = _urlController.text.trim();
    if (rawUrl.isEmpty) {
      setState(() {
        _testResultSuccess = null;
        _testResultError = 'Please enter a server address first.';
      });
      return;
    }

    setState(() {
      _isTesting = true;
      _testResultSuccess = null;
      _testResultError = null;
    });

    try {
      final duration = await _apiService.testConnection(rawUrl);
      if (!mounted) return;
      setState(() {
        _testResultSuccess =
            'Connected successfully (${duration.inMilliseconds}ms)';
        _testResultError = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _testResultSuccess = null;
        _testResultError = e.toString().replaceAll('Exception: ', '');
      });
    } finally {
      if (mounted) {
        setState(() {
          _isTesting = false;
        });
      }
    }
  }

  Future<void> _handleSave() async {
    final rawUrl = _urlController.text.trim();
    if (rawUrl.isEmpty) {
      setState(() {
        _testResultError = 'Server address cannot be empty.';
      });
      return;
    }

    final normalized = ApiService.normalizeUrl(rawUrl);
    final isDifferent = normalized != _apiService.baseUrl;

    if (widget.isLoggedIn && isDifferent) {
      final confirm = await showDialog<bool>(
        context: context,
        builder: (ctx) {
          final theme = Theme.of(ctx);
          return AlertDialog(
            title: const Text('Switch Server?'),
            content: const Text(
              'Switching to a different server instance will log you out of your current session. Do you want to continue?',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(ctx, false),
                child: const Text('Cancel'),
              ),
              ElevatedButton(
                onPressed: () => Navigator.pop(ctx, true),
                style: ElevatedButton.styleFrom(
                  backgroundColor: theme.colorScheme.error,
                  foregroundColor: Colors.white,
                ),
                child: const Text('Switch & Sign Out'),
              ),
            ],
          );
        },
      );

      if (confirm != true) return;
    }

    setState(() {
      _isSaving = true;
    });

    try {
      await _apiService.setBaseUrl(normalized);
      if (widget.isLoggedIn && isDifferent) {
        await _apiService.clearAuth();
      }
      widget.onServerChanged?.call(normalized);

      if (!mounted) return;
      Navigator.pop(context, true);

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Server address updated to $normalized'),
          behavior: SnackBarBehavior.floating,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _testResultError = 'Failed to save server: $e';
        _isSaving = false;
      });
    }
  }

  Future<void> _handleReset() async {
    setState(() {
      _urlController.text = _apiService.defaultBaseUrl;
      _testResultSuccess = null;
      _testResultError = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDark = theme.brightness == Brightness.dark;

    final dialogBg = isDark ? const Color(0xFF18181B) : const Color(0xFFFFFFFF);
    final borderColor = isDark
        ? const Color(0xFF27272A)
        : const Color(0xFFE5E5E5);
    final textMuted = isDark
        ? const Color(0xFFA1A1AA)
        : const Color(0xFF6B7280);

    return Dialog(
      backgroundColor: dialogBg,
      insetPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: borderColor),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Padding(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Header
              Row(
                children: [
                  Container(
                    width: 36,
                    height: 36,
                    decoration: BoxDecoration(
                      color: isDark
                          ? const Color(0xFF27272A)
                          : const Color(0xFFF3F4F6),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Icon(
                      LucideIcons.server,
                      size: 18,
                      color: theme.colorScheme.onSurface,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Server Settings',
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.bold,
                            color: isDark
                                ? const Color(0xFFFAFAFA)
                                : const Color(0xFF111827),
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          'Self-hosted instance configuration',
                          style: TextStyle(fontSize: 12, color: textMuted),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    icon: const Icon(LucideIcons.x, size: 18),
                    padding: EdgeInsets.zero,
                    constraints: const BoxConstraints(),
                    onPressed: () => Navigator.pop(context, false),
                  ),
                ],
              ),
              const SizedBox(height: 20),

              // Server Address Input Field
              TextField(
                controller: _urlController,
                autofocus: false,
                decoration: InputDecoration(
                  labelText: 'Server Address',
                  hintText: 'http://192.168.1.100:9400',
                  prefixIcon: const Icon(LucideIcons.globe, size: 16),
                  suffixIcon: _urlController.text.isNotEmpty
                      ? IconButton(
                          icon: const Icon(LucideIcons.xCircle, size: 16),
                          onPressed: () {
                            setState(() {
                              _urlController.clear();
                              _testResultSuccess = null;
                              _testResultError = null;
                            });
                          },
                        )
                      : null,
                ),
                keyboardType: TextInputType.url,
                onChanged: (_) => setState(() {
                  _testResultSuccess = null;
                  _testResultError = null;
                }),
              ),
              const SizedBox(height: 8),

              // Default info & quick reset
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Expanded(
                    child: Text(
                      'Default: ${_apiService.defaultBaseUrl}',
                      style: TextStyle(fontSize: 11, color: textMuted),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  GestureDetector(
                    onTap: _handleReset,
                    child: Text(
                      'Use Default',
                      style: TextStyle(
                        fontSize: 12,
                        color: theme.colorScheme.primary,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),

              // Test Connection Row & Feedback
              Row(
                children: [
                  OutlinedButton.icon(
                    onPressed: _isTesting ? null : _runConnectionTest,
                    icon: _isTesting
                        ? const SizedBox(
                            width: 14,
                            height: 14,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(LucideIcons.activity, size: 15),
                    label: Text(
                      _isTesting ? 'Testing...' : 'Test Connection',
                      style: const TextStyle(fontSize: 13),
                    ),
                    style: OutlinedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 10,
                      ),
                      minimumSize: const Size(0, 36),
                    ),
                  ),
                ],
              ),

              if (_testResultSuccess != null) ...[
                const SizedBox(height: 10),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 8,
                  ),
                  decoration: BoxDecoration(
                    color: const Color(0xFF10B981).withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: const Color(0xFF10B981).withValues(alpha: 0.3),
                    ),
                  ),
                  child: Row(
                    children: [
                      const Icon(
                        LucideIcons.checkCircle,
                        color: Color(0xFF10B981),
                        size: 16,
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          _testResultSuccess!,
                          style: const TextStyle(
                            color: Color(0xFF10B981),
                            fontSize: 12,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ],

              if (_testResultError != null) ...[
                const SizedBox(height: 10),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 8,
                  ),
                  decoration: BoxDecoration(
                    color: theme.colorScheme.error.withValues(alpha: 0.08),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: theme.colorScheme.error.withValues(alpha: 0.3),
                    ),
                  ),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Padding(
                        padding: const EdgeInsets.only(top: 2.0),
                        child: Icon(
                          LucideIcons.alertTriangle,
                          color: theme.colorScheme.error,
                          size: 15,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          _testResultError!,
                          style: TextStyle(
                            color: theme.colorScheme.error,
                            fontSize: 12,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ],

              if (widget.isLoggedIn) ...[
                const SizedBox(height: 16),
                Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: const Color(0xFFF59E0B).withValues(alpha: 0.08),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: const Color(0xFFF59E0B).withValues(alpha: 0.25),
                    ),
                  ),
                  child: Row(
                    children: [
                      const Icon(
                        LucideIcons.info,
                        color: Color(0xFFF59E0B),
                        size: 16,
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          'Changing server while logged in will sign you out of current session.',
                          style: TextStyle(
                            fontSize: 11,
                            color: isDark
                                ? const Color(0xFFFCD34D)
                                : const Color(0xFFB45309),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ],

              const SizedBox(height: 24),

              // Action Buttons
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: _isSaving
                        ? null
                        : () => Navigator.pop(context, false),
                    child: const Text('Cancel'),
                  ),
                  const SizedBox(width: 8),
                  ElevatedButton(
                    onPressed: _isSaving ? null : _handleSave,
                    style: ElevatedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 20),
                      minimumSize: const Size(80, 40),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8),
                      ),
                    ),
                    child: _isSaving
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('Save & Apply'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
