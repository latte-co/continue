# Cursor Agent 集成设计

## PRD

Latte Work 在执行主机上发现 Cursor Agent CLI，并通过现有本机/SSH Server 协议提供对话、工具输出、取消与连续轮次。桌面只负责呈现与请求，不启动 CLI。Agent ID 为 `cursor`，显示名为 `Cursor Agent`，可执行路径 override 为 `LATTE_WORK_CURSOR`。

不支持 App Provider、独立 effort、即时 steering、机器审批/问题、侧边聊天、子智能体历史和原生命令发现。不默认加入 `--force`、`--yolo`、`--approve-mcps` 或 `--trust`；原生默认权限并不等于只读。只读模式仅按已安装 CLI 的实际参数能力提供。

## 架构与 system design

现有 Agent 保持常驻双向传输。Cursor 使用持久 Host actor 和按轮子进程，native `session_id` 独立于 Latte session ID。

- Open：只准备 Host 上下文，不调用模型、不创建空 chat、不伪造 native Ready。`agent_session_open=false`。
- Start：精确请求去重 → Cursor argv 输入校验 → 请求事务落库 → baseline → spawn `--print --output-format stream-json` → native init → 立即保存 ID → 事件投影。prompt 通过独立 argv 传入，正文必须小于 128 KiB 且不能含 NUL；这是保守的单参数预算，不保证完整 argv/ENV 永远不会超限。单轮 stdin 使用 null，立即 EOF，不保留假的机器输入通道。
- Completion：明确 native result → stdout drain → exit status → owned process group 确认收尾 → 最终状态与快照 → 下一 FIFO 轮。
- Continue：下一轮使用已保存 ID 的 `--resume`，不重发历史 prompt。返回 ID 不一致即失败，不 fallback 新建。
- Stop/Close：由 Runtime 关闭 owned process group；confirmed reap 后标记本轮停止，不宣称文件操作已撤销。未知收尾阻止 replacement。
- Interruption：daemon 重启保留 Unknown，已交付输入不自动重放。首次 admitted 执行后仍无 native ID时，保守禁止把新 chat当作 continuation。只有精确 spawn 阶段的 ENOENT/E2BIG 已持久化为请求绑定的「确定未执行」证据时，该记录才不再阻止用户以新 request ID 重试；旧请求仍只去重、不重放。已启动未 init、未知错误、旧数据库记录及证据写入失败均不满足例外。

前端分别保存 Host-prepared 和 native-open 证据；其他 Agent 的存活要求不变。断线、重连、关闭和迟到响应沿用 host/session/version fencing。

## 技术契约

Cursor JSON 保留在独立 adapter；Runtime 只消费通用 action，并拥有落库、进程、超时、队列和授权。首版不启用 partial output，assistant 完整段逐个投影，最终聚合 result 不重复追加。工具 started/completed 使用 `call_id` 配对，本轮累计 ID 不得重复，最多 512 个调用。Cursor 原生单帧读取上限为 1 MiB，分片且无换行的超限输出也在读取端拒绝；其他 Agent 的既有读取契约不变。

官方 generic `tool_call.function` 的 `name` 与字符串 `arguments` 可投影，opaque arguments 不强制当作 JSON。官方未公布其 completed result 的可靠结构，因此完成记录严格配对后只发未确认 Notice，不产生虚假的成功 ToolResult；主轮仍要求已确认的 native 终结结果。已知 `*ToolCall` 的 success/error payload 必须为结构化对象。未知字段可扩展，关键字段非法不能推断成功。

元数据探测使用 Host shell snapshot、受限输出、超时和 owned process group 清理，ENV 按 OsString 合并后才转换为诊断文本，非 UTF-8 值不应使 Server panic。自动发现按安装路径/PATH 的 cursor-agent、agent 顺序核验 version/help 所需协议能力；显式 LATTE_WORK_CURSOR 失败不回退。模型 ID与 label 仅来自实际 CLI，不能从名称猜 effort/context。目录查询与历史 Open 容忍已下架的保存 ID，不自动改模型；实际发送仍严格校验当前目录。stderr 持续 drain、有界保留，按实际 child ENV 的继承/覆盖/移除与 Provider 凭据上下文脱敏；超限诊断省略原始内容。应用注入的凭据通过环境传递，不放入启动 argv；不宣称任意原生凭据来源或所有 stdout 都得到全面脱敏。prompt不经 shell，CLI参数独立传入。

参考接口：
- [Cursor output format](https://cursor.com/docs/cli/reference/output-format)
- [Cursor headless](https://cursor.com/docs/cli/headless)
- 本机 `2026.11.13-eacade1` 的 version/help（只能证明参数存在，不代表真实轮次验证）

## Task list 与验证

1. 新增 Cursor fixture及 UT/E2E，先验证 RED。
2. 实现独立 Cursor adapter、metadata和registry路由。
3. 扩展内部按轮 transport，保留既有 persistent默认语义。
4. 修正前端 Host-prepared恢复并补回归测试。
5. 执行 focused测试、`make ci`、新增模块coverage及本地代码审查。
6. 更新验证证据，执行 `make clean`，保留 worktree；不 commit/push/PR。

必须覆盖：无 prompt Open、admission先于spawn、两轮不同PID同native ID、文本不重复、工具错误、resume mismatch、EOF无result、result后非零退出/挂起、取消、stderr截断/脱敏、配置隔离、FIFO等待收尾、断线去重与daemon重启不重放。

确定性 fixture、真实 Cursor metadata、真实模型两轮/取消恢复、原生桌面和真实 SSH分别报告。真实模型调用需另行确认，测试通过不能替代真实CLI契约或覆盖率证据。

最终二进制测试的启动、客户端 bridge 及独立升级 bootstrap 都带显式 CLI fixture ENV，防止新 daemon 采用机器默认 Agent。不要并发重建正在被本地升级测试使用的同一 Server 二进制；覆盖率使用独立 target。
