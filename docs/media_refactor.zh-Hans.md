# 媒体存储与播放重构方案

状态：方案已定，尚未实施（2026-11-09）。

本文取代 [media_track_improvement_tasks.zh-Hans.md](./media_track_improvement_tasks.zh-Hans.md) 中和 Track 相关的部分：Track 字段边界、Track 元数据重复，以及 Media / Track 组合约束。那份任务书里身份、`eid`、独立媒体和 File 生命周期的约束继续有效，本文沿用。

范围：原件、封面、预览图（取代现在的"低清晰度封面"）、音视频的流信息、字幕、歌词、重封装产物、HLS 和 DASH 播放、Live Photo，以及从 Track 迁移过来的步骤。

怎么读：

- 想了解整体：读第 1、2、3 节。
- 实施某个阶段：读第 13 节，找到对应的表（第 3 节）和流程（第 5 到 8 节）。
- 只关心播放：读第 7、8 节。

## 1. 为什么要重构

Track 一张表要同时表示五类东西：原件、平台给的低画质版本、系统生成的封面、字幕，以及 DASH 的音视频分轨。结果是：

- **语义靠组合列推断。** 一行到底是什么，要看 `type`、`purpose`、`is_original`、`is_generated`、`quality`、`stream_layout` 这几列的组合才知道，需要专门的组合校验（`media-composition.ts`）和推导代码（`media-playback.ts`、`track-format.ts`）。
- **元数据散在三处。** 同一个信息可能在独立列里，也可能在 `metadata` JSONB 或 `streams` JSONB 里，读的时候要层层回退。`queries.ts` 拿不到真实的编码字符串时，只能硬编码一个，比如把所有 H.264 都写成 `avc1.640028`。
- **播放能力受限。**
  - Video.js 10.3 的 `dash-video` 不把音轨交给播放器，网页上的音轨菜单一直是空的；
  - AVPlayer 不支持 DASH，iOS 和 macOS 上带分轨的媒体播不了；
  - 现在的 DASH 清单给每个文件单独设 `presentationTimeOffset`，音画可能不同步。
- **不支持多语言音轨。** "日语原声 + 中文配音 + 英文配音"这种常见情况放不进去。

## 2. 原则

1. **原件只增不改。** 替换原件就是删掉旧行、插入新行，探测结果因此永远不会过期。
2. **一张表只放一类东西。** 不用 JSONB 杂物箱，不靠"某列为 null 表示什么"这种隐含约定；只属于某些类型的列，用 CHECK 约束。
3. **只有音视频需要特殊处理。** 图片、PDF，以及以后的 SVG、Markdown、txt，都只有一个原件，不需要流信息。
4. **原件随时都能播放或查看。** 派生文件只是为了让播放更好，没有派生文件也能用。
5. **派生结果表只记录结果：成功或最终失败。** 每一行要么有文件，要么有 `last_error`，二者恰有其一；进度留在任务队列里。这和任务队列"失败看结果行"的约定一致（[job_queue.zh-Hans.md](./job_queue.zh-Hans.md) 6.1）。
6. **质量由系统判断，不由用户判断。** 用户上传的文件一律是原件，不支持手动上传低清晰度版本；平台导入只取最高画质。
7. **元数据只分两层。** 媒体层面的元数据只放在 `media` 表；播放打包信息只放在 `av_file` 和 `av_stream`，而且只有播放组装模块读取（第 7 节）。
8. **这次不做转码。** 以后要做，只需要往 `av_rendition` 里加配方、在清单里加档位，表结构不用改。

关系一律是逻辑关联，不建物理外键，沿用任务书 2.1：写入前由应用层校验，后台用完整性扫描兜底。下文的 `→` 表示逻辑引用。

## 3. 表结构

### 3.1 总览

```text
media ─┬─ media_original ── file
       │       └─(音视频)── av_file ── av_stream ─┬─ av_rendition ── file ── av_file ── av_stream
       │                                          └─ media_caption（EMBEDDED）
       ├─ media_cover ── file
       ├─ media_preview ── file
       ├─ media_caption ── file
       └─ media_lyrics ── file
```

所有类型都用：`media`、`media_original`、`media_cover`、`media_preview`。只有音视频用：`av_file`、`av_stream`、`media_caption`、`media_lyrics`、`av_rendition`。

### 3.2 media（新增三列）

