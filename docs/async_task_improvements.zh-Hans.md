# 异步任务改进清单

状态：方案已确定，尚未实施。第 1–10 节记录 AI 模块评审中发现的、与异步任务（`async_task` 任务引擎及其周边后台循环）相关的不足，第 11 节是确定的重构方案。

适用范围：`apps/server/src/infra/jobs/*`、`features/ai/embedding-queue.ts`、`embedding-worker.ts`、`embedding-spaces.ts`、`queue-enrichment.ts`、`jobs/enrich-handler.ts`，以及 `image-source.ts` 中依赖封面任务的部分。

## 1. 现状：两套后台任务系统

| | 任务引擎（`async_task` / `async_task_unit`） | Embedding 队列（`asset_embedding` 行） |
|---|---|---|
| 工作单元 | 任务下的 unit | `embedding_status = PENDING` 的向量行 |
| 认领 | 任务引擎的锁和租约 | `available_at` 前推 300 秒当租约，`skip locked` |
| 重试 | `infra/jobs/policy.ts`、`TaskRetryReason` | `MAX_EMBEDDING_ATTEMPTS = 5` + `retryDelaySeconds` |
| 唤醒 | `jobRunner.wake()` | Redis 发布订阅 `ai:embedding:wake` + 10 秒轮询 |
| 进程生命周期 | `jobRunner.start/drain` | `embeddingWorker.start/drain`（另起两个循环） |
| 可见性 | 任务页面 | 只有 `/api/ai/status/:library_id` |
| 附带的周期工作 | `JobSweeper` | 第 0 个循环顺带跑空间切换（`maintain()`） |

单独做这套队列，理由是把同一库、同一向量空间的多个媒体合成一次 provider 请求（文本最多 64 条，Gemini 图片 6 张）。代价如下：

- 有两套重试语义、两套租约、两套关停流程。
- 任务页面看不到 embedding 进度，失败的向量只能在 AI 设置页点"重试失败项"。
- 链路是 enrich unit 把向量行写入队列，再由 embedding worker 处理，一个媒体要走两跳。任务显示"成功"时，向量其实可能还在排队或已经失败。
- 两跳各自下载源图：enrich unit 为描述下载一次，embedding worker 为图片向量再下载一次同一个文件。

**改造方向**：任务引擎需要支持"同类 unit 攒批执行"（同一个批次键下最多 N 个 unit 一次处理），这样 embedding 就能并回任务引擎。或者反过来证明批量收益不值得，直接在 enrich unit 里同步做 embedding。成本大头是逐张调用的图片描述，批量 embedding 只省了很小一部分。

## 2. Batch API（已删除，待在任务引擎上重建）

2026-10-14 删除了旧实现：只覆盖"换文本向量模型时的回填"，有一套独立于任务引擎的作业状态机。以后一定要支持 Batch API，但要建在改造后的任务引擎上，不再单独实现。

### 2.1 删除了什么

- 代码：`features/ai/batch/`（`BatchEmbeddingBackend` 接口、`OpenAiBatchBackend`）、`embedding-batches.ts`、`EmbeddingWorker.maintain()` 里的 Batch 维护、`TextEmbeddingProvider.batchBackend`、`AiService.submitBatch/pollBatch`。
- 数据库：`ai_batch_job` 表和 `ai_batch_job_status` 枚举、`asset_embedding.batch_job_id`、`library_embedding_space.use_batch_api`、`ai_provider.batch_api_enabled`。
- 接口和界面：绑定接口的 `use_batch_api`、供应商的 `batch_api_enabled`、模板的 `supportsBatchApi/batchApiByDefault`，以及前端的两个勾选框和"Batch"标记。
- 旧代码从未提交到 git。如需参考，删除前暂存区里还有一份。

### 2.2 为什么删

- **收益小**：只用于文本 embedding 回填，而这本来就是最便宜的环节（五折省下的只是几分钱）。真正贵的图片描述没有走 batch。
- **自建状态机**：SUBMITTING → SUBMITTED → COMPLETED/FAILED，外加提交超时回滚、300 秒轮询、600 秒攒批。实时队列还要用 SQL 排除 batch 模式的行。
- **体验**：BUILDING 空间要等 batch 作业完成才切成 ACTIVE，可能要等一天，而且任务页面看不到进度。

