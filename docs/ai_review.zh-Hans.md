# AI 功能评审

状态：改造中。记录 2026-10-15 对 AI 模块的评审结论。已修复的条目在标题后标注"已修复"并说明做法，其余尚未处理。

适用范围：`apps/server/src/features/ai/*`、`apps/server/src/api/ai.ts`、`apps/server/src/api/search.ts`，以及 `apps/web/app/components/settings/` 下的 AI 设置页（前端只粗看过）。

与异步任务系统相关的问题（两套任务系统、自动触发、按资源限流、队列公平性、熔断等）记在 [async_task_improvements.zh-Hans.md](async_task_improvements.zh-Hans.md)，这里只引用编号。

## 1. 高可用与可靠性

### 1.1 向量空间切换可能删掉可用的旧空间（已修复）

`promoteBuiltSpaces()`（`embedding-spaces.ts`）只看两件事：回填任务是否结束，队列里是否还有 PENDING 行。它不看成功了多少。

- 新模型的 key 填错时，所有行都会变成 FAILED。队列一空，新空间就被提升为 ACTIVE。
- 提升时会 `dropSpace` 旧的 ACTIVE 空间，旧向量被物理删除，语义搜索丢失且无法回滚。
- 回填任务被取消或失败，同样算"结束"，同样会触发提升。

**改造方向**：按覆盖率阈值（READY 数 / 应覆盖的媒体数）决定是否切换。失败比例高时留在 BUILDING，并在设置页提示原因。旧空间切换后保留一段时间，支持回滚。

**已修复（2026-10-15）**：

- `assessBuildingSpace()` 决定能否切换：失败不超过已完成的 5%，且 READY 数不少于当前 ACTIVE 空间的 95%。用 ACTIVE 空间的向量数做基准，不必推算"应覆盖多少媒体"。
- 不满足时停在 BUILDING，`/api/ai/status` 返回 `blocked`，设置页显示原因。"重试失败项"同时会为覆盖不足的空间重新发起回填。
- 被替换的空间改为 `RETIRED`，保留 7 天。期间重新选择旧模型即可恢复，不重新计算全部向量；过期后由 embedding worker 删除。
- 详见 [ai_hybrid_search.zh-Hans.md](ai_hybrid_search.zh-Hans.md) 第 4.1 节。

### 1.2 降级是静默的（已修复）

- `resolver.ts` 解析不了模型（模型无效、key 解不开）时只 `console.error`，返回 null，这个角色就消失了。
- `search.ts` 的 `textSemanticSearch` / `visualSemanticSearch` 出错时返回 `[]`，`rerankTopCandidates` 出错时保持融合顺序。

用户只会觉得"搜索变差了"，看不到原因。

**改造方向**：搜索响应带上 `degraded` 字段，列出失效的通道和原因。设置页显示每个绑定的健康状态和最近一次错误。

**已修复（2026-10-15）**：`resolveAiConfig()` 把无法解析的绑定记入 `issues`，不再只打日志。搜索响应新增 `degraded: { channel, reason }[]`，语义通道或重排序失败、绑定失效时都会列出；媒体页在结果上方提示"结果可能不完整"。

设置页部分也已修复（2026-10-15）：

- `/api/ai/status` 改由 `features/ai/status.ts` 汇总，新增 `issues`（无法使用的绑定及原因）和 `describe`（当前描述流水线的完成、排队、失败数）。每个空间以及描述都带 `lastError`，即仍在排队或已失败的条目中最近一次的错误。
- 描述失败时，供应商的错误写入 `asset_ai_metadata.last_error`：可重试的保持 PENDING，不可重试的直接标记 FAILED。`finalizeTask` 不再用笼统的 "AI enrichment task failed" 覆盖原错误。库级任务原本不回写失败状态，现在会把记录过错误的行标记为 FAILED（见 async 文档第 7 节）。
- 设置页在每个角色下显示绑定问题、描述进度和最近错误。"重试失败项"在有描述失败时会重新发起一次库级处理；已有结果会复用，只有缺失的部分会发给供应商。
- rerank 只在搜索时调用，它的失败通过搜索响应的 `degraded` 展示，不单独记录。

### 1.3 错误分类有误判（已修复）

- provider 返回的条数或维度不对时，抛的是 `AiConfigurationError`（`providers/dashscope.ts`、`providers/gemini.ts`、`utils.ts` 的 `toEmbeddingResult`）。它会被归为 CONFIGURATION、不重试。但这类情况多半是网关的偶发问题，应归为 provider 错误。
- `classifyAiError` 靠消息文本里是否出现 `"abort"`、`"cancel"`、`"network"` 等词来判断。provider 的报错文本只要带 "cancel"，就会被当成用户取消。取消应以 `signal.aborted` 或 `error.name === "AbortError"` 为准，文本匹配只作最后的兜底。

