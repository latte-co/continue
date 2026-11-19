# Cursor Agent 集成验证（2026-11-18）

## 范围与基线

- 新 worktree：`.oh-my-code/worktree/continue/feature-cursor-agent`。
- 分支：`feature/cursor-agent`；基线：`46cd40caa8e93bf6474e77c46f9eabb6ddb8a090`（fetch 后的 main）。
- 不提交、不推送、不发布；原 checkout 保持只读。

## 原生 CLI 元数据证据

原生实测仅安排本机 `cursor-agent` 的只读元数据核验，没有安排真实模型 smoke，也未修改 Cursor 登录/配置：

- `--version`：`2026.11.13-eacade1`。
- `--help`：支持 print、stream-json、resume、model、ask/plan 等参数。
- `models`：退出码 0，stderr 为空；stdout 使用 `Available models` 标题、`id - label` 行、可选 `(default)` 标记和 `Tip:` 尾部提示。

这只证明已安装 CLI 的元数据接口；不证明真实 session 持久化、工具运行或取消恢复。
官方协议依据见 [设计说明](../cursor-agent.md)。

## TDD 与自动化证据

阶段记录（早期测试数量保留为历史证据，最终结果见末尾）：

- Registry RED：新增 Cursor 注册用例先因“此 Agent 尚未实现：cursor”失败。
- 前端 RED：Host-prepared 恢复新增测试先出现 3 个失败。
- 前端 GREEN：6 个 focused 测试文件、164 个测试通过；`tsc --noEmit` 与改动文件 Prettier 检查通过。
- 全量前端：103 个测试文件、1,021 个测试通过；`npm run web-build` 通过（Vite 提示现有 bundle chunk 大于 500 kB）。
- 首次最终二进制 E2E：编译失败，因正在扩展的 `Action::SpawnTurn` 尚未覆盖及测试本身的 Status 借用错误；后者已修复。这不是功能性 RED 或通过证据。
- Runtime：28 个 focused UT 通过；初始化截止时间与 native Ready 分离，stderr 超限诊断全省略以避免 secret 截断泄漏。跨截断边界回归曾真实 RED，修复后 GREEN。
- Server 二进制 UT：311 个通过；server Clippy（`-D warnings`）通过。
- Cursor adapter：18 个名称匹配测试通过，其中 12 个 Cursor 模块测试；非法 `success:false` 的工具结果曾 RED，修复为结构化 payload 校验后 GREEN。
- Cursor 最终二进制 E2E：修正归档测试预期并补充原生模型/ask/plan 参数后，精确 `cursor_e2e::` 的 11 个场景全部通过（65.10 秒）。包含 prepared Open、两 PID 同 ID 续聊、FIFO 等退出、EOF/非零/畸形/超限/错 session、取消、无 ID 禁止 replacement、daemon 重启 Unknown/不重放、ENV stderr 脱敏、result-only/flag-like prompt 与归档。首次 9/10 通过，后续中间编译缺口不作为最终功能证据。
- Decoder/前端独立复审：generic function 工具表示、已完成 call ID 重复、非对象工具 success payload，以及无断线连接替换 generation fencing 均已修复，限定范围无剩余可行动问题。generic completed 只提示未确认，不推断工具成功。
- 同 Server 连接替换回归：3 个用例先 RED，修复后 focused 6 文件、168 tests 与 TypeScript 检查通过。
- Cursor 模块最新 15 tests 通过；新增 function/重复 call ID/专属 frame limit 均真实 RED→GREEN。
- Runtime 最新 30 个 UT 通过；关闭 journal 写入失败会清除并禁用 result deadline，避免忙循环，显式 Close 仍可重试。新增无换行超限读取测试通过；生产路径还将用最终二进制 fixture 回归。
- 定向安全审查确认继承 Host ENV 值可能绕过原诊断脱敏，但未找到未经授权外传的可利用路径；按严格门槛不报 HIGH/MEDIUM 漏洞。作为明确脱敏契约问题，用合成 secret 修复/验证，不读取真实凭据。
- 继承 ENV 诊断回归：最终 Server 二进制 synthetic E2E 先真实 RED（Failed 消息包含测试 secret），修复为实际 child ENV 的继承/覆盖/移除脱敏上下文后 GREEN；runtime 最新 35 个测试通过。
- PerTurn stdin EOF 回归：原保留 pipe 的合成 CLI 先 RED；改用 null stdin 后，单轮 EOF、拒绝机器 Write、Persistent 双向 echo 三项 GREEN。
- 最终 Cursor 焦点 E2E：12 个场景通过（84.24 秒），包含继承 ENV、无换行超限及所有单轮 stdin EOF 约束。
- Bridge ENV 隔离：引用单引号/换行值的回归先 RED，修复后 GREEN；独立升级 bootstrap 同样接入五个 CLI fixtures。
- 配套 LLVM 工具经用户确认安装；早期单元测试插桩中，Cursor 生产模块行覆盖率 91.64%（559/610），transport 文件级 97.71%，Server 单元测试插桩总体 74.57%。
- 最终联合覆盖率命令 `cargo llvm-cov -p latte-work-server --bin latte-work-server --test e2e --locked --json --output-path target/cursor-full-coverage.json -- --test-threads=1` 退出码 0：321 个 UT、180 个 E2E 通过，1 个真实 SSH 用例忽略。该插桩报告总体行覆盖率 92.51%（28,507/30,814）；Cursor 生产模块（不含 tests.rs）98.52%（601/610），其中 cursor.rs 100%、decoder.rs 98.06%、metadata.rs 98.28%；transport 文件级 99.24%（260/262）。这是上述 Rust Server binary/E2E 测量范围，不是全 workspace 或前端覆盖率。
- 完整 `make ci` 已通过：格式、生成类型一致性、CI/shell 静态检查、全 workspace Clippy（warnings denied）、321 个 Server UT、其他 Rust crate UT、103 文件/1,025 个前端测试、最终二进制 E2E 180 通过/1 个真实 SSH 用例按既定要求忽略、macOS 边界脚本及 35 个 Desktop Rust 测试、Web 生产构建和 Rust 文档。
- 独立复审已关闭 decoder/UI、runtime/transport/ledger、stdin、诊断及测试 bootstrap 接入的已验证问题，已审范围无剩余可行动 finding。