### 2.3 将来在任务引擎上需要哪些能力

1. **等待外部结果**：unit 提交后进入"等待外部结果"状态，记录外部作业 id 和下次检查时间。引擎按时轮询，等待期间不占执行并发。这是通用能力，Batch API 只是其中一种用法。
2. **攒批**：多个 unit 合成一个外部作业，按批次键、最大条数、最长等待时间。这和第 1 节"同类 unit 攒批执行"是同一个能力。
3. **提交不重复**：旧实现先在事务里预留行，再调用 provider。如果在拿到外部 id 之前崩溃，超时后会回滚并重新提交。但 provider 那边可能已经建了作业，结果就是重复计费。新实现应在提交时带上可追溯的标识（比如 OpenAI Batch 的 `metadata`），恢复时先查有没有孤儿作业。
4. **部分结果**：作业过期或取消时，provider 只返回一部分。已返回的 unit 正常完成，缺失的 unit 计一次失败后重新排队。旧接口 `poll()` 返回 `{ state: "finished", items, error? }`，这个约定可以沿用。
5. **取消**：空间被删、模型更换或任务被取消时，应同时取消 provider 端的作业。旧实现没有做这一步，只是丢掉结果，钱照样花了。
6. **降级**：provider 关掉 batch 能力或凭证失效时，未提交的 unit 转回实时执行。
7. **限流**：提交和轮询本身也算 provider 请求，归入第 6 节的按资源限流。
8. **可见性**：任务页面显示"已提交外部批处理，等待结果"，以及作业 id、条数、提交时间。

### 2.4 适用场景和协议

- **场景优先级**：图片描述（单次最贵）优先，文本和图片 embedding 回填其次。实时路径永远保留，batch 只用于用户明确选择、能接受延迟的整库回填。
- **协议**：
  - OpenAI Files + Batches 格式：OpenAI 和百炼兼容模式都支持，覆盖 `/v1/embeddings` 和 `/v1/chat/completions`。
  - Gemini 的 Batch Mode 是另一种格式。
  - 协议差异放在 provider 适配器一层，比如 `submit(inputs) / poll(id) / cancel(id)`。任务引擎只认"外部作业"。
- **开关放哪里**：放在"发起回填"这个动作上，不放在供应商连接上。旧实现是连接开关加绑定勾选框两层，用户很难理解。

## 3. 向量空间切换和任务状态耦合

`promoteBuiltSpaces()` 每 30 秒执行一次（挂在 embedding worker 的维护循环上）。它通过 `library_embedding_space.backfill_task_id` 左连接 `async_task` 判断回填任务是否结束，再检查队列里还有没有 PENDING 行，两者都满足才把 BUILDING 切成 ACTIVE。

- 空间状态依赖两套系统的状态，只能靠轮询把它们拼起来。
- 回填任务结束（unit 全部完成）不代表向量写完，因为向量还在另一个队列里。
- "结束"包括 FAILED 和 CANCELLED，而且不看成功了多少。新空间可能全是失败行就被切成 ACTIVE，同时旧空间被删除。这是空间切换逻辑本身的缺陷，见 [ai_review.zh-Hans.md](ai_review.zh-Hans.md) 第 1.1 节。改造任务系统时，"空间建完"的判定要带上覆盖率。

**改造方向**：如果第 1 节合并了，切换就能放进任务的 `finalizeTask`，不再需要轮询。否则至少要有统一的"某个库的某个空间是否已建完"事件。

## 4. 任务之间的依赖靠轮询实现

`resolveAiImageSource()` 会查有没有正在运行、且 `input_snapshot->'media_ids'` 包含该媒体的 `COVER_BATCH` 任务。有的话就抛 `CoverNotReadyError`，enrich unit 以 `DEPENDENCY_PENDING` 重试，等封面生成完再做。

- 每次都要用 jsonb `@>` 扫描任务表。
- 依赖关系藏在业务代码里，任务页面看不出 AI 任务在等封面。

