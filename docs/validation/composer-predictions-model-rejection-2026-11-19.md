# 输入建议模型拒绝与非阻挡回收验证 — 2026-11-19

## 范围与修复

针对 PR #33 的 `16c0fb696e4fe6227d414b8876c70c64ddbb8e73`，在已有 `feature-composer-predictions` worktree 修复两处接收边界。没有新增依赖、MSRV、数据库 schema、wire 字段或 RPC，生产前端未修改。

1. 仅 Send 的 `resolve_native_model` 终止错误交给现有 `reject_send`。SendQueued 归一化后保持相同 Guard；只有唯一 known in-flight attempt 且同一锁下成功双 ledger 快照证明 ID 不存在，才返回 `send_not_admitted`。旧同 ID continuation、durable request、全部 queue 状态/tombstone 或核实失败仍保持 generic/unknown。不解析错误文案、不改变共享 resolver 的其他调用或模型验证规则。
2. 删除普通轮次在 Accepted 后等待 prediction 回收三秒并 terminal 的专属路径。仍 invalidate/cancel 旧 generation、abort/join observer；独立 owner 继续持有 child、permits 和 inventory 直到确认 cleanup。主 native Group 不占用辅助生成许可，所以不引入 prediction 准入门禁、queue defer、timer 或后台重试。

同配置下一轮、FIFO 和 explicit queued dispatch 不再因独立 prediction 慢回收失败。真正 native Close、配置替换、idle upgrade 和 daemon drain 的资源确认保持；取消 observer 不是 child reap，未知或已接收请求仍不能 replay。预测生成仍仅 Codex 启用，其余三个 Agent 使用默认提示。

## TDD：真实 RED 与最小 GREEN

所有 Rust 命令显式使用 checkout-local `CARGO_TARGET_DIR="$PWD/target"`，不调用真实 CLI 或付费模型。

### 模型拒绝

- RED：`cargo test -p latte-work-server --test e2e --locked prediction_admission_e2e::native_ -- --test-threads=1`，1 passed、2 failed。实际 resolver 返回 `request_failed`，符合证明条件的用例预期 `send_not_admitted`。
- RED：`cargo test -p latte-work-server --bin latte-work-server --locked send_admission_tests::native_model_rejection -- --test-threads=1`，1 passed、1 failed。唯一 Guard 与双 ledger absence 未升级为 typed rejection；保守负例通过。
- GREEN：`send_admission_tests::` 5 passed，`prediction_admission_e2e::` 10 passed，均零失败/ignored。

最终 binary/socket 测试执行 Send/SendQueued × missing model/native Medium effort 的四个拒绝组合，以及两种动态目录组合：先公布 `retired-codex`，实际 Send 前移除；读取日志证明 resolver 再次读到变更后的目录，不绕过缓存或校验。拒绝 ID 无 requests、queue、User/terminal 或 native prompt/thread 执行副作用；改有效模型、新 ID 后正常执行一次。已 admitted request、pending queue 和 cancelled tombstone 保持 generic。metadata initialize/model-list 不计作主消息执行。

中间 DB-failure 测试曾误要求原模型文案/typed `AdmissionUnknown`。核实 Guard 契约后改为 generic 与“无法核实消息准入状态”上下文，并保留到达 resolver 的读取日志证明；未为测试放宽生产代码。编译暂态 warning 与测试断言作者错误不计作业务 RED。

### 慢 prediction cleanup

- RED：`cargo test -p latte-work-server --bin latte-work-server --locked runtime::auxiliary_tests -- --nocapture`，4 passed、3 failed。普通 Send、FIFO 和 explicit Dispatch 均实际进入旧三秒回收 Failed 分支。
- 删除六行 wait/bail，并将失去唯一生产调用的 `wait_predictions` 标为 `#[cfg(test)]` 后，GREEN 7 passed、零失败/ignored。
- 其他 focused GREEN：`runtime::` 27、`agents::codex_jobs::tests` 12、`predictions::tests` 5、`message_queue::tests` 8，均零失败。

