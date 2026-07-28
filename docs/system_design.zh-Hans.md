# 系统设计与数据库规范 (简体中文)

> [English](./system_design.md)

本篇文档主要阐述 Stationary 平台的业务模块关系、核心数据库设计原则、双轨制展示机制以及多租户权限隔离方案。

---

## 1. 数据库设计原则

为保证系统在高并发、海量资产导入与同步时的吞吐能力与横向扩展能力，项目在数据库层面遵循以下核心设计规范：

### 1.1 命名规范 (Snake Case)
- 数据库的所有表名、字段名必须**严格使用 `snake_case` (下划线命名法)**。例如：`avatar_file_id`, `create_time`, `sort_order`。
- 注：Better Auth 生成的底层系统表（如 `better_user`, `better_session`）由于依赖库底层映射，保留其默认命名格式，但业务拓展字段及所有新业务表必须遵守 `snake_case`。

### 1.2 无物理外键设计 (No Explicit Foreign Keys)
- **硬性要求**：在 Drizzle ORM 定义中，绝对不允许在列上声明物理外键 `.references()`（除注释说明外）。
- **设计 Rationale**：物理外键在分布式或大规模水平扩容时会造成严重的锁竞争与级联操作负担。
- **关联处理**：所有实体关联关系均为**逻辑关联**。关联的维护和业务完整性由应用层逻辑负责，并通过 Drizzle 的 `relations`（在 `relations.ts` 中通过 `defineRelations`）进行声明，以便在 API 层进行便捷的类型推导与 `with` 关联查询。

---

## 2. 核心数据模型关系

Stationary 的底层数据模型主要分为**内容层**、**资产层**、**用户与隔离层**。

```mermaid
erDiagram
    User ||--o{ Library : "owns"
    User ||--o{ UserGroupMember : "member_of"
    UserGroup ||--o{ UserGroupMember : "has"
    Library ||--o{ Post : "contains"
    Library ||--o{ Media : "contains"
    Author ||--o{ Post : "writes"
    Post ||--o{ Media : "has"
    Media ||--o{ Track : "references"
    Track }o--|| File : "points_to"
```

### 2.1 内容层关系
- **Author (作者)**：跨平台唯一（通过 `library_id` + `platform` + `eid` 联合唯一）。保存多平台博主的昵称、签名、平台及头像文件引用（`avatar_file_id`）。
- **Post (帖子/文章)**：属于某一个 `Library`（媒体库）。是内容的逻辑载体，记录源站的 `eid`、标题、描述、标签及原始发布时间 (`published_time`)。
- **Media (媒体逻辑实体)**：隶属于某个 `Post`，或作为独立媒体（`post_id` 为 null）。包含排序、标题、描述、媒体类型（IMAGE, VIDEO, LIVE_PHOTO, AUDIO, PDF）以及各类原始下载 URL。

### 2.2 资产与物理存储层 (Track & File)
- **File (物理资产表)**：对应 S3 中的真实文件。以 UUID 为主键，记录防重下载的 SHA-256 `hash`，以及文件大小 `size`、S3 存储路径 `path`、存储桶 `bucket`、图片/视频尺寸 (`width`, `height`) 和视频时长 `duration`。
- **Track (媒体轨道表)**：作为 `Media` 与 `File` 之间的桥梁，表明一个物理文件在当前媒体中扮演的角色和格式。单个逻辑 `Media` 可以包含多个 `Track` 变体：
  - `type` (TrackType 轨道类型)：`IMAGE` (图片)、`VIDEO` (视频)、`AUDIO` (音频)、`SUBTITLE` (字幕)。
  - `purpose` (TrackPurpose 轨道用途)：
    - `CONTENT`：主轨道（如主视频轨、音频轨或原图）。
    - `COVER`：封面图（如视频对应的封面图）。
    - `THUMBNAIL`：提取的较小网格缩略图。
    - `PREVIEW`：低码率的预览流。
  - `quality` (TrackQuality 轨道画质)：`ORIGINAL`, `HIGH`, `MEDIUM`, `LOW`。
  - `priority` (优先级) 与 `source_url` (原始同步 URL)：后台同步下载时用于确定变体解析和流媒体选择的策略。
- **引用审计规则**：当多个实体引用同一个物理 `File` 时，系统不使用静态的 `ref_count` 字段，而是通过 `DeleteService.canPurgeFile` 对 `Author` 头像、`Library` 封面和 active `Track` 记录进行动态联表计数查询。

---

## 3. 生命周期与删除策略 (Lifecycle & Deletion Policies)

在无物理外键的数据库架构下，应用层必须显式维护引用完整性并规范删除流程。

