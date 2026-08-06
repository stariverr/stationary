# Stationary Media / Track 数据架构改进任务书

状态：实施中（身份、组合校验、File 一对一生命周期和完整性扫描已落地；生产迁移仍需先执行盘点）

适用范围：`Media`、`Track`、`File`、媒体导入与同步、媒体删除与回收、封面生成、播放解析、相关文档和测试。

## 1. 背景

Stationary 当前采用以下媒体资产模型：

```text
Library
  └── Post
        └── Media          逻辑媒体资产，post_id 可以为空
              └── Track    内容轨、音频轨、字幕、封面、缩略图和变体
                    └── File?  S3 中的物理文件
```

`Media` 表示用户可见的逻辑资产，`Track` 表示该资产的一个物理组成部分或变体，`File` 表示实际存储对象。该模型用于支持：

- 独立上传且不绑定 Post 的媒体；
- 一个视频同时拥有视频轨、音频轨、字幕和封面；
- Live Photo 的图片轨和视频轨；
- 多质量、多语言和多编码版本；
- DASH / HLS 播放；
- 异步下载、封面生成和软删除。

当前模型方向不需要推翻重做。改进重点是身份语义、应用层一致性、软删除生命周期、Track 元数据边界和历史结构清理。

## 2. 已确定的架构约束

以下内容是本任务书的前提，不属于待决策事项。

### 2.1 不使用物理外键

数据库中不引入 `.references()`、显式 `FOREIGN KEY`、物理级联删除或依赖数据库外键的跨服务事务。

`Post`、`Media`、`Track`、`File` 之间的关系属于逻辑关系：

- Drizzle `relations` 仅用于查询和类型推导；
- 写入前由应用层检查父对象和租户范围；
- 删除由应用层执行软删除；
- 后台通过完整性扫描发现异常记录；
- 任何 Worker 或 API 都不得假设数据库会自动级联清理。

### 2.2 `external_id` 在持久化边界必须存在

用户不需要填写 `external_id`。必须区分请求输入和持久化结果：

- 外部同步媒体：调用方提供稳定 ID，或按照确定算法生成稳定 ID；
- 手动上传媒体：服务端生成稳定 ID；
- 进入领域服务和数据库前，`Media.eid` 必须是非空字符串；
- 不允许用 `sort_order` 作为身份匹配 fallback；
- 不允许使用每次请求都会变化的随机值解决外部同步幂等问题；
- 如果外部同步既没有外部 ID，也无法推导稳定身份，应拒绝请求。

当前数据库列名为 `eid`，API 常用名称为 `external_id`。本阶段可以保留数据库列名，但必须统一二者的语义和映射。

### 2.3 独立媒体是正式业务状态

`post_id = NULL` 的 Media 不是异常数据，而是正式的独立媒体：

- 必须拥有 `library_id`；
- 必须拥有服务端生成的 `eid`；
- `sort_order` 只用于展示，通常为 `0`；
- 可以拥有完整的 Track、File、标签、AI 元数据和封面；
- 不得因为没有 Post 而被同步、搜索、删除或封面任务错误过滤。

### 2.4 不保留废弃路径

已经被 Track/File 取代的旧 URL 字段和兼容逻辑，在确认数据不再使用后直接移除，不增加长期 fallback、双写或迁移兼容层。

## 3. 当前问题清单

### P0: 身份和幂等性

1. `Media.eid` 虽然是 `NOT NULL`，但空字符串仍然可以写入。
2. Task API 的 `external_id` 目前是 optional。
3. `TaskService.saveMetadata` 在缺少外部 ID 时写入空字符串。
4. 同步逻辑在缺少外部 ID 时会退化到 `sort_order`。
5. `sort_order` 是可变展示字段，不适合作为资产身份。
6. Media 没有针对其业务身份的 active 唯一约束。
7. 手动上传、外部同步和独立媒体目前没有统一的身份生成入口。

涉及文件：

