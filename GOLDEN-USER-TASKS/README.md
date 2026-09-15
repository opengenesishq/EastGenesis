# 五用户计时黄金任务契约

本目录只定义 0913 重构方案要求的五个黄金场景和真实用户验收记录格式，不声称已经完成真实用户测试。五个场景来自 `CAOGEN-FLAGSHIP-RESTRUCTURE-2026-09-13.md`：代码变更、研究报告、Office 交付、长程维护、团队协作。

运行 `node scripts/golden-task-contract-required.mjs` 会校验契约，并读取 `evidence/*.json` 中已经由真实用户测试产生的脱敏记录。没有记录时，任务状态是 `blocked`，总体验收状态是 `partial`；脚本不会生成参与者、耗时、成功率或满意度数据来填空。

采集器本身的 fail-closed 生命周期检查使用 `npm run test:golden-tasks:evidence-harness`；session 组织入口的契约检查使用 `npm run test:golden-tasks:session`。这些检查只在临时目录创建并取消/清理会话，不产生可计入验收的用户证据。

每个证据文件对应一个真实参与者完成一个任务，建议使用下面的字段（时间应由测试记录产生，不能从目标值推导）：

```json
{
  "schemaVersion": 1,
  "kind": "caogen.golden-user-task-evidence",
  "taskId": "golden-code-change",
  "participantId": "redacted-participant-001",
  "consent": true,
  "synthetic": false,
  "evidenceOrigin": "human-test",
  "evidenceKinds": ["plan", "diff", "test", "review"],
  "startedAt": "2026-09-14T08:00:00.000Z",
  "firstUsefulAt": "2026-09-14T08:04:12.000Z",
  "completedAt": "2026-09-14T08:09:41.000Z",
  "completed": true,
  "timing": { "firstUsefulSeconds": 252, "totalSeconds": 581 },
  "contextCopyCount": 0,
  "evidenceComplete": true,
  "recovery": { "attempted": false, "succeeded": null },
  "notes": "脱敏后的观察摘要"
}
```

`participantId` 必须是脱敏标识；不得提交姓名、邮箱、API Key、访问令牌、完整聊天记录或未脱敏 Provider 响应。测试主持人应在任务开始前记录输入边界和版本，在任务结束后保存结果和阻塞原因。脚本仅验证格式、指标和门槛，不替代人工观察、访谈或产品质量判断。

## 真实测试采集流程

先使用 session runner 组织任务。它会列出五个场景、输入边界、交付物和必需 `evidenceKinds`；`status` 只输出脱敏元数据，便于主持人把 session ID 交给另一台终端继续操作。runner 只转发显式参数给跨进程采集器，不会创建合成参与者或合成证据：

```bash
npm run golden-tasks:session -- list
npm run golden-tasks:session -- start \
  --task golden-code-change \
  --participant redacted-participant-001 \
  --consent true \
  --version 0.1.9-local \
  --before-summary-file /path/to/redacted-before.txt
npm run golden-tasks:session -- status --session golden-<uuid>
```

仓库提供的跨进程采集器使用系统 monotonic clock 计算耗时，并把会话中间态放在 `evidence/in-progress/`；中间态不会被黄金任务门禁当作证据。摘要必须先写入脱敏文本文件，采集器会拒绝凭据、邮箱和过长文本。runner 和采集器都要求显式 `--consent true`，参与者只能使用 `redacted-*` 标识。

```bash
# 测试开始前：在 CaoGen 中打开实际构建，记录输入边界和版本
npm run golden-tasks:session -- start \
  --task golden-code-change \
  --participant redacted-participant-001 \
  --consent true \
  --version 0.1.9-local \
  --before-summary-file /path/to/redacted-before.txt

# 首次得到可用结果时，在另一个终端执行（sessionId 来自上一步）
npm run golden-tasks:session -- mark-first-useful \
  --session golden-<uuid> \
  --first-useful-summary-file /path/to/redacted-first-useful.txt

# 任务结束后显式填写结果；不得用目标阈值倒推出耗时
npm run golden-tasks:session -- finish \
  --session golden-<uuid> \
  --completed true \
  --evidence-kinds plan,diff,test,review \
  --context-copy-count 0 \
  --evidence-complete true \
  --recovery-attempted false \
  --notes-file /path/to/redacted-notes.txt \
  --after-summary-file /path/to/redacted-after.txt

node scripts/golden-task-contract-required.mjs
```

采集器生成的记录包含 `capture.harness`、构建版本、开始/结束脱敏摘要和 monotonic clock 原始值；门禁会重新计算 `timing` 并拒绝不一致记录。采集器不能证明参与者身份，因此报告仍将 `realUserIdentityVerified` 标记为 `false`，最终门槛仍需要主持人的真实用户测试和人工审查。取消未完成会话可执行 `npm run golden-tasks:session -- cancel --session golden-<uuid>`。
