# 多空间混合搜索 MVP 设计

> [English](./ai_hybrid_search.md)

本文档记录 Stationary 中 AI 增强搜索的 MVP 架构规划。它是设计与实现指南；部分组件会随实现阶段逐步落地。

---

## 1. 目标

Stationary 会存储来自多个平台的帖子与媒体资产。搜索能力需要同时支持精准文本检索与视觉发现：

- 对标题、描述、标签、作者、OCR、AI caption 做精确或模糊关键词搜索。
- 对拼接后的帖子/媒体文档做文本语义搜索。
- 对图片内容、色彩、构图、风格、氛围做视觉/多模态语义搜索。
- 在检索和排名融合前严格执行 Library 级访问控制。
- 以数学上安全的方式处理不同模型与不同 pipeline 产生的 embedding。

MVP 使用三个互补的检索信号：

```text
关键词匹配
+ 文本语义向量搜索
+ 视觉/多模态向量搜索
→ RRF 倒数排名融合
→ 按实体去重后的结果
```

---

## 2. 核心原则

### 2.1 Embedding Space Segregation

不同 embedding 模型、模型版本、task type、维度、预处理规则或归一化策略生成的向量，属于不同语义空间。即使物理维度相同，也不能跨空间计算 cosine 或其他距离。

因此，每条 embedding 记录都携带 `embedding_space_id`，由模型定义计算为 `{modelName}:{dimension}:{taskPrefixType|plain}`，例如：

```text
gemini-embedding-2:768:gemini-asymmetric
qwen3-vl-embedding:1024:plain
```

空间 ID 有意不包含供应商连接：同一模型换一个供应商提供服务，向量仍可比较，因此迁移供应商无需重新向量化。凡是会改变向量的因素（模型、输出维度、输入模板）都会改变空间 ID。

### 2.2 Canonical Lifecycle Integration

AI 派生记录应镜像现有生命周期字段：

- `delete_status`
- `delete_time`
- 必要时包含 `recycle_time`

但搜索正确性仍必须以 canonical `Post` / `Media` 为准。一个搜索结果只有在 canonical 实体满足以下条件时才有效：

```sql
delete_status = 'ACTIVE'
AND recycle_time IS NULL
```

AI 表可以保存冗余生命周期字段，用于索引和清理，但不能成为可见性判断的唯一事实来源。

### 2.3 Pre-Filter Security Bounds

所有检索路径都必须在高成本检索或排名融合前执行 Library 访问边界：

1. 解析当前用户可访问的 Library 集合。
2. 在关键词搜索、文本语义搜索、视觉语义搜索中分别应用该边界。
3. join canonical `Post` / `Media`，再次校验 `library_id`、`delete_status` 和 `recycle_time`。
4. 之后才能执行 RRF 融合并返回结果。

禁止先把未授权候选结果放入 RRF，再在融合后过滤。

---

## 3. 输入源与 AI 调用

搜索增强 pipeline 只有两类源输入：

1. 原始图片二进制。
2. 拼接后的描述性文本。

为了最大化利用这两类输入，MVP 会执行三类 AI 调用：

| 通道                  | 输入       | 模型族                     | 输出                                               | 用途                                                            |
| :-------------------- | :--------- | :------------------------- | :------------------------------------------------- | :-------------------------------------------------------------- |
| 图片理解              | 图片二进制 | Gemini Flash               | caption、tags、objects、colors、styles、scene、OCR | 把视觉内容转成结构化文字元数据。                                |
| 视觉/多模态 Embedding | 图片二进制 | `multimodal-embedding-004` | 1408 维向量                                        | 支持视觉相似、氛围、色彩、构图和跨模态视觉描述搜索。            |
| 文本语义 Embedding    | 拼接文本   | `text-embedding-004`       | 768 维向量                                         | 支持原帖文本、AI caption、OCR、标签、作者、概念和实体语义搜索。 |

这个区分很重要：

