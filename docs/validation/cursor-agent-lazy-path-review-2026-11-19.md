# Cursor Agent PR #34：惰性 PATH 文件检查（2026-11-19）

## 范围与契约

- 基线：`e16a47a2426b78b1fc65046188295e65b9fc22c4`；继续原 `feature/cursor-agent` worktree 和 [PR #34](https://github.com/latte-co/continue/pull/34)。用户授权修复后正常提交、推送，不合并、不同步 main、不发布评审回复、不移除 worktree。
- 移除同名 PATH 的全量文件系统预扫描。路径按 Host snapshot PATH/cwd 的词法顺序构造；每次只检查当前项，找到候选后立即探测，不先检查后续文件或软链接。
- 首次 version 的实际 spawn 返回精确 EACCES 才继续同名 PATH 查找。成功、已启动不兼容、help 启动失败或其他初次 spawn 错误终止同名扫描；version/help 核验成功后继续复用该绝对路径。
- HOME 安装候选也仅构造路径，不提前对低优先级安装位置做存在性检查。逻辑命令之间的回退保持惰性。
- 文件检查与 spawn 的新准入共用 discovery deadline；已开始的阻塞 syscall 不承诺可由硬期限中断。已启动 owned group 的回收和清理未确认停止回退约束不变。
- 不新增依赖、公共协议字段或 unsafe，不改变会话配置 PATH 不能重选 CLI 的约束。

## TDD 证据

- scoped `cargo test -p latte-work-server --bin latte-work-server cursor --locked` 真实 RED：54 通过/5 失败，不计为通过。
- 三个检查 predicate 回归分别捕获未消费候选就做文件检查、首项返回前检查第二项、第二项返回前检查第三项。
- 两个 HOME 回归捕获不存在安装文件时丢弃候选，以及低优先级本地悬空 generic symlink 被存在性过滤。后者证明预过滤行为，单独不能证明没有 stat；最终控制流与检查记录的验证另列。
- 不挂载或访问真实失联网络盘。检查记录/拒绝访问的测试 seam 验证实际路径选择控制流，不把模拟记录冒充真实网络文件系统运行证据。
- 集中 GREEN 验证已通过：默认并行 371 个 Server UT，27 个 `cursor_` 最终二进制 E2E。首次完整 `make ci` 在测试断言的 `cloned_ref_to_slice_refs` Clippy 警告处失败，不计通过；改用 `std::slice::from_ref` 保持同一精确断言，不修改生产控制流，最终门禁结果另列。
- 保留上轮的真实 EACCES、已启动 lookup 边界、绝对路径绑定、队列和清理回归；严格计时的 metadata fixtures 仍沿用测试资源单 permit，默认全量测试并行及生产期限不变。

## 最终验证

- 最终完整 `make ci` 退出码 0：格式、协议类型一致性、CI/shell 静态检查、全 workspace Clippy、默认并行 371 个 Server UT、103 文件/1,025 个前端测试、最终二进制 E2E 194 通过/1 个既定真实 SSH 用例忽略、macOS 边界脚本与 35 个 Desktop Rust 测试、Web 构建和 Rust 文档均通过。
- 新增六个 metadata 检查记录测试调用实际生产 lookup loop 与真实 probe/spawn/cleanup，覆盖首项成功不访问后项、真实 EACCES 仅推进到下一项、已启动不兼容/help EACCES 不访问后项、其他初次 spawn 错误不推进、已过期零检查，以及检查耗尽期限后不启动 probe 或检查后项。测试 checker 不单独证明没有绕过 seam 的 FS 调用；该结论由生产调用链静态复审补足。
- 联合覆盖率命令 `cargo llvm-cov -p latte-work-server --bin latte-work-server --test e2e --locked --json --output-path target/cursor-lazy-path-review-coverage.json -- --test-threads=1` 退出码 0：371 UT 与 194 E2E 通过，1 个真实 SSH 用例忽略。Rust Server binary/E2E 插桩范围总体行覆盖率 **92.57%（29,182/31,523）**，不是全 workspace 或前端覆盖率。
- 四个 Cursor 源码文件 JSON summary 合计 **96.52%（970/1,005）**，含 executable 的内联 UT，排除独立测试文件。用 `cargo llvm-cov report --lcov --output-path target/cursor-lazy-path-review-coverage.info` 导出唯一 DA 源码行，排除全部独立/内联测试后，Cursor 生产源码为 **96.20%（785/816）**；词法 executable 生产行 **100%（18/18）**。统计口径不混用。
- transport 文件级行覆盖率 **97.31%（325/334）**；ENV redaction 文件级 **100%（63/63）**。
- 独立静态复审完整覆盖本轮源代码、测试和契约文档，未发现 actionable findings；Clippy 的单行测试断言修正也已补审，保持精确路径/顺序/数量断言。审查不代表 GitHub approval，也不替代上述运行证据。

## 验证边界与收尾

行为测试仅使用隔离 CLI fixtures，不调用真实 Cursor 模型、不修改登录状态。真实账户多轮/取消恢复、原生桌面窗口、真实 Cursor SSH 与失联网络盘未独立实测。

所有构建和覆盖率导出结束后，重新通过 `make fmt-check`、`git diff --check`；最终源代码和测试文件 SHA-256 与独立复审绑定一致。执行 `make clean` 清理当前 worktree 的 6.6 GiB Rust 产物，确认 target 不再存在；原始 JSON/LCOV 随 target 清理，统计摘要保留于本文。未删除 worktree、共享缓存、前端依赖或测试数据。