**改造方向**：任务引擎原生支持依赖（unit 声明依赖哪个任务或 unit，被依赖的完成后才变为可执行），或者支持"完成后自动触发后续任务"。

## 5. 缺少自动触发和合并去重，导致新内容不会自动建索引

现在只有两种情况会触发 AI 处理：用户手动点"AI 处理"（`/api/task/queue-ai`），或者修改绑定、语言触发全库回填。新上传或导入的媒体、改标题、改标签、移动库、改标签别名，都不会更新搜索文档和向量。

搜索文档本身已经不再依赖 AI 配置：`enrichMediaItem` 对未配置 AI 的库、以及描述失败的媒体，也会照常写入（2026-10-14 已修复）。剩下的问题只在触发：没人触发，就没有搜索文档，关键词搜索也就搜不到。

要补自动触发，入口很分散：

- 内容就绪：`ingest/downloader.ts` 下载完成、`post/create-post.ts` 手动发帖、`media/track.ts` 替换文件或新增内容轨、`media/add-tracks-from-draft.ts`。
- 文本变化：`api/media.ts` 和 `api/post.ts` 的 `update-info`、`tags/replace`、`bind_media`、`media/:id/remove`。
- 批量变化：`library/move-items.ts`，以及 `features/tag/tag-service.ts` 的改名、合并、删除。

任务引擎缺下面这些能力，导致直接接入代价大：

- **按对象合并**：同一个媒体短时间被改多次，应该只留一个待执行 unit（比如用 `ai:${mediaId}` 作为全局去重键，而不只是任务内唯一）。否则每次编辑都会生成一个任务，任务页面会被刷屏。
- **延迟和防抖**：编辑时稍等几秒再执行，把连续修改合成一次。
- **区分"轻量刷新"和"重活"**：改标题只需要重建搜索文档和文本向量，不需要调用视觉模型。现在两者都走 `enrichMediaItem`。虽然能复用已有描述，但仍然要建任务、走一遍整个流程。

**改造方向**：先在任务引擎里加上按对象去重和延迟执行，再在上面列出的入口统一调用一个 `scheduleMediaIndexing(mediaIds)`。

**同一媒体并发处理会产生互相覆盖的描述（2026-10-16）**：多个任务（或任务和手动处理）同时处理同一个媒体时，`enrichMediaItem` 都读到"还没有描述"，各自调用视觉模型。模型输出不确定，两次描述不同，文本 hash 随之不同，先写入的文本向量被后写入的取代，留下 STALE 行，描述费用也翻倍。

- 已修复保存绑定时的触发源：同时绑定文本和图像模型、或同时改语言，现在只建一个全库任务（`startBackfill` 接收多个空间）。
- 没有修复：库级处理接口（`/status/:library_id/process`、`/redescribe`）先查"是否已有任务"再建任务，中间没有加锁，连点两次就会建出两个重叠的库级任务（2026-10-20 发现）。
- 没有修复：任务之间仍然没有按媒体的互斥。用户在回填期间手动点"AI 处理"，或两个库级任务因其他原因重叠，同样会触发。这需要和上面的"按对象合并"一起解决，例如全局去重键 `ai:${mediaId}`，或描述前对媒体加锁并重读元数据。

## 6. 限流和调度互相不知道对方

- 后台 AI 调用用的是 `maxWaitMs = 0`：provider 限流时立刻抛 `AiThrottledError`，unit 以 `THROTTLED` 重新排期。provider 被打满时，unit 会在"认领、被限流、重新排期"之间空转。
- 任务引擎按全局并发认领 unit，不知道每个 provider 的并发上限和每分钟请求数（`ai_provider.max_concurrency` / `requests_per_minute`）。

- **没有熔断**：key 失效或欠费时，每个 unit、每个向量行都会各自调用一次 provider，再各自以不可重试的错误失败。任务页面被失败刷满，修好 key 之后还要手动"重试失败项"。
- **没有公平性**：embedding 队列按 `available_at` 全局先进先出，任务引擎也按全局并发认领。一个库的整库回填会饿死其他库的新内容，多用户部署时尤其明显。

**改造方向**：