使用可工作的确定性 Codex fixture 与真实 owner/ReapGate，不使用缺失 executable 替代主执行。gate 未释放跨过原三秒阈值时，主消息收到 Start 并 Completed；同 ID 只去重，不再次输入；同配置 followup 保持相同 native PID。两个辅助 slots/库存保持到 gate release，随后确认 owner/PID 消失。title-only 的实际 Send 不等待或取消标题；有/无 actor Close 与 changed-config 的五秒资源确认门禁保持。RED 也先释放 gates、确认清理，再抛行为断言，防止污染全局容量。

### 前端回归

`npm test -w apps/desktop -- src/useWorkbench.test.tsx src/Composer.test.tsx`：241 passed（138 + 103），typecheck 与格式检查通过。

新增五项仅锁定既有正确行为：typed/generic/unknown 各自模型拒绝后改有效模型的新 ID、匹配 User/完成和后续建议对照；相同参数手动重试复用原 ID；Composer 返回 false 后保留正文，仅再次点击才重试。正文成功清理由 Conversation/DraftStore 所有者处理，不把受控组件测试冒充整体清除证明。初跑的测试断言错误修正后生产前端未改，故不称为前端实现 RED。

## 完整门禁状态

`make fmt`、文档 Prettier、`git diff --check` 通过。冻结版本执行 `CARGO_TARGET_DIR="$PWD/target" make ci`，完整退出码 **0**：

- 服务端 **329** 项单测；client **5** 项、config **14** 项、protocol **8** 项通过。
- 前端 **104** 文件、**1206** 项测试通过。
- 最终二进制 E2E **190** 项通过、零失败、**1** 项 ignored，耗时 **783.92 秒**。
- macOS 原生边界/桌面测试 **35** 项通过，WebKit/站点图标与 packaging-tool isolation 门禁通过。
- 格式、生成类型一致性、actionlint/ShellCheck、workspace Clippy（warnings denied）、Rust doc tests、前端 typecheck/Vite 和 Rustdoc 通过。

ignored 项为 `ssh_e2e::global_skills_over_real_ssh_are_isolated_reversible_and_reconnectable`，需要 `scripts/test-ssh-skills.py` 与隔离 OpenSSH daemon；本轮未使用配置中的 SSH 主机。Vite 保留产物块超过 500 kB 的非阻断提示，未做无关 code splitting。

CI 前后八个源码/测试文件的 manifest 一致。完成后核验 target 是当前 checkout 的普通目录、非 symlink/共享目录，且无其中运行中的程序，再执行 checkout-local `make clean`，清理 **19462** 个文件、**5.8 GiB** Rust 产物；worktree、修复、共享缓存和其他状态保留。

## 独立静态复查与绑定

按 `review-code-changes` 只读复查两组最终 delta，均 No actionable findings、限定 Coverage Complete/Approve；不执行被审代码，不把实施方 GREEN 当独立 execution。

- 基准 HEAD：`16c0fb696e4fe6227d414b8876c70c64ddbb8e73`。
- 两个前端测试文件 binary diff SHA-256：`f3a767fa8fa26610fb433f8b2aea382673001c780fdd68f205afd261990dd3d2`。
- 后端六文件与两份契约文档 binary diff SHA-256：`de417f3d5ed8dbd25792cc37ad323394dec3c14e4893646ba358e271e45e0418`。
- 八个源码/测试文件完整 content manifest SHA-256：`e42f9b66a67ad2dcfbf3e34906c4ea3774380fbec9bfa61076a0cf9b130f136f`；算法为按路径排序的 `sha256  path\n`，不含文档/产物。

推荐只覆盖上述未提交 delta，不批准完整 PR 或未来代码版本。本记录不改变已测产品代码。

## 验证限制与发布

未测量覆盖率，不以测试数量宣称 80%。没有真实模型、真实 Agent CLI、VoiceOver 或中文 IME/原生窗口验收；fixture/DOM 和原生边界单测分别记录，不互相冒充。强制 OS 退出/runtime 故障仍是 best effort，`child.wait()` 只确认直接 child，不证明任意 detached descendants 已停止。

本轮最初仅授权本地修复；完整门禁运行期间，用户明确要求 push，授权将本轮已验证修复提交并普通推送到原 PR 分支，使用 `liuhaoyang`。本记录完成时尚未执行该 commit/push、GitHub review 或 PR 修改；不 force push、不发布 review、不删除 worktree。远端 CI 与本地 CI 分别核对，不以本地通过推断远端结果。