- 系统输入源只有图片与文本两类。
- AI 派生出的检索/增强信号有三类：VLM 元数据、视觉 embedding、文本 embedding。

### 示例

一条小红书帖子包含：

- 图片：一杯心形拉花拿铁，放在暖色木桌上。
- 文字：“今天在塞纳河畔喝到了超治愈的咖啡，推荐这家塞纳左岸店。”

搜索表现：

- 查询 `塞纳河畔` 或 `塞纳左岸店`：关键词和文本语义通道应该占主导，因为这是正文概念或命名实体。
- 查询 `温馨、日系风格的暖色咖啡素材`：视觉/多模态通道应该强贡献，因为它描述的是氛围、色彩和构图。
- 查询 `咖啡拉花`：三个通道都可能贡献结果。

注意：多模态 embedding 空间可以把文本 query 和图片 document 映射到同一空间。它不是“只认识像素”的模型。它的优势是把视觉语言描述映射到图片内容；但它不应该替代关键词或文本语义通道来处理精确实体、原帖正文、作者名和业务元数据。

---

## 4. 规划数据模型

MVP 会在 `apps/server/src/db/schema/index.ts` 中引入以下逻辑表。

### 4.1 `library_embedding_space`

记录每个媒体库按向量角色（`textEmbedding` / `imageEmbedding`）写入的空间。

- `status = ACTIVE`：检索使用的空间，每个角色一个。
- `status = BUILDING`：更换模型后正在填充的新空间。回填任务结束、队列清空，并且满足下面两个条件，才会替换 ACTIVE：
  - 失败的向量不超过已完成的 5%；
  - READY 向量数不少于 ACTIVE 空间的 95%。

  不满足时空间停在 BUILDING，`/api/ai/status` 返回 `blocked`（`too_many_failures` / `low_coverage`）。设置页的"重试失败项"会把失败的向量重新排队，覆盖不足时还会重新发起回填。
- `status = RETIRED`：被替换下来的旧 ACTIVE 空间，向量保留 7 天，既不检索也不写入。期间重新选择它的模型，会直接把它恢复为 BUILDING，只补齐这段时间的变化，不需要重新计算全部向量。过期后由 embedding worker 删除。每个角色最多一个 RETIRED。
- `model_id`：提供该空间向量的模型；同一空间换供应商只更新这里，不重建。
- `backfill_task_id`：把整个媒体库重新处理一遍的 AI 任务（按页发现媒体）。

切换期间 enrichment 同时写 ACTIVE 与 BUILDING，检索只读 ACTIVE，因此搜索不中断。

### 4.2 `asset_search_document`

帖子和媒体的反范式搜索文档。

只存搜索会读的内容：

- `title`：媒体标题，没有时用帖子标题
- `content`：媒体和帖子的标题与描述、帖子和媒体的标签及其别名，以及 AI 生成的 scene、caption 和 OCR 文本
- `source`、`media_type`：过滤列
- `content_hash`：决定是否重写文档、是否重新生成文本向量

`content` 只存各字段的值，每行一个，不带字段名。如果带上 `Title:` 这类标签，搜索 "title" 就会命中所有文档。不论媒体库是否配置了 AI，每个被索引的媒体都会写入搜索文档；图像描述失败也不会阻止写入。文档使用当前最合适的已有描述，新描述生成后会重写文档。

推荐唯一约束：

```text
(entity_type, entity_id)
```

### 4.3 `asset_ai_metadata`

资产的结构化 AI 解析结果，是 AI 生成内容的唯一来源：搜索把其中一部分复制进搜索文档，媒体详情接口把选中的结果作为 `ai` 返回给前端展示。

典型字段：

- caption
- tags
- objects
- colors
- styles
- scene
- OCR text
- model
- metadata pipeline ID
- processing status
- last error

metadata pipeline 独立于模型名进行版本化：由 prompt 版本和输出语言组成，例如：

```text
image-metadata:v2:zh-Hans
```