```text
media  （现有列）+ display_width, display_height, duration
```

| 列 | IMAGE | VIDEO | LIVE_PHOTO | AUDIO | PDF |
|---|---|---|---|---|---|
| `display_width`、`display_height` | 图片按 EXIF 方向旋转后的宽高 | 视频流的宽高再套上旋转 | 图片原件的宽高 | 必须为空 | 必须为空 |
| `duration` | 必须为空 | 音视频原件里最长的时长 | 视频原件的时长 | 原件的时长 | 必须为空 |

- CHECK：`display_width` 和 `display_height` 同时为空或同时有值；表中"必须为空"的组合，用按 `type` 区分的 CHECK 约束。
- 适用的类型下为空，只表示还没探测完。
- 由探测步骤写入（第 6 节）。每一列都由某个确定的原件探测得到，没有"保留旧值"的情况。
- 用途：列表、排序、筛选只读 `media` 表，再按 `(media_id, size)` 连一次 `media_preview` 取缩略图。

### 3.3 media_original

```text
media_original  id, media_id, file_id, source_url, source_key, status, last_error
                index(media_id)
                CHECK ((status = 'COMPLETED') = (file_id IS NOT NULL))
```

- 没有 kind 或 role 列。一个原件是什么，看它的文件内容：探测出视频流，就是含视频的原件；只有音频流，就是只有音频的原件；是图片，就是图片原件。
- `source_url` 和 `source_key` 用于导入：`source_key` 是同步时用来匹配同一资源的稳定键。手动上传的原件这两列为空，插入时 `status` 就是 `COMPLETED`。
- `status` 沿用 `SyncStatus`。它表示"下载并探测完成"，探测失败也记为 `FAILED`。

### 3.4 media_cover

```text
media_cover  id, media_id (unique), origin (FILE|EMBEDDED), file_id, original_id → media_original,
             source_url, source_key, status, last_error
             CHECK ((origin = 'EMBEDDED') = (original_id IS NOT NULL))
             CHECK ((status = 'COMPLETED') = (file_id IS NOT NULL))
```

- `FILE`：用户上传，或者导入时带的封面。
- `EMBEDDED`：从原件里提取的封面，比如音频的专辑封面。只在提取完成后才插入。
- 一个媒体最多一个封面。两种来源都有时，用 `FILE` 的那个，`EMBEDDED` 的那行不保留。
- 只有 VIDEO、AUDIO、PDF 能有封面，图片和 Live Photo 不能有。这条在应用层校验。

### 3.5 media_preview

```text
media_preview  id, media_id, size (SMALL|MEDIUM|LARGE), source_file_id, recipe_version,
               file_id, width, height, last_error
               unique(media_id, size)
               CHECK ((file_id IS NOT NULL) <> (last_error IS NOT NULL))
               CHECK ((file_id IS NULL) = (width IS NULL AND height IS NULL))
```

- 系统生成。尺寸沿用现在 `COVER_PROFILES` 的最长边：SMALL 360、MEDIUM 720、LARGE 1440，输出格式为 AVIF。
- 每个媒体固定生成三个档位，取代 `Library.cover_qualities` 的按库配置。
- 一行要么是成功的结果（有 `file_id`、宽高），要么是最终失败（有 `last_error`）。
- **`source_file_id` 记录这一行由哪个文件生成（封面或原件）。** 一个档位只有在 `source_file_id` 等于当前来源、`recipe_version` 等于当前版本时才算最新，所以写入方改封面或原件时不必删除预览图行，preview pipeline 按当前状态对齐即可（level-triggered）。失败行同理：scan 跳过来源和版本都是当前的失败行；配方升级、来源变化、用户重新生成或重试，都会让它重新生成。
- AI 读取 LARGE 预览图（缺失时退到 MEDIUM、SMALL），输入哈希取 `source_file_id` 对应文件的哈希，因此配方升级不会触发重新描述和重新嵌入。

### 3.6 av_file

```text
av_file  id, file_id (unique), container, duration, bitrate,
         init_range, index_range, timescale, earliest_presentation_time
         CHECK：后四列同时为空或同时有值
```

- 每个音视频文件一行，包括原件和重封装产物。
- 后四列来自 sidx，只有带 sidx 的 fMP4 才有。HLS 和 DASH 只引用有这四列的文件。

