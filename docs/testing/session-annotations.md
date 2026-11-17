# 会话划词注释验收

## 自动化检查

- `npm test`：主对话与侧聊的注释发送、失败保留、独立草稿、版本确认、队列取回、已发送消息展示。
- `annotations.test.ts`：富文本跨节点选区、Unicode 与重复文本的精确位置、跨消息拒绝、损坏或未知清单原文保留、UTF-8 总量限制。
- `AnnotationUI.test.tsx`：保存与取消、空评论禁用、输入法、快捷保存、编辑与删除、键盘焦点、隐藏与滚动关闭选区操作、重复位置编号避让。
- `cargo test -p latte-work-server --test e2e session_annotations_reach_native_input_and_replay_exactly_once --locked -- --test-threads=1`：生产 server 二进制与确定性 CLI fixture，核对完整原生输入、持久消息、断线重连与重复请求去重。

在由 OpenCode ACP 启动的开发会话内执行测试时，当前 Agent 的 `OPENCODE_CONFIG_CONTENT` 可能带入真实 socket 插件。
既有 OpenCode fixture 会选取配置中首个 socket 插件，因而误连当前会话而不是测试自己的 sideband。
可使用 `env -u OPENCODE_CONFIG_CONTENT make ci` 仅隔离验证子进程的这项配置；不修改用户配置、权限或运行中的 Agent。

本次执行结果：

- 全量前端测试：103 个文件、974 项通过；随后新增的链接选区测试随 `AnnotationUI.test.tsx` 的 7 项测试通过。最终前端构建、格式检查和 Clippy 通过。
- 注释最终二进制专项测试通过。
- 首次 `make ci` 的 E2E 阶段为 154 通过、10 失败、1 个既有 ignored；失败集中在继承 socket 插件的 OpenCode 测试，因此这次完整命令并非一次性通过。
- 去掉该环境变量重跑 OpenCode 分组：11/12 通过；剩余 `opencode_parent_finishes_while_a_child_question_remains_answerable` 曾报告模型目录不匹配，使用同一隔离方式单独复跑通过。未修改或放宽这些既有测试。
- 补跑 `make test-doc test-native` 与 warnings-denied Rustdoc 通过，桌面 Rust 测试为 35 项通过。

## 浏览器组件验收记录

本次在隔离浏览器页面中挂载生产 `AnnotatedMessage`、`AnnotationSummary`、`Composer` 和 `UserMessage`，使用固定回复文字和本地发送回调；没有调用真实模型或连接用户运行中的主机服务。

已验证：

1. 在回复中依次选中两处文字，保存两条不同评论。
2. 原文高亮、编号与输入区「2 条注释」同步；汇总正确显示每条原文和评论。
3. 正文与两条注释一同提交；已发送消息展示只读注释，草稿注释清空。
4. 浅色和默认深色主题、窄窗口浮层边界；窗口实际最小宽度为 500 CSS px，无水平页面溢出。
5. 2,100 字符评论在输入框内滚动，浮层保持在窗口内；取消后不添加注释，焦点回到回复。
6. 编辑器实际获得焦点，输入使用既有主题底色、边框与圆角，空评论的保存按钮禁用。

## PR #29 评审修复验证

- 链接拖选只抑制紧随鼠标释放的一次点击；覆盖保存／取消／Escape 后保留选区的复制、文件按钮和键盘激活。
- 任务摘要对用户消息和队列交付消息均剥离注释清单；回归覆盖含转义换行、引号、围栏示例链接的注释，同时保留正文链接与实际附件。
- 编号编辑器关闭时保留 Modal 恢复的触发点；侧边追问不抢回主聊焦点。
- 编号使用消息内的独立留白，浏览器验证主聊和侧聊各自在 240、280、320、400、600 CSS px 五种宽度下 `scrollWidth === clientWidth`，编号未超过消息右边界。
- 侧聊最终 UTF-8 字节数在创建会话前校验，包含正文、注释、附件清单和 quotes；回归覆盖恰好 128 KiB 可发送、超出 1 byte 保留全部草稿且不创建会话。
- 本轮全量前端测试：103 个文件、987 项通过。浏览器同时验证旧选区下文件打开、编号焦点恢复与侧聊焦点保留。
- 本轮 `env -u OPENCODE_CONFIG_CONTENT make ci` 完整通过：987 项前端测试、165 项 server E2E（1 个既有 ignored）、35 项桌面测试，以及格式、类型一致性、Clippy、脚本检查、构建和 Rustdoc。

## Linux CI：侧聊 EOF 恢复与 Undo 时序

`9a1ecda` 的 Linux E2E 在 `undo_ignores_prelaunch_rejection_and_fences_unconfirmed_native_exit` 失败：期望侧聊写入未确认错误，实际先收到主机仍忙错误。
运行时会先持久化 Failed，再恢复原生会话并更新 `agent_session_busy`；仅等待 Failed/Completed 不代表 actor 已完成恢复和队列结算。

测试在 Undo 前等待主、侧会话的公开 `agent_session_busy == false` 投影，并保持状态断言。
Codex fixture 增加受控的 side-resume 握手：恢复被阻塞时，断言主机忙保护且文件不变；释放后，再断言侧聊写入待确认保护和文件不变。预启动拒绝分支仍必须可以撤销。
这不是延长固定等待或放宽错误匹配，也未改动生产代码的安全判定。

恢复本地验证时，完整并行单测还复现了 Skill staging 回收测试的租约时序问题：并发子进程创建可短暂持有已关闭的锁描述符，单次回收会正确跳过该目录。
测试采用与相邻回收边界测试一致的 5 秒有界重试，并在每次尝试中断言活跃目录、无标记目录和符号链接保持不变；锁未释放时保留 marker 和 payload，最终必须实际回收。生产回收代码不变。

修复后 `env -u OPENCODE_CONFIG_CONTENT make ci` 完整通过：277 项 server 单测、987 项前端测试、165 项 server E2E（1 个既有 ignored）、35 项桌面测试；格式、Clippy、脚本检查、构建和 Rustdoc 同时通过。

## 原生桌面手动复核清单

以下是交付后的原生验收入口，不代表本次已经验证：

- 在独立状态目录启动本 worktree 的 Tauri 应用，验证 macOS WebKit 原生拖选与中文输入法。
- 在连接本地与 SSH 的项目分别执行「选中 → 保存 → 发送 → 重新打开会话」；对照实际 Agent 收到的原文与评论。
- 浏览器工作区打开时，检查注释浮层与原生网页覆盖关系。
- 断线发送结果未知时先核对历史；不自动重发，修改后的草稿不得被旧确认清空。