- 任务引擎支持按资源键限流（比如 `provider:<id>`）。资源没有余量时就不认领该资源的 unit，而不是认领之后再失败。
- 同一个资源键支持熔断：遇到 AUTHENTICATION 等配置类错误时，暂停该资源下所有 unit（保持待执行，不计失败次数）并通知用户；凭证更新后自动恢复。
- 认领时按库（或按 owner）轮转，整库回填这类大批量任务降低优先级，不阻塞新内容。

## 7. AI 处理状态存了两份

- `asset_ai_metadata.processing_status` 和 unit 状态各管一份。`queueAiEnrichment` 预先写入 PENDING 行，之后由 `AiEnrichHandler.finalizeTask` 把失败的改成 FAILED。
- `finalizeTask` 只处理 `input_snapshot.media_ids`。库级回填任务（`scope: "library"`）的失败不会回写到元数据状态。
  - 2026-10-15 补丁：描述失败时会把错误写进元数据行。库级任务结束且有失败 unit 时，`finalizeTask` 把本库中仍为 PENDING 且记录了错误的行标记为 FAILED。
  - 这是从元数据反推 unit 结果。如果同一库里还有按媒体发起的任务在跑，可能误标。等状态统一到 unit 后应删除。

**改造方向**：AI 处理状态统一以任务 unit 为准，`asset_ai_metadata` 只存结果。

## 8. 每个工作单元都重新解析配置

每个 enrich unit、每次 embedding 批处理、每次 Batch 维护，都会调用 `AiService.forLibrary()`：要查库、查空间、逐个解析模型，最多 8 次查询，还要解密 API Key。库级回填时这个开销会乘以媒体数量。

**改造方向**：任务执行上下文提供按任务或按库的短期缓存，或者在任务开始时解析一次，所有 unit 共用。

## 9. 绕过任务系统的旧路径（已修复）

`scripts/backfill_ai.ts` 直接循环调用 `AiEnrichmentService.enrichPost()`，不建任务、不走限流后的重试、任务页面也看不到。`enrichPost` 只被这个脚本使用。

**改造方向**：删掉脚本和 `enrichPost`，需要整库回填时用 `queueLibraryAiEnrichment`。

**已修复（2026-10-16）**：脚本和 `enrichPost` 已删除。

## 10. 失败任务被后续成功解决后仍显示失败（2026-10-20）

场景：导入媒体后自动生成封面，unit 重试 5 次都失败，任务变为 FAILED。用户随后手动新建一个重新生成封面的任务并成功。旧任务仍然显示失败，仍然可以重试，但它的 unit 和新任务的完全相同。封面的 unit key 是 `媒体:质量:源文件`，相同的工作在不同任务里 key 相同。

- 保留失败任务本身是对的：它是历史，记录了第一次为什么失败。不应删除或改写成成功。
- 建新任务时也不应拦截：手动重新生成本来就是在修复这次失败。全局去重只针对活跃的 unit，不挡住它。
- 缺的是"这个失败已被解决"的表达：旧失败一直算作待处理，重试它会重复渲染已有的封面。

**改造方向**：

- 某个 unit 成功时，把其他任务中去重键相同、状态为 FAILED 的 unit 的 outcome 标为 `SUPERSEDED`，`result_ref` 指向解决它的 unit。状态仍为 FAILED，历史不变。
- 任务页面区分"失败"和"失败但已解决"。全部失败都已解决的任务不再出现在需要处理的列表，也不再提供重试。
- `retryFailedUnits` / `retrySingleFailedUnit` 跳过 SUPERSEDED 的 unit。
- 兜底：所有 handler 的 `execute` 都应幂等，开始时先检查目标状态是否已经满足（封面已有同源文件、未过期的 track），满足就以 SKIPPED 结束。源文件已变化的旧 unit 以 `SOURCE_CHANGED` 跳过。

## 11. 重构方案（2026-10-25 确定）

取代 2026-10-20 的草案。第 1–10 节的"改造方向"是早期设想，与本节冲突时以本节为准；11.10 列出各节问题在新方案里怎么解决。

### 11.1 结论

不再以"任务 / unit"为中心。后台工作按性质分两类，各用一种机制：