### 3.7 av_stream

```text
av_stream  id, av_file_id, stream_index, type (VIDEO|AUDIO|SUBTITLE),
           codec, codec_string, bitrate, language, label, is_default,
           width, height, rotation, frame_rate,
           channels, sample_rate
           unique(av_file_id, stream_index)
```

CHECK 约束：

- `(type = 'VIDEO') = (width IS NOT NULL AND height IS NOT NULL)`
- `type = 'VIDEO' OR (rotation IS NULL AND frame_rate IS NULL)`
- `rotation IS NULL OR rotation IN (0, 90, 180, 270)`
- `(type = 'AUDIO') = (channels IS NOT NULL)`
- `type = 'AUDIO' OR sample_rate IS NULL`
- `type <> 'SUBTITLE' OR codec_string IS NULL`

各列说明：

- **`codec`**：ffprobe 的 `codec_name`，必填，比如 `h264`、`hevc`、`av1`、`vp9`、`aac`、`opus`、`flac`、`ac3`、`eac3`、`dts`、`truehd`、`webvtt`、`subrip`、`ass`、`hdmv_pgs_subtitle`。
  - 原样存储，不维护映射表。新出的编码也不用改枚举。
  - 界面上显示的 "HEVC"、"AAC" 这类名称，由前端映射。
- **`codec_string`**：RFC 6381 字符串，比如 `avc1.640028`、`hvc1.2.4.L153.B0`、`av01.0.08M.10`、`mp4a.40.2`、`mp4a.40.5`、`opus`、`ec-3`。
  - 探测时从 init 段里的 sample entry 配置盒（avcC、hvcC、av1C、esds、dOps 等）解析出来，不靠猜。
  - RFC 6381 由 MP4 的 sample entry 定义，所以只有 MP4 或 fMP4 文件里的视频流和音频流才有。MKV 等其他容器里的流没有，这条由探测代码保证，并写在列注释里。
  - 清单只引用单流 fMP4，所以只要会出现在清单里的流，一定有 `codec_string`。
  - 用途：HLS 的 `CODECS`、DASH 的 `codecs`，以及客户端调用 `MediaSource.isTypeSupported()`。
- **`width`、`height`**：编码尺寸，HLS、DASH 和解码能力判断都要用它。显示尺寸由宽高和 `rotation` 推出。
- **`rotation`**：取自视频的 display matrix。手机竖拍的视频通常编码为 1920×1080，旋转 90°。
- **专辑封面不写入本表。** 它在 ffprobe 里是一条带 `attached_pic` 的视频流，提取到 `media_cover`，记为 `EMBEDDED`。
- **`language`、`label`、`is_default`** 按这个顺序确定：先用探测结果；导入时有声明的，用声明覆盖；之后用户可以修改。同一个文件只探测一次，用户改过的值不会被覆盖。
- **默认音轨**：一个媒体的所有音轨（跨所有原件）里，只能有一条 `is_default`，在应用层校验。

### 3.8 media_caption

```text
media_caption  id, media_id, origin (FILE|EMBEDDED), language, label, is_default,
               vtt_file_id, source_file_id, source_stream_id → av_stream,
               source_url, source_key, status, last_error
               index(media_id)；部分唯一索引 (media_id) WHERE is_default
```

CHECK 约束：

- `(origin = 'EMBEDDED') = (source_stream_id IS NOT NULL)`
- `origin = 'FILE' OR source_file_id IS NULL`
- `(status = 'COMPLETED') = (vtt_file_id IS NOT NULL)`
- `origin = 'EMBEDDED' OR status <> 'COMPLETED' OR source_file_id IS NOT NULL`

说明：

- **`FILE`**：外挂的字幕文件。`source_file_id` 保存原始文件（SRT、ASS 等，作为原件保留），`vtt_file_id` 保存转换后的 WebVTT。
- **`EMBEDDED`**：从原件里提取的文字字幕，引用它在 `av_stream` 里对应的那条流。只在提取完成后才插入。
- PGS、VobSub 这类图片字幕不提取，它们只留在 `av_stream` 里作为记录。

### 3.9 media_lyrics

```text
media_lyrics  id, media_id, origin (FILE|EMBEDDED), language, label, is_default,
              timing (NONE|LINE|WORD), lrc_file_id, source_file_id, original_id → media_original,
              source_url, source_key, status, last_error
              index(media_id)；部分唯一索引 (media_id) WHERE is_default
```