- `apps/server/src/api/task.ts`
- `apps/server/src/services/task.ts`
- `apps/server/src/api/import.ts`
- `apps/server/src/db/schema/index.ts`
- `docs/external_api.contract.zh-Hans.md`

### P1: 应用层关系完整性

在不使用外键的前提下，仍需要处理以下逻辑关系：

- Media 的 `post_id` 对应的 Post 是否存在；
- Media 的 `library_id` 是否与所属 Post 的 `library_id` 一致；
- Track 的 `media_id` 是否对应有效 Media；
- Track 的 `file_id` 是否对应有效 File；
- `source_track_id` 是否指向允许的源 Track；
- 标签关联是否跨越了错误的 Library；
- 搜索、AI、任务和封面记录是否仍指向可见的实体。

当前这些约束分散在 API、Service 和任务处理器中，缺少统一的写入检查和定期对账机制。

### P1: Media / Track 组合约束

以下规则目前主要由部分 API 的 Valibot 校验负责，数据库和所有写入路径没有统一保证：

- IMAGE Media 至少拥有有效的 IMAGE CONTENT Track；
- VIDEO Media 至少拥有有效的 VIDEO CONTENT Track；
- LIVE_PHOTO 至少拥有默认 IMAGE CONTENT 和默认 VIDEO CONTENT；
- AUDIO Media 至少拥有默认 AUDIO CONTENT；
- PDF Media 至少拥有默认 PDF CONTENT；
- COVER 和 THUMBNAIL 应使用 IMAGE Track；
- SUBTITLE 和 PDF 应使用 CONTENT purpose；
- Track 的 `variant_key` 必须非空；
- Track 的 `priority` 不应为负数；
- 一个 Media 下每个 `(type, purpose)` 最多一个 active default；
- 一个 Media 下最多一个 active primary；
- `is_original` 和 `is_generated` 的组合必须有明确语义。

### P1: File 生命周期

当前业务不支持复用同一个 File。每个 Track、Author 头像、Library 封面和 Draft 上传都使用各自的物理 File。File 的生命周期由其所属业务记录控制，不需要跨业务记录执行引用计数。

需要保证：

- 删除 Post 或 Media 时，在同一事务中删除对应的 Track 和 File 状态；
- Track 替换 File 后，旧 File 进入删除状态；
- 封面替换、同步失败、重试和回收站清理使用一致的 File 生命周期；
- Track 引用不存在的 File 时能够被识别；
- 过期的 DELETED File 可以由 purge 任务清理。

### P1: Track 元数据重复和漂移

Track 的格式和展示信息同时存在于独立列、`metadata` JSONB 和 `streams` JSONB 中，例如：

- `codec` / `metadata.codecs`；
- `language` / `metadata.language`；
- `width`、`height`、`duration`、`bandwidth` / metadata 对应字段；
- `container`、`is_fragmented`、`stream_layout` / metadata 对应字段；
- `source_track_id` / `metadata.source_track_id`。

当前有 `cleanTrackMetadata` 和 `deriveTrackFormat`，但同步、TrackService、封面服务存在多个写入入口，
仍然可能产生列和 JSON 不一致。

### P2: 历史结构和 schema 漂移

需要处理以下明确的历史债务：

- `Media.primary_url`、`alternative_url`、`live_photo_url`、`cover_url` 已被标记 deprecated；
- `track_quality` 的历史 migration 包含 `ORIGINAL`，当前 TypeScript `TrackQualityEnum` 不包含它；
- 当前原始性同时由 `quality`、`is_original`、`is_generated` 表达；
- 旧文档仍描述 File 保存图片尺寸和视频时长，但这些字段已经迁移到 Track；
- 旧文档仍把 Media URL 描述为主要资产来源；
- `File.size` 使用 PostgreSQL `integer`，多 GB 视频可能超过其上限；
- `File.hash` 的注释提到去重，但当前没有明确的去重语义或唯一约束；
- `File.path` 全局唯一，但同时存在 `bucket` 字段，需要明确是否永远只有一个 bucket。

### P2: 时间字段和状态机一致性

