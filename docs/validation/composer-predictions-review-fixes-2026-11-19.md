# 输入建议评审修复验证 — 2026-11-19

## 范围

针对 PR #33 初版 `a18c646`，在现有 `feature/composer-predictions` worktree 修复四项评审反馈，不增加依赖、不迁移 Provider/API，也不修改实际组织配置。

- Claude 所有 Provider 模式停止后台建议，正常任务、原生标题、侧聊及托管 Hooks 保留。
- History/Events 携带可选内存快照，前端不再发送独立建议查询；缓存争用/poison 仅省略字段，真实 transport failure 仍断线。
- durable User 插入时捕获来源 event seq，支持首屏没有 User 的截断历史；前端按来源及 request-start epoch 拒绝旧快照。
- Codex 标题和建议共享两个执行许可；标题容量八个（包含等待、执行及清理），FIFO 等待最多 150 秒，执行仍为 30 秒；预测只 try-acquire。队列溢出/超时不回退 once marker 或重试。

Claude 的隔离结论依据官方 [Hooks 文档](https://code.claude.com/docs/en/hooks#disable-or-remove-hooks) 和 [CLI reference](https://code.claude.com/docs/en/cli-reference)：用户级 `disableAllHooks` 和 `--safe-mode` 不会禁用 managed Hooks。初版 `tools=[]` smoke 不能证明此边界，历史验证记录已添加纠正说明。

## TDD 与定向结果

先运行失败测试，再实施最小修复。已确认的有效 RED 包括：Claude App Provider 仍返回 Ready；合成托管 Hook 收到第二次后台 transcript 输入；预测满载使旧标题请求立即失败；主历史没有建议快照；源码缺少来源 admission/cache projection 接口。

已通过的定向验证：

- 协议 History/Events 快照与缺字段/null 往返测试。
- 来源 admission 序号与 duplicate 不重放测试。
- prediction cache 单测 5 项，包括局部 Mutex 争用和 poison 时立即省略。
- 最终二进制长历史测试：添加超过初始窗口的事件，首屏无 User，History 和后续空 Events 仍携带正确来源 seq 与同一 generation。
- Codex 标题单测 8 项，包含显式 poll Pending 的 FIFO/容量/取消/超时测试；标题 E2E 13 项全部通过，包含预测满载时完成命名和排队中取消。
- 正常 Claude adapter 单测 48 项；原生标题、侧聊、权限/恢复定向 E2E 各 1 项通过。

- 前端完整测试：104 个文件、1128 项通过；typecheck 和定向格式检查通过。Workbench 90 项、来源 helper 28 项，保留 Composer 的严格空草稿与 Tab/Escape 回归。
- 追加 RED/GREEN 覆盖发送中消费 User、同 Server 重连、权威 Cancel/Take 的 provisional 退休、同 ID 新 Send token、旧 Server 回调、五种发布门禁，以及旧 Send epoch 同连接帧和自动/手动早期补页。User 事实与快照发布分开鉴权，不将旧 epoch 失败断言改成接受旧建议。

最终 `make fmt && make ci` 在上述冻结代码完成，退出码 **0**：格式、生成类型一致性、actionlint／ShellCheck、workspace Clippy（warnings denied）、Rust unit／最终二进制 E2E／doc／native tests、前端 typecheck／测试／Vite 和 Rustdoc 均通过。

- 服务端单测 **296** 项通过；协议单测 **8** 项通过。
- 前端 **104** 文件、**1128** 项通过。
- 最终二进制 E2E **178** 项通过、0 失败、**1** 项 ignored，总耗时 1385.40 秒。跳过 `ssh_e2e::global_skills_over_real_ssh_are_isolated_reversible_and_reconnectable`，需要 `scripts/test-ssh-skills.py` 和隔离 OpenSSH daemon。
- macOS 原生单元／边界测试 **35** 项通过；不等同于本功能真实窗口验证。
- Vite 保留产物块大于 500 kB 的非阻断提示；本轮不做无关的 code splitting。

最终测试后复核前后端代码指纹与静态审查绑定值一致。核验 `target/` 是本 worktree 内的普通目录、非 symlink／共享 target 后，以显式 checkout-local `CARGO_TARGET_DIR` 执行 `make clean`，删除 23414 个文件、6.2 GiB Rust 产物。worktree 和未提交修复保留，未删除共享缓存或其他本地状态。

## 整合过程

首次 `make fmt && make ci` 在 Clippy 阶段失败：新增 fixture 的 `auth` moved-value 编译错误，以及删除尾部辅助实现后暴露的 `items_after_test_module`。修正使用预计算认证标记，并将保留的 `provider_settings` 移到测试模块之前，不降低 lint 门槛。

## 静态复查

按 `review-code-changes` 对本轮未提交 delta 独立进行后端及前端只读复查。后端与前端最终冻结范围均无剩余 actionable finding；发送、重连、队列退休和旧 epoch／早期页来源事实的追加问题均已修复并复核。审查不执行被审代码，不把实施方测试结果当作独立运行证明。

- 后端 tracked diff SHA-256（`git diff --binary HEAD -- crates`）：`3d89ef4ea4a4c6cfcf1c05160ceb8689973f302ca826c58c43c9cb08d11784d3`。
- 前端 tracked diff SHA-256（`git diff --binary HEAD -- apps/desktop/src`）：`9d6ad753d0713cc86cbe0b77d8163c2100ef463fbb6d25b72e42dea7e8d8cb16`。
- 前端十个实施文件按路径排序的 SHA-256 manifest 聚合：`19aad8e03491ffc94ff852ed2c9a85f6f33600249bfcdf7df069933abe689c9c`。

这些结论仅绑定上述本轮冻结代码，不代表后续修改、真实 Agent CLI／Tauri 或远端 PR Gate 的批准。

## 验证边界

- 使用合成 managed Hook 和确定性 CLI fixture，不读取真实托管配置或凭据。
- 未执行真实付费模型、真实 Tauri 窗口、中文 IME 实机或配置中的 SSH 主机验证。
- 未测量覆盖率百分比，不以测试数量声称达到覆盖率门槛。
- 未重跑远端 GitHub PR Gate，不能将本地结果作为远端检查通过的证据。
- 本轮尚未提交或推送修复，未发布 GitHub 评审。
