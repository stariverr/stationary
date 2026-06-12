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

因此，每条 embedding 记录必须携带 `embedding_space_id`，用于表示完整 pipeline 配置，例如：

```text
gemini:text-embedding-004:768:cosine:v1
gemini:multimodal-embedding-004:1408:cosine:v1
```

版本后缀是 **pipeline version**，不只是模型版本。以下任一变化都必须 bump 版本：

- embedding 模型或模型版本变化。
- 输出维度变化。
- query/document task type 变化。
- prompt 结构或元数据拼接方式变化。
- 文本归一化、chunking、语言处理或 tag 格式变化。
- 图片预处理、resize、视频帧选择或裁剪策略变化。
- 向量归一化策略或距离度量变化。

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

### 4.1 `embedding_space`

用于登记活跃、废弃和实验性语义空间。

关键字段：

- `id`：完整 pipeline 标识，例如 `gemini:multimodal-embedding-004:1408:cosine:v1`。
- `provider`：embedding provider，例如 `gemini`。
- `model` 与 `model_version`。
- `dimension`。
- `space_kind`：`TEXT` 或 `MULTIMODAL`。
- `metric`：`COSINE`、`INNER_PRODUCT` 或 `L2`。
- `status`：`ACTIVE`、`DEPRECATED` 或 `EXPERIMENTAL`。
- `config`：JSON 配置，包含支持的输入模态、query/document task type、归一化、预处理和 pipeline 说明。

### 4.2 `asset_search_document`

帖子和媒体的反范式搜索文档。

聚合以下可搜索文本：

- title
- description/content
- source platform
- tags
- AI tags
- author name
- AI metadata 中的 OCR 和 caption

推荐唯一约束：

```text
(entity_type, entity_id)
```

### 4.3 `asset_ai_metadata`

资产的结构化 AI 解析结果。

典型字段：

- caption
- summary
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

metadata pipeline 应独立于原始模型名进行版本化。推荐 ID 形态：

```text
gemini:gemini-2.5-flash:image-metadata:v1
```

推荐唯一约束：

```text
(entity_type, entity_id, metadata_pipeline_id)
```

### 4.4 `asset_embedding`

保存帖子和媒体生成的向量。

关键字段：

- `entity_type`, `entity_id`。
- `library_id`，用于检索前预过滤。
- `document_id`，在关联 `asset_search_document` 时使用。
- `embedding_space_id`。
- `embedding_role`，例如 `CONTENT_TEXT`、`AI_CAPTION`、`IMAGE_PRIMARY`、`VIDEO_KEYFRAME`、`OCR_TEXT`。
- `input_modality`，例如 `TEXT`、`IMAGE`、`VIDEO_FRAME`、`AUDIO`。
- `dimension`。
- `embedding`，使用无固定维度的 pgvector `vector` 类型。
- `content_hash`，用于幂等处理。
- `source_file_id`，用于文件型媒体 embedding。
- `embedding_status`，例如 `READY`、`STALE`、`FAILED`、`DISABLED`。
- 生命周期字段。

推荐唯一约束：

```text
(entity_type, entity_id, embedding_space_id, embedding_role, content_hash)
```

`content_hash` 应为非空；或者 unique index 必须使用 `NULLS NOT DISTINCT`。否则 PostgreSQL 会允许多条 `NULL` hash 的重复记录。

---

## 5. 向量存储与索引

### 5.1 Generic Vector Column

使用单个无固定维度的 pgvector 列：

```sql
embedding vector NOT NULL
```

实际维度存入 `dimension` 并进行校验：

```sql
ALTER TABLE asset_embedding
ADD CONSTRAINT check_vector_dims
CHECK (vector_dims(embedding) = dimension);
```

应用层也必须在写库前校验 provider 输出维度。数据库约束是最后一道防线，不应作为主要校验机制。

### 5.2 Partial HNSW Indexes

为不同模型空间创建独立 partial HNSW expression index：

```sql
CREATE INDEX IF NOT EXISTS asset_embedding_gemini_mm_1408_hnsw
ON asset_embedding
USING hnsw ((embedding::vector(1408)) vector_cosine_ops)
WHERE embedding_space_id = 'gemini:multimodal-embedding-004:1408:cosine:v1'
  AND dimension = 1408
  AND embedding_status = 'READY'
  AND delete_status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS asset_embedding_gemini_text_768_hnsw
ON asset_embedding
USING hnsw ((embedding::vector(768)) vector_cosine_ops)
WHERE embedding_space_id = 'gemini:text-embedding-004:768:cosine:v1'
  AND dimension = 768
  AND embedding_status = 'READY'
  AND delete_status = 'ACTIVE';
```

查询条件应尽量与 partial index predicate 保持一致。

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

使用 `pg_trgm` index 做模糊关键词检索：

```sql
CREATE INDEX IF NOT EXISTS asset_search_doc_title_trgm_idx
ON asset_search_document
USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS asset_search_doc_content_trgm_idx
ON asset_search_document
USING gin (content gin_trgm_ops);
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
    const accessibleLibraryIds = await resolveAccessibleLibraries(userId, params.library_id);
    if (accessibleLibraryIds.length === 0) {
        return { list: [], total: 0 };
    }

    const textSpace = "gemini:text-embedding-004:768:cosine:v1";
    const visualSpace = "gemini:multimodal-embedding-004:1408:cosine:v1";

    const [keywordResults, textSemanticResults, visualSemanticResults] = await Promise.all([
        keywordSearch(params, accessibleLibraryIds),
        params.q ? textSemanticSearch(params.q, textSpace, accessibleLibraryIds) : [],
        params.q ? visualSemanticSearch(params.q, visualSpace, accessibleLibraryIds) : [],
    ]);

    return reciprocalRankFusion([keywordResults, textSemanticResults, visualSemanticResults], {
        k: 60,
        weights: [1.0, 1.0, 1.2],
        dedupeKey: (item) => `${item.entity_type}:${item.entity_id}`,
    });
}
```

关键细节：

- 关键词搜索最适合精确名称、原文、作者名、品牌名和平台标识。
- 文本语义搜索用于拼接文档上的同义表达与概念匹配。
- 视觉/多模态搜索用于风格、氛围、色彩、构图和视觉语言描述。
- 向量通道应先取多于最终页面大小的候选，再进入 RRF。
- 混合搜索中的 `total` 不一定是数据库全量精确总数；如果未实现精确分页，应明确它是候选数量，或改用 `hasMore`。

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
