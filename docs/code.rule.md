# TypeScript / Bun Coding Guidelines

> [简体中文](./code.rule.zh-Hans.md)

## Forced Coding Standards & Alternatives

- **Date -> Temporal**: Do not use the native JavaScript `Date` constructor. All date, time, and timezone operations must utilize the `Temporal` API.
  > **Why**: The native `Date` object has legacy API flaws, inconsistent timezone behaviors, and side effects. The `Temporal` API is a modern standard proposed by TC39 that handles dates, times, and timezones safely and reliably.
- **node:stream -> Web API stream**: Use standard Web API streams instead of Node.js stream modules when processing file uploads, downloads, or buffer piping.
- **node:fs -> bun:File**: Use the native `bun:File` APIs (such as `Bun.file()`) and Bun's built-in file system utilities for optimized file reading/writing performance.