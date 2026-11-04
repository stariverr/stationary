# 异步任务待处理清单

设计见 [async_task_improvements.zh-Hans.md](./async_task_improvements.zh-Hans.md) 第 11 节。上线步骤见 [async_task_rollout.zh-Hans.md](./async_task_rollout.zh-Hans.md)。这里只记还没做完的事，处理完就删掉对应条目。

2026-10-30 对照 `1a030f9` 和第 3 层的工作区改动核对。

## 待处理

只记会出错或会误导人的问题，按建议的处理顺序排列。"以后可能需要"的改进记在设计文档 11.14。

11. **`giveUp` 仍然先锁队列行**：这是"先结果行、后队列行"的唯一例外。它很少触发，也能自愈，但压测没有覆盖这条路径。
13. **文档过期**：`apps/server/README.md` 第 46 行起的一节和 `apps/server/docs/README.zh-Hans.md` 还在写 `AsyncTask` / `JobRunner`；`docs/task_engine_extension.md` 及其中文版整篇都是旧引擎，根目录 `README.md` 还链接着它；`apps/server/docs/openapi.json` 也过期了，还留着 `/api/jobs/list`，要重新生成。
16. **`scanPage` 不接收中止信号**：scan 步骤超时后不会真正停下，只靠语句超时和让出槽位兜底。
17. **长语句可能被 120 秒超时杀掉**：大库的 `dropSpace`、删除媒体库和 `markCoversStale` 要按生产数据量确认。

## 待验证

- 真实 AI provider 和完整的故障演练。第 3 层的提醒是直接写 Redis 模拟封锁验证的。
- 任务页的等待时长和封锁时长显示。暂停开关和顶部提醒已在浏览器看过。
- 提醒被关闭后，封锁结束再次触发时能重新出现。
- 繁体中文的新文案，还没在页面上看过。
- 控制台里 `LibrarySwitcher` 和任务页的 hydration 警告，没有和改动前对比过。
- `cover-all-formats` 测试，需要 S3。
- 生产环境的 Postgres 版本。
- 开发库的 worker 恢复情况。57 行 `ai.text` 的 `attempts` 最高到 112，现在被认领后会再跑一次，再失败就只记错误、由巡检重新入队。还没在开发库上看过。
- 接入 PgBouncer 时要配 `ignore_startup_parameters`，否则带超时参数的连接可能被拒。