- CHECK 约束和 `media_caption` 相同，只是把 `source_stream_id` 换成 `original_id`，把 `vtt_file_id` 换成 `lrc_file_id`。
- **`EMBEDDED`**：歌词存在标签里，不是流，所以引用原件。来源有 ID3 的 USLT 和 SYLT、FLAC 的 LYRICS、M4A 的 ©lyr。
- **`timing`**：`NONE` 是纯文本，`LINE` 是逐行时间，`WORD` 是逐字时间（enhanced LRC）。
- 统一转成 LRC 存入 `lrc_file_id`。

### 3.10 av_rendition

```text
av_rendition  id, media_id, source_stream_id → av_stream, recipe (remux-video|remux-audio),
              recipe_version, file_id, last_error
              unique(source_stream_id, recipe)；index(media_id)
              CHECK ((file_id IS NOT NULL) <> (last_error IS NOT NULL))
```

- 派生文件。每条都直接引用它来自的那条流，所以不需要 origin 列。
- 和 `media_preview` 一样，一行要么是成功的结果，要么是最终失败。源流随原件一起删除，所以失败时的输入同样只看 `recipe_version`。
- 目前只有重封装：`ffmpeg -c copy` 把一条流取出来，写成带 sidx 的单流 fMP4。
- 产物同样是音视频文件，所以也有自己的 `av_file` 和 `av_stream` 行。
- 以后加转码时，在这里加 `video-1080`、`audio-aac` 这类配方。

## 4. 组合规则

| 类型 | 原件 | 封面 |
|---|---|---|
| VIDEO | 恰好 1 个含视频流的原件，加上 0 到 N 个只有音频的原件 | 可以有 |
| AUDIO | 1 个 | 可以有 |
| LIVE_PHOTO | 1 个图片原件 + 1 个含视频流的原件 | 不能有 |
| IMAGE | 1 个 | 不能有 |
| PDF | 1 个 | 可以有 |

- 这些规则由应用层的统一写入入口校验，取代 `media-composition.ts` 里按 Track 组合的规则。
- 媒体的音轨列表，就是它所有原件里所有 AUDIO 类型的 `av_stream` 合在一起。混流文件里的多条音频流，和单独的音频文件，处理方式完全相同。
- 视频原件只有一个。如果它里面有多条视频流，只取第一条。"不同版本"和"多机位"都不支持。

## 5. 封面与预览图

预览图来源：

| 类型 | 预览图来源 |
|---|---|
| VIDEO | 有封面用封面，否则截一帧 |
| AUDIO | 有封面用封面，否则不生成 |
| PDF | 有封面用封面，否则取第一页 |
| IMAGE、LIVE_PHOTO | 图片原件 |

- 封面或原件发生变化时，删除这个媒体的所有预览图，由 `preview` 流水线重新生成。
- 截哪一帧、怎么缩放，都写在配方代码里，由 `recipe_version` 管理，不存进数据库。
- 生成时显式加上 `-map_metadata -1`，避免把原图的 EXIF（包括 GPS）带进预览图。

## 6. 导入与探测

### 6.1 导入

- 拉取最高画质，外加平台提供的所有语言音轨、字幕、封面和歌词。
- 平台的低画质版本不导入。

### 6.2 探测

每个原件下载完成后，由 `download` 流水线在同一步里探测，所有结果在同一个事务里写入：

- **音视频原件**
  - ffprobe 加上 sidx 解析，写入 `av_file` 和 `av_stream`，包括 `codec_string` 和 `rotation`。
  - 带 `attached_pic` 的流提取为 `EMBEDDED` 封面。
  - 内嵌的文字字幕提取为 VTT，写入 `media_caption`，记为 `EMBEDDED`。
  - 标签里的歌词提取为 LRC，写入 `media_lyrics`，记为 `EMBEDDED`。
  - 把显示尺寸和时长写入 `media`。
- **图片原件**：把按 EXIF 方向旋转后的宽高写入 `media`。
- **Live Photo**：宽高来自图片原件，时长来自视频原件。换掉哪个原件，就探测哪个、写哪几列。
- **外挂文件**：字幕和歌词下载完成后马上转换格式。

