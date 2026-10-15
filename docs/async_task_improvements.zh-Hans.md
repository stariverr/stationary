# 异步任务改进清单

状态：待改造。记录 AI 模块评审中发现的、与异步任务（`async_task` 任务引擎及其周边后台循环）相关的不足，供之后改造任务系统时参考。这里的问题都还没有修。

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

## 9. 绕过任务系统的旧路径

`scripts/backfill_ai.ts` 直接循环调用 `AiEnrichmentService.enrichPost()`，不建任务、不走限流后的重试、任务页面也看不到。`enrichPost` 只被这个脚本使用。

**改造方向**：删掉脚本和 `enrichPost`，需要整库回填时用 `queueLibraryAiEnrichment`。

## 10. 优先级建议

1. 第 5 节的按对象去重和延迟执行：这是"新内容自动建索引"的前提，对用户价值最大。
2. 第 1、3 节一起决定 embedding 是否并回任务引擎；同时为第 2.3 节的"等待外部结果"留好位置，Batch API 重建排在其后。
3. 第 6 节的按资源限流、熔断和按库公平调度。
4. 第 4、7、8、9 节随改造顺手处理。
