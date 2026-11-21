# 帖子与媒体接口整理方案

媒体重构（[media_refactor.zh-Hans.md](./media_refactor.zh-Hans.md)）理顺了媒体内部的数据：原件、预览图、播放、字幕。这份方案处理它的外壳：帖子和媒体接口的路由、请求参数和响应字段。目标是让同一个概念在所有接口里只有一个名字、一种写法。

不保留旧接口，也不做兼容层（AGENTS.md）。服务端、网页、Flutter 在同一次改动里一起切换。

## 1. 现状问题

**路由有三种风格**

| 风格 | 例子 | 所在 |
|---|---|---|
| 动作在前 | `GET /post/list`、`GET /post/detail/:id`、`POST /post/delete/:id`、`POST /post/update-info/:id` | post、media、library、tag |
| 资源在前，只用 POST | `POST /media/:id/cover/delete`、`POST /media/:id/captions/:captionId/update` | media 的编辑接口 |
| 资源在前，用 HTTP 方法 | `PUT /ai/providers/:id`、`DELETE /ai/models/:id`、`DELETE /user/tokens/:id` | ai、user |

命名也混着用：`bind_media` 是下划线，`regenerate-previews` 是连字符。

**请求参数不统一**

- 每页数量：`/post/list` 和 `/media/list` 用 `count`（10 到 100），`/post/:id/media` 用 `limit`。
- 排序：`sort_by=import_time` 实际按 `create_time` 排，名字和字段对不上。
- `src/api/schemas/` 下的部分 schema 和 `post.ts` 里的同名定义重复；`SingleRegenerateCoverParamSchema`、`BatchRegenerateCoversSchema`、`GetMpdRequestSchema`、`GetHlsRequestSchema`、`GetHlsVariantRequestSchema` 已经没有地方用。

**列表的响应不统一**

- `/post/list`、`/media/list` 返回 `{ list, total }`；`/post/:id/media` 返回 `{ list, page, limit, total, total_pages }`。

**字段不统一**

| 问题 | 现状 |
|---|---|
| 同名不同义 | 帖子的 `type` 是 `MULTI_MEDIA` / `TEXT`，由媒体数量推出；媒体的 `type` 是 IMAGE、VIDEO 等 |
| 名字看不出含义 | 媒体列表的 `media_count` 指“所在帖子的媒体数” |
| 空值写法不一 | 帖子的 `published_time` 没有值时是 `null`；媒体的 `create_time`、`published_time` 没有值时直接省略 |
| 列表和详情对不上 | 媒体列表有 `ai_status`、`ai_error`，详情是 `ai` 对象；媒体详情有 `tags`，媒体列表没有；帖子列表有 `tags` |
| 多余字段 | 媒体详情的 `position`：客户端没有用到，页码和下标就能算出 |
| 同一概念两个名字 | 帖子和媒体的外部身份叫 `eid`，导入接口里叫 `external_id`；作者字段平铺成 `author_name`、`author_avatar_url`、`author_external_id` |
| 帖子列表里的媒体另成一套 | 只有 `id`、`post_id`、`type`、`sort_order`、`previews`、`url`，和媒体列表的条目不是同一个形状 |

## 2. 规则

以后新增或修改接口都按这些规则来。

### 2.1 路由

不完全照搬 REST，只用 `GET` 和 `POST` 两种方法，规则如下：

- 路径按“资源 → ID → 子资源 → 动词”的顺序写，资源名沿用现在的单数前缀：`/api/post`、`/api/media`。
- 读用 `GET`：
  - 列表：`GET /post/list`；
  - 单个资源：`GET /post/:id`；
  - 子资源列表：`GET /post/:id/media`。
- 写一律用 `POST`，路径以动词结尾，如 `POST /post/create`、`POST /post/:id/update`、`POST /post/:id/trash`、`POST /media/:id/cover/delete`。动词从固定的一组里选：`create`、`add`、`update`、`replace`、`reorder`、`remove`、`delete`、`trash`、`restore`、`regenerate`，以及专用的 `upload-url`、`download-url`。
- `delete` 是删除记录本身；`remove` 是解除关联，比如把媒体移出帖子。
- 路径里多个单词用连字符：`audio-tracks`、`upload-url`。`bind_media` 这类下划线写法不再使用。

