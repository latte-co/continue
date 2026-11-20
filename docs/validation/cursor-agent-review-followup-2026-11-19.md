# Cursor Agent PR #34 二轮复审修复（2026-11-19）

## 范围

- 基线：`5aaf6b7eab34a6aff4489dbcd8e6bb9e266cb3c0`；继续使用原 `feature/cursor-agent` worktree 和 [PR #34](https://github.com/latte-co/continue/pull/34)。
- 用户授权修复后提交、正常推送；不合并、不同步 main、不发布评审回复、不移除 worktree。
- 本文只记录本轮结果；上一轮验证见 `cursor-agent-review-2026-11-19.md`，其并行候选方案已由本轮真实回退替代。

## 修复契约

1. `EditQueuedMessage` 在保存 Cursor 正文前复用 `validate_prompt`：拒绝正好 128 KiB、UTF-8 字节超限及 NUL；失败不改变正文、revision 或 FIFO。`None` 取消与其他 Agent 的通用上限不变；执行前校验仍保留以处理旧记录。
2. discovery 按 Host-effective PATH 和实际 discovery cwd 一次解析候选为绝对路径，核验成功后保留同一路径。模型/权限 metadata、发送前选择校验和 native turn 均使用该路径；会话 PATH 仍给 CLI 依赖使用，不再重新选择同名程序。裸显式 override 按 Host PATH 解析，含 slash 的相对路径绑定 discovery cwd；显式 override 失败不回退。
3. 首选兼容时立即停止，不执行低优先级 `agent`。候选/version/help 共用 discovery deadline，失败探测确认 owned group 回收后才尝试回退；清理未确认即停止。普通 models/permissions 保留成功 spawn 后的五秒读取窗口。不通过外层 timeout/drop 跳过清理；同步路径检查和 spawn 的等待不承诺严格 wall-clock 硬上限。

绝对路径绑定不等于程序文件不可替换或脚本内部依赖已验证。普通 symlink 允许；无法表示为现有 UTF-8 binary 合约的首个可执行路径 fail closed，不偷偷选择后续程序。

## TDD 与中间结果

- 非法队列编辑最终二进制回归真实 RED：`invalid Cursor edit must reject before saving`。
- configured PATH shadow 最终二进制回归真实 RED：`unverified same-name agent received metadata or prompt`；测试同时覆盖发送前 models probe 与提示词轮次。
- 首选兼容的惰性回退单测真实 RED：`a compatible preferred CLI must prevent executing the generic fallback`。
- 首次集中 Cursor UT 为 41 通过/1 失败：macOS 拒绝测试创建非 UTF-8 目录（`Illegal byte sequence`），未触达产品断言。改为纯 predicate seam，生产仍使用真实权限检查，保留不可表示首选不得继续选择后续 CLI 的断言。
- 首次全量默认并行 UT 在与覆盖率首次编译并发时为 345 通过/5 个 discovery 失败；该次不计通过。日志只证明部分探测未在总预算内完成，不能定位为首次准备或后续排队。未放宽 deadline、未串行化默认单测、未跳过断言；相同源码重跑默认并行 350 UT 全部通过，随后完整 `make ci` 的 350 UT 也全部通过。

## 验证结果

- `cargo test -p latte-work-server --test e2e cursor_ --locked -- --test-threads=1`：26 通过，0 失败；包括 25 个 Cursor 场景与 1 个既有快照游标回归。
- `cargo test -p latte-work-server --bin latte-work-server --locked`：350 通过，0 失败（默认并行）。
- 独立静态复审完整覆盖本轮八个源代码/测试/契约文件，原两条 P2 均判 fixed，无 actionable findings。生产与测试内容绑定到最终 predicate seam；不代表 GitHub approval，也不以静态复审替代运行结果。
- 完整 `make ci` 退出码 0：格式、协议类型一致性、CI/shell 静态检查、全 workspace Clippy、350 个 Server UT、103 文件/1,025 个前端测试、最终二进制 E2E 193 通过/1 个真实 SSH 用例按既定配置忽略、macOS 边界脚本及 35 个 Desktop Rust 测试、Web 构建与 Rust 文档均通过。
- 联合覆盖率命令 `cargo llvm-cov -p latte-work-server --bin latte-work-server --test e2e --locked --json --output-path target/cursor-review-followup-coverage.json -- --test-threads=1` 退出码 0：350 UT、193 E2E 通过，1 个真实 SSH 用例忽略。Rust Server binary/E2E 插桩范围总体行覆盖率 **92.66%（29,364/31,690）**，不是全 workspace 或前端覆盖率。
- 四个 Cursor 源码文件 JSON summary 合计 **98.38%（1,153/1,172）**，其中 metadata/executable 的内联 UT 也计入，不能当作纯生产覆盖率。用 `cargo llvm-cov report --lcov --output-path target/cursor-review-followup-coverage.info` 导出唯一 DA 源码行，排除内联测试块与独立测试文件后，Cursor 生产源码为 **97.76%（742/759）**；新增 executable 的生产行 **100%（33/33）**。统计口径不混用。
- transport 文件级行覆盖率 **97.31%（325/334）**；ENV redaction 文件级 **100%（63/63）**。

## 收尾

- 所有构建与覆盖率导出结束后，重新通过 `make fmt-check` 和 `git diff --check`；tracked patch 与最终 executable 的 SHA-256 均与独立复审绑定一致。
- 执行 `make clean`，移除当前 worktree 的 6.5 GiB Rust 产物；原始 JSON/LCOV 随 target 清理，统计摘要保留于本文。未删除 worktree、共享缓存、前端依赖或测试数据。

## 验证边界

行为回归仅运行隔离 CLI fixtures，不调用真实 Cursor 模型、不修改登录状态。真实账户多轮/取消恢复、原生桌面窗口、真实 Cursor SSH 未独立实测；既有真实 SSH 用例是否运行另按门禁实际结果报告。不新增依赖或公共协议字段，不改变其他 Agent 的通用输入上限。保留 worktree、前端依赖、共享缓存及测试数据；全部构建任务结束后仅用 `make clean` 清理当前 worktree Rust 产物。