`Media` 和 `Track` 的部分更新路径没有统一维护 `update_time`。同时，`sync_status`、`delete_status`、
`delete_time`、`recycle_time` 的合法组合缺少集中定义。

需要明确：

- 哪些状态变更必须更新 `update_time`；
- 重新激活记录时是否清除 `delete_time`；
- `PENDING`、`IN_PROGRESS`、`COMPLETED`、`FAILED` 的合法转换；
- `DELETED`、`PURGED` 和回收站状态的边界；
- Track 没有 File 时哪些 `COMPLETED` 状态是合法的，例如无 URL 的可选 Track。

### P2: 索引和多租户查询

当前索引能够支持部分访问，但没有完全贴合常用查询：

- Media 列表通常过滤 `library_id`、`delete_status`、`recycle_time`，并按 `create_time` 排序；
- Post 下的 Media 常按 `post_id`、active 状态和 `sort_order` 查询；
- Track 常按 `media_id`、active 状态、同步状态和 priority 查询；
- 当前部分索引使用 `delete_time`，不一定覆盖 active/recycle 查询条件；
- Post 的 `(source, eid)` 当前是全局唯一，而 Library 是多租户边界，需要明确帖子身份到底是全局还是库内。

不能在没有数据和执行计划的情况下盲目增加索引，必须先用代表性数据验证。

## 4. 目标状态

### 4.1 Media 身份模型

```text
Media.id
  Stationary 内部主键，由服务端生成

Media.eid
  持久化后的稳定外部身份，永不为空

Media.sort_order
  Post 内展示顺序，仅用于排列和堆叠视图
```

手动上传：

```text
生成 media_id = UUIDv7
设置 id = media_id
设置 eid = media_id
post_id = NULL 或用户选择的 Post
```

外部同步：

```text
有外部 ID       -> 使用外部 ID
无外部 ID       -> 使用规范化主资源的确定性派生 ID
动态流地址      -> 使用稳定的上游身份和固定媒体锚点
无法确定        -> 拒绝同步
```

### 4.2 Media 身份唯一范围

按照当前服务层的匹配语义，建议使用两类 active partial unique index：

```text
绑定 Post 的 Media：
(post_id, source, eid)
WHERE post_id IS NOT NULL
  AND delete_status = 'ACTIVE'
  AND trim(eid) <> ''

独立 Media：
(library_id, source, eid)
WHERE post_id IS NULL
  AND delete_status = 'ACTIVE'
  AND trim(eid) <> ''
```

在实现前必须确认业务是否允许同一个外部媒体在同一 Library 的多个 Post 中重复出现。
如果外部平台 ID 是全局唯一且媒体不允许重复，则应改为 `(library_id, source, eid)` 或 `(source, eid)`，
不能同时保留相互矛盾的规则。

### 4.3 Track 字段边界

独立列作为播放选择、排序和过滤的规范来源：

- `variant_key`
- `type`
- `purpose`
- `quality`
- `priority`
- `is_default`
- `is_primary`
- `language`
- `codec`
- `duration`
- `width`
- `height`
- `bandwidth`
- `container`
- `is_fragmented`
- `stream_layout`
- `has_video`
- `has_audio`
- `streams`
- `source_track_id`

`metadata` 只保留不适合固定列的低频或格式特有信息，例如：

- DASH `segment_base`；
- 封面 recipe 和 generation mode；
- 原始平台扩展字段；
- 不参与常规查询的解析信息。

同一字段不应同时在独立列和 `metadata` 中作为两个可写真相。

## 5. 实施任务

### M0. 数据盘点和规则冻结

优先级：P0

任务：

- 统计 `Media.eid IS NULL` 和 `trim(eid) = ''`；
- 统计绑定 Media 的重复 `(post_id, source, eid)`；
- 统计独立 Media 的重复 `(library_id, source, eid)`；
- 统计以 `sort_order` 作为唯一可匹配依据的历史数据；
- 统计 Media 与 Post 的 `library_id` 不一致；
- 统计不存在 Media 的 Track；
- 统计不存在 File 的 Track；
- 统计非法 `source_track_id`；
- 统计 `is_original` 和 `is_generated` 同时为 true 的 Track；
- 统计负数 priority、尺寸、时长和带宽；
- 统计废弃 URL 字段仍有非空值的 Media；
- 确认 Post 的 `(source, eid)` 是全局身份还是 Library 内身份；
- 确认同一外部媒体是否允许挂载到多个 Post。

