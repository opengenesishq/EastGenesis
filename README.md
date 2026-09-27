# EastGenesis

EastGenesis 是本地优先、模型中立的 AI 桌面助手。首屏只有一个工作台：首次启动配置模型，之后输入一句话，直接生成结果；需要时再展开模型路由、费用、恢复和交付证据。

> 品牌说明：EastGenesis 是产品名。安装升级期间仍保留一组历史兼容标识，用于保护已有用户数据；这些标识不代表产品名称，也不会出现在安装包、窗口标题或界面文案中。

## 当前状态

当前验证 checkout 为 `release/1.0`；类型检查和生产构建由统一测试入口执行。核心旗舰闭环、五用户黄金任务和打包发布仍属于重构验收范围，不能仅凭编译通过宣称完成。

## 开发

```bash
npm ci
npm run typecheck
npm run build
npm test
```

`npm test` 会按顺序运行类型检查、生产构建、fixture 契约检查和最小运行闭环，并将报告写入 `test-results/`。报告目录属于本地验证产物，不应提交到 Git。

需要验证跨进程强杀恢复和交付账本时，运行 `npm run test:verified-delivery:required`；该专项门禁会生成独立报告。

跨引擎文本续聊和路由性能专项门禁分别使用 `npm run test:remote-continuation:required` 与 `npm run test:routing-performance:required`。

Context Pack 边界、持久化和 Electron 重启运行时契约使用 `npm run test:context-pack:required`，报告写入 `test-results/context-pack-contract/`、`test-results/context-pack-persistence/` 和 `test-results/context-pack-electron-runtime/`。

五个黄金用户任务契约使用 `npm run test:golden-tasks:required`；真实测试主持人先用 `npm run golden-tasks:session -- list|start|status|mark-first-useful|finish|cancel` 组织 session，再用 `npm run golden-tasks:session -- report --out <脱敏报告路径>` 导出当前 session、参与者数、证据种类和阻塞原因。报告只输出操作状态，不携带摘要或证据原文；发现 synthetic、未知任务或坏 timing 会 fail-closed。底层采集器记录跨进程 monotonic 计时和脱敏前后摘要。没有真实用户记录时门禁保持 blocked，runner 和采集器都不会生成合成证据。 Studio 内“黄金任务”页签只维护本地 list/start/status/cancel 状态，并强制脱敏参与者与明确同意；主持人证据桥接可复制 report/status/finish 命令并下载脱敏 session 状态，UI 明确提示证据仍须 CLI capture/report 生成，使用 `npm run test:golden-task-evidence-bridge:required` 验证。打包预览源代码契约使用 `npm run test:packaged-preview:required`；已有本地构建产物时可执行 `node scripts/packaged-preview-smoke-required.mjs --artifact dist/mac/EastGenesis.app --launch` 获取启动证据，仍不会把未签名本地预览当作正式发布。

计划确认、账本和交付证据使用对应的本地契约门禁。旧的宫苑/PalaceScene 代码只保留为隔离兼容资产，不进入当前 EastGenesis 导航、首屏、任务创建或发布验收；3D 方向后续另行设计为仿古明朝风格游戏化空间。`npm run test:packaged-ui-click:required` 以本地 built Electron 输出驱动当前 EastGenesis 一句话工作台、首启模型引导、品牌图标和缺模型回填；传入 `--artifact dist/mac/EastGenesis.app` 可重复验证目录包 renderer，均不调用 Provider。

目标编译为业务线、四角色、WorkItem DAG 和待验收清单使用 `npm run test:mission-compiler:required`；将该编译结果转换为仅待用户确认的 TaskPlan 草稿使用 `npm run test:mission-task-plan-adapter:required`。适配器是纯函数，不创建版本、审批事件、canonical 投影或执行授权。
Work Inbox 五栏共享投影（待我确认、运行中、被阻塞、待交付、已完成）使用 `npm run test:work-inbox:required`，跨项目聚合和导航使用 `npm run test:cross-project-work-inbox:required`，首次进入 Studio 的默认入口使用 `npm run test:work-inbox:first-screen:required`；已接入现有 ProjectInbox 和 Studio 根级 Work Inbox 的可折叠五栏展示，支持项目级导航。Work Inbox 的创建目标入口和 Goal/约束/验收标准/交付物表单使用 `npm run test:goal-intake:required`；Goal 完整创建、编辑、并发 revision、归档、重启读回和恢复的生产 Electron 点击链使用 `npm run test:goal-contract:required`，该门禁已纳入 `npm test`；Run 行可通过 canonical session 打开现有计划确认工作台，使用 `npm run test:task-plan-inbox-entry:required` 验证；待交付行和 Run 详情可打开现有 Delivery/Acceptance Workbench，使用 `npm run test:delivery-acceptance-inbox-entry:required` 验证。统一 Run 详情、Acceptance Gate 和 Recovery 状态投影使用 `npm run test:run-detail:required`；唯一匹配本地 snapshot 的 failed Run 可调用现有恢复动作；Electron 人工点击路径和真实 Provider 恢复仍待验收。 Work OS 的 Runs/Review 入口使用 `npm run test:work-os-runs-review:required`，分别读取 canonical Supervisor TaskRun 和 WorkItem Acceptance，并可导航到项目/交付验收；真人验收和 Electron 点击时序仍待覆盖。

Provider 连接身份轮换契约使用 `npm run test:provider-identity:required`。

四岗位并行、Route Receipt、身份 revision 和冻结 failover 边界使用 `npm run test:provider-integration:required`；真实 Provider `/models` 受控探针必须显式设置 `EASTGENESIS_RUN_REAL_PROVIDER=1`，然后运行 `npm run provider-integration:harness`，默认不会联网。旧版 `CAOGEN_RUN_REAL_PROVIDER=1` 仅作为迁移别名保留。

Provider 首次连接与健康检查边界使用 `npm run test:provider-onboarding:required`；本地 mock Provider runtime 使用 `npm run test:provider-runtime:required`；Recovery Route 使用 `npm run test:native-recovery-route:required`；变更影响和 Acceptance 重验使用 `npm run test:change-impact:required`，Workflow Ledger 原子提交使用 `npm run test:change-impact:transaction:required`。

重构范围和验收门槛见仓库外的 0913 方案，以及仓库内的 [STATUS.md](STATUS.md)、[ARCHITECTURE-V2.md](ARCHITECTURE-V2.md)、[ARCHITECTURE-TRACEABILITY-0913.md](ARCHITECTURE-TRACEABILITY-0913.md) 和 [ACCEPTANCE-MATRIX-V2.md](ACCEPTANCE-MATRIX-V2.md)。