这样做的原因：现在大多数接口已经是 GET 加 POST，媒体的编辑接口也已经是“资源在前、动词在后”，只需把剩下的接口统一过来。动词写在路径里，看日志和代码时一眼就知道是什么操作，客户端也不用区分 `PUT`、`PATCH`、`DELETE`。

### 2.2 请求

- 分页统一用 `page`（从 1 开始）和 `page_size`。
- 排序用 `sort_by` 和 `sort_order`，`sort_by` 的值就是响应里的字段名，如 `create_time`、`published_time`。
- 多值过滤沿用逗号分隔的字符串，如 `tag_ids=a,b`。
- 每个接口的 schema 只定义一次，放在 `src/api/schemas/`；删掉没有用到的 schema。

### 2.3 响应

- 外层信封不变：`{ success, code, message, data }`。
- 列表统一为 `{ list, total, page, page_size }`。总页数由客户端计算。
- 字段永远存在。没有值就是 `null`，不省略。
- 时间都是 ISO 8601 字符串，字段名以 `_time` 结尾，和数据库一致。
- 同一个资源只有两种形状：摘要（列表里用）和详情（单个资源用）。详情是摘要的超集，同名字段含义相同。
- 能从别的字段直接推出来的值不返回，如帖子的 `type`、媒体的 `position`、`total_pages`。

## 3. 资源形状

### 3.1 媒体

**MediaSummary**：`GET /media` 的条目，也是帖子摘要里 `media` 的条目。

| 字段 | 说明 |
|---|---|
| `id`、`library_id`、`post_id` | `post_id` 可为 `null`（没有归属帖子的媒体） |
| `post_media_count` | 所在帖子的媒体数；没有帖子时为 `null`。原 `media_count` |
| `external_id` | 原 `eid` |
| `type`、`source`、`title`、`description`、`sort_order` | |
| `width`、`height`、`duration` | 媒体摘要（media_refactor 3.2） |
| `url` | 主原件地址，可为 `null` |
| `previews` | `{ small, medium, large }`，每项为 `{ url, width, height }` 或 `null` |
| `tags` | 标签名数组 |
| `ai` | `{ status, error }`，原 `ai_status`、`ai_error` |
| `sync_status`、`last_error` | |
| `create_time`、`published_time` | |

**MediaDetail**：`GET /media/:id` 和 `GET /posts/:id/media` 的条目。在 MediaSummary 之上增加：

| 字段 | 说明 |
|---|---|
| `cover` | 用户设置的封面，可为 `null` |
| `playback` | 播放信息（media_refactor 7.1），可为 `null` |
| `originals`、`captions` | 编辑器用，形状不变 |
| `ai` | 扩展为完整的 AI 信息（描述、标签建议等），`status`、`error` 两个字段保留 |

删除 `position`。

### 3.2 帖子

**PostSummary**：`GET /posts` 的条目。

| 字段 | 说明 |
|---|---|
| `id`、`library_id`、`external_id`、`source`、`title` | `external_id` 原 `eid` |
| `author` | `{ name, avatar_url, external_id }`，没有作者时为 `null`。原平铺的三个字段 |
| `tags` | 标签名数组 |
| `media_count` | 帖子的媒体总数 |
| `media` | 前 4 个媒体，每个是 MediaSummary |
| `sync_status`、`last_error`、`create_time`、`published_time` | |

删除 `type`：客户端用 `media_count > 0` 判断。

**PostDetail**：`GET /posts/:id`。在 PostSummary 之上增加 `description`、`url`（源平台帖子地址）。媒体仍然通过 `GET /posts/:id/media` 分页读取，返回 MediaDetail，因为查看器要用播放信息。

## 4. 路由对照

`GET /post/:id` 和 `GET /media/:id` 的 `:id` 只接受 UUID，`list`、`authors` 这类固定路径注册在它们之前。

### 4.1 帖子（前缀 `/api/post` 不变）

| 现在 | 改为 |
|---|---|
| `GET /post/list` | 不变 |
| `GET /post/detail/:id` | `GET /post/:id` |
| `GET /post/authors` | 不变 |
| `POST /post/create` | 不变 |
| `POST /post/update-info/:id` | `POST /post/:id/update` |
| `POST /post/trash/:id` | `POST /post/:id/trash` |
| `POST /post/restore/:id` | `POST /post/:id/restore` |
| `POST /post/delete/:id` | `POST /post/:id/delete` |
| `POST /post/:id/tags/replace` | 不变 |
| `GET /post/:id/media` | 不变 |
| `POST /post/:id/bind_media` | `POST /post/:id/media/add` |
| `POST /post/:id/media/reorder` | 不变 |
| `POST /post/:id/media/:mediaId/remove` | 不变 |