| 类型 | 例子 | 机制 |
|---|---|---|
| 衍生数据：由源数据和配置决定，应当保持最新 | 下载、头像、封面、AI 描述、搜索文档、文本 / 图像向量 | reconcile 队列（11.3） |
| 操作：用户发起，有开始和结束，要能列出、看进度、取消 | 导出 ZIP、存储迁移、年度回顾、外部 Batch API | operation 层（11.9），第一个操作要做时再建 |

自建，不引入 pg-boss、DBOS、River、BullMQ 或 Temporal：

- 需要的调度语义（按对象合并、运行中再入队、按 provider 限流和熔断、按库暂停、优先级、按空间攒批）都要写进认领条件，现成的库只能覆盖其中一部分。
- 后端以后可能迁到 Go。队列里只有 key，换实现的成本很低；迁 Go 之后 River 仍是选项。
- 队列本身只有四个操作（11.3）。现有引擎的租约、fencing、心跳、AbortSignal、wake、drain 和 `test:jobs` / `test:jobs:db` 都能复用。

设计参照：Kubernetes controller（level-triggered reconcile、client-go workqueue 的 dirty 语义、`Watches`）、Dagster 的资产依赖声明，以及 Dropbox Cape（写入方只发"某对象变了"的 ping，订阅关系和依赖写在配置里，另有 Refresh worker 扫库补漏）。

### 11.2 原则

1. **期望状态靠计算，不另存。** 期望结果由源数据和库配置算出。结果行只记录生成来源（provenance），以及最近一次失败和失败时的输入。输入一变，旧失败自动作废（解决第 10 节）。
2. **队列只存 key。** 一行 `(流水线, 对象)` 的意思是"这个对象可能过期了，去看一眼"。reconcile 读当前状态，只做差异部分，可以重复执行。差异是双向的：既补齐缺的，也删掉不该有的，比如媒体移到别的库后，挂在旧库下的结果行。
3. **写入方只报告"什么变了"。** 调用 `markChanged`，由声明表决定哪些流水线跟着更新；入队和业务写入在同一个事务里。处理函数不直接入队下一步。
4. **进度、失败、取消都从状态推出。** 进度就是覆盖率，失败看结果行，取消就是把期望改回去或暂停整个库。

### 11.3 reconcile 队列

```sql
job_queue(
  pipeline text, subject_id text, library_id uuid,
  priority smallint, available_at timestamptz,
  dirty boolean, cursor text, resource_key text,
  lease_token uuid, lease_expires_at timestamptz, attempts int,
  PRIMARY KEY (pipeline, subject_id)
)
-- 另有领取用索引 (priority, available_at)，以及进度用索引 (library_id, pipeline)
```

四个操作，语义与 client-go workqueue 一致：

- **enqueue**：`INSERT … ON CONFLICT DO UPDATE`。行已存在时，可以把 `available_at` 往后推实现防抖，`priority` 取两者中较高的；这一行正在运行时标 `dirty`。
- **claim**：选出到期、且没有租约或租约已过期的行，`FOR NO KEY UPDATE SKIP LOCKED` 锁住后写上租约。过期租约在这里直接回收，不需要单独的 sweeper。认领时附加的条件见 11.7。
- **finish**：校验 `lease_token` 后删除这一行。被标了 `dirty` 的，释放租约后立刻重跑。
- **defer**：失败或被限流时用。设置新的 `available_at`（指数退避加随机抖动），释放租约。被限流不计入 `attempts`。超过最大重试次数时，把失败写到结果行，然后删除队列行。

其他约定：

- 写结果的事务里，先确认队列行的 `lease_token` 仍是自己的（fencing），租约已经过期的 worker 写不进去。同一 `(流水线, 对象)` 只有一行、一个租约，所以不会出现两个 worker 同时描述同一个媒体（第 5 节的竞态）。
- 这张表插入和删除都很频繁：索引只保留上面三个，单独调低它的 autovacuum 阈值，领取事务保持很短。

### 11.4 流水线和依赖声明