### 3.1 回收站语义 (软删除与硬删除)
为提供数据可恢复性并保证物理资产的一致性，删除流程分为两阶段：
- **进入回收站 (软删除)**：`Post` 或 `Media` 的首次删除操作被定义为“软删除”。在表中将 `delete_status` 设置为 `DeleteStatus.DELETED`，并标记 `delete_time` 时间戳。对应的 `Track` 和 `File` 记录也会同步设为 `DELETED`，此时保留 S3 物理对象不作任何删改。
- **清空回收站 (异步硬删除/Purge via Cron)**：
  1. 系统后台配置了一个定时任务 `/purge-expired-files`（例如每日运行）。
  2. 该任务检索已被标记为 `DELETED` 且超过 30 天的 `File` 记录。
  3. 针对每个待清理的 `File`，执行 `DeleteService.canPurgeFile(fileId)` 动态审计。
  4. **只有当该物理文件完全没有任何其他实体引用时**，才调用 S3 API 物理删除存储对象 (`s3.delete`)，并在数据库中彻底 `DELETE` 该 `File` 记录。
  5. 这种软删除状态机确保了 S3 物理资源与 DB 逻辑数据的高度一致，避免了 API 响应阻塞和悬挂引用的发生。

### 3.2 资源库删除策略
为了防止意外删除，非空的媒体库（Library）不支持直接删除。
- **删除前置检查**：在尝试删除某个资源库 `Library` 之前，系统必须检查该库下是否存在任何 `Post` 或 `Media`，包括回收站中的记录。
- **判定规则**：只要库下仍存留任何内容，系统将拒绝删除请求并提示用户先清空资源库及其回收站。只有在内容完全清空后，才允许删除 `Library` 记录本身。

---

## 4. 双轨制展示机制 (Dual-View System)

在交互层面，平台提供以下两套主要视图：

### 4.1 看板视图 (Board View / Post List)
- 展示是以 `Post` 为主体的流。每个 Card 对应一篇帖子，卡片封面上展示该帖子下 `sort_order` 为 0 的 `Media` 缩略图。
- 能够显示作者信息、帖子标题、发布时间与帖子包含的媒体总数。

### 4.2 资产视图 (All Pins / Media List)
资产视图允许用户越过 Post 维度，直接在图片/视频层面进行铺展。在此视图下支持**两种布局切换**：

| 布局模式 | 业务筛选逻辑 (SQL Filter) | 展现效果 |
| :--- | :--- | :--- |
| **平铺模式 (Flat)** | 无特殊限制，查询并排列所有 `Media` 记录 | 每一个独立的图片或视频都作为一个单独的 Card 渲染，用户可以高频检索细节资产。 |
| **堆叠模式 (Stacked)** | `or(isNull(Media.post_id), eq(Media.sort_order, 0))` | 将属于同一帖子的多张媒体卡片“折叠”起来。只显示无 Post 的独立媒体，以及每个帖子中的**首个媒体（`sort_order` 为 0）**。卡片上会显示角标（如 `+5`）提示该合辑下还有其他多张图片。 |

---

## 5. 多租户隔离与共享机制 (User Group & Library)

为支持多用户团队协作，系统引入了多级权限控制：

### 5.1 访问资源实体
- **Library (媒体库)**：资产的物理隔离单位。每一个 Post 和 Media（如果关联）在创建时都必须指定所属的 `library_id`。

### 5.2 协作与权限
- 用户拥有独立的 `Library` 实例，亦可建立 `UserGroup` (用户组)。
- 系统支持两个维度的分享授权：
  1. **用户级别分享 (`LibraryUserAccess`)**：将 Library 的查看/编辑权限赋予特定 `User`。
  2. **用户组级别分享 (`LibraryGroupAccess`)**：将 Library 授权给整个 `UserGroup`（组内成员拥有 `LibraryGroupAccess` 定义的相应权限）。
- **权限角色 (AccessRole)**：
  - `VIEWER`：只读权限，可以浏览、搜索和检索资产。
  - `EDITOR`：编辑权限，可以创建/更新 Post、Media 并进行资产移动归档。
  - `ADMIN`：管理权限，除编辑外还可以执行媒体库删除、授权分享管理等高风险操作。

---

## 6. 任务队列引擎与 JobRunner 架构 (Task Queue Engine & JobRunner Architecture)

Stationary 采用**自研的基于 PostgreSQL 数据库轻量级异步任务队列**与进程内 `JobRunner`，完全消除了对外部集中式消息中间件（如 Redis / BullMQ）的强依赖。任务状态、分片发现、租约锁、指数退避重试与状态对账逻辑全部由 PostgreSQL 原生支撑。

```mermaid
flowchart TD
    A[API / 业务发起] -->|createTask| B[(async_task 主任务)]
    B -->|流式分批扫描| C[(async_task_unit 执行单元)]
    D[JobRunner 调度器] -->|claimUnits FOR UPDATE SKIP LOCKED| C
    D -->|executeUnit| E[TaskHandler 策略处理器]
    E -->|定时心跳续租| F[renewUnitLease]
    E -->|结算执行结果| G[settleTaskUnit]
    G -->|更新计数并校验终态| H[reconcileTask]
    I[JobSweeper 定时扫尾 process] -.-|清理死锁租约/恢复中断发现| C
```

### 6.1 主任务与执行单元数据模型

