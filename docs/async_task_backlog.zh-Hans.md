# 异步任务待处理清单

设计见 [async_task_improvements.zh-Hans.md](./async_task_improvements.zh-Hans.md) 第 11 节。上线步骤见 [async_task_rollout.zh-Hans.md](./async_task_rollout.zh-Hans.md)。这里只记还没做完的事，处理完就删掉对应条目。

2026-10-30 对照 `1a030f9` 和第 3 层的工作区改动核对。

## 待处理

只记会出错或会误导人的问题，按建议的处理顺序排列。"以后可能需要"的改进记在设计文档 11.14。

目前没有。

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
