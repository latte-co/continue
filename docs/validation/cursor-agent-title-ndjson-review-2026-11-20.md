# PR #34：Codex 标题测试 NDJSON 修复（2026-11-20）

## 范围与根因

基线为 `bd07921cab2e9293a825d610377411342c602c1a`，继续既有 `.oh-my-code/worktree/continue/feature-cursor-agent` 和 [PR #34](https://github.com/latte-co/continue/pull/34)。遵循修复验证后普通提交、推送的持续授权，不强推、不合并 PR、不删除 worktree。

[Linux E2E 日志](https://github.com/latte-co/continue/actions/runs/44573005833/job/135732889716) 确认 `codex_queued_title_manual_rename_and_close_cancel_without_retry` 在旧 `titles.rs:558` 报 `trailing characters`，位置为第 2 行。该轮远端 E2E 为 219 通过、1 失败、1 忽略，不能记为通过。

首轮 `native-auto-title` 也可能生成预测，后续 `prediction-held` 向同一 `prediction-inputs` 文件追加记录。fixture 的记录格式是 NDJSON，整文件 `serde_json::from_str` 不符合多记录格式；此前本机门禁通过不代表排除了此调度分支。

本轮仅修改测试：

- 新增私有 `tests/support/title_prediction_records.rs`，逐行解析全部记录，按 `description` 的完整 User 段精确匹配 `prediction-held`，返回对应 PID。
- 不取首条/末条，不依赖宽泛 substring，不把 assistant reply 中的文本当成用户提示；目标前后坏 JSON 均报错，重复目标明确报错，PID 使用 checked 转换。
- fixture 在关闭目标记录文件后才写 `prediction-active`；保留原 active 等待顺序，不增加 sleep、期限或额外模型输入。
- `titles.rs` 仅挂载私有模块并替换解析调用。原标题等待、取消、release、`gone(pid)` 与无重试断言均保留。
- 产品代码、fixture、依赖、协议和 CI 配置均未改动。

## RED / GREEN

- 新增确定性多行回归，目标记录位于中间，并包含相似提示与仅 reply 含同名文本的干扰记录。保留旧整文件解析时真实 RED：`trailing characters at line 2 column 1`，0 通过/1 失败；不是 compiler 错误，也不依赖本机恰好产生首轮预测。
- 修复后 3 个解析回归通过，覆盖精确选取、相似提示排除、目标前后坏行；重复目标拒绝另经静态核验，没有宣称所有错误分支均已测试。
- 原失败的标题取消 E2E、共享 helper 的标题等待 E2E 均通过，原断言未修改。
- 新 helper 与回归随后机械移入 75 行私有模块，避免继续扩大旧文件。迁移后重新通过 3 个解析回归及两个标题 E2E；独立复审在内存拼回旧布局后精确复得旧 hash，确认无隐藏逻辑变化。
- 曾主动停止旧布局上的本地门禁；该轮 E2E 未完成，不计为整轮通过。最终布局另行完整重跑。

## 最终验证

冻结后的实际执行结果：

- 完整 `make ci` **退出码 0**：格式、协议类型同步、CI/shell 静态检查、全 workspace Clippy、Rust UT、前端 typecheck/tests/build、最终二进制测试、macOS 边界检查和 Rust 文档通过。
- Server UT **423 通过**；前端 **104 文件/1,234 测试通过**；Desktop Rust **35 通过**。
- E2E target **223 通过、1 个既定真实 SSH 用例忽略**，其中包含本轮新增的 3 个纯解析测试；不把这 3 个测试冒充 native 进程运行。
- 原 `codex_queued_title_manual_rename_and_close_cancel_without_retry` 与 `codex_title_waits_for_held_predictions_then_generates_exactly_once` 在最终全量运行中再次通过。

覆盖率仅测新增测试辅助模块：

```sh
CARGO_TARGET_DIR="$PWD/target/title-ndjson-coverage" cargo llvm-cov -p latte-work-server --test e2e --locked --json --output-path target/title-ndjson-coverage.json -- titles_e2e::prediction_records:: --test-threads=1
```

该命令退出码 0，3 个插桩解析测试通过。当前 `cargo llvm-cov` 的默认报告过滤 `tests/`，不能从该报告声称新模块覆盖率。通过 verbose 核实实际过滤规则后，使用同一工具链的 `llvm-cov export`，读取同一插桩 E2E 对象及合并后的 profdata，仅选择新模块源码，得到文件级行覆盖率 **100%（64/64）**。

该数字包含模块内 3 个测试，不是 Server/全 workspace 覆盖率，也不表示所有 branch 均覆盖。本轮产品源码未变，未重新测量总体生产覆盖率；此前总体统计仍仅属于 `bd07921` 的验收记录。

## 复审、绑定与收尾

独立 `review-code-changes` 复审完整覆盖两文件 delta，结论 Fixed / NoActionable；确认私有模块挂载、机械迁移、精确匹配、全行解析、PID 转换、fixture 写入顺序及原等待/取消断言保留。仅测试变化，未发现新的产品安全影响。静态复审不算执行验证或 GitHub approval。

最终首尾 SHA-256：

- `crates/latte-work-server/tests/support/titles.rs`：`b6ecaf35ac6dc81260eca3443b0f228be38beccb31e6ebc4a3d2fe503a66b326`。
- `crates/latte-work-server/tests/support/title_prediction_records.rs`：`c234d0e89ff781ad42abf3be30d172f4c92238c40eb9fe47736d1b2edf943678`。
- 添加本文前，按排序后的 `relative-path SHA-256` 聚合，两测试文件 manifest：`70c18f790ee4b12276844fdc18856e95ad6cdb4b2483e39dd1dc89b8ad21a47e`。完整门禁、插桩与清理后未漂移。

所有构建和覆盖率导出结束后执行 `make clean`，Cargo 报告清理 **5.8 GiB**，确认本 worktree `target` 不再存在。原始报告随 target 清理，摘要保留于本文；未删除 worktree、共享缓存、前端依赖或测试数据。

本轮执行平台为 macOS，未独立复跑 Linux CI、真实 Codex 账户/模型或原生桌面窗口。远端新 head 的 `PR Gate` 仍须由 GitHub CI 验证，本文不宣称它已通过。