确定性 peer 是测试专用 Python CLI，经过 `LATTE_WORK_CURSOR` 显式隔离，不调用真实 Cursor/model。按轮 argv、输出、延迟退出、取消和异常由 fixture 决定；不能替代原生实测。

## 收尾

- 最终 `make fmt-check`、`make lint`（全部 Rust targets，warnings denied）与 `git diff --check` 通过。
- 全部验证任务结束后执行 `make clean`，移除 8.4 GiB 当前 checkout 的 Rust 构建产物；确认 `target/`（包含独立 coverage target 与原始报告）已不存在。覆盖率摘要保存在本文，未清理共享缓存、前端依赖或 worktree。
- 原 checkout 的 `git status --short --branch` 为干净 `main...origin/main`；feature worktree 保留未提交实现。不提交、不推送、不创建 PR、不发布。

## 未执行的验证

- 真实账户模型调用、两轮上下文续聊、真实取消/resume：未完成独立验证，需另行确认外部调用。
- 一次中间并发构建期间，焦点测试重连后出现未确认 EOF；发现本地升级路径的 bridge 缺少完整 fixture ENV。已停止并发、补全隔离并串行重跑。该次失败不用于推断真实 CLI 的执行、模型调用或效果，也未读取真实账户日志。
- 原生桌面窗口/UI：未执行。
- 真实 SSH：未执行；使用既有统一 Server 协议不等于实际远程验收。

## 安全边界

- 不自动添加 force/yolo/trust/approve-mcps。
- 原生默认配置并非只读，App 不提供 Cursor 的机器审批。
- positional prompt 通过独立 argv 传给原生 CLI，不经 shell、不记录完整 argv；同执行主机有权限的进程检查仍可能看到 prompt。未证实 stdin prompt 输入时，不宣称其保密性。
- 不推断 EOF、exit 0、工具缺失结果或 daemon 中断成功。