交付物：

- 一份只读 SQL 盘点脚本：`apps/server/src/scripts/audit_media_track_integrity.ts`；
- 一份可阻断迁移的前置检查：`apps/server/src/scripts/verify_media_track_migration.ts`；
- 一份数据问题统计结果；
- 一份冻结后的身份范围和媒体组合规则。

验收标准：

- 所有历史异常都有数量；
- 每类异常都有处理策略：修复、保留并标记、或拒绝迁移；
- 没有在未盘点数据前直接创建唯一索引。

### M1. 统一 Media 身份生成和校验

优先级：P0

建议新增一个小型领域工具，例如：

```text
apps/server/src/lib/utils/media-identity.ts
```

职责：

- 校验非空外部身份；
- 规范化外部 ID；
- 为手动 Media 生成 UUIDv7；
- 为无原生 ID 的外部媒体生成确定性派生 ID；
- 处理动态流地址的固定锚点；
- 明确区分“调用方提供的 ID”和“服务端生成的 ID”；
- 不依赖 `sort_order`。

实现要求：

- 手动上传创建 Media 时，在领域层生成 `eid`；
- 外部同步 payload 在进入 `saveMetadata` 前完成身份解析；
- 外部同步无法得到稳定身份时返回明确的参数错误；
- `Media.eid` 不允许写入空字符串；
- 所有 Media API 响应继续返回稳定身份；
- 重新同步同一 Media 时必须复用原有身份；
- 不用每次请求随机生成的 ID 作为外部同步 fallback。

验收标准：

- 手动上传不需要用户输入 `external_id`，但数据库记录一定有非空 `eid`；
- 缺少稳定外部身份的同步请求不会创建新 Media；
- 删除 `sort_order` 匹配逻辑后，已有同步测试仍能通过；
- 同一 payload 重复提交不会产生重复 Media。

### M2. 移除 sort_order 身份 fallback

优先级：P0

修改范围：

- `TaskService.saveMetadata`；
- `TaskService.processMedia`；
- `TaskService.processMediaById`；
- 任何通过 `sort_order` 查找 Media 的同步或重试路径；
- 相关文档和测试。

规则：

- `sort_order` 只用于展示、排序和 Post 内重排；
- 同步、重试、变更检测和删除必须使用 `media.id` 或稳定 `eid`；
- 如果调用方只知道 `post_id + sort_order`，调用方需要先完成身份解析，不能由服务端继续 fallback。

验收标准：

- 全仓库搜索不再存在用 `sort_order` 识别 Media 的业务逻辑；
- Media 重排不会改变后续同步对象；
- 外部媒体顺序变化不会造成错误覆盖或错误删除。

### M3. 增加非外键的数据约束

优先级：P0

迁移内容：

- `Media.eid` 增加非空语义检查：`trim(eid) <> ''`；
- 增加绑定 Media 的 active 身份唯一索引；
- 增加独立 Media 的 active 身份唯一索引；
- 移除 `Track.variant_key` 的 `temp-migration` 默认值；
- Track 的所有写入路径必须显式生成 `variant_key`；
- 根据盘点结果增加 `priority >= 0`；
- 根据盘点结果增加尺寸、时长和带宽的非负检查；
- 根据最终语义增加 `is_original` / `is_generated` 组合检查；
- 根据最终规则增加 `sort_order >= 0`。

注意：当前 `RecycleService` 会先使用负数临时 sort order 再重排。若增加 `sort_order >= 0`，必须先把临时值改为不冲突的正数临时值，再增加检查。

验收标准：

