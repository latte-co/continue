# Cursor Agent PR #34 评审修复（2026-11-19）

## 范围

- 基线：`917b6101023d73f34195ba56e95579ca5c27cedf`。
- 评审：[5970557554](https://github.com/latte-co/continue/pull/34#pullrequestreview-5970557554)。
- 继续使用 `feature/cursor-agent` worktree；用户授权修复后的提交和推送，不合并、不发布、不移除 worktree。

## 修复契约

| 评审问题 | 修复与回归 |
| --- | --- |
| 非 UTF-8 ENV 导致 Server panic | metadata/transport 共用实际子进程 ENV 脱敏算法；使用 `vars_os()`，以 OsString 合并 override/remove，最后才 lossy 转换。合成非 UTF-8 ENV 的最终 Server 启动测试。 |
| 保存模型下架后无法打开目录/历史会话 | catalog/Open 保留历史选择但容忍下架；实际发送仍校验当前目录。同 native session 从 cursor-test 改为 cursor-next 的最终二进制回归。 |
| 128 KiB 首条输入和明确 spawn 失败使会话不能重试 | 精确请求去重优先，Cursor 新输入在 queue/begin 前验证 UTF-8 字节及 NUL。仅精确 Command::spawn ENOENT/E2BIG 可写入请求绑定的「确定未执行」证据；旧记录默认 Unknown。旧 ID 只确认，不重放；已启动未 init、未知错误及证据写失败仍阻止 replacement。 |
| 无 result EOF 丢失 stderr | 先有界 wait/drain，再保留缺 result 事实、退出码与脱敏诊断。覆盖 init 前/后非零退出、exit 0、截断和 EOF 后挂起；缺 result 永远不能完成。 |
| 仅安装 agent 无法发现 | 依优先级核验安装目录/PATH 的 cursor-agent、agent 的 version/help 协议能力；显式 override 失败不回退。 |

独立复审又确认并补充了三类回归：候选串行探测超过 Host 连接预算、编辑后队列的原始 admission 被执行 ledger 遮盖，以及 CLI 离线时已接受请求无法确认。候选采用有界并行，全部收尾后按原优先级选择；version/help 共用读取 deadline。CursorQueued 在 CLI/config/model 检查前按 queue admission → requests ledger 精确确认，只对真正的新输入进行执行验证。

元数据准备和同步 spawn 在阻塞线程完成，避免候选互相阻塞异步 I/O/timer；普通 models/permissions 保持成功 spawn 后的 5 秒读取窗口。没有通过外层 timeout/drop 跳过已启动进程的清理。

## TDD 证据

- 初始功能 RED：下架模型 catalog、长输入提前拒绝、真实 ENOENT 跨 Store 重启重试，以及无 result 的脱敏诊断四个 UT 均失败；非 UTF-8 Server 启动和 agent 发现的最终二进制回归出现 3 个失败。
- 复审预算 RED：四个 help 挂起的候选串行耗时 20.66 秒，超过测试的 Host 连接预算。
- 复审身份 RED：编辑队列执行后重试原 payload、以及 CLI 缺失重启后确认原 admitted 请求，分别在最终二进制测试中真实失败。
- 中间测试参数编译错误与全量并行 UT 暴露的 deadline 起点问题不作为功能通过证据；最终结果另列。

## 最终验证

- 本轮 focused 验证已通过：344 个 Server UT；`cursor_` 最终二进制筛选 24 个通过（23 个 Cursor 场景及 1 个既有快照游标回归）。
- 独立静态复审已关闭原 5 条意见及新增预算/身份问题；生产文件指纹在会话恢复后与最终已审内容一致。
- 首次完整 `make ci` 和联合覆盖率因会话结束中断，不计为通过或覆盖率证据。恢复时确认并停止了遗留的隔离测试 daemon，未删除其数据或 worktree。
- 重跑的完整 `make ci` 退出码 0：格式、类型一致性、静态 CI/shell 检查、全 workspace Clippy、344 个 Server UT、103 文件/1,025 个前端测试、最终二进制 E2E 191 通过/1 个真实 SSH 用例按既定配置忽略、macOS 边界脚本与 35 个 Desktop Rust 测试、Web 构建和 Rust 文档均通过。
- 联合覆盖率命令 `cargo llvm-cov -p latte-work-server --bin latte-work-server --test e2e --locked --json --output-path target/cursor-review-coverage.json -- --test-threads=1` 退出码 0：344 UT 与 191 E2E 通过，1 个真实 SSH 用例忽略。Rust Server binary/E2E 插桩范围总体行覆盖率 **92.65%（29,181/31,497）**，不是全 workspace 或前端覆盖率。
- Cursor 三个源码文件的 JSON summary 合计 **98.98%（974/984）**；排除独立 tests.rs，但 metadata.rs 内仍含 UT，不能把这个值当作纯生产源码覆盖率。另用 `cargo llvm-cov report --lcov --output-path target/cursor-review-coverage.info` 导出唯一 DA 源码行，排除 metadata.rs 内联测试块和独立测试文件后，Cursor 生产源码为 **98.68%（673/682）**。两种统计口径不混用。
- transport 文件级行覆盖率 **97.31%（325/334）**；共用 ENV redaction 文件级 **100%（63/63）**。

## 收尾

- 验证及覆盖率导出结束后执行 `make clean`，移除 6.8 GiB 当前 worktree 的 Rust 产物；原始 JSON/LCOV 报告随 target 清理，统计摘要保留于本文。
- 原始开发 worktree 保留，不清理共享缓存、前端依赖或测试遗留数据；修复按用户授权提交并推送到原 PR，不合并、不发布。

## 验证边界

所有行为回归使用隔离的 CLI fixtures；不调用真实 Cursor 模型，不修改登录状态。真实账户两轮/取消恢复、原生桌面窗口与真实 Cursor SSH 场景没有独立实测。本轮不新增依赖或协议字段，不改变其他 Agent 的通用输入上限。