**已修复（2026-10-15）**：

- 取消只看错误类型：沿 `cause` 和 AI SDK `RetryError` 的 `lastError` 查找 `AbortError`（归为 CANCELLED）或 `TimeoutError`（归为 TIMEOUT，可重试），不再匹配消息文本。
- 返回条数不对、向量不合法时，改为抛出可重试的 `AiProviderError("TRANSIENT")`。
- 维度不对仍算配置错误：模型忽略或不支持声明的维度时，每次调用都会出错，重试没有意义。
- 仅以系统错误码表示的连接失败（`ECONNREFUSED` 等）归为 TRANSIENT。
### 1.4 下载源图没有超时和大小上限（已修复）

- `enrich.ts`（描述）和 `embedding-queue.ts` 的 `downloadImages`（图片向量）都用全局 `fetch` 拉预签名 URL。除了任务的 `abortSignal` 没有超时，并且会把整张原图读进内存再转码。
- 描述和图片向量会把同一个文件各下载一次（见 async 文档第 1 节"两跳"）。

**改造方向**：改用 S3 客户端读取，加超时和 Content-Length 上限，优先用封面或缩略图作为来源。

**已修复（2026-10-15）**：
- 读取源图的原则：
  - 需要服务器转手的（模型只收图片字节），用 S3 SDK 读取，走配置的 S3 endpoint，可以是内网。
  - 模型能直接拉图片链接的，才传公网 URL，服务器不经手。现在所有 provider 都只收字节，而且服务器要先转码（例如 HEIC 转 JPEG），所以还没有这条路径。等接入能收 URL 的模型时再加。
- `readAiSourceImage()`（`image-source.ts`）在 `s3.read()` 之上加了 60 秒超时和 50 MB 上限，描述和图片向量都用它。
  - 超时记为 TIMEOUT，会重试。SDK 把所有中断都报成 AbortError，所以由这里区分超时和取消。
  - 超出上限记为 INVALID_REQUEST，不重试。`s3.read()` 先看 Content-Length，超限就不下载正文。
- 来源本来就优先选封面（`selectAiImageSource`），没有改。
- 同一个文件仍会被描述和图片向量各读一次，这属于 async 文档第 1 节的"两跳"问题。

### 1.5 配置写入不是原子的，同一份信息存了两处

- `POST /api/ai/bindings/:library_id` 先更新 `library.ai_bindings`，再逐个角色调用 `syncEmbeddingSpace`。中途失败的话，两边就不一致了。
- 删除 provider 或 model 时，`clearBindingsForModels` 和后续的删除分成好几条语句，没有包在一个事务里。
- `ai_bindings.textEmbedding/imageEmbedding` 和 `library_embedding_space` 记的是同一件事。resolver 只读 spaces，bindings 实际只用来给前端回显。

**改造方向**：embedding 角色只以 `library_embedding_space` 为准，`ai_bindings` 只保留 describe 和 rerank。整个绑定更新放进一个事务。

### 1.6 搜索分页每页都重跑整条管线

- 每翻一页，都会重新跑三个通道（各取前 100 条），再 rerank 前 50 条。query 向量和 rerank 的缓存在进程内，多副本部署时命中率低。
- 候选集最多约 300 条，`total` 是截断后的数量，不是真实总数。
- 新向量写入期间翻页，结果会漂移，出现重复或漏项。

**改造方向**：第一页时把融合并 rerank 后的有序 id 列表缓存到 Redis（按库、查询、过滤条件生成键，设短 TTL），后续页只取切片。`total` 改为明确的"至多 N 条"语义。

### 1.7 RPM 限流是固定窗口

`rate-limit.ts` 用 INCR 加 60 秒过期实现每分钟请求数，在窗口边界附近可能瞬间打出 2 倍 RPM。改成滑动窗口或令牌桶。

## 2. 反直觉与设计不合理

### 2.1 关键词搜索依赖"AI 处理"

搜索文档是关键词搜索的唯一来源，却在 `enrichMediaItem` 里生成，代码归在 AI 模块。没配 AI 的用户也得点"AI 处理"才能搜到。触发问题见 async 文档第 5 节。这里要补充的是归属：建索引不是 AI 功能，搜索文档的构建应拆到独立的 search/indexing 模块，AI 只是它的一个输入。

### 2.2 换描述模型和换语言的行为不一致

- 换语言会对全库重新描述；换描述模型不会，只有新内容用新模型。
- 新旧描述混在一起（`selectStoredMetadata` 会回退到旧 pipeline 的结果），用户分不清哪条是哪个模型写的。
- 没有"全部重新描述"的入口。

**改造方向**：换描述模型时，和换语言一样弹确认框，让用户选"只用于新内容"还是"重新描述全部"。

### 2.3 描述模型必须支持 json_schema（决定不改）

