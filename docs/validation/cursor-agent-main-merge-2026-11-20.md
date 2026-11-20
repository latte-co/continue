# PR #34：合入 main 与输入建议交集验证（2026-11-20）

## 范围与版本

用户授权在既有 `.oh-my-code/worktree/continue/feature-cursor-agent` 中解决冲突，使用 `liuhaoyang` 提交、普通推送到 [PR #34](https://github.com/latte-co/continue/pull/34)。本轮不执行 squash merge、不强推、不删除 worktree。

采用普通 merge，冻结两个父版本：

- Cursor 分支：`665fb188d0122e55fcab6a1b38f62d9fc6ed5172`。
- main：`705748cb5fe637fc021f719f907e6cf6b0a48049`，包含 PR #33 输入建议。

实际内容冲突为 `apps/desktop/src/useWorkbench.ts`、`crates/latte-work-server/src/runtime.rs`、`crates/latte-work-server/src/store.rs`。逐段融合，并检查相关自动合并内容；未整文件选择 ours/theirs。

## 保留的交集契约

- 桌面同时保留单调 connection generation 与当前连接有效性；replacement 开始立即 fencing，成功握手先同步 ref。同一 daemon 的未知 Send、User、handoff 事实跨重连保留；准备态 Poll 不消费预测或发送关联事实。
- 有效历史补页按捕获的原 scope 保存 matching User/handoff，不受当前导航页面限制；页面发布资格仍独立验证。旧 connection/daemon 响应不进入缓存，新页面不接收旧页面正文或预测，历史补页不推进 live frontier。
- Runtime 保留 Cursor 可选 Transport/PerTurn 生命周期，接入 Guard 与 prediction/source observation。Store 在同一事务返回 durable User seq；Cursor 已 admitted 的精确 ENOENT/E2BIG 证据与 `SendNotAdmitted` 的双 ledger absence 证明分开。
- 精确重复先查原 queue admission，再查 requests，优先于当前 CLI/model/新输入校验；原 ID 只确认，不重放。Cursor 队列编辑与旧行执行校验、惰性 PATH 检查和绝对 CLI 路径绑定保留。
- 普通 Send 不等待旧 prediction child reap，也不取消 title。真正 Close、无 transport Close、重配、archive 和 drain 仍确认辅助 owner，失败保留 Unknown/inventory。正常 Cursor 轮次仅退休物理 transport，不执行 whole-session Close。
- result 与 stdout EOF 后仍等待 native 自然 cleanup/exit 0；取消保留共同 deadline 内最多两秒 TERM grace。辅助确认在 native reap 前完成，最终 inherited-group KILL 位于同步 reap 边界；后续重试不再向已 reap child 的旧 PGID 发信号。
- Cursor 沿用默认 unsupported prediction；读取和重复确认不产生额外 native prompt。未新增依赖、Cursor 控制能力或真实模型调用。

## 回归与失败记录

- 新增旧普通 Poll、旧 History 在 replacement pending 时的交叉回归，真实 RED 后修复为 GREEN。
- 新增跨 session、跨 host 导航补页两项回归：原实现缓存了有效补页，却漏收 matching User，返回原 scope 后仍被旧 Unknown barrier 阻挡；真实 RED 后最小修复为 GREEN。同时检查新页面不被污染、来源边界不回退、不自动重放。
- 新增 Cursor admitted spawn failure 与 fresh `SendNotAdmitted` 的 durable fact 区分测试。初次测试误用了字面量反斜杠加 `0`，随后改为真实 NUL；这是测试输入错误，不计为功能 RED。
- Cursor Stop E2E 捕获了合并引入的 TERM 后立即 KILL 回归：`cursor-active` 未被 native finally 清理。新增已安装 TERM trap 的清理 marker 测试真实 RED，恢复有界 grace 后 GREEN；保留原 fixture 和 Stop 清理断言，没有放宽退出或 owner 确认。
- 新增自然 EOF 后 native cleanup、无 transport 辅助确认/超时、正常 PerTurn retirement 不取消辅助 owner，以及 Cursor preparation/两轮 completion 不生成预测或第三次输入的回归。
- 一次统一验证因后台任务两分钟上限被停止；当时仅 423 UT 已完成，E2E 不能计为通过。延长任务时限后重新完整执行交集 E2E 和门禁。

## 最终执行验证

冻结源码上的实际结果：

- Server 默认并行 UT：**423 通过**。
- Cursor focused E2E：**28 通过**；输入建议相关 focused E2E：**21 通过**。
- 前端发送/历史/建议/Composer/Conversation/队列交集：**7 文件、441 测试通过**，typecheck 通过。
- 完整 `make ci` **退出码 0**：格式、协议类型同步、CI/shell 静态检查、全 workspace Clippy、Rust UT、前端 **104 文件/1,234 测试**、全量最终二进制 E2E **220 通过/1 忽略**、macOS 边界检查、**35 Desktop Rust 测试**、Web 构建及 Rust 文档通过。
- 忽略项仍为需要隔离 OpenSSH daemon 的既定真实 SSH 用例；不把它计为通过。

联合覆盖率命令与 LCOV 导出均 **退出码 0**，使用独立 target，不与默认门禁并发重建同一 binary：

```sh
CARGO_TARGET_DIR="$PWD/target/cursor-merge-coverage" cargo llvm-cov -p latte-work-server --bin latte-work-server --test e2e --locked --json --output-path target/cursor-merge-coverage.json -- --test-threads=1
CARGO_TARGET_DIR="$PWD/target/cursor-merge-coverage" cargo llvm-cov report --lcov --output-path target/cursor-merge-coverage.info
```

插桩样本重新完成 423 UT、220 E2E，1 个真实 SSH 用例忽略。

| 统计范围                          |   已覆盖/总行 | 行覆盖率 |
| --------------------------------- | ------------: | -------: |
| Server binary/E2E 联合插桩总体    | 31,561/33,980 |   92.88% |
| 四个 Cursor 源码文件 JSON summary |     970/1,005 |   96.52% |
| Cursor 生产源码唯一 LCOV DA 行    |       785/816 |   96.20% |
| executable 生产行                 |         18/18 |     100% |
| transport 文件级                  |       375/384 |   97.66% |
| ENV redaction 文件级              |         63/63 |     100% |
| admission 文件级                  |       184/189 |   97.35% |
| predictions 文件级                |       346/361 |   95.84% |

总体不是全 workspace 或前端覆盖率；JSON 文件级口径包含内联 UT，Cursor JSON 合计排除独立测试文件。Cursor 生产行另排除内联测试和测试专用项，以唯一 DA 行统计，不混用两种口径。

## 复审、绑定与收尾

- 独立前端复审确认导航补页问题 Fixed，无剩余 actionable findings；稳定 41 文件范围 SHA-256 为 `a2a23854ca8ba472d1afcb4d04db8f7e446b47b36021755281ccdf7b14e9edcd`。
- 后端初次静态审查漏掉 TERM grace 回归，旧准入建议已撤回。修复后独立复审确认 Fixed，无剩余 actionable findings；稳定 63 文件范围 SHA-256 为 `155dfefab673b7869f1fb739a6c14e6142d48858bdbc3f7771ddce19baaca504`。
- 提交前定向安全核验未发现 confirmed 高/中风险注入、授权越界或凭据泄漏。审查仅为静态范围结论，不是 GitHub approval，也不替代执行门禁或全面安全认证。
- 添加本文前，66 个 staged 变化文件按排序后的 `relative-path SHA-256` 聚合为 `808c2126b89c2e7eecee6aa2410cee181e5301b6a7fb5632c51390517523ada4`；完整门禁、覆盖率与清理后均未漂移。
- 所有构建/覆盖率导出结束后执行 `make clean`，Cargo 报告清理 **6.9 GiB**，确认本 worktree `target` 不再存在。原始 JSON/LCOV 随 target 清理，摘要保留于本文；未删除 worktree、共享缓存、前端依赖或测试数据。

本轮行为验证使用隔离 CLI fixtures。真实 Cursor 账户/模型多轮与取消恢复、真实 Cursor SSH、原生桌面窗口未独立实测。本文不代表推送后新 head 的 GitHub `PR Gate` 已完成。
