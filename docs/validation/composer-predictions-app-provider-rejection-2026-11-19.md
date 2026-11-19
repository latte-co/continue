# App Provider 旧模型拒绝验证 — 2026-11-19

## 范围

针对 PR #33 的 `b7f31714d7222fa0261c1853fe1429f3a0b83634`，补齐 App Provider 发送前拒绝的错误分类。沿用 `feature-composer-predictions` worktree；没有新增依赖、MSRV、schema、wire 字段或 RPC，生产前端、共享 ProviderStore、native resolver、prediction cancellation 和真实 Close 均未修改。

## 最小修复

仅 Send 调用点把 `turn_config` 的 Result 放在命名 Provider MutexGuard 的独立 block 中；block 结束释放 Provider 锁后，才执行 `map_err(reject_send)`。因此不会为准入证明新增 Provider → admission → DB 嵌套锁；`.lock()` 自身失败保留既有保守错误。

SendQueued 归一化时保留同一 Guard。只有当前唯一 known in-flight attempt，且同一 admission 锁下成功 SQLite snapshot 证明 requests 和全部 message_queue 状态均无该 ID，才能返回 `send_not_admitted`。旧同 ID continuation、durable ID、pending/cancelled tombstone 和 DB 核实失败仍不能升级为确定未准入。不解析错误文案、不改前端对 generic/unknown 的退休规则或自动重放策略。

## TDD 与定向验证

真实 App-owned Provider snapshot 最初包含 `retired-codex`，随后最新配置移除该模型。请求继续携带旧选择和最新 snapshot，模拟客户端缓存选择与配置不一致。

- RED：实际返回 `request_failed`，预期 `send_not_admitted`。失败前确认该请求的 requests/queue/User 为 **(0,0,0)**，事件/队列为空，native 和辅助 prompt 记录均为 **0**。
- 两个新 Guard/DB-failure 单测同样取得业务 RED；不是编译失败或缺失 executable。
- 最小修复后 App Provider socket 回归 **2/2**、`send_admission_tests` **7/7**、既有 native admission **3/3**、capability-removal **1/1**，合计 **13 个不同测试通过**。
- Send/SendQueued 均覆盖；有效模型使用新 ID 后完成一次，duplicate 不重复执行。已入库请求、pending/cancelled 队列身份、旧 Guard 和 DB 失败保守负例通过。
- server focused Clippy（warnings denied）、rustfmt、`git diff --check` 通过。所有 Cargo 命令显式使用 checkout-local `CARGO_TARGET_DIR="$PWD/target"`。

回归复用固定 CLI fixture、临时配置和虚拟 credential，不调用真实模型。socket 测试模拟旧缓存选择，不实际驱动桌面 UI 刷新失败；现有前端缓存和 typed/generic 处理由静态上下文核验及全套前端测试验证，不能将其称为真实窗口验收。

为保持小模块，将新增 313 行测试放入 `tests/support/app_provider_admission.rs`，父 `codex.rs` 仅三行 `#[path]` 注册并复用原 helper；不修改 `e2e.rs` 或继续膨胀已有 800 行 admission 模块。

## 独立静态复查

按 `review-code-changes` 完整只读复查 `main.rs`、`codex.rs`、新增测试模块和 `DEVELOPMENT.md` 四文件 delta 及必要上下文，结论 **No actionable findings / Coverage Complete / Approve**，只绑定本轮未提交内容，不批准整个 PR 或未来版本。

审查未执行被审代码、测试、build 或 hooks，未联网或访问真实 credentials。实施方 GREEN 不是独立 execution 证据。

- 基准 HEAD：`b7f31714d7222fa0261c1853fe1429f3a0b83634`。
- 三个源码/测试文件按路径排序的 `sha256  path\n` content manifest：`7be13e25097fe95c4313f1a82ce34c884fcdf6b3c38890c60cc7a3fb74077cf8`。
- `main.rs`：`b6f706b5da10fdbe56878a9be0ac228726fc5c78205d5c355cf26fa0ad156b27`。
- `codex.rs`：`6ab96f5239cdfd29b7d72c80fa6dbc27e692911da68116733654351542d74d16`。
- `app_provider_admission.rs`：`d2b4e9443b73ba5484150f193c9638088551d62b3cd6d4f08cf70b49827bb6a7`。
- `DEVELOPMENT.md`：`6bd538849916fb311a90d45f5beed5a977970c7ed94b79194064c8b4c3d79bcf`。

## 完整门禁与交付状态

`make fmt`、文档 Prettier、`git diff --check` 通过。冻结源码执行 `CARGO_TARGET_DIR="$PWD/target" make ci`，完整退出码 **0**：

- 服务端 **331** 项单测；client **5** 项、config **14** 项、protocol **8** 项通过。
- 前端 **104** 文件、**1206** 项测试通过。
- 最终二进制 E2E **192** 项通过、零失败、**1** 项 ignored，耗时 **794.84 秒**。
- macOS 原生边界/桌面测试 **35** 项通过，WebKit/站点图标和 packaging-tool isolation 门禁通过。
- 格式、生成类型一致性、actionlint/ShellCheck、workspace Clippy（warnings denied）、Rust doc tests、前端 typecheck/Vite 和 Rustdoc 通过。

ignored 项为 `ssh_e2e::global_skills_over_real_ssh_are_isolated_reversible_and_reconnectable`，需要 `scripts/test-ssh-skills.py` 与隔离 OpenSSH daemon；本轮未操作配置中的 SSH 主机。Vite 保留产物块超过 500 kB 的非阻断提示，未进行无关 code splitting。

CI 前后三个源码/测试文件的 manifest 一致。门禁完成后核验 target 为当前 checkout 普通目录、非 symlink/共享目录，且无其中运行中的程序，再执行 checkout-local `make clean`，清理 **17467** 个文件、**5.3 GiB** Rust 产物，保留共享缓存和其他本地状态。

验证完成时本轮尚未提交或推送。用户随后明确要求「修复了就 push 到远程」，持续授权已验证修复自动提交并普通推送到对应分支；本轮按该授权更新原 PR 分支，不强推、不合并、不发布 review 或删除 worktree。本记录不改变已测产品代码，不将本地 CI 通过推断为远端 PR CI 通过。

未测量覆盖率，不宣称 80%。未进行真实模型、VoiceOver、中文 IME 或本功能原生窗口验收；fixture/DOM 与原生边界测试分别记录。
