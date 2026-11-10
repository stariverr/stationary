import 'package:flutter_test/flutter_test.dart';
import 'package:stationary/models.dart';

void main() {
  test('media detail parses originals, captions and manifest playback', () {
    final media = Media.fromJson({
      'id': 'm1',
      'type': 'VIDEO',
      'sort_order': 0,
      'url': 'https://cdn.test/video.mp4',
      'width': 1080,
      'height': 1920,
      'duration': 12.5,
      'previews': {
        'large': {
          'url': 'https://cdn.test/l.avif',
          'width': 810,
          'height': 1440,
        },
      },
      'cover': null,
      'playback': {
        'direct_url': 'https://cdn.test/video.mp4',
        'direct_mime_type': 'video/mp4',
        'hls_url': '/api/media/m1/manifest.m3u8?sig=x',
        'dash_url': '/api/media/m1/manifest.mpd?sig=x',
        'duration': 12.5,
        'video': {
          'id': 'v',
          'codec': 'h264',
          'codec_string': 'avc1.640028',
          'width': 1920,
          'height': 1080,
          'rotation': 90,
          'frame_rate': 29.97,
        },
        'audio_tracks': [
          {
            'id': 'a1',
            'codec': 'aac',
            'codec_string': 'mp4a.40.2',
            'language': 'en',
            'label': null,
            'is_default': false,
            'channels': 2,
          },
          {
            'id': 'a2',
            'codec': 'aac',
            'codec_string': null,
            'language': 'ja',
            'label': 'Japanese',
            'is_default': true,
            'channels': 6,
          },
        ],
        'captions': [
          {
            'id': 'c1',
            'language': 'en',
            'label': null,
            'is_default': true,
            'vtt_url': 'https://cdn.test/c1.vtt',
          },
        ],
      },
      'originals': [
        {
          'id': 'o1',
          'kind': 'VIDEO',
          'url': 'https://cdn.test/video.mp4',
          'mime_type': 'video/mp4',
          'size': 1000,
          'status': 'COMPLETED',
          'last_error': null,
        },
      ],
      'captions': [
        {
          'id': 'c1',
          'origin': 'UPLOAD',
          'language': 'en',
          'label': null,
          'is_default': true,
          'status': 'COMPLETED',
          'last_error': null,
          'vtt_url': 'https://cdn.test/c1.vtt',
        },
        {
          'id': 'c2',
          'origin': 'UPLOAD',
          'language': null,
          'label': null,
          'is_default': false,
          'status': 'PENDING',
          'last_error': null,
          'vtt_url': null,
        },
      ],
    });

    expect(media.width, 1080);
    expect(media.duration, 12.5);
    expect(media.previews.poster?.width, 810);
    expect(media.originals.single.kind, 'VIDEO');
    expect(media.captions.map((c) => c.vttUrl), [
      'https://cdn.test/c1.vtt',
      null,
    ]);
    final playback = media.playback!;
    expect(playback.sourceUrl, '/api/media/m1/manifest.m3u8?sig=x');
    expect(playback.video?.rotation, 90);
    expect(playback.audioTracks.map((a) => a.isDefault), [false, true]);
    expect(playback.captions.single.vttUrl, 'https://cdn.test/c1.vtt');
  });

  test('media without a manifest plays its original directly', () {
    final playback = MediaPlayback.fromJson({
      'direct_url': 'https://cdn.test/video.mp4',
      'direct_mime_type': 'video/mp4',
      'hls_url': null,
      'dash_url': null,
      'duration': null,
      'video': null,
      'audio_tracks': [],
      'captions': [],
    });
    expect(playback.sourceUrl, 'https://cdn.test/video.mp4');
  });

  test('post list media carries its main original url and previews', () {
    final item = MediaPreview.fromJson({
      'id': 'm1',
      'post_id': 'p1',
      'type': 'VIDEO',
      'sort_order': 0,
      'url': 'https://cdn.test/video.mp4',
      'previews': {
        'medium': {
          'url': 'https://cdn.test/m.avif',
          'width': 405,
          'height': 720,
        },
      },
    });
    expect(item.url, 'https://cdn.test/video.mp4');
    expect(item.toMedia().previews.thumbnail?.width, 405);
    expect(item.toMedia().playback, isNull);
  });
}