`model` 列记录是哪个模型写的描述。因此更换描述模型时，已有描述保留，只有新增或变更的内容用新模型；用户选择"重新描述全部"时，才会跑一次带 `redescribe` 的全库任务，把由其他模型写的描述重新生成。

推荐唯一约束：

```text
(entity_type, entity_id, metadata_pipeline_id)
```

搜索文档和结果说明优先使用当前描述管线的结果；当前管线还没有结果时，使用较早管线中最新的结果。这样在更换语言、重新描述整个库期间，描述依然可以被搜索到。当前管线为某个媒体写入结果后，该媒体在旧管线中的行会被删除。

### 4.4 `asset_embedding`

既是向量结果表，也是向量请求队列：一行先以 `PENDING` 入队，由 embedding worker 填入向量后变为 `READY`。

关键字段：

- `entity_type`, `entity_id`, `library_id`（检索前预过滤）, `document_id`。
- `embedding_space_id`, `embedding_role`（`AI_CAPTION`、`IMAGE_PRIMARY` 等）, `input_modality`, `dimension`。
- `embedding`：无固定维度的 `halfvec`，排队期间为 null。
- `content_hash`：本行自身输入的哈希（图像为源文件哈希，文本为实际向量化的文本）。
- `source_file_id`：图像输入；`input_text` / `input_title`：文本输入，向量写入后清空。
- `embedding_status`：`PENDING`、`READY`、`STALE`（同空间同角色被新输入取代）、`FAILED`（多次失败后放弃，可手动重试）。
- 队列字段：`available_at`（可领取时间，领取时前推作为租约）、`attempt_count`、`last_error`。

唯一约束：

```text
(entity_type, entity_id, embedding_space_id, embedding_role, content_hash)
```

### 4.5 向量队列

- enrichment 只负责图像描述和搜索文档，并为每个写入中的空间登记待计算行；新行完成前，旧的 `READY` 向量继续服务检索。
- embedding worker（每个实例 2 个循环）按「媒体库 + 空间 + 模态」领取一批，批量大小取决于供应商（文本最多 64 条，DashScope 20 条；Gemini 图像 6 张，其他图像 1 张）。
- 失败过的行单独重试，避免一条坏输入拖累整批；被限流的批次延后且不计重试次数。
- 新任务入队后通过 Redis 发布唤醒所有实例，另有 10 秒轮询兜底。
- 回收站中媒体的待计算向量会暂停，恢复后继续；它们不阻塞空间切换，也不计入进度。永久删除媒体时，同一事务内删除其向量、搜索文档和图像描述。
- 文本输入按模型 `maxInputTokens` 的约 90% 截断，采用保守估算（中日韩字符每字 1.5 token，其他每 3 字符 1 token）；文档中标题和标签排在 OCR 之前，超长时先截掉尾部。

---

## 5. 向量存储与索引

### 5.1 Generic Vector Column

使用单个不定维的半精度 pgvector 列：

```sql
embedding halfvec NOT NULL,
CONSTRAINT asset_emb_dimension_check CHECK (vector_dims(embedding) = dimension)
```

Provider adapter 在写库前按模型定义校验返回的维度，数据库约束是最后一道防线。`halfvec` 存储减半，并把 HNSW 的维度上限从 2000 提高到 4000。

### 5.2 Partial HNSW Indexes

HNSW 需要固定维度，因此 schema 为每个支持的维度声明一个 partial expression index（`features/ai/model-schema.ts` 中的 `EMBEDDING_DIMENSIONS`：256、384、512、768、1024、1536、2048、2560、3072）。模型定义只能使用这些维度，原生维度更高的模型通过 MRL 截断。

```sql
CREATE INDEX asset_emb_hnsw_1024 ON asset_embedding
USING hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops)
WHERE dimension = 1024;
```

查询使用相同的字面量维度做类型转换，过滤 `dimension = <字面量>`，按距离 `ORDER BY ... LIMIT`，距离阈值在取回 top-k 之后再应用。空间、角色、媒体库等过滤条件依靠 `hnsw.iterative_scan = relaxed_order`（pgvector ≥ 0.8）在扫描中执行。

