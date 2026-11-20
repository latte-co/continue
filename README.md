# Latte Work

A desktop workspace for coding agents, with local and SSH projects.

**Tauri 2 · React · Rust**. Integrates installed **Claude Code**, **Traex**, **Codex**,
**OpenCode 2.x**, and **Cursor Agent** CLIs through native protocols and session history.

## Start

```sh
make setup
make dev
```

Install and sign in to the selected CLI (`claude`, `traex`, `codex`, `opencode`, or
`cursor-agent`) on each execution host, or bind a compatible App Provider before
sending a task. OpenCode supports the App Provider and native host configuration.
Cursor uses its native account and configuration, not App Providers.
Create a project, select this computer or an SSH host, and choose its folder
(local system picker or remote directory browser). Then create a task and send
a prompt. You can also enter an absolute path. File
inspection and Git changes are available in the collapsible right panel.

On Windows, install locked frontend dependencies and launch directly from PowerShell 7:

```powershell
npm ci
pwsh -NoProfile -File scripts/desktop.ps1 dev
```

Windows native Claude execution requires `claude.exe`; interactive terminals
require PowerShell 7 (`pwsh.exe`). Other agents retain their native launch and
capability contracts; installed CLI availability is reported by the execution host.
The existing Windows live acceptance record covers Claude, SSH and installation;
it does not establish real-model acceptance of every agent in the merged build.

The desktop starts the bundled local server. Connections using the same host user
and state directory share one daemon, which owns projects, persistent history and
independent Agent processes. Closing the window hides it; explicit Quit cleans up
this App's owned resources. A transport disconnect does not stop accepted host tasks.
Windows SSH connects to a same-user daemon started independently outside SSH;
Unix SSH can start the daemon on demand. See [SSH setup](docs/remote.md).

## Capabilities

- Native desktop on macOS and Windows; headless server on macOS, Linux and Windows.
- Local and SSH projects, persistent conversations and bounded history replay.
- Native Agent tool events, explicit single-use approval, cancellation and native resume.
- Request deduplication, reconnect and honest interrupted/unknown state after crashes.
- Host-owned terminal tabs, read-only file previews and project-scoped Git review.
- Frozen per-turn changes and guarded Undo; Windows Undo supports eligible local
  NTFS regular files in Git and non-Git projects.
- App-owned Provider configuration, per-host Agent associations, and per-turn
  model, effort and permission choices. Claude accepts Anthropic Messages; Codex
  accepts OpenAI Responses; Traex and OpenCode accept all three configured protocols.
  Cursor uses its native account and configuration.
- Unsigned macOS packaging and Windows x64 per-user NSIS installation.

The CLI's existing permission rules still apply. Register only projects you trust:
Agents load their configuration. Latte Work does not manage CLI login or provide
an Agent sandbox. Unsupported agents and capabilities fail explicitly.

## Build and verify

```sh
make ci           # formatting, Clippy, tests, frontend build, docs
make build        # native desktop and server debug build
make package      # unsigned native application and standalone release server
make cache-info   # Cargo output path and optional sccache statistics
```

See [development](DEVELOPMENT.md) for prerequisites, PowerShell commands, test
boundaries and package provenance; [architecture](docs/architecture.md) for runtime
contracts; [Provider configuration](docs/providers.md), [UI design](docs/design-system.md)
and [theme import/export](docs/themes.md) for their respective workflows.

Automatic remote binary installation, Windows Service deployment, Windows MSI/ARM
installers, signing/notarization, updater publication and guaranteed continuation of
in-flight work after a daemon crash are outside the current support profile.

模型服务在「设置 → Provider」统一管理，支持 Anthropic Messages、
OpenAI Chat Completions、OpenAI Responses 配置。在「设置 → 连接与 Agent」中关联兼容的
Provider。OpenCode 和 Traex 支持三种协议。Claude Code 接受 Anthropic Messages，Codex 接受 OpenAI Responses。
`LATTE_WORK_CODEX` 和 `LATTE_WORK_OPENCODE` 分别可指定对应的 CLI 路径。
OpenCode 通过 [OpenCode 2.x ACP](https://opencode.ai/docs/cli/acp/) 运行会话，并读取执行主机的原生配置。
详见 [Provider 与 Agent 配置](docs/providers.md)。

Cursor Agent 通过执行主机上的 `cursor-agent`（或 `agent`）运行，`LATTE_WORK_CURSOR`
可指定 CLI 路径。每轮独立启动，后续输入用已确认的原生 session ID 续聊；打开历史任务
只准备 Host，不发送提示词、不伪造「已打开」。支持原生模型选择与 CLI 已声明的只读模式，
不提供 App 审批、即时发送、独立 Effort、App Provider 或子智能体历史。
默认遵循 Cursor 配置，不自动添加 `--force`、`--trust` 或批准 MCP；默认权限不等于只读。
详见 [Cursor Agent 契约与验证](docs/cursor-agent.md)。

Provider 可配置默认模型和多个可选模型。在输入框底部选择本轮模型，下一次发送时生效；
会话记住已提交的选择，不影响其他会话。远程项目使用远端已同步的模型列表。

支持智能输入建议的 Agent 完成一轮对话后，空输入框可显示灰色的下一条消息建议。
按 Tab 仅插入可编辑草稿，不会自动发送；Escape 取消当前建议。不支持此能力的
Agent 或旧版主机继续使用原有占位提示与欢迎建议。目前仅 Codex 启用智能生成；
Claude Code（包括 App Provider 模式）、Traex 和 OpenCode 保留默认提示。
建议状态随正常会话轮询返回，不额外占用主机读取通道。