### 4.2 媒体（前缀 `/api/media` 不变）

| 现在 | 改为 |
|---|---|
| `GET /media/list` | 不变 |
| `GET /media/detail/:id` | `GET /media/:id` |
| `POST /media/update-info/:id` | `POST /media/:id/update` |
| `POST /media/trash/:id` | `POST /media/:id/trash` |
| `POST /media/restore/:id` | `POST /media/:id/restore` |
| `POST /media/delete/:id` | `POST /media/:id/delete` |
| `POST /media/:id/tags/replace` | 不变 |
| `POST /media/:id/regenerate-previews` | `POST /media/:id/previews/regenerate` |
| `POST /media/regenerate-previews` | `POST /media/previews/regenerate` |
| `POST /media/:id/cover/presign-upload` | `POST /media/:id/cover/upload-url` |
| `POST /media/:id/cover` | `POST /media/:id/cover/replace` |
| `POST /media/:id/cover/delete` | 不变 |
| `POST /media/:id/originals` | `POST /media/:id/originals/add` |
| `POST /media/:id/originals/:originalId/delete` | 不变 |
| `GET /media/:id/originals/:originalId/download-url` | 不变 |
| `POST /media/:id/captions` | `POST /media/:id/captions/add` |
| `POST /media/:id/captions/:captionId/update` | 不变 |
| `POST /media/:id/captions/:captionId/delete` | 不变 |
| `POST /media/:id/audio-tracks/:streamId/update` | 不变 |

三个播放清单 `GET /media/:id/manifest.mpd`、`GET /media/:id/manifest.m3u8`、`GET /media/:id/hls/:renditionId/manifest.m3u8` 不变：播放器按固定的文件名请求，本来就符合规则。

帖子 13 条里改 6 条，媒体 19 条里改 11 条，其余已经符合规则。

## 5. 客户端改动

- **网页**：`app/types/post.ts` 等类型定义；`stores/posts.ts`、`stores/media.ts` 的请求和字段映射；直接请求接口的组件（`MediaLightbox`、`MediaEditor`、`MediaCoverPanel`、`PostCreateDialog`、`OrphanMediaPickerDialog`、`MoveItemsBar`、`PostCard`、`MediaCard` 等）。帖子卡片和媒体卡片改用同一个 MediaSummary 映射。
- **Flutter**：`lib/services/api_service.dart` 的 5 个帖子接口调用（列表、详情、作者、帖子媒体）；`lib/models.dart` 的帖子和媒体模型。
- **OpenAPI**：`src/scripts/generate_openapi.ts` 按新的 schema 重新生成。

## 6. 分步实施

每一步结束时，服务端和两个客户端都能完整运行。

1. **字段**：按第 3 节改响应形状和第 2.2 节的请求参数，路由不动。服务端、网页、Flutter 一起改。
2. **路由**：按第 4 节改帖子和媒体的路由，同时删掉重复和不用的 schema。
3. **其余接口**：library、tag、trash、import、task、jobs、ai、user 按同样的规则整理，单独规划。其中 ai 和 user 现在用了 `PUT`、`DELETE`，要改回 `POST` 加动词。

## 7. 影响

- **API Token**：`requireAuth` 接受 API Token，所以用户自己写的脚本也可能在调帖子和媒体接口。旧路由会直接失效，上线时需要告知。
- **导入契约文档**：[external_api.contract.zh-Hans.md](./external_api.contract.zh-Hans.md) 里的导入格式还是 Track 结构，已经和 media_refactor 6.3 节不一致。它属于导入接口，不在这次范围内，但应该另外更新。

## 8. 待定

- **标签的形状**：现在是标签名数组。如果客户端要用标签 ID 跳转到按标签过滤，改为 `{ id, name }`。
- **作者列表的位置**：留在 `GET /post/authors`，还是独立成 `GET /author/list?library_id=`。前者改动小，后者把作者当成一种资源。