ffprobe 解不开文件时，按"输入被拒"处理（见 [job_queue.zh-Hans.md](./job_queue.zh-Hans.md) 6.1）：原件记为 `FAILED`，写入 `last_error`。

### 6.3 不在范围内的元数据

ID3、EXIF 这类描述性标签不提取：

- 不用拍摄时间填 `published_time`。schema 里 `published_time` 的定义是"在来源平台上的发布时间"，拍摄时间是另一回事。
- 以后要按拍摄时间排序时，再加一个单独的 `captured_time` 字段，从原件里回填。原件不会被修改，标签一直都在。
- GPS 不写入数据库。

## 7. 播放组装

一个与协议无关的模块，负责所有播放相关的读取。详情 DTO、HLS 清单、DASH 清单都通过它取数据，其他代码不直接连接这些表。它的工作：

1. 按媒体 ID 批量读取原件、`av_file`、`av_stream`、`av_rendition`、字幕、歌词、封面和预览图，每张表一次 `WHERE media_id IN (...)` 查询，在内存里拼起来。
2. 选出视频流：取含视频的原件里的第一条视频流。
3. 列出所有音轨，标出默认音轨。
4. 为每条要放进清单的流找一个可用的单流 fMP4：
   - 原件本身就是带 sidx 的单流 fMP4，直接用原件；
   - 否则用它的 `remux-*` 产物；
   - 两者都没有，这条流先不进清单，等重封装完成。
5. 挂上字幕。

服务端不判断编码兼容性。所有流都带上 `codec_string` 下发，由客户端判断。

### 7.1 详情 DTO 里的播放信息（示意）

```text
playback
  direct_url        原件地址，任何形态都有
  hls_url, dash_url 只在需要流式播放时有
  video             { codec, codec_string, width, height, rotation, frame_rate }
  audio_tracks[]    { id, codec, codec_string, language, label, is_default, channels }
  captions[]        { id, language, label, is_default, vtt_url }
  lyrics[]          { id, language, label, is_default, timing, lrc_url }
```

字段的具体命名在实施时定。

## 8. 播放

### 8.1 播放方式

| 媒体形态 | 播放方式 |
|---|---|
| 1 个原件，最多 1 条音轨 | 直接播放原件，不需要派生文件 |
| 其他情况（多条音轨，或者视频和音频分开存放） | 用 HLS 或 DASH 播放；直接播放原件仍然保留，但只能听到默认音轨 |

重封装几乎不耗 CPU，所以不设开关，代价是多占一份存储。

### 8.2 两种清单

两种清单都在请求时生成，不写入数据库，引用的是同一批文件里的同一段字节。

**DASH**

- 每条流用 `SegmentBase`，写入 `init_range` 和 `index_range`。sidx 由播放器自己读取。
- 整个 Period 共用同一个 `presentationTimeOffset`：取所有选中流里最小的 EPT（按秒计），再换算成每条流各自的 timescale。不能给每个文件单独归零，那样会抹掉视频和音频之间本来就有的偏移（B 帧、AAC priming），造成音画不同步。
- 每种语言的音频一个 AdaptationSet，带 `lang`、`Label`，默认音轨带 `Role` main。
- 字幕作为 `text/vtt` 的 AdaptationSet。
- 继续使用 `dash-manifest.ts`，但要改成读组装模块，并改用共同的偏移。

**HLS**

- 主列表里，一条 `EXT-X-STREAM-INF` 对应唯一的视频档位，带 `CODECS`、`RESOLUTION`、`BANDWIDTH` 和 `AUDIO` 分组。
- 每条音轨一条 `EXT-X-MEDIA TYPE=AUDIO`，带 `LANGUAGE`、`NAME` 和 `DEFAULT`。
- 字幕写成 `EXT-X-MEDIA TYPE=SUBTITLES`，供外部播放器使用。
- 每个文件一个分片列表：用 `EXT-X-MAP` 指向 init 段，再用 `EXT-X-BYTERANGE` 逐个列出分片。分片列表在请求时生成：读 `index_range` 那一小段 sidx 展开，按文件缓存。`mp4-segment.ts` 已经能解析 sidx。

### 8.3 各端使用的协议

| 端 | 协议 |
|---|---|
| 网页 | 默认 HLS，在播放器设置里可以手动切到 DASH，不做自动回退 |
| iOS、macOS（Flutter） | HLS，AVPlayer 不支持 DASH |
| Android（Flutter） | 两种都可以 |
| 外部播放器（VidHub、SenPlayer 等） | 两种都提供 |

