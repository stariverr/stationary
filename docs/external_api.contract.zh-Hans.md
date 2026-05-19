# 媒体元数据同步工作流设计与 API 规范 (简体中文)

> [English](./external_api.contract.md)

本规范旨在界定外部数据同步端（如集成代理、同步客户端）与 Stationary 后端（`TaskService`）之间的数据通信格式、同步状态流转以及幂等性保证协议。

---

## 1. 架构设计原则

本同步工作流遵循 **职责分离 (Separation of Concerns)** 与 **契约优先** 原则，以保证平台在应对高频次、重复同步的场景下具有绝对的**幂等性**与**稳定性**。

* **调用方（同步客户端/数据源端）职责**：负责解析多平台数据源、清洗防盗链参数、组装标准 Payload，并**建议尽量提供媒体的唯一标识（`external_id`）**。
* **服务端（`TaskService`）职责**：基于标准的 Payload 执行状态机流转、数据库幂等更新（Upsert）、差异化对比以及物理存储（S3）的管理。

---

## 2. 媒体唯一标识 (`external_id`) 生成规范

在外部平台同步数据时，必须保证每个媒体拥有稳定、唯一的 `external_id`。绝对**禁止单纯使用媒体数组的索引 (`index`)** 作为标识，以防止源贴内容删减导致的乱序覆盖漏洞。

### 2.1 无原生 ID 时的降级策略 (Pseudo-ID)

当源平台未提供独立的媒体 ID 时，调用方必须在业务层构建**伪唯一标识**，构建算法必须严格统一：

1. **URL 清洗**：提取源 URL 的基础路径（Base Path），**必须剥离所有动态参数**（如 `?x-expires=...`、签名 token 等防盗链参数）。
2. **哈希计算**：对清洗后的纯净 URL 计算 **BLAKE3** 散列，以其 32 位十六进制字符串作为该媒体的 `external_id`。

### 2.2 复合媒体的“主资产锚定”原则

针对由多个文件组成的逻辑实体（如 Live Photo、带有封面的视频），其 `external_id` 的生成**必须且仅能由该实体的主资产（Primary Asset）决定**。

- **Live Photo (`type: "LIVE_PHOTO"`)**
  - **主资产**：静态图片 (Image)
  - **附属属性**：动态视频轨 (Video/`live_photo_video_url`)
  - **规则**：`external_id = BLAKE3(清洗后的静态图片 URL)`。动态视频轨的 URL **不参与** ID 计算。
- **视频 (`type: "VIDEO"`)**
  - **主资产**：视频 file (Video)
  - **附属属性**：封面图 (Cover)
  - **规则**：`external_id = BLAKE3(清洗后的视频 URL)`。封面图 URL **不参与** ID 计算。

> [!IMPORTANT]
> **设计目的**：当复合实体的附属属性（如 Live Photo 的动轨 URL）发生防盗链变化时，基于主资产生成的 `external_id` 保持不变，从而精确触发服务端的局部更新逻辑（仅替换动轨文件），而不会导致整个实体的误删重建。

---

## 3. 特殊场景：视频流地址 (Streaming Media)

视频流地址（如直播流、分段的 M3U8/HLS 流）与普通的 MP4 静态地址有本质区别：**流地址是动态的、时效性极强的，且通常不对应一个单一的文件哈希。**

针对这种只有“流地址”的情况，工作流需要引入一套特殊的处理策略：

1. **身份锚定**：若媒体类型为流地址（如 HLS/M3U8），且无原生唯一 ID，其 `external_id` 应采用 `所属帖子ID + "_video_stream"` 强制生成。
2. **跳过常规比对**：由于流地址 Token 具有高频变动性，服务端在执行 `Change Detection` 时，对流地址仅更新数据库 URL 记录，不触发基于 URL 变更的物理文件删除逻辑。
3. **异步落地**：流地址的持久化需标记为 `STREAM_PROCESSING` 状态，由独立的转码服务进行异步拉流存储，主同步流不等待其完成。

---

## 4. API 契约与 Payload 格式

### 4.1 任务创建接口

- **Endpoint**: `POST /api/task/create`
- **Content-Type**: `application/json`

#### 请求体 Schema (JSON Schema 表达)

```json
{
  "posts": [
    {
      "title": "帖子标题",
      "url": "https://platform.com/post/12345",
      "description": "帖子详细描述文本",
      "external_id": "platform_post_unique_id",
      "tags": ["标签1", "标签2"],
      "platform": "XHS",
      "library_id": "uuid-of-target-library-optional",
      "published_time": "2026-05-19T10:00:00Z",
      "author": {
        "name": "作者昵称",
        "short_id": "123456",
        "external_id": "author_platform_unique_id",
        "avatar_file_url": "https://platform.com/avatar.jpg"
      },
      "media": [
        {
          "external_id": "media_unique_id",
          "title": "媒体分段标题",
          "description": "媒体描述",
          "type": "IMAGE",
          "primary_file_url": "https://platform.com/media_primary.jpg",
          "alternative_file_url": null,
          "live_photo_video_url": null,
          "cover_file_url": null,
          "duration": null,
          "published_time": "2026-05-19T10:00:00Z"
        }
      ]
    }
  ]
}
```

#### 关键字段约束说明

| 字段路径 | 类型 | 是否必填 | 约束说明 |
| :--- | :--- | :--- | :--- |
| `posts[].platform` | String | 是 | 枚举值：`UNKNOWN`, `X`, `XHS`, `BILIBILI`, `DOUYIN`, `TIKTOK`, `INSTAGRAM` |
| `posts[].published_time` | String | 否 | 支持 ISO-8601 格式或 10/13 位 UNIX 时间戳（由 Zod 转换器自动解析） |
| `posts[].media[].type` | String | 是 | 枚举值：`IMAGE`, `VIDEO`, `LIVE_PHOTO` |
| `posts[].media[].primary_file_url` | String | 是 | 主媒体文件的直链 URL |
| `posts[].media[].live_photo_video_url` | String | 否 | 仅当媒体类型为 `LIVE_PHOTO` 时传递的动态视频轨 URL |
| `posts[].media[].cover_file_url` | String | 否 | 仅当媒体类型为 `VIDEO` 时传递的视频封面 URL |

---

## 5. API 对接约束检查清单（供调用方参考）

- [ ] 是否所有媒体元素均提供了有效的 `external_id`？
- [ ] 伪 ID 计算是否完全排除了 URL 的动态 Query 参数？
- [ ] 对于 Live Photo，是否仅使用了静态图片 URL 来计算伪 ID？
- [ ] 同一个帖子的媒体列表中，是否确保了 `external_id` 不存在重复？