`supportsAiBindingRole("describe")` 要求 `structuredOutput`。DeepSeek 和很多国产兼容端点只支持 `json_object`，因此根本不能绑定。
**结论（2026-10-15）：不做运行时降级，改成绑定时强制验证（已实现）。**
- 退回 JSON mode 要维护第二套解析和校验路径，不同模型的输出质量也不一致，出问题时很难排查。
- 能力开关只是目录或用户的声明，不能保证端点真的支持。例如目录把 DeepSeek 标为支持结构化输出，而它的聊天接口文档只列了 `json_object`，没有 `json_schema`（未实测）。
- 所以 `POST /api/ai/bindings/:library_id` 对新绑定的模型（与当前绑定不同的）跑一遍 `probeModel`，任何检查失败都返回 400 和原因，不会存下一个运行时才失败的绑定。没有改动的角色不重复探测。
- 设置页保存失败时显示服务端的原因。
- 代价是保存绑定时多几次小请求，而且只支持 `json_object` 的端点不能做描述模型，这是有意取舍。

### 2.4 关键词搜索是整串子串匹配

`keywordSearch` 对整个查询做 ILIKE。"red car" 搜不到 "car, red"：不分词，不支持多词 AND，也没有短语或排除语法。

**改造方向**：按空白切词，每个词各自匹配后取 AND，排序仍用 `word_similarity`。CJK 继续依赖 trigram。

### 2.5 调参细节直接交给用户

- 模型表单让用户填余弦距离阈值（0–2）、MRL、taskPrefix、imageFormats、maxInputTokens 和 `options` JSON。
- 接入流程要走四层：建 provider → 加 model 并填能力 → 回到库里绑定 → 才能用。

**改造方向**：提供"选供应商、填 key、套用推荐组合"的一步式接入。高级字段默认折叠，只在自定义模型时出现。

### 2.6 Rerank 的接入方式不直观

rerank 只挂在 openai-compatible 适配器上，走 Cohere 风格的 `/rerank`，但 OpenAI 官方根本没有 rerank 接口。Cohere、Jina、Voyage 都没有对应模板，用户要选"Other OpenAI-compatible"自己拼 base URL 才能用。应补上这几家的模板。

### 2.7 AI 标签和正式标签体系完全分开

`ai_tags` 只写进搜索文档，不能一键采纳为正式标签。前端也没找到人工修正或锁定 AI 描述的入口（待确认）。

### 2.8 Catalog 会把便宜的老模型藏起来

`MIN_RELEASE_DATE = "2025-06-01"`，加上同系列只保留最新版本（`lifecycle.ts`），便宜的老视觉模型不会出现在推荐列表里。而图片描述恰恰最适合用便宜模型。

## 3. 过度设计

### 3.1 模型 catalog 机制偏重

现在的组成：models.dev 生成脚本、靠启发式解析版本号的 `lifecycle.ts`、vendor 前缀表、每周一次开 PR 的 CI，以及约 3000 行、打进服务端包的 `catalog.json`。实际真正用到的只有三项：是否支持图片输入、是否支持结构化输出、embedding 维度。自托管用户只有升级时才能拿到新 catalog。

**改造方向**：只保留 curated 的 embedding 和 rerank 列表。生成模型直接用 provider 的 `/models` 列表加 probe 结果判断，去掉 `lifecycle.ts` 和定期生成流程。

### 3.2 能力 schema 太细

`reasoningLevels`、`contextWindow`，以及 audio/video/pdf 这几种输入模态，对目前唯一的生成任务（描述图片）几乎没有作用。

### 3.3 未使用的代码和残留

按 AGENTS.md 应直接删除：

- 枚举值：`EmbeddingRole.CONTENT_TEXT/VIDEO_KEYFRAME/OCR_TEXT`、`ModalityType.VIDEO_FRAME/AUDIO`、`EmbeddingStatus.DISABLED`、`ProcessingStatus.IN_PROGRESS`
- 字段：`asset_ai_metadata.summary`（与 `caption` 重复）
- `providers/http.ts` 的 `postForm`、`getText`（Batch API 删除后的残留）
- `AiEnrichmentService.enrichPost` 和 `scripts/backfill_ai.ts`（绕过任务系统的旧路径，见 async 文档第 9 节）

## 4. 不符合最佳实践

### 4.1 SSRF（已修复）

`base_url` 可以填任意 URL，服务端会代为请求，连接测试和 probe 还会把响应体前 500 字回显给用户。多用户部署时，可以借此探测内网，比如 Redis、云厂商 metadata 地址（169.254.169.254）、集群内的 Service。

**改造方向**：服务端请求前解析地址并按运维配置的 CIDR 黑名单检查。不回显非 JSON 的响应体。

**已修复（2026-10-15）**：