| 流水线 | 对象 | 依赖的方面 | 结果 | 失败记在哪 |
|---|---|---|---|---|
| `download` | media | `media.source` | content track 的文件 | `track` / `media` 的 `sync_status`、`last_error` |
| `avatar` | author | `author.avatar_source` | `author.avatar_file_id` | 需新增：`author` 上的头像来源和失败字段 |
| `cover` | media | `media.content`、`media.library`、`library.cover_config` | cover track（`variant_key`、`metadata.source_file_id`） | cover track 的 `last_error` |
| `ai.describe` | media | `media.cover`、`media.library`、`library.ai_config` | `asset_ai_metadata`（model、prompt_version、language、input_hash） | `last_error`、`error_kind` |
| `ai.index` | media | `media.description`、`media.meta`、`media.library` | `asset_search_document`（content_hash） | 不调 provider，只记日志 |
| `ai.text:<space>` | media | `media.search_doc`、`media.library`、`library.spaces` | `asset_embedding`（content_hash） | `last_error` |
| `ai.image:<space>` | media | `media.cover`、`media.library`、`library.spaces` | `asset_embedding`（source_file_id） | `last_error` |

`media.library` 表示媒体所属的库变了。所有按库配置计算的流水线都依赖它：

- AI 结果行（`asset_ai_metadata`、`asset_search_document`、`asset_embedding`）带自己的 `library_id`。reconcile 发现行的 `library_id` 和媒体当前的库不一致，就删掉，再按当前库的配置重建。
- cover track 不分库：当前库配置里有的质量，只要源文件没变就直接复用；配置里没有的质量照旧不删。

```ts
markChanged(tx, aspect, ids)
```

- 媒体级的方面：直接给依赖它的流水线入队。`ai.text` / `ai.image` 展开为该库写入的每个空间各一条。
- 库级的方面（`library.*`）：入队一行 `scan:<pipeline>`，对象是 library_id。scan 每次领取后，从 `cursor` 往后取一页媒体，只挑需要处理的（复用 `coverage.ts` 的条件），按低优先级批量入队，保存 `cursor` 后 defer 自己，扫完就删除。扫描期间再次触发时 `cursor` 清零（运行中的先标 `dirty`，释放时清零），从头重扫。已入队的行运行时读的是当前配置，不会生成过期的东西。
- 定期巡检：定时给每个库入队一次 scan，补上漏掉的变化。
- 只有产出**真的变了**才调用 `markChanged`；reconcile 发现已是最新，就不往下传。
- 启动时检查声明表没有环。
- 每个 reconcile 开头先检查前置条件，比如封面没好时 `ai.describe` 直接结束、不记失败。封面写好后的 `markChanged("media.cover")` 会再把它入队（取代第 4 节的 `CoverNotReadyError`）。

### 11.5 入口

第 5 节列出的入口，统一改为在自己的事务里调用 `markChanged`：

| 入口 | 方面 |
|---|---|
| 导入新帖、手动发帖 | `media.source`、`author.avatar_source` |
| 下载完成、替换文件、新增内容轨、`add-tracks-from-draft`、回收站恢复 | `media.content` |
| `update-info`、`tags/replace`、`bind_media`、`media/:id/remove`、`tag-service` 的改名 / 合并 / 删除 | `media.meta` |
| `move-items`、将来的复制 | 见下文 |
| 修改封面质量 | `library.cover_config` |
| 修改 AI 绑定、语言 | `library.ai_config`、`library.spaces` |
| 用户手动"重新生成" | 先把旧结果标为过期（封面用现有的 `is_stale`，描述的做法实现时定），再 `markChanged` 对应方面 |

**移动、复制 post 或媒体到别的库**

移动和复制本身不是后台任务，而是一次同步请求：在一个事务里改元数据，后续的衍生工作交给 reconcile。只有量特别大、事务撑不住时，才改成 operation（11.9）。

- **移动**（现有的 `move-items.ts`）：
  - 在一个事务里改 post 和 media 的 `library_id`，在目标库对应或新建 author 和 tag。这部分保持不变。
  - 同一个事务里，对所有被移动的媒体调用 `markChanged(tx, "media.library", mediaIds)`。
  - 新建的 author 在头像来源里记下源 author 的头像文件，再调用 `markChanged(tx, "author.avatar_source", authorIds)`，由 `avatar` 流水线复制。AVATAR_COPY 任务类型删除。
  - 文件不用搬，存储路径和库无关。