不做自动回退：HLS 出错就悄悄改用 DASH，会掩盖 HLS 的问题，也说不清某次播放用的是哪种协议。

### 8.4 网页播放器

网页只用我们封装的播放器，不用浏览器原生的播放和控件。

```text
播放器组件
  ├─ 引擎：hlsjs-video（HLS）或 dash-video（DASH）   只有这一层随协议变化
  └─ 引擎以上，两种协议共用
       音轨菜单   读取 media.audioTracks
       字幕       把 VTT 直接加到 text track 上，不经过清单里的 SUBTITLES
       能否播放   对每条流的 codec_string 调用 MediaSource.isTypeSupported()
```

- **HLS 在所有浏览器上都用 hls.js。** Chrome、Edge、Firefox 和桌面版 Safari 基于 MSE；iOS 上的浏览器（底层都是 WebKit）基于 ManagedMediaSource，需要 iOS 17.1 以上。Safari 也不切换到原生 HLS，这样各浏览器的音轨列表和清晰度信息都来自 hls.js，行为一致。
- **DASH 需要一段音轨桥接。** Video.js 10.3 的 `dash-video` 不会填写 `media.audioTracks`，要自己补上：加载后把 dash.js 的 `getTracksFor('audio')` 转换成 `audioTracks`，用户切换时调用 `setCurrentTrack()`。以后 Video.js 官方补上这个功能，就删掉桥接。
- **兼容性由客户端判断。** 浏览器之间差别很大，有些还取决于硬件（Chrome 能否播放 HEVC 要看有没有硬件解码；AC3 和 EAC3 在 Safari 能播，在 Chrome 一般不能），服务端无法得知：
  - 不支持的音轨不列出；
  - 视频流不支持时，提示用户下载原件。
- **iOS 17.1 之前**没有 MSE，只能直接播放原件。

### 8.5 外部播放器的地址

外部播放器只拿到一个 URL，不会带上 cookie，也不会在播放中途刷新清单。所以：

- 清单的 URL 带一个可以撤销的播放 token；
- 清单里引用的分片地址指向我们自己的稳定地址，由服务端 302 跳转到 S3 预签名 URL，不直接写入会过期的预签名 URL。

细节等真正对接外部播放器时再定。现在只要求：清单和分片的地址不依赖 cookie。

### 8.6 清晰度标签

按短边计算，即 `min(width, height)`。竖屏视频旋转前后短边不变，所以不受 `rotation` 影响。

## 9. Live Photo

- 由一个图片原件和一个视频原件组成，按文件内容区分哪个是图片、哪个是视频。
- 播放视频原件；客户端判断视频编码不支持时，只显示静态图片。
- 原件不做任何修改，Apple 用来配对图片和视频的 content identifier 因此得以保留。
- Android 的 Motion Photo（JPEG 后面附加 MP4）暂时不处理，当作普通图片。

## 10. 生命周期

沿用任务书里 File 一对一的生命周期：每个业务记录拥有自己的 File，不复用。

- **删除原件**（包括替换）：在同一个事务里删除它的 `av_file`、`av_stream`、由它派生的 `av_rendition`、`EMBEDDED` 字幕、`EMBEDDED` 歌词、`EMBEDDED` 封面，以及这个媒体的所有预览图（包括失败行）；这些行引用的 `file` 全部标为 DELETED。然后用 `markChanged` 报告原件变化，触发重新生成。
- **删除或替换封面**：删除封面行和所有预览图，对应的 `file` 标为 DELETED。
- **删除媒体**：沿用现有的软删除，各表的行不动。
- **清理 S3**：由 DELETED 推进到 PURGED 的清理任务负责，目前还没有实现。

## 11. 任务队列的改动

