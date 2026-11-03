# 异步任务待处理清单

设计见 [async_task_improvements.zh-Hans.md](./async_task_improvements.zh-Hans.md) 第 11 节。这里只记还没做完的事，处理完就删掉对应条目。

2026-10-30 对照 `1a030f9` 和第 3 层的工作区改动核对。

## 待处理

按建议的处理顺序排列。

### 安全

1. **`/library/list` 和 `/library/update` 没有 owner 校验**：已修，在本地 `main` 的 `42c7a32`。这个分支合入 main 后删掉本条。

### 上线和运维

4. **滚动发布时可能丢行**：`QueueWorker.run` 遇到不认识的流水线名会直接删除该行。k8s 是 1 副本，但默认滚动更新时新旧 Pod 会短暂并存，新增流水线时旧版本 worker 可能删掉新版本入队的行。能靠 scan 补回的要等下次巡检。

### 调度公平性

5. **所有流水线共用 8 个槽位**：`QueueWorker` 的 `concurrency` 默认 8，下载、FFmpeg 和 AI 互相抢，一批慢任务能占满全部槽位。
6. **"重试全部"和新内容同优先级**：`retryFailures` 走 `requeue`，优先级和编辑触发的变化一样是 `Priority.CHANGE`，大批量重试可能挤占新内容。
7. **按库轮转**：一个大库能占满全部槽位。11.7 写的是多用户部署需要时再加。

### 失败处理

10. **有些失败只有日志**：`ai.index` 和 scan 的失败不进失败数，任务页看不到。
11. **`giveUp` 仍然先锁队列行**：这是"先结果行、后队列行"的唯一例外。它很少触发，也能自愈，但压测没有覆盖这条路径。

### 效率和维护

12. **`AiService.forLibrary` 没有缓存**：每批都要重新解析配置和解密 Key，`GET /api/jobs/pipelines` 有积压时也会调用它，现在顶部提醒每分钟也会调用一次。
13. **文档过期**：`apps/server/README.md` 第 46 行起的一节和 `apps/server/docs/README.zh-Hans.md` 还在写 `AsyncTask` / `JobRunner`；`docs/task_engine_extension.md` 及其中文版整篇都是旧引擎，根目录 `README.md` 还链接着它；`apps/server/docs/openapi.json` 也过期了，还留着 `/api/jobs/list`，要重新生成。
14. **字段命名不统一**：`asset_ai_metadata.error_input_hash` 和 `asset_embedding.error_hash` 是同一个含义。

### 还没做的功能

15. **operation 层**（第 4 层，11.9）：手动复制和移动、导出 ZIP、存储迁移、年度回顾都要等它。第一个操作要做时再建。

### 超时修复留下的

16. **`scanPage` 不接收中止信号**：scan 步骤超时后不会真正停下，只靠语句超时和让出槽位兜底。
17. **长语句可能被 120 秒超时杀掉**：大库的 `dropSpace`、删除媒体库和 `markCoversStale` 要按生产数据量确认。
18. **卡死重启会带上 API**：worker 和 API 在同一进程，超过 8 个卡死的 run 时 API 也会重启。拆出独立的 worker 进程后才能避免。

### 第 3 层留下的

19. **暂停没有全局提醒**：忘了恢复时只能在任务页和设置页看到。暂停覆盖库的全部流水线，所以新上传的文件也不会生成封面。
20. **熔断提醒的覆盖范围有限**：只看当前活动库，设置页布局里不显示，60 秒采样加 120 秒阈值，故障开始几分钟后才出现。

### 2026-11-02 复核新增

22. **没有指标和告警**：只有任务页的最久等待和封锁时长，没人打开页面就不知道出了问题。
23. **Batch API 没有重建计划**：设计文档第 2 节写明要在任务引擎上重建，但分层计划里没有它。
24. **合并 main 时要确认权限校验**：`queue-enrichment.ts`、`retry-sync.ts`、`trash-service.ts` 等处和 `main` 的 owner 修复冲突，合并后要确认校验还在，并跑 `test:library:db`、`test:content:db`、`test:tokens:db`。`jobs.ts` 和 `main` 的 `ownedLibrary` 也要合成一份。
25. **上线步骤没有集中记录**：要执行 `drizzle push`，含 `enqueued_at`、`interruptions` 和 `jobs_paused`；已有的文本向量会全部重新生成一次，要预估 provider 费用。
26. **毒丸会连累同时运行的对象**：worker 崩溃时，同一进程里所有运行中的行都记一次中断。这些行重启后往往又和毒丸一起跑，连续 5 次就会被一起记成"输入被拒"。这是原有行为，单独计中断次数后也没有改变。

## 待验证

- 真实 AI provider 和完整的故障演练。第 3 层的提醒是直接写 Redis 模拟封锁验证的。
- 任务页的等待时长和封锁时长显示。暂停开关和顶部提醒已在浏览器看过。
- 提醒被关闭后，封锁结束再次触发时能重新出现。
- 繁体中文的新文案，还没在页面上看过。
- 控制台里 `LibrarySwitcher` 和任务页的 hydration 警告，没有和改动前对比过。
- `cover-all-formats` 测试，需要 S3。
- 生产环境的 Postgres 版本，以及 `DB_URL` 前面有没有连接池。有的话 `LISTEN` 会失效，队列退回 5 秒轮询；`secret.example.yaml` 写的是直连。
- 开发库的 worker 恢复情况。57 行 `ai.text` 的 `attempts` 最高到 112，现在被认领后会再跑一次，再失败就只记错误、由巡检重新入队。还没在开发库上看过。
- 接入 PgBouncer 时要配 `ignore_startup_parameters`，否则带超时参数的连接可能被拒。