- **复制**（将来）：在目标库里新建 post、media、track 行，再对新媒体调用 `markChanged("media.source", ...)`。文件怎么处理取决于删除方式：
  - 按引用删除（删一条记录不会连带删掉别人还在用的文件）：新行直接引用同一批 File，复制也是同步请求加 reconcile。
  - 不是按引用删除：必须真的拷贝文件，复制量大时做成 operation，按 `ctx.step` 分批拷贝。

### 11.6 进度和可见性

进度直接从状态算，不需要任务计数器：

| 显示项 | 算法 |
|---|---|
| 总数 | 库里有效媒体的数量 |
| 剩余 | `job_queue` 中该库、该流水线的行数 |
| 已处理 | 总数 − 剩余（scan 只把需要处理的媒体入队，所以成立） |
| 正在处理 / 重试中 | 剩余行里租约有效的 / `attempts > 0` 的 |

- 该库的 scan 行还在时，显示"正在统计…"，否则剩余数会偏小。
- 队列清空后，算一次完整覆盖率（`getLibraryCoverage`），显示最终结果和失败原因。
- 运行期间有新上传，分母随之变大；同一媒体被改多次也只有一行，不会重复计数。
- 前端沿用 2 秒轮询，只在该库队列有行时轮询；以后需要推送时，再从 `finish` 发 `NOTIFY` 转 SSE。
- `cover-jobs/active`、`getLibraryAiProgress` 改为数队列。
- 任务页 `jobs.vue` 改为按"库 × 流水线"展示排队、处理中、失败及原因。"重试失败"等于清掉失败记录后 `markChanged`，"暂停 / 恢复"就是库级暂停开关。不再保留任务历史，需要追查时看日志。

### 11.7 限流、熔断、优先级、暂停

- **限流**：provider 打满时，Redis 限流器（`rate-limit.ts`）给出可重试时间，行按这个时间 defer，不计失败。
- **熔断**：入队时把 `resource_key`（如 `provider:<id>`）写在行上，仅作调度提示，reconcile 运行时仍重新解析配置。遇到 AUTHENTICATION、额度类错误时，给该资源设长冷却并通知用户。认领时排除冷却中的资源，这些行保持排队、不计失败；凭证更新后清除冷却并唤醒。
- **优先级**：导入和编辑触发的为高，scan 入队的为低，新内容不会被整库回填饿死。多用户部署需要时，再加按库轮转。
- **暂停**：库上加一个暂停字段，认领时排除。用于停掉大规模回填，又不想改回配置的情况。

### 11.8 攒批

`ai.text:<space>`、`ai.image:<space>` 一次认领同一流水线最多 N 行（文本 64，Gemini 图片 6），一次 provider 请求，每行单独结算。先不做"凑不满就等"，有多少取多少。批内只解析一次 `forLibrary()`。

### 11.9 operation 层（第一个操作要做时再建）