| 流水线 | 改动 |
|---|---|
| `download` | 产出改为写入 `media_original`、`media_cover`、`media_caption`、`media_lyrics`，下载后在同一步里探测（第 6.2 节） |
| `cover` | 改名为 `preview`，读 `media.content` 和 `media.cover`，产出 `media.preview`。`recordFailure` 写入预览图的失败行。延续 `cover` 的例外：最终失败或无事可做时，也报告 `media.preview`，避免下游永远等不到它 |
| `ai.describe`、`ai.image:<空间>` | 读的方面从 `media.cover` 改为 `media.preview`，图片来源改用 LARGE 预览图 |
| `remux`（新增，第 3 阶段） | 读 `media.content`，为需要流式播放、但原件不是带 sidx 的单流 fMP4 的那些流，生成 `av_rendition`；最终失败写入 `av_rendition` 的失败行。播放在请求时组装，所以它的产出没有下游流水线 |

- 库级的方面 `library.cover_config` 随 `Library.cover_qualities` 一起删除。
- 新增流水线按 [job_queue.zh-Hans.md](./job_queue.zh-Hans.md) 9.4 节的步骤加入。

## 12. 迁移

1. Track 里属于原件的内容轨（CONTENT）写入 `media_original`。所有音视频文件重新探测，写入 `av_file` 和 `av_stream`；图片也重新探测，把宽高写入 `media`。
2. 非系统生成的封面（COVER）写入 `media_cover`，记为 `FILE`。系统生成的封面不迁移，对应的 `file` 标为 DELETED，由 `preview` 流水线重新生成预览图。
3. 外挂字幕写入 `media_caption`，记为 `FILE`，必要时转成 VTT。
4. 平台导入的低画质版本：Track 行不迁移，对应的 `file` 标为 DELETED，并写入 `delete_time`，S3 上的对象不动。
5. 删除 Track 表。

迁移时不保留旧结构，也不双写（任务书 2.4）。

## 13. 分阶段

每个阶段结束时，产品都能完整运行。

**第 1 阶段：封面与预览图**

- 新建 `media_cover` 和 `media_preview`，`cover` 流水线改为 `preview`。这一阶段原件还在 Track 里，预览图从 Track 的内容轨读取原件。
- 迁移封面，删除 `Library.cover_qualities`。

**第 2 阶段：原件、流信息和播放**

- 新建 `media_original`、`av_file`、`av_stream`、`media_caption`，给 `media` 加摘要列。
- 实现播放组装模块，改写 DASH 清单，新增 HLS 清单。
- 网页播放器默认改用 hls.js，在设置里可以切到 DASH。
- 修改客户端用到的 DTO，完成迁移，删除 Track。
- 这一阶段已经能播放现有的两种形态：直接播放，以及视频和音频分开存放的 fMP4（如 B 站）。

**第 3 阶段：多音轨**

- 新建 `av_rendition`，新增 `remux` 流水线。
- 导入时开始拉取所有语言的音轨。
- 网页播放器补上 DASH 的音轨桥接。

**第 4 阶段：歌词**

- 新建 `media_lyrics`。

转码不在计划内。

## 14. 待定

- **外部播放器鉴权的细节**：等真正对接时再定（第 8.5 节）。
- **预览图生成会不会带上元数据**：需要核实现在的 ffmpeg 命令（第 5 节）。

## 15. 删除清单

- Track 表，以及 TrackType、TrackPurpose、TrackStreamLayout、TrackQuality 四个枚举。
- `TrackMetadata`、`MediaStream` 类型，以及 `metadata`、`streams` 两个 JSONB 列。
- `Library.cover_qualities`。
- `media-playback.ts` 里的推导逻辑、`track-format.ts`、`features/ingest/track-metadata.ts`，以及 `queries.ts` 里硬编码的编码字符串。
- `backfill_track_formats` 和 `migrate_track_fields` 两个脚本。
- `media-composition.ts` 里按 Track 组合的规则，由第 4 节的规则取代。
- 客户端里管理 Track 和变体的界面（`ManageTracksDialog.vue`、`MediaVariantsManager.vue`）：改写或删除，实施时逐个确认。

## 16. 参考

| 做法 | 来源 |
|---|---|
| 媒体对象带摘要（时长、清晰度），逐条流的细节放在下一层 | YouTube Data API 的 `contentDetails` 和 `fileDetails` |
| 每条流记录旋转角度 | Jellyfin 的 MediaStream |
| 同一批 CMAF 分片，Web 和 Android 用 DASH，Apple 用 HLS | YouTube |
| 拍摄时间等 EXIF 信息作为单独字段，不和发布时间混用 | Immich、Apple Photos |
| 上传时去掉 EXIF | X、小红书。我们保留原件不动，所以改为在对外交付时处理 |