### 5.3 Extension 与迁移注意事项

需要 PostgreSQL extension：

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

运维注意事项：

- `CREATE INDEX CONCURRENTLY` 必须在 transaction block 外执行。
- extension 初始化建议作为独立 bootstrap 步骤，因为托管数据库可能要求更高权限或 extension allow-list。
- 开发环境可以使用普通 `CREATE INDEX`；生产大表应优先使用 `CREATE INDEX CONCURRENTLY`。
- Drizzle 生成的 DDL 可能需要配套手写 migration，用于 extension、pgvector HNSW index 和 trigram index。

### 5.4 Keyword Indexes

`asset_search_document` 把规范化后的标题和正文存为生成列（规范化规则见 5.5），trigram 索引建在这两列上：

```sql
ALTER TABLE asset_search_document
  ADD COLUMN folded_title text GENERATED ALWAYS AS (replace(lower(normalize(title, NFKC)), 'ß', 'ss')) STORED,
  ADD COLUMN folded_content text GENERATED ALWAYS AS (replace(lower(normalize(content, NFKC)), 'ß', 'ss')) STORED;

CREATE INDEX search_doc_folded_title_trgm_idx ON asset_search_document USING gin (folded_title gin_trgm_ops);
CREATE INDEX search_doc_folded_content_trgm_idx ON asset_search_document USING gin (folded_content gin_trgm_ops);
CREATE INDEX search_doc_library_idx ON asset_search_document (library_id);
```

规范化表达式只在代码里定义一次（`searchFold`），生成列和查询模式都用它。查询同时按 `asset_search_document.library_id` 和 `media.library_id` 过滤：前者把扫描限制在当前媒体库，后者仍是访问控制的依据。

之所以存生成列而不是建表达式索引：词常见或只有两个字时，查询会顺序扫描整个库，还要对每个命中行计算排序键，表达式索引下每行都要重新算一次 `normalize()`。20 万条文档的单库实测，最坏情况从 1.3–2.4 秒降到 0.13–0.26 秒；词少见、能走索引的查询在 10 毫秒以内。代价是文本存储大约翻倍。

### 5.5 关键词检索（多语言）

当前支持的语言：中文、日文、英文、德文。

关键词通道负责**精确召回**：名称、品牌、编号、专有名词、中英混排等向量容易漏掉的内容。同义词、整句自然语言和跨语言检索由语义通道负责，因此文本 embedding 模型应使用多语言模型。

**原则：文档存原文，只切查询，按子串匹配。** 切出的每一段都是原查询的子串，分词出错只会让匹配变宽，不会比整句匹配少召回；文档端不分词，所以不用维护索引侧词典，换分词器也不需要重建数据。

1. **规范化**（数据库表达式，文档和查询共用）：NFKC 统一全角与半角（`ＩＰＨＯＮＥ１５` → `iphone15`，`ｶﾀｶﾅ` → `カタカナ`），转小写，`ß` → `ss`。不去变音符号，以免 `Bar` 匹配 `Bär`。`title` 和 `content` 保留原文，供 embedding 和 rerank 使用；规范化后的副本存在生成列里。
2. **查询分词**：先按空白切分，英文和德文到此为止。含汉字或假名的片段再交给 `Intl.Segmenter`（运行时自带的 ICU）切分，之后：
   - 把相邻的单个汉字拼回去，还原 ICU 词典没有的新词（ICU 会把 `赛博朋克` 切成单字）；
   - 去掉单独的平假名（`の`、`は`、`が` 等助词）。

   每一段都必须作为子串出现在标题或正文中。整句自然语言查询可能因此匹配不到，交给语义通道。
3. **排序**（让 RRF 名次有意义）：
   1. 标题包含完整查询；
   2. 完整单词命中的数量（`\m…\M` 词边界：`art` 排在 `start` 前，`Tür` 排在 `Haustür` 前；中日文没有词边界，此项不起作用）；
   3. 标题命中的词数；
   4. 正文包含完整查询；
   5. 创建时间。

