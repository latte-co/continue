# 输入建议准入与回收评审修复验证 — 2026-11-19

## 范围

针对 PR #33 的 `81e5239903624fbe7728525df2022549987cb541`，在已有 `feature-composer-predictions` worktree 修复发送来源屏障、辅助进程回收与可访问描述。本记录不沿用初版或前轮 CI 作为本轮验证证据。

仅 Codex 启用后台建议；Claude 全 Provider 模式、Traex 和 OpenCode 保留默认提示。未增加依赖、修改 MSRV、数据库 schema、wire 字段或新增 RPC；未读取真实组织配置或调用付费模型。

## 修复契约

- `send_not_admitted` 使用内部 typed error，经 actor oneshot 保留类型。只有当前 Guard 是同数据库／request ID 唯一在途 attempt，且同锁下成功 SQLite snapshot 证明 requests 与全部状态的 message_queue 均不存在该 ID，才返回该代码。已接收身份／Provider 冲突、DB 错误、transport timeout 与仍有旧 continuation 的结果保持 generic／unknown。
- 最多 2048 个在途 Guard，以数据库实例与固定 32 字节 request-ID SHA-256 摘要关联，不复制任意长 ID。Guard 从 Send 解码后、lifecycle/file admission gate 前持有，经 Submission 移交 Control/actor；sender 超时不能销毁旧 continuation 的 Guard。该证明不排除未来新请求或尚未接收的字节。
- 前端保留最多 128 个未解身份的平面 ID/token 记录。新 Send 的拒绝不能删除此前未知或已观察的事实；matching User／handoff 可逐项核实。权威 Queue Cancel/Take 与本次 Send 拒绝使用不同退休依据，均保留 scope/token 保护。
- `QueuedMessageSent` 只是持久交接时序，不是 User、native success 或 consumed。同 ID 经 native 拒绝、revision 增加后可合法再次 handoff；有效 handoff 的最大序号只加强阻挡 fence，非 matching receipt 不能解除其他未知输入。更晚事实独立撤下不再满足条件的已显示建议，不依赖本帧 snapshot 是否可发布。
- Codex owner 在 observer spawn 前同步注册，持有 child 与许可。observer abort／Drop／等待超时只请求取消；推理 timer 不销毁 cleanup。保留 2 个执行许可、8 个标题全生命周期容量、实际 Semaphore poll FIFO、150 秒等待和 30 秒执行期限，prediction 只 try-acquire。
- group signal 已确认后，wait 失败只重试 wait；child 已 reap 但 group signal 未确认时保留 owner／许可，不向保存的旧 PGID 重发信号。inventory 删除与许可归还处于同一临界区。
- Close 合并 native 与 auxiliary 确认；先向 native 发 TERM，再在第一次 native reap 前等待 auxiliary，共用绝对 deadline，避免新增 post-reap 异步等待扩大旧 PID 复用窗口。不重写其他 Group/probe 路径。
- daemon 停止新 admission、请求 cancel 并等待 owner drain；不能以固定 sleep 或 runtime teardown 冒充回收。注册中的辅助资源参与 idle-upgrade veto。
- textarea 的 accessible description 关联完整建议与「Tab 插入」，ID 唯一；正文仍不写入 value，不启用 Send、不新增 live announcement，接受／Escape／blocked 后不残留过期描述。

## TDD 与定向验证

先运行真实失败回归，再修复实现。有效 RED 包括：明确拒绝仍留下等待、H55 更新后旧 D50 仍可接受、三 unknown 全部确认后仍 sticky blocked、较早身份再次 handoff 被漏掉、unknown 的权威 Cancel/Take 无法退休，以及旧同 ID Control 在 sender 超时后仍可能准入却被第二次拒绝误判为确定未准入。

PGID 回归也先失败：group signal 成功但 wait 失败时重发旧数值，以及 group signal 失败但 direct reap 成功后错误释放许可。另用真实子进程确认原生 reap 后才等待 auxiliary 的旧顺序失败，调整后通过。库存临界区的小修使用既有容量/FIFO回归验证，未宣称新增独立 RED。

核实服务端后纠正了测试假设：H40/H45 是合法多次 handoff，不应永久标为 conflict；H45 不必撤下 D50，H55 必须撤下。早期页有效 handoff 可纯阻挡，但无关 User 仍不能推进 live frontier。未将失败功能期望改成接受旧建议。

定向 GREEN：

- Composer 全文件 102 项；来源 helper 与 Workbench 合计 180 项。
- Codex owner 12 项，以及 3 项慢回收/准入/关闭集成回归。
- Guard/admission 定向 15 项、原 runtime 19 项；完整门禁另验证全部服务端单测。
- 真实 socket 准入/steering 7 项、既有 Codex E2E 6 项。
- 两项关闭 E2E 加强为成功回执后立即检查辅助 PID 为 ESRCH，不再容忍回执后五秒延迟回收。

