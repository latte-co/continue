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

## 原生桌面手动复核

以下是交付后的原生验收入口，不代表本次已经验证：

- 在独立状态目录启动本 worktree 的 Tauri 应用，验证 macOS WebKit 原生拖选与中文输入法。
- 在连接本地与 SSH 的项目分别执行「选中 → 保存 → 发送 → 重新打开会话」；对照实际 Agent 收到的原文与评论。
- 浏览器工作区打开时，检查注释浮层与原生网页覆盖关系。
- 断线发送结果未知时先核对历史；不自动重发，修改后的草稿不得被旧确认清空。