已知局限：

- 少于三个字符的词（多数中文双字词）用不上 trigram 索引，在单个媒体库内退化为顺序扫描。
- 平假名与片假名不互通；其他拉丁语言的变音符号和泰文等语言暂不支持。

升级路径（达到触发条件再做，架构不变）：

| 触发条件 | 升级方向 |
|---|---|
| 双字词查询明显变慢 | 引入 `pg_bigm` |
| ICU 加拼字规则处理不好的情况增多 | 分词函数中，中文换 jieba，日文换 Lindera / kuromoji（只用切出的原样片段，不用词形还原） |
| 文档变长（OCR、语音转写、PDF 正文）且能控制 Postgres 镜像 | ParadeDB `pg_search`（BM25） |
| 产品要求边打字边出结果、拼写容错 | Meilisearch 只承担关键词通道，Postgres 仍是唯一数据来源 |

不采用的方案：`tsvector`（需要按文档区分语言配置，默认解析器不切中文）、SPLADE 等稀疏向量（关键词通道会依赖 AI 配置）、Elasticsearch / Typesense（自托管运维成本过高）。
```

同时维护过滤用 B-tree index：

```sql
CREATE INDEX IF NOT EXISTS asset_search_doc_library_status_idx
ON asset_search_document (library_id, delete_status, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS asset_embedding_space_library_idx
ON asset_embedding (embedding_space_id, library_id);

CREATE INDEX IF NOT EXISTS asset_embedding_entity_idx
ON asset_embedding (entity_type, entity_id);
```

---

## 6. Provider 抽象

AI provider 应显式建模文本 embedding 的 query/document purpose：

```ts
export interface ImageAiMetadata {
    caption: string;
    tags: string[];
    objects: string[];
    colors: string[];
    styles: string[];
    scene: string;
    ocrText: string;
}

export interface EmbedTextParams {
    text: string;
    spaceId: string;
    purpose: "QUERY" | "DOCUMENT";
}

export interface EmbedImageParams {
    imageBuffer: Buffer;
    mimeType: string;
    spaceId: string;
}

export interface AiProvider {
    embedText(params: EmbedTextParams): Promise<number[]>;
    embedImage(params: EmbedImageParams): Promise<number[]>;
    describeImage(imageBuffer: Buffer, mimeType: string): Promise<ImageAiMetadata>;
}
```

实现要求：

- 按 `spaceId` 路由，拒绝未知空间。
- 从 `embedding_space.config` 读取 task type。
- 生成后立刻校验输出维度。
- API key 只能来自环境变量。
- 结构化图片解析结果必须做 schema validation。
- 使用 `content_hash` 与 pipeline ID 保证幂等。
- 默认测试应 mock provider，不应真实调用外部 AI API。

---

## 7. 搜索流程

MVP 搜索流程示意：

```ts
async function search(params: SearchParams, userId: string) {
    if (!(await canSearchLibrary(userId, params.library_id))) {
        return { list: [], total: 0 };
    }

    const textSpace = "gemini:text-embedding-004:768:cosine:v1";
    const visualSpace = "gemini:multimodal-embedding-004:1408:cosine:v1";

    const [keywordResults, textSemanticResults, visualSemanticResults] = await Promise.all([
        keywordSearch(params, params.library_id),
        params.q ? textSemanticSearch(params.q, textSpace, params.library_id) : [],
        params.q ? visualSemanticSearch(params.q, visualSpace, params.library_id) : [],
    ]);

    return reciprocalRankFusion([keywordResults, textSemanticResults, visualSemanticResults], {
        k: 60,
        weights: [1.0, 1.0, 1.2],
        dedupeKey: (item) => `${item.entity_type}:${item.entity_id}`,
    });
}
```

关键细节：

- 关键词搜索最适合精确名称、原文、作者名、品牌名和平台标识。查询经规范化与分词后，每一段都按字面子串（转义 `%` 和 `_`）匹配标题或正文，排序规则见 5.5。
- 文本语义搜索用于拼接文档上的同义表达与概念匹配。
- 视觉/多模态搜索用于风格、氛围、色彩、构图和视觉语言描述。
- 向量通道应先取多于最终页面大小的候选，再进入 RRF。
- 混合搜索中的 `total` 不一定是数据库全量精确总数；如果未实现精确分页，应明确它是候选数量，或改用 `hasMore`。
- 查询向量按「向量空间 + 查询文本」缓存 10 分钟：多个角色共用同一模型时只计算一次，翻页时直接复用。
- 每路语义检索都会丢弃超过模型 `matchDistance` 的结果（`text` 用于文本对文本，`image` 用于文本对图像，默认 0.5 和 0.6）。阈值可在模型上直接修改，无需重建向量。
- 媒体库绑定了重排序模型时，融合后的前 50 个候选会按其搜索文档文本交给重排序模型重新排序（Cohere 格式的 `/rerank`），其余保持融合顺序；重排序失败时保留融合顺序。得分会缓存，翻页只重排一次，并通过 `matched_details.rerank` 返回。
- 某个 AI 通道本该参与却没有参与时（绑定的模型无法解析、调用失败、被限流），搜索照常返回其余通道的结果，并在 `degraded` 中列出 `{ channel, reason }`。`channel` 取 `text_semantic` / `visual_semantic` / `rerank`，AI 配置整体无法加载时为 `ai`；`reason` 是错误分类（如 `CONFIGURATION`、`AUTHENTICATION`、`THROTTLED`）。前端据此在结果上方提示"结果可能不完整"。
- 结果只返回结构化的 `matched_details`，由客户端按浏览者的语言渲染说明。
- 图像描述使用媒体库的 `ai_language` 输出（OCR 保留原文）。语言属于描述管线标识的一部分，修改后会对整个库重新生成描述。

---

## 8. 生命周期与同步规则

删除 `Post` 或 `Media` 时，尽可能在同一事务内更新 AI 派生表：

```text
asset_search_document.delete_status = 'DELETED'
asset_ai_metadata.delete_status = 'DELETED'
asset_embedding.delete_status = 'DELETED'
```

同时设置 `delete_time`。

对于回收站、恢复和 Library 移动：

- 搜索最终可见性必须依赖 canonical `Post` / `Media` join。
- 实体移动 Library 时，应同步派生表中的 `library_id`。
- 即使派生表 `library_id` 暂时过期，也不能造成权限泄露，因为 canonical `library_id` 与生命周期检查会再次执行。

---

## 9. 验证清单

自动化检查：

- schema migration 能创建所需表和约束。
- pgvector 维度不匹配会失败。
- provider 输出维度不匹配会在入库前抛错。
- 未知 `embedding_space_id` 会被拒绝。
- RRF 按 `entity_type:entity_id` 去重。
- Library 访问过滤应用于关键词、文本语义和视觉语义三条路径。
- 回收站或已删除的 `Post` / `Media` 不出现在搜索结果中。

手动检查：

1. 预置 active text 和 multimodal `embedding_space` 记录。
2. 处理代表性图片，例如咖啡照片、暗黑科技图、带 OCR 的截图、多图帖子。
3. 检查生成的 metadata、文本 embedding 和图片 embedding 维度符合预期。
4. 在受限 Library 上执行自然语言搜索，确认没有权限泄露。
5. 针对关键词型、概念型、视觉风格型查询检查命中通道和排序。

---

## 10. MVP 非目标

首版实现不需要一次性解决所有未来检索问题。以下能力可以后置：

- 除关键帧外的完整视频理解。
- 音频 embedding。
- 跨模型迁移工具。
- 混合搜索的全局精确 total。
- 复杂 learning-to-rank 模型。
- 自动化搜索质量评估面板。

MVP 应优先保证数学正确性、访问边界安全、AI 处理幂等，以及 embedding space 的清晰隔离。