- 数据库可以拒绝空 `eid`、重复身份和非法数值；
- 所有现有写入路径都能通过新约束；
- 软删除记录不阻塞 active 身份重建；
- 没有引入物理外键或级联删除。

### M4. 建立应用层关系完整性和 reconciliation

优先级：P1

实现内容：

- 创建 Media 时校验 Library；
- 绑定 Post 时校验 Post 存在且 Library 一致；
- 更新或移动 Media 时校验新的 Library 和 Post 组合；
- 创建或更新 Track 时校验 Media；
- 绑定 File 时校验 File 记录和可用状态；
- 设置 `source_track_id` 时校验来源是否允许；
- 更新 MediaTag、PostTag 时校验目标 Tag 属于同一 Library 或明确允许共享；
- 所有访问路径统一执行 Library 权限检查；
- 增加周期性完整性扫描任务：`POST /api/task/sweep-media-track-integrity`，默认只报告和计数，不自动物理删除。

reconciliation 至少检查：

```text
Media.post_id -> Post
Media.library_id -> Library
Media.post_id + Media.library_id -> Post.library_id
Track.media_id -> Media
Track.file_id -> File
Track.source_track_id -> Track
MediaTag -> Media / Tag
PostTag -> Post / Tag
AI / Search / Job records -> canonical entity
```

处理策略：

- 默认只报告和计数，不自动物理删除；
- 可安全修复的记录进入软删除或 FAILED 状态；
- 修复过程必须可重试、可审计；
- 任务结果记录发现数量、修复数量和跳过原因。

验收标准：

- 不依赖 FK 也能发现孤儿和跨 Library 引用；
- 所有新增写入路径都有应用层 guard；
- reconciliation 重复执行不会产生额外副作用；
- 任务异常不会删除仍可能被使用的物理文件。

### M5. 统一 Media / Track composition 校验

优先级：P1

把 `media-composition.ts` 中的规则提升为所有写入路径共享的领域校验：

- 外部同步；
- 手动导入；
- Media API 注册 Track；
- 从 Draft 添加 Track；
- 封面生成；
- 任何后台修复和重试任务。

需要单独定义两种状态：

1. **创建中的暂态**：允许 Media 或 Track 处于 PENDING，允许 Track 暂时没有 File；
2. **可见完成态**：必须满足 Media 类型对应的最小 Track 组合，并且主内容轨可解析。

不能简单增加 `sync_status = COMPLETED AND file_id IS NOT NULL` 这种全局规则，因为无 URL 的可选 Track
可能合法地以无 File 状态结束。需要先定义状态矩阵，再实现校验。

验收标准：

- 所有 API 和后台路径对同一非法组合返回相同错误；
- PENDING 暂态仍能正常创建和重试；
- COMPLETED Media 不会缺少必要的主内容轨；
- LIVE_PHOTO、PDF、SUBTITLE 等特殊规则有测试覆盖。

### M6. 统一 Track 格式和元数据写入

优先级：P1

修改范围：

- `TrackService`；
- `TaskService`；
- `CoverService`；
- `track-format.ts`；
- Track metadata 类型定义。

规则：

- 所有 Track 写入先经过同一个格式归一化入口；
- `container`、`is_fragmented`、`stream_layout`、`has_video`、`has_audio`、`streams`
  使用独立列作为规范来源；
- `codec`、`language`、`duration`、尺寸和 bandwidth 使用独立列作为规范来源；
- `metadata` 不再重复存储这些字段；
- `source_track_id` 只保留独立列；
- `metadata` 只保留 DASH、封面 recipe 和低频原始扩展信息；
- 所有更新路径都重新计算派生格式字段；
- 收紧 `TrackMetadata` 的类型，避免无限制的 `any` 覆盖核心字段。

验收标准：

- 同一个 Track 的列和 metadata 不再出现冲突值；
- 同步下载、替换 File、生成封面和手动修改后格式字段一致；
- DASH、HLS、progressive、字幕和 PDF 的现有播放行为不回归；
- 新增字段有明确的 canonical owner。

### M7. 统一 File 一对一生命周期

