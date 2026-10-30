# 异步任务待处理清单

设计见 [async_task_improvements.zh-Hans.md](./async_task_improvements.zh-Hans.md) 第 11 节。这里只记还没做完的事，处理完就删掉对应条目。

2026-10-30 对照 `1a030f9` 和第 3 层的工作区改动核对。

## 待处理

按建议的处理顺序排列。

### 安全

1. **`/library/list` 和 `/library/update` 没有 owner 校验**：`apps/server/src/api/library.ts` 的 `/list` 返回所有用户的库，`/update` 只按库 id 更新，任何已登录用户都能读取和修改别人的库。这是这次核对时发现的旧问题，和任务队列无关。

### 上线和运维

2. **容器收到 SIGTERM 时跳过优雅关停**：`docker/entrypoint.ts` 的 `shutdown` 给子进程发完信号就 `process.exit(0)`，不等它们退出。入口是容器的 1 号进程，它一退出，容器里其余进程都会被立刻杀掉，所以 `queueWorker.drain()` 实际跑不完。每次发布时进行中的 run 都要等租约过期（最多 60 秒），并计一次中断。应该等子进程退出后再退出。k8s 没有配 `terminationGracePeriodSeconds`，默认 30 秒，够 15 秒的 drain 用。
3. **`job_queue` 的 autovacuum 要手动设置**：`drizzle push` 不管表的存储参数，每个库都要手动执行一次 `ALTER TABLE`（11.3），漏了不会有提示，时间长了领取会变慢。要做成部署步骤。
4. **滚动发布时可能丢行**：`QueueWorker.run` 遇到不认识的流水线名会直接删除该行。k8s 是 1 副本，但默认滚动更新时新旧 Pod 会短暂并存，新增流水线时旧版本 worker 可能删掉新版本入队的行。能靠 scan 补回的要等下次巡检。

### 调度公平性

5. **所有流水线共用 8 个槽位**：`QueueWorker` 的 `concurrency` 默认 8，下载、FFmpeg 和 AI 互相抢，一批慢任务能占满全部槽位。
6. **"重试全部"和新内容同优先级**：`retryFailures` 走 `requeue`，优先级和编辑触发的变化一样是 `Priority.CHANGE`，大批量重试可能挤占新内容。
7. **按库轮转**：一个大库能占满全部槽位。11.7 写的是多用户部署需要时再加。

### 失败处理

8. **未知错误没有总重试上限**：持续失败的对象每次巡检最多再试 5 次，也就是每小时 5 次，一直消耗 provider 配额。
9. **错误可能被误判为输入问题**：对象会被判成"输入被拒"，要等手动重试或输入变化才恢复。两处来源：
    - AI：provider 的 400 和 422 都算 `INVALID_REQUEST`，配置错误也可能报这两个状态。403 算鉴权错误，不受影响。
    - 下载和头像：`DownloadStatusError.rejected` 把 408、425、429 以外的 4xx 都算被拒，CDN 临时返回 403 时会误判。
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

## 待验证

- 真实 AI provider 和完整的故障演练。第 3 层的提醒是直接写 Redis 模拟封锁验证的。
- 任务页的等待时长和封锁时长显示。暂停开关和顶部提醒已在浏览器看过。
- 提醒被关闭后，封锁结束再次触发时能重新出现。
- 繁体中文的新文案，还没在页面上看过。
- 控制台里 `LibrarySwitcher` 和任务页的 hydration 警告，没有和改动前对比过。
- `cover-all-formats` 测试，需要 S3。
- 生产环境的 Postgres 版本，以及 `DB_URL` 前面有没有连接池。有的话 `LISTEN` 会失效，队列退回 5 秒轮询；`secret.example.yaml` 写的是直连。
- 有 run 正在执行时收到 SIGTERM 的完整流程。目前只在空闲时测过 `apps/server/src/index.ts`，没有经过容器入口。