steering 使用确定性 CLI fixture 的真实 ack 与 release marker：ack＋receipt 时仍为 forwarded；同 turn completion 后为 dispatched；明确拒绝恢复 pending＋revision；daemon SIGKILL/restart 后保留 uncertain／Unknown、不重放，无新 User。这不是 seeded 状态替代 native handoff 的证明。

## 完整门禁

冻结代码执行 `make fmt && make ci`，显式使用 checkout-local `CARGO_TARGET_DIR`，退出码 **0**：

- 前端 **104** 文件、**1201** 项通过。
- 服务端单测 **323** 项；protocol **8** 项、client **5** 项、config **14** 项通过。
- 最终二进制 E2E **187** 项通过、0 失败、**1** 项 ignored，耗时 **755.24 秒**。
- macOS 原生单元/边界测试 **35** 项通过；WebKit 边界与 packaging-tool isolation 脚本通过。
- 格式、生成类型一致性、actionlint/ShellCheck、workspace Clippy（warnings denied）、Rust doc tests、前端 typecheck/Vite 与 Rustdoc 通过。
- Vite 保留产物块超过 500 kB 的非阻断提示；未进行无关 code splitting。

ignored 项为 `ssh_e2e::global_skills_over_real_ssh_are_isolated_reversible_and_reconnectable`，需要 `scripts/test-ssh-skills.py` 和隔离 OpenSSH daemon。本轮未使用用户配置中的 SSH 主机。

## 独立静态复查与冻结绑定

按 `review-code-changes` 独立复查最终 delta，前述准入、重复 handoff、unknown 退休、库存与 PID 等待顺序问题均已修复并重审；最终前后端限定范围无 actionable findings。审查只读，不执行被审代码，不将实施方 GREEN 当作独立运行证据。

- HEAD/base 保持 `81e5239903624fbe7728525df2022549987cb541`。
- 六个前端文件 binary diff SHA-256：`0742a5c531047fb24e1588b9d1cc6dd1b212fb8978b06d892867963adf6757ab`。
- tracked 后端 binary diff SHA-256：`6ae8da0d32d85153c09d897ba982d8f3d82f35fd667a2e6c9492446b4b375601`。
- 审查方后端 17 文件＋两份契约文档 manifest：`98fe28d02d65dd289e4aebbbef3bb79f1aafc3eab907b5fb71a8ba9f9985fda0`。
- 协调方 23 个产品源码/测试文件（含全部五个 untracked Rust 文件）的完整 content manifest SHA-256：`5104d74a69841b7fa97323630517192607ee54c3f96cfb276b834984168d5838`。算法为按路径排序的 `sha256  path\n`，不含文档或生成产物。

CI 前后上述代码指纹一致。后续仅新增本记录，不改变已测产品代码；静态推荐不覆盖未来版本。

## 验证与容量边界

- 未测量覆盖率百分比，不以测试数量宣称满足 80% 门槛。
- 未运行真实付费模型、真实 Agent CLI、本功能原生 Tauri 窗口、VoiceOver 或中文 IME 实机验证；DOM 与原生边界单测不冒充这些结果。
- 超过 128 个不同未解身份时，预测相关性保守退回默认提示，不阻塞普通 Send；不宣称容量外全部 matching facts 到齐后仍可自动恢复。
- `child.wait()` 确认直接 child reap，不证明任意 detached descendants 已退出。group signal 未确认时保持 unknown，不对已回收 PID 盲目重试。
- forced OS termination、runtime crash 或断电仅 best effort，不属于 graceful confirmed cleanup；未知输入不会自动 replay。
- 未运行远端 PR Gate，不以本地 CI 推断 GitHub branch protection 或远端检查状态。

## 清理与发布状态

CI 后核验 target 是本 worktree 的普通目录、非 symlink/共享 target，且无执行中的 checkout-target 程序；显式 checkout-local `CARGO_TARGET_DIR` 执行 `make clean`，删除 **22599** 个文件、**7.0 GiB** Rust 产物。worktree、源码、npm/Cargo/sccache 共享缓存及其他本地状态保留。

验证收尾时，已按本轮批准范围，用 `liuhaoyang` 仅更正 PR #33 描述的「仅 Codex 启用」能力边界，并保留其他内容，PR 代码 head 未改变；当时修复尚未提交或推送，未发布 GitHub review。随后用户明确要求 push，授权将已验证修复提交并以普通 fast-forward push 更新原分支；上次 force-with-lease 批准不用于本轮推送。
