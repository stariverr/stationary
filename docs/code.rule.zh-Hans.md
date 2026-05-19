# TypeScript / Bun 编写规范 (简体中文)

> [English](./code.rule.md)

## 替代方案与强制规约
- **Date -> Temporal**：绝对禁止直接或间接使用原生的 `Date`。所有需要获取/处理时间戳、日期和时区的地方都必须使用 `Temporal`。
    > 因为原生 `Date` 存在接口行为不可预测、时区支持薄弱、功能有缺陷等历史遗留设计问题。`Temporal` API 是 TC39 提出的下一代高级日期时间标准，安全性高，支持精细化时区处理，是 Date 的绝对替代者。
- **node:stream -> Web API stream**：在处理文件下载与数据流传输时，统一使用符合标准 Web API 规范的 Stream API，弃用 Node.js 传统的 stream 模块。
- **node:fs -> bun:File**：进行物理文件读取、写入和检查时，优先使用 Bun 运行时的原生 `bun:File`（如 `Bun.file()`）和 I/O 接口以获得最佳吞吐性能。