优先级：P1

审计并修改：

- `DeleteService.deletePost`；
- `DeleteService.deleteMedia`；
- `TrackService.replaceFile`；
- `TrackService.deleteTrack`；
- `TaskService` 的过期 Track 清理；
- `CoverService.generateCover`；
- File purge 和孤儿扫描任务。

规则：

- File 记录存在但对应业务记录已删除时，进入 purge 队列；
- S3 物理删除只能由 purge 任务执行；
- File 软删除和所属业务记录的软删除必须在同一个业务事务内完成。

验收标准：

- Track 删除会同步处理其所属 File；
- Track 替换 File；
- 封面重新生成；
- 回收和恢复；
- 过期 File purge 可以安全重试；

### M8. 清理历史字段并统一枚举语义

优先级：P2

#### Media 旧 URL 字段

确认没有运行时代码依赖后，删除：

- `primary_url`；
- `alternative_url`；
- `live_photo_url`；
- `cover_url`。

同步更新 API、OpenAPI、前端类型和文档。所有物理资源地址从 Track/File 派生。

#### Track 原始质量语义

在数据盘点后选择唯一方案：

- 推荐方案：`quality` 只表达 `HIGH`、`MEDIUM`、`LOW`，原始性由 `is_original` 表达；迁移并清理数据库中的
  `ORIGINAL` enum 值；
- 备选方案：保留 `ORIGINAL`，将其加入 TypeScript enum、API schema、播放和封面配置，并明确 `is_original` 是否仍然保留。

禁止让 migration、TypeScript enum、文档和测试分别使用不同语义。

#### File 元数据

- 更新文档，明确尺寸、时长和播放格式属于 Track；
- `File.size` 评估并迁移为 `bigint`，确保支持多 GB 文件；
- 明确 `File.hash` 是仅用于审计，还是用于内容去重；
- 如果实现内容去重，定义 hash 算法、空值策略、碰撞处理和唯一范围；
当前决策：`File.hash` 仅作为可选审计/内容指纹字段，不参与自动去重；`File.path` 是当前全局唯一的 S3
对象身份，`bucket` 是存储位置记录。若未来支持多 bucket 下同名 path，需要先新增明确的 `(bucket, path)` 迁移
和唯一约束。

验收标准：

- 生产代码和文档不再引用已删除 URL 列；
- enum 的数据库值和 TypeScript 值完全一致；
- 多 GB 文件的 size 写入、读取和 API 序列化正确；
- File hash 和 path 的唯一性语义有文档和测试。

### M9. 统一时间字段和状态转换

优先级：P2

实现内容：

- 审计所有 Media、Track 的 update 路径；
- 所有业务字段更新统一维护 `update_time`；
- 定义 Media、Track 的状态转换表；
- 明确 retry、restore、replace、soft delete、purge 的字段清理规则；
- 重新激活时明确是否清除 `delete_time`；
- 让状态对账任务可以发现状态和物理 File 不一致。

验收标准：

- 任何可观察到的业务更新都有正确的 update_time；
- 非法状态转换会被拒绝；
- 重试不会遗留旧的 `last_error`、`file_id` 或 stale 标记；
- 回收、恢复和物理清理的字段状态可预测。

### M10. 查询和索引优化

优先级：P2

先使用真实或代表性数据执行 `EXPLAIN (ANALYZE, BUFFERS)`，再决定索引。

重点评估：

- Library 下 active Media 列表；
- Post 下 active Media 排序；
- 独立 Media 列表；
- Media 批量读取 active Track；
- Cover reconcile 批量扫描；
- File purge；
- 外部 ID 幂等查询。

候选索引包括：

- active Media 的 `(library_id, create_time)`；
- active Media 的 `(post_id, sort_order)`；
- active Track 的 `(media_id, priority)`；
- 身份匹配的 partial unique index；
- reconciliation 所需的状态索引。

候选索引不能未经执行计划验证直接添加，避免重复索引和写入放大。

验收标准：

