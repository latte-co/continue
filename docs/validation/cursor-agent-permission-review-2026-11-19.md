# Cursor Agent PR #34：PATH 权限回归修复（2026-11-19）

## 范围与契约

- 基线：`004a846ba0605f422e3e268b43f369cda7606c77`；继续原 `feature/cursor-agent` worktree 与 [PR #34](https://github.com/latte-co/continue/pull/34)。用户授权修复后正常提交、推送，不合并、不同步 main、不发布评审回复、不移除 worktree。
- 不再把文件的任意执行位当作 Server 有效权限。PATH 候选保留有序绝对路径，由首次 `--version` 的实际 `Command::spawn` 判断权限；仅该调用返回精确 `EACCES` 时继续同名 PATH 项，不将其他错误推断为权限拒绝。
- version 一旦启动，PATH lookup 即已确定：不因不兼容 version/help、help 启动权限变化或 ENOEXEC 换成后续同名程序。version/help 均核验成功后才保存绝对路径，用于 models/permissions 和实际轮次；会话 PATH 不能重选 executable。
- 裸 override 只查其命令名的 PATH 项，含 slash 的 override 保持唯一路径。逻辑命令间回退仍是惰性的；全部探测共享原 discovery deadline，已启动 owned group 必须完成回收，清理未确认则停止回退。
- 不新增依赖、nix features 或 unsafe；实际 kernel spawn 判定也覆盖文件有效权限以外的 ACL、目录访问和解释器等启动拒绝，不以模式位手动猜测授权。绝对路径仍不保证文件内容不可替换或脚本依赖已验证。

## TDD 与中间失败

- 最终二进制测试先断言首个文件真实 spawn 返回 `PermissionDenied`，然后真实 RED：`EACCES on the first PATH entry must not hide the usable same-name CLI`。首项 owner 无执行位、另一权限类有执行位；不可执行 shebang interpreter 使 root 测试运行者也能验证真实 EACCES。正常后项 CLI 应完成真实 fixture 轮次并记录其绝对路径。
- 新 permission UT 的同名 PATH、裸 override、共享预算、配置 PATH 四类场景真实 RED；另外三个首次失败属于测试先设为 owner 无读写权限、再尝试覆盖 fixture 的建立错误，已修正建立顺序，不当作产品 RED 或通过证据。
- 修复后隔离 focused 验证：51 个 Cursor UT、27 个 `cursor_` 最终二进制 E2E 通过（26 个 Cursor 场景及 1 个既有快照游标回归）。默认全量并行 UT 首次为 351 通过/8 失败；带临时阶段计时的诊断重跑为 352 通过/7 失败，均不计通过。
- 阶段诊断中 context/bind 约 0 ms、准备/spawn 约 1–3 ms；部分已启动的简单 version fixture 在执行/读取阶段消耗 3,049/3,843 ms，另一预算场景的 version 到 deadline 时仍未完成。证据不支持将其归因于 Host snapshot 初始化或路径绑定排队，也未证明具体 OS 子系统原因。
- 临时计时仅用于测试构建，已完整删除并恢复已审生产文件指纹。两份测试准入 permit 的默认全量重跑为 358 通过/1 个预算 fixture 失败，仍不计通过。随后将严格 wall-clock 的 Cursor metadata 进程 fixtures 改为共享单份 permit，在任何测量起点/discovery 前获取；仅这些 fixtures 独占该测试资源，不改变默认全量测试并行配置、生产超时、回退、fixture 脚本或原断言。
- 既有 13 个 metadata UT 移至独立 `metadata_tests.rs`，保留全部断言；新权限场景位于 `metadata_permission_tests.rs`，用重入子进程设置 ENV，不修改测试运行者的全局 ENV。

## 最终验证

- 最终单 permit 的默认并行 `cargo test -p latte-work-server --bin latte-work-server --locked`：359 通过、0 失败；完整 `make ci` 内的相同默认单测门禁也全部通过。此前失败不计为通过，不放宽生产 deadline 或原断言。
- 完整 `make ci` 退出码 0：格式、协议类型一致性、CI/shell 静态检查、全 workspace Clippy、359 个 Server UT、103 文件/1,025 个前端测试、最终二进制 E2E 194 通过/1 个既定真实 SSH 用例忽略、macOS 边界脚本与 35 个 Desktop Rust 测试、Web 构建及 Rust 文档均通过。
- 联合覆盖率命令 `cargo llvm-cov -p latte-work-server --bin latte-work-server --test e2e --locked --json --output-path target/cursor-permission-review-coverage.json -- --test-threads=1` 退出码 0：359 UT 与 194 E2E 通过，1 个真实 SSH 用例忽略。Rust Server binary/E2E 插桩范围总体行覆盖率 **92.58%（29,087/31,419）**，不是全 workspace 或前端覆盖率。
- 四个 Cursor 源码文件 JSON summary 合计 **97.11%（875/901）**，仍含 executable 的内联 UT；独立 metadata 测试文件已排除。用 `cargo llvm-cov report --lcov --output-path target/cursor-permission-review-coverage.info` 导出唯一 DA 源码行，排除全部独立/内联测试后，Cursor 生产源码为 **96.71%（765/791）**，executable 生产行 **100%（32/32）**。统计口径不混用，测试拆分后的分母不与上一轮含内联 UT 的值直接比较。
- transport 文件级行覆盖率 **97.31%（325/334）**；ENV redaction 文件级 **100%（63/63）**。
- 独立静态复审覆盖本轮全部源代码、测试和契约文档，未发现 actionable findings；确认实际 spawn 权限判定、精确 EACCES 边界、PATH 固定、共享预算、清理和测试资源准入。该结果不代表 GitHub approval，也不替代上述运行证据。

## 验证边界与收尾

行为测试只使用隔离 CLI fixtures，不调用真实 Cursor 模型或修改登录状态；真实账户两轮/取消恢复、原生桌面窗口和真实 Cursor SSH 未独立实测。

所有构建与覆盖率导出结束后，重新通过 `make fmt-check` 和 `git diff --check`；两个生产文件 SHA-256 与独立复审绑定一致。执行 `make clean` 清理当前 worktree 的 6.6 GiB Rust 产物，确认 target 不再存在；原始 JSON/LCOV 随 target 清理，统计摘要保留于本文。未删除 worktree、共享缓存、前端依赖或测试数据。
