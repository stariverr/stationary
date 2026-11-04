# 异步任务重构上线步骤

`refactor/job-queue` 合入 main 后第一次部署时按这里执行。设计见 [async_task_improvements.zh-Hans.md](./async_task_improvements.zh-Hans.md) 第 11 节。

2026-11-04 在一次性数据库上演练过：先推 main 的 schema、写入旧格式的行，再按下面的步骤升级。真实数据量下的耗时没有测过。

## 为什么要停机

- 新旧版本的 schema 不兼容：旧版本读写 `async_task` 和 `asset_embedding` 的队列字段，新版本需要 `job_queue`。
- `drizzle push` 不是一个事务。中途失败时，前面的语句已经生效：演练中建唯一索引失败时，`async_task` 已经删掉了，`job_queue` 还没建。所以要先备份，再清理数据，最后 push。

## 步骤

1. **预估向量费用**。文本向量的 `content_hash` 现在是搜索文档的哈希，所以上线后所有文本向量都会重新生成一次。在旧库上统计数量和输入长度：

   ```sql
   SELECT e.embedding_space_id, count(*) AS vectors, sum(length(d.title) + length(d.content)) AS characters
   FROM asset_embedding e
   JOIN asset_search_document d ON d.entity_type = e.entity_type AND d.entity_id = e.entity_id AND d.library_id = e.library_id
   WHERE e.embedding_role = 'AI_CAPTION' AND e.embedding_status = 'READY'
   GROUP BY 1;
   ```

   `embedding_space_id` 对应 `library_embedding_space.space_id`，从这里能查到模型，再按 provider 的价格估算。图片向量和描述的判断方式没有变，不会重新生成。以前失败的描述和向量没有记录失败时的输入，所以会各重试一次。

2. **停掉旧版本**。Argo CD 开着 `selfHeal`，直接把副本数调成 0 会被改回去，所以要先暂停自动同步，再把 Deployment 缩到 0。等 Pod 退出，旧版本才不会继续写数据。

3. **备份数据库**，例如 `pg_dump -Fc`。

4. **清理旧数据**。新的唯一索引 `asset_emb_entity_space_unique` 不再包含 `content_hash`，每个媒体在每个空间只能有一行。旧库里同一媒体可能还有 PENDING、FAILED 或 STALE 行，不清理的话 push 会在建索引时失败：

   ```sql
   BEGIN;
   -- Only READY rows hold a current vector; PENDING and FAILED rows were queue entries, STALE ones superseded vectors.
   DELETE FROM asset_embedding WHERE embedding_status <> 'READY';
   -- Should a media still have two vectors in one space, keep the newest.
   DELETE FROM asset_embedding older USING asset_embedding newer
   WHERE older.entity_type = newer.entity_type AND older.entity_id = newer.entity_id
     AND older.embedding_space_id = newer.embedding_space_id AND older.embedding_role = newer.embedding_role
     AND (older.create_time, older.id) < (newer.create_time, newer.id);
   COMMIT;
   ```

   删掉的行不用补：新版本启动时会扫描所有库，缺什么就重新入队。

5. **在 `apps/server` 下执行 `drizzle push`**，用新版本的代码，`DB_URL` 指向生产库。
   - 新增的表、字段和索引都要选"新建"，不能选"从旧的重命名"。
   - 删除旧表和旧字段要确认数据丢失。push 会逐项列出，非交互执行时要全部写进 `--hints`。下面是演练时需要的全部 hints，表里没有数据时，对应的确认项不会出现：

   ```bash
   bunx drizzle-kit push --force --hints '[
     {"type":"create","kind":"table","entity":["public","job_queue"]},
     {"type":"create","kind":"column","entity":["public","asset_ai_metadata","is_stale"]},
     {"type":"create","kind":"column","entity":["public","asset_ai_metadata","error_input_hash"]},
     {"type":"create","kind":"column","entity":["public","asset_embedding","error_hash"]},
     {"type":"create","kind":"column","entity":["public","library","jobs_paused"]},
     {"type":"create","kind":"index","entity":["public","asset_ai_metadata","ai_metadata_library_target_idx"]},
     {"type":"create","kind":"index","entity":["public","asset_embedding","asset_emb_entity_space_unique"]},
     {"type":"create","kind":"index","entity":["public","asset_embedding","asset_emb_library_space_role_idx"]},
     {"type":"confirm_data_loss","kind":"table","entity":["public","async_task"]},
     {"type":"confirm_data_loss","kind":"table","entity":["public","async_task_unit"]},
     {"type":"confirm_data_loss","kind":"column","entity":["public","asset_ai_metadata","processing_status"]},
     {"type":"confirm_data_loss","kind":"column","entity":["public","asset_embedding","document_id"]},
     {"type":"confirm_data_loss","kind":"column","entity":["public","asset_embedding","input_text"]},
     {"type":"confirm_data_loss","kind":"column","entity":["public","asset_embedding","input_title"]},
     {"type":"confirm_data_loss","kind":"column","entity":["public","asset_embedding","embedding_status"]},
     {"type":"confirm_data_loss","kind":"column","entity":["public","asset_embedding","available_at"]},
     {"type":"confirm_data_loss","kind":"column","entity":["public","asset_embedding","attempt_count"]},
     {"type":"confirm_data_loss","kind":"column","entity":["public","library","cover_config_version"]},
     {"type":"confirm_data_loss","kind":"column","entity":["public","library_embedding_space","backfill_task_id"]}
   ]'
   ```

   - 如果提示里出现了上面没有的项，先停下来查明原因，不要直接加进 hints。
   - 完成后再执行一次不带 hints 的 `bunx drizzle-kit push`，应该没有任何改动，也不会再提示。

6. **启动新版本**，恢复 Argo CD 自动同步。
   - 旧任务表里没跑完的任务不会迁移。启动时的巡检会扫描每个库，把下载、封面、头像和 AI 缺的部分重新入队。
   - 在任务页确认各流水线的积压在下降。

## 配置

- 新增可选环境变量 `DB_STATEMENT_TIMEOUT_MS`，默认 120000，设为 0 表示不限时，交给数据库自己的配置。
- 关停时 worker 最多 drain 15 秒。k8s 默认的 30 秒宽限期够用。`docker-compose.yml` 已配 `stop_grace_period: 30s`。
- 接入 PgBouncer 时要配 `ignore_startup_parameters`，否则带超时参数的连接可能被拒。

## 以后的版本

- 新增流水线可以滚动发布：旧版本只认领自己认识的队列名。
- 删掉一条流水线时，它在 `job_queue` 里留下的行不会被自动清理，要在上线步骤里手动删掉。
- 改索引定义时要换一个索引名。push 只按名字比较索引，名字不变时，定义的变化会被忽略。