- 代表性数据下核心列表和详情查询没有大范围顺序扫描；
- 新增索引能够被目标查询使用；
- 写入吞吐和 migration 时间没有不可接受的回归；
- 删除和 reconciliation 查询也有可接受的执行计划。

### M11. 完善测试矩阵

优先级：P1/P2

新增或补充 PostgreSQL 集成测试，不能只依赖静态源码匹配测试。

必须覆盖：

#### 身份

- 手动上传不输入 external_id 仍生成非空 eid；
- 外部同步使用调用方 external_id；
- URL 派生 ID 稳定且规范化；
- 缺少稳定身份时请求失败；
- sort_order 改变不会改变 Media 身份；
- 重复提交同一 payload 不产生重复 Media；
- 并发重复提交受到唯一约束保护。

#### 独立 Media

- `post_id = NULL` 可以创建、查询、移动 Library、生成封面和删除；
- 独立 Media 不依赖 Post 的排序；
- 独立 Media 的 eid 在 Library 范围内正确隔离。

#### Track 组合

- 每种 MediaType 的最小 Track 组合；
- 默认轨和主轨唯一性；
- 多语言音频和字幕；
- Live Photo；
- PDF；
- PENDING Track 无 File 的合法暂态；
- 无效 Track 组合在每个写入入口都被拒绝。

#### 生命周期

- Media 删除会同步处理所属 File；
- Track 替换 File；
- 封面重新生成；
- 回收和恢复；
- 过期 File purge 可以安全重试；

#### 数据质量

- 空 eid、重复 eid、非法 priority 和非法尺寸被拒绝；
- schema migration 可处理现存脏数据；
- enum 和 API schema 一致；
- `File.size` 支持大文件。

## 6. 推荐实施顺序

```text
M0 数据盘点和规则冻结
  ↓
M1 统一身份生成
  ↓
M2 移除 sort_order fallback
  ↓
M3 增加非外键的数据约束
  ↓
M4 应用层关系完整性和 reconciliation
  ↓
M5 统一 Media / Track composition 校验
  ↓
M6 统一 Track 格式和 metadata
  ↓
M7 统一 File 生命周期
  ↓
M8 清理历史字段和 enum
  ↓
M9 时间字段和状态机
  ↓
M10 索引优化
  ↓
M11 完整测试和生产验证
```

其中 M0 到 M3 属于身份正确性基础，未完成前不应继续扩展新的 Media/Track 变体类型。

## 7. 迁移和发布要求

1. 先部署只读盘点和指标，不先改变写入行为。
2. 修复历史空 eid 和重复身份，生成迁移报告。
3. 部署身份生成逻辑，保证新数据不再产生空 eid。
4. 部署唯一索引和检查约束。
5. 移除 sort_order fallback。
6. 部署 reconciliation 和 File purge 生命周期。
7. 最后删除废弃列和旧兼容代码。
8. 每一步都保留可查询的迁移统计和失败记录。

不允许：

- 在没有数据盘点的情况下直接创建唯一索引；
- 用随机值掩盖无法确定的外部身份；
- 保留 sort_order fallback 作为长期兼容路径；
- 使用数据库外键或级联删除解决问题；
- 通过删除有意义的字段来规避诊断或迁移失败。

## 8. 完成定义

本任务整体完成需要满足：

- 所有持久化 Media 都有非空且稳定的 eid；
- 手动上传不要求用户输入 external_id；
- 外部同步不再依赖 sort_order；
- 独立 Media 是受支持的正式状态；
- Media 身份范围和唯一性规则已落入数据库索引；
- 不使用物理外键，但应用层关系检查和 reconciliation 完整；
- Media / Track composition 规则覆盖所有写入入口；
- Track 格式字段拥有唯一 canonical 来源；
- Track/File 一对一生命周期和删除流程经过统一实现；
- 废弃 Media URL 字段已删除；
- enum、文档、TypeScript 和 migration 一致；
- 多 GB File size 可以正确保存；
- 核心身份、组合、删除、恢复、重试和并发场景都有集成测试；
- 相关文档已同步更新。