- `providers/egress.ts` 的 `guardedFetch` 接管所有供应商请求（ky 和 AI SDK 的 `fetch` 选项）。配置了 `AI_BLOCKED_CIDRS`（逗号分隔，IPv4 和 IPv6 均可）时，先解析主机并检查地址，再拒绝重定向；保存供应商时也做同样检查。
- 默认留空，不限制任何目标，自托管模型服务、局域网网关和 Clash、Surge 的 fake-ip 都能直接使用。内置的私网判断已移除，因为各种代理的假地址段无法穷举，内置名单会误伤正常使用。公开的多租户部署应设置，例如 `169.254.0.0/16,fe80::/10` 屏蔽云厂商 metadata。
- 供应商错误只回显 JSON 响应体。
- 剩余风险：仅对配置了 `AI_BLOCKED_CIDRS` 的部署有意义。检查和建立连接之间 DNS 结果若被篡改（DNS rebinding），仍可能绕过。要彻底解决，需要在连接层固定解析结果，或者经由出站代理。

### 4.2 描述输出长度不受控（部分修复）

- `maxOutputTokens` 直接取 catalog 里模型的输出上限，可能是几十万。
- schema 对 tags 数量、caption 和 OCR 长度都没有限制。
- prompt 没有带上帖子的标题和描述作为上下文。

**改造方向**：describe 固定一个合理的 `maxOutputTokens`（例如 2k）；schema 加 `maxItems` 和长度限制；prompt 带上已有的标题和描述。

**已修复（2026-10-15）**：

- `maxOutputTokens` 取模型上限和 `DESCRIBE_MAX_OUTPUT_TOKENS`（4096）中较小的一个，给轻量推理留出余量。
- 生成后再截断：caption、scene、OCR 有长度上限；tags、objects、colors、styles 去重并限制条数。限制没有写进 JSON schema，因为严格结构化输出模式不接受字符串长度关键字。超长的输出会被截断，描述本身不会失败。
- prompt 和 schema 没有改，因此 `IMAGE_METADATA_PIPELINE_VERSION` 不变，已有描述不会被重新生成。

**仍待处理**：prompt 带上标题和描述作为上下文。这会改变描述的输入，需要提升流水线版本，复用判断（目前只比较图片 hash）也得把文本算进去。建议和 2.2"重新描述全部"一起做。
### 4.3 没有用量和费用记录

不记 token 用量，也没有预算或上限。整库重新描述的成本，用户只看到一个确认框。

**改造方向**：按库、按 provider 记录调用次数和 token；设置页显示用量；支持每库月度上限，达到上限时暂停后台 AI 任务。

### 4.4 可观测性只有 console 日志

没有成功率、延迟、429 次数这类指标，每处理一张图还会打一条 info 日志。

### 4.5 小问题

- `ai_model` 没有 `(provider_id, name)` 唯一约束，同一模型可以重复添加。
- rerank 缓存键只包含文档 id，不包含文档内容；文档在 10 分钟内被修改的话，用的仍是旧分数。

## 5. 缺失的功能

- **新内容自动建索引**：最大的缺口，见 async 文档第 5 节。
- **以图搜图 / 相似图片**：图片向量已经有了，却没有相应接口。
- **近重复检测**：基于同一批向量即可实现。
- **图片 embedding 供应商太少**：openai-compatible 适配器不支持图片 embedding，目前只有 Gemini 和 DashScope 能用。自托管的 CLIP/SigLIP（vLLM、Infinity、Ollama），以及 Jina、Voyage、Cohere 的多模态 embedding 都用不了。
- **常用供应商模板**：Anthropic 原生、OpenRouter、Azure OpenAI、Ollama。
- **视频只用封面一帧**：没有关键帧、字幕或语音转写。
- **搜索能力**：只能搜 Media，不能搜 Post；没有按日期、作者、标签过滤。
- **失败明细**：现在只有失败计数和"全部重试"，看不到哪个媒体失败、原因是什么。
- **管理面板**：用量和预算、按库暂停 AI、provider 健康状态。

## 6. 优先级建议

1. **P0**
   - ~~空间切换加覆盖率阈值并支持回滚（1.1）~~ 已修复
   - ~~堵住 SSRF（4.1）~~ 已修复
   - 新内容自动建索引（async 文档第 5 节）
   - ~~把降级展示给用户（1.2）~~ 已修复
2. **P1**
   - provider 熔断（async 文档第 6 节）
   - ~~描述模型退回 JSON mode（2.3）~~ 决定不做
   - 控制描述输出长度（4.2，prompt 上下文待做）、记录用量（4.3）
   - 绑定只保留一份并原子写入（1.5）
   - ~~修正错误分类（1.3）~~ 已修复
3. **P2**
   - 删除残留代码（3.3）
   - 精简 catalog 和接入流程（3.1、2.5）
   - 以图搜图、近重复检测等新功能（第 5 节）