- 一张 `operation` 表：owner、库、类型、状态、上下文、进度、取消标志、结果、错误。队列里放一行 `op` / operation_id 驱动它。
- 步骤写成 `await ctx.step(name, fn)`：每步结果存进 operation 行，重试时已完成的步骤直接返回存好的结果，不再执行。不手写 `switch(step)` 状态机。
- 长步骤靠心跳续租。取消标志通过心跳传到 AbortSignal，在步骤之间停下。等待（比如导出文件 24 小时后删除）用 `available_at` 实现。
- 动手前先评估 [Absurd](https://github.com/earendil-works/absurd)：只依赖 Postgres，SQL 核心加很薄的 TS / Go SDK。2026-10 时为 v0.5.1、Go SDK 仍是实验性，届时不成熟就自己写 `ctx.step`。
- Batch API（第 2.3 节）建在这一层：提交、轮询、写回三步。
  - 提交时带可追溯的 `metadata`，恢复时先查孤儿作业。
  - 在途的媒体，各自的 reconcile 跳过。
  - 部分结果和降级不需要特殊处理：没拿到结果的媒体仍然过期，reconcile 会用实时路径补上。
  - 取消操作时同时取消 provider 端的作业。
- 不做：操作内部的扇出再汇合、分支、补偿。真需要时再评估 Temporal。

### 11.10 各节问题的落点

| 节 | 新方案 |
|---|---|
| 1. 两套系统 | 合并为一个队列；embedding 的批量收益由 11.8 保留 |
| 2. Batch API | 11.9 |
| 3. 空间切换 | `ai.*` 批次结束时，若该库该空间的队列已空且没有 scan，就按覆盖率判断是否切换，不再每 30 秒轮询；`backfill_task_id` 删除 |
| 4. 依赖靠轮询 | 前置条件 + `markChanged("media.cover")` |
| 5. 自动触发、去重、竞态 | 11.5 的入口；主键去重、`dirty`、防抖；单行单租约加 fencing；改标题只走 `ai.index`，不调用视觉模型 |
| 6. 限流和调度 | 11.7 |
| 7. 状态存两份 | 状态由结果行和队列推出；删除 `asset_ai_metadata.processing_status`、`asset_embedding` 上的队列字段、`finalizeTask` 的反推补丁 |
| 8. 重复解析配置 | `forLibrary()` 按库和配置版本做进程内短期缓存；批内只解析一次 |
| 10. 已解决的失败仍显示 | 失败只记在结果行上，带当时的输入；成功或输入变化后自然消失 |

### 11.11 删除和复用

- **删除**：`async_task` / `async_task_unit` 表，`store.ts` 的任务 / unit 模型、`sweeper.ts`、`JobManager.createTask` 及所有调用处、各 `TaskHandler`（包括 `avatar-copy-handler.ts`），`embedding-queue.ts`、`embedding-worker.ts`、`ai:embedding:wake`，`CoverNotReadyError` 的扫描，`queue-enrichment.ts`。
- **复用**：`runner.ts` / `executor.ts` 的租约、fencing、心跳、AbortSignal、wake、drain；`rate-limit.ts`；`coverage.ts`；cover-handler 里和现有 Track 比对的逻辑（变成 `cover` 的 reconcile）。

### 11.12 分层实施

每一层做完，产品都能完整跑通：

1. **队列和声明表**：`job_queue`、`markChanged`、scan、巡检；迁移 `download`、`avatar`、`cover`，接入 11.5 的入口；设置页进度和新的"库 × 流水线"视图。COVER_*、POST_PROCESS、AVATAR_COPY 从旧引擎下线，旧引擎只剩 AI_ENRICH。
2. **AI 迁移**：`ai.describe`、`ai.index`、`ai.text`、`ai.image`，含按空间攒批和限流 defer；空间切换按覆盖率。删除旧引擎、两张任务表和 embedding 队列，旧任务页下线。
3. **调度增强**：熔断、优先级、库级暂停；需要时加按库轮转。
4. **operation 层**：第一个操作要做时（11.9）。

### 11.13 评审中发现的现有 bug（2026-10-26）

1. **移动后新建的 author 拿不到头像。** `avatar-copy-handler.ts` 调用 `processAvatar(targetAuthorId, "")`：URL 是空字符串，读出来的源 author id 没有用上。移动时新建的 author 的 `avatar_file_id` 为空，`processAvatar` 因此一定会去下载这个空 URL，在上传前就抛出 `Failed to construct 'Request': url is required.`。结果被标为可重试，白跑满 5 次后失败，头像从未复制成功。2026-10-26 已用真实的处理函数和只读数据库连接运行验证。第 1 层由 `avatar` 流水线取代：头像来源记成源 author 的头像文件，reconcile 负责复制。
2. **移动后 AI 数据还挂在旧库下。** `move-items.ts` 只改 post 和 media 的 `library_id`，`asset_ai_metadata`、`asset_search_document`、`asset_embedding` 上的 `library_id` 没有更新。搜索按 `asset_search_document.library_id` 过滤（`search.ts`），所以移走的媒体在目标库搜不到，在原库反而还能搜到；原库的覆盖率统计也会把它们算进去。第 2 层由 `media.library` 加"删掉不该有的结果"解决（11.4）。在那之前，如果要先止血，可以在移动的事务里删掉这些行，再对移动的媒体触发一次 AI 处理。