- **`AsyncTask` (主任务表)**：代表大粒度异步业务操作（如 `COVER_RECONCILE`、`COVER_BATCH`、`AI_ENRICH`、`POST_PROCESS`、`AVATAR_COPY`）。维护流式发现游标 (`discovery_cursor` / `discovery_complete`)、外部控制信号 (`PAUSE` / `CANCEL`)、全局并发度上限 (`max_in_flight`) 以及四项进度计数 (`total_units`, `succeeded_units`, `failed_units`, `cancelled_units`)。
- **`AsyncTaskUnit` (执行单元表)**：代表最小原子执行单位（如具体单张图片的 `COVER_DERIVATIVE` 缩略图生成或单条媒体的 AI 打标）。记录实体映射 (`subject_type` / `subject_id`)、全局唯一业务键 (`unit_key`)、执行状态 (`PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED`) 以及抢占租约锁 (`lease_token` / `lease_expires_at`)。

### 6.2 任务生命周期与安全机制

1. **流式分批发现 (Chunked Discovery)**：主任务启动后通过游标增量扫描候选数据，避免单次大表查询造成 DB 性能抖动。
2. **原子抢占与租约锁 (Lease Locking)**：`JobRunner` 利用 PostgreSQL `FOR UPDATE SKIP LOCKED` 语法 (`claimUnits`) 安全抢占就绪的 `PENDING` 单元，并授予 60 秒的租约。
3. **心跳续租与异常中断 (Heartbeat & Cancellation)**：执行阶段由后台定时器每 20 秒发起 `renewUnitLease` 自动续期。若租约丢失或主任务收到取消信号，系统将通过 `AbortController` 协同中断当前 Handler 的物理执行。
4. **指数退避与随机抖动 (Exponential Backoff with Jitter)**：对于可重试失败，系统根据重试次数自动计算下一次可执行时间 (`available_at`)：
   $$\text{延迟时间} = \min\left(300, 5 \times 2^{\text{attempt}-1} \times \text{jitter}\right) \text{ 秒}$$
5. **状态对账与终态收敛 (Reconciliation)**：单元结算时更新原子计数。当所有单元消费完毕且 `discovery_complete = true`，主任务自动收敛至 `COMPLETED` 或 `FAILED` 并触发 `finalizeTask` 回调。
6. **跨节点实时唤醒与兜底机制 (Redis Pub/Sub & Fallback)**：当新任务创建、恢复或流式发现时，系统通过 Redis Pub/Sub 广播频道 (`jobs:wake_channel`) 实时发布唤醒信号（`notifyJobsAvailable`），驱动多节点集群下的 `JobRunner` 立即抢占执行。为保证高可用与强容错，`JobRunner` 保留了 5 秒 `setInterval` 定时轮询与 `JobSweeper` 后台巡检作为兜底机制，即使 Redis 发生闪断或 Pub/Sub 丢包，任务依然能确保在 5 秒内被正确拉起执行。

### 6.3 容错与自动修复 (`JobSweeper`)

后台定时巡检器 `JobSweeper` 每 30 秒自动执行自我修复：
- **`reclaimExpiredLeases`**：回收已崩溃 Worker 留下的死锁租约，重置为 `PENDING` 或标记超限失败。
- **`recoverInterruptedDiscovery`**：自动拉起服务重启前未完成的流式数据扫描。
- **`reconcileReadyTasks`**：审计并修复状态未对齐的主任务。
- **`purgeOldTasks`**：清理 7 天前已处于终态的历史任务与单元数据，防止数据库膨胀。

### 6.4 封面生成与调和行为规范 (Cover Generation & Reconciliation Specification)

媒体封面的生成、更新与调和逻辑由 `CoverJobHandler` 与 `CoverService` 共同维护，遵循以下行为规范：

1. **手动重新生成与同规格覆盖**：
   - 当对已有封面的媒体手动触发生成某规格（如 `LOW` + `MEDIUM`）时，系统会重新提取渲染源媒体帧，将渲染出的 AVIF 文件上传至 S3 **覆盖原有 S3 路径**。
   - 数据库中的 `File` 记录（大小、尺寸、更新时间）与 `Track` 记录（`file_id`、`update_time`、`sync_status = COMPLETED`）会被同步更新。
2. **多规格独立并存**：
   - 若媒体已存在 `LOW` + `MEDIUM` + `HIGH` 三种规格，而任务仅派发了 `LOW` + `MEDIUM`，系统仅渲染并更新 `LOW` 与 `MEDIUM` 规格。
   - 已存在的 `HIGH` 规格 `Track` 记录与 S3 文件完全保留（保持 `ACTIVE` 状态），不会受到影响。
3. **`COVER_RECONCILE` 调和规则**：
   - **增量调和 (Incremental Reconcile)**：调和任务仅负责补齐当前媒体库配置（`library.cover_qualities`）所要求的规格。
   - **配置缩减不裁切**：若媒体库配置由 `[LOW, MEDIUM, HIGH]` 缩减为 `[LOW, MEDIUM]`，`COVER_RECONCILE` **绝不清理或删除**已有的 `HIGH` 封面。
   - **配置恢复免重复计算**：若后续重新将配置改回 `[LOW, MEDIUM, HIGH]`，再次运行 `COVER_RECONCILE` 时，系统会识别到 `HIGH` 封面已存在且关联源文件未变，自动标记 `isAlreadyCompleted = true` 跳过渲染。


