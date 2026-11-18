# 输入框智能建议验证 — 2026-11-18

## 目标与能力边界

- 空输入框显示非编辑的多行灰色建议，Tab 仅插入草稿，发送仍是独立动作。
- 四个 Agent 共用输入交互；生成能力按适配器可验证的边界启用，不创建持久辅助会话。
- Codex 复用临时 structured request；Claude 采用可固定 App Provider 的独立请求。
- Claude 纯 CLI、Traex、OpenCode 或旧主机缺少已验证生成能力时保持默认提示。

## 已执行的前端验证

在 `feature/composer-predictions` worktree 执行：

- `make setup`：通过，使用锁定依赖，未增加依赖。
- `make types`：通过，包含 `ComposerPredictionStatus` 的生成声明。
- 最终 `make ci` 中的前端测试：103 个测试文件、1055 项测试全部通过。
- `npm run web-build`：TypeScript 和 Vite 生产构建通过；Vite 仍提示产物块超过 500 kB，此提示不阻断构建。

新增验证覆盖 Tab 不发送、光标恢复、严格空正文、空注释组件、附件／引用、IME、菜单、修饰键、Escape、跨会话去重、迟到响应和 pending 查询边界。多行建议使用独立展示层，不加入真实输入 value 或启用发送按钮。

## 原生能力证据与限制

Claude Code 2.1.302 的 help 包含 `--prompt-suggestions`。该选项配合无真实凭据的 localhost 模型 fixture 探测未产出可关联的 `prompt_suggestion` 事件，因此生产实现不因选项存在就猜测事件来源，也不声称原生建议事件已经接入。

独立生成路径另通过真实 CLI 与最终 server binary 的 localhost fixture smoke：

- Claude Code **2.1.302**：建议状态 ready，唯一建议辅助请求，`tools=[]`，来源模型 `claude-sonnet-4-6` 与显式 `effort=high` 沿用。
- Codex **0.170.0**：建议状态 ready，唯一建议辅助请求，`tools=[]`，来源模型 `custom-codex` 沿用；未选 effort 时保持 null。
- 两者都关联正确的 `source_request_id`；辅助上下文不含项目私有标记或 fixture 凭据，主事件未出现建议正文。第一轮总模型请求为普通主请求、既有标题请求、建议请求各一次。

这些是真实 CLI 的协议／隔离测试，模型回复仍由本机 fixture 提供，不是付费模型的质量评估。

真实 server 入口另做了隔离 smoke：启动已编译的 `latte-work-server serve --state-dir`，使用空 HOME、空项目库和不可用 Agent 路径，实际通过 Unix socket 查询 Hello、Projects 及不存在会话的建议请求。新增能力声明为 true，项目列表为空，无效 session 返回 error；未触及用户已有 daemon 或会话。首个临时目录路径超过 macOS Unix socket 的 SUN_LEN 限制导致启动失败，改用短 `/tmp` 目录后通过。此 smoke 只证明真实服务入口和路由，不证明模型建议质量。

## 最终门禁与审查

`make fmt && make ci` 完成，退出码 **0**：格式、生成类型一致性、actionlint／ShellCheck、Clippy（warnings denied）、Rust 单元／E2E／doc／native tests、TypeScript、Vite 和 Rustdoc 均通过。

- 服务端 291 项单元测试通过。
- 最终二进制 E2E：173 项通过、0 项失败、1 项按配置 ignored。跳过的是 `ssh_e2e::global_skills_over_real_ssh_are_isolated_reversible_and_reconnectable`，需要单独的脚本和隔离 OpenSSH daemon。
- 新增 6 项建议 E2E 与既有 11 项标题回归全部通过。Ready／持有 PID 的 Pending 状态直接 SIGINT 重启回归已独立覆盖；不据此声称 SIGKILL 清理保证。
- 35 项 macOS 原生单元／边界测试通过；不等同于本功能的真实窗口 UI smoke。

前端及后端冻结快照静态审查中的问题均已修复并复核，无剩余可执行 finding；安全限定复查未发现高置信 HIGH／MEDIUM 问题。审查与执行测试的证据分别记录，不把静态审查当作运行证明。

最后已核验 `CARGO_TARGET_DIR` 位于本 worktree，执行 `make clean` 清除 5.8 GiB Rust 构建产物；未删除 worktree、未修改共享缓存、未提交或推送。

## 未覆盖的验证

- 本轮未执行真实付费模型的建议质量评估。
- 本轮未执行原生 Tauri 窗口的截图、中文 IME 或 Tab 实机 smoke；模拟 DOM 测试不代表实机验证。
- 未使用配置中的真实 SSH 主机。
- 未测量覆盖率百分比，不据测试数量声称达到覆盖率门槛。
