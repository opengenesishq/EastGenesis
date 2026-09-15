# CaoGen 状态

> 2026-09-15 重构实施覆盖说明：以 [完整重构方案](../CAOGEN-REFACTOR-MASTERPLAN-2026-09-15.md) 和 [R00—R14 清单](../planning/refactor-2026-09-15/BACKLOG.csv) 为后续实施顺序。新建默认皇帝、内阁、六部及相关机构；太子三省与四岗位为兼容/可选模板，旧身份、权限、记录及运行版本保留。下文 09-13 切片和既有报告保留原时间边界，不能作为本次重构完成证据。当前实施记录见 [执行进度](../planning/refactor-2026-09-15/PROGRESS.md)。

更新时间：2026-09-15

## 基线

- 唯一源码 checkout：`CaoGen-source`。
- 基线 SHA：`974aa2315a23a0b7bd9e8b4567d499421a1ea6a8`。
- 产品版本：`0.1.9`。
- 运行时：Electron `41.10.3`，TypeScript `5.9.3`。
- `npm test` 已统一为基线（类型检查/生产构建）、Product Launch Fixture、Context Pack（含 Electron 重启运行时）、Provider 身份/onboarding、Capability Card/health contract、integration harness 与本地 mock runtime、Recovery Route 与本地 Recovery runtime（3/3）、计划确认、Mission Compiler、Mission→TaskPlan 适配、Work Inbox（含跨项目导航、首屏入口和 Delivery/Acceptance 入口）、统一 Run/Acceptance/Recovery 详情、宫苑投影、PalaceScene manifest/Builder/UI/受控 IPC/runtime、PalaceScene packaged runtime（47/47）、变更影响事务与 source recall、Golden evidence harness/session runner、Runs/Review fixture UI 和 packaged source contract；各门禁均写入对应 `test-results/*/latest.json` 报告，未把这些报告当作 Provider、真人或签名发布证据。

## 0915 本轮代码进展与验证边界

- 2026-09-15 使用用户本轮授权的临时测试凭据取得有限真实 Provider 证据：`GET /v1/models` 返回 200、发现 34 个模型；`gpt-5.4-mini` 的 Chat 和 Responses 均返回 400，Responses 明确为 `model_not_found` / `unknown provider`；`gpt-5.6-luna` 的 Responses 返回 200，输出 `OK`，报告 `exactResponseMatched=true`。上游报告 usage 为输入 4391、输出 5、合计 4396 tokens，此数值不作为计费核验证据。总计 4 次请求，报告状态 `partial`；仅有一次成功生成，未覆盖 CaoGen 主流程、四岗位执行、failover、真人任务或发布。证据：`test-results/provider-connection-probe/latest.json`。测试凭据未持久化；本次探测未读取或修改既有 private Provider 配置。
- 无 Provider 的本地规划 Session 门禁已通过 12/12：未初始化/已初始化的本地计划可经真实 active registry 持久化并恢复；initialPrompt 不执行，恢复后保持本地 idle，切换执行、固定目标、子任务和非法注册表写入仍受路由校验。该门禁使用生产生命周期/Engine 加本地 shell/parser fixture，`fetchCalls=0`；报告 `test-results/local-plan-session/latest.json`，命令 `npm run test:local-plan-session:required`。
- Goal starter 的显式“产品发布（四岗位）”模板接入 Mission 编译 → Session → `compileMissionTaskPlan`（`task-plan` / `compile-mission` IPC） → canonical Goal/Project/父 WorkItem 读取；默认自动规划继续走 `generateTaskPlan`，普通目标不强制四岗位；pending 版本保存来源摘要，审批和 dispatch 复核 Goal revision、资料授权及策略。`test-results/mission-task-plan-production/latest.json` 已报告本地存储/协调器 9/9；新增 `test-results/mission-compile-ui/latest.json` 的整机编译/审批点击门禁待本轮验证，尚不能宣称无执行的完整 UI 证据已取得。
- 审计导出以稳定 opaque digest 区分需要脱敏的事件身份，并同步映射 causationId，修复多次 Recovery 导出后的 `Duplicate Audit identity`；保留聚合身份校验。`test-results/workflow-audit-identity/latest.json` 本轮 8/8，覆盖导入/再次导出、序号变化与幂等性。
- Recovery 详情按 Run 身份隔离异步结果，旧 Promise 不回写新 Run；Ledger refresh 错误继续向恢复按钮回调传播，失败不显示“已刷新完成”；canonical 状态变化后仍可见回调结果，缺 Acceptance 仍保留正确 WorkItem 的 Delivery 导航。`test-results/recovery-ui-state/latest.json` 本轮真实 React/Electron 组件 harness 9/9；其 store/IPC 为本地 fixture，不是生产主进程恢复证据。
- 三个派生 UI wrapper 现在在启动 child 前替换旧状态；child 失败、缺报告、旧 runId/时间和错误 fixture 均不能沿用旧 passed。每次子报告保存在 wrapper 目录的独立 `nested-<id>.json`，避免共享 `packaged-ui-click/latest.json` 被后续运行覆盖。`test-results/ui-evidence-report/latest.json` 本轮 Node 子进程回归 36/36。
- 修改后的整机 Run/Acceptance/Recovery/Delivery、Runs/Review、计划确认、Mission UI、目录包与完整 `npm test` 正在重验；以下先前 UI/打包通过条目均仅为历史记录。本轮未完成全量验证；已有上述单次真实 Provider 生成结果，CaoGen 主流程与四岗位真实交付、failover、真人黄金任务、签名、公证和公开发布仍未验收。

## 已确认

- 0913 Work OS 导航已在 Sidebar 提供 Work Inbox、Projects、Runs、Review、Library、Settings 六个双语入口；入口通过独立事件合同切换现有 Studio Inbox/项目/团队资源库；Runs/Review 已分别接入 canonical Supervisor TaskRun 与 WorkItem Acceptance projection，并可导航到项目或交付验收，Settings 仍走现有设置边界；懒加载 Studio 挂载时消费排队的目标，折叠侧栏同步隐藏导航。新增本地 canonical fixture UI gate，以生产 command boundary seed 一条 TaskRun 和一条失败 Acceptance，历史 Electron 点击 Runs 行与 Review 行曾分别导航成功，6/6 通过；本轮 wrapper 与 Recovery 修改后的整机 UI 待重验；报告位于 `test-results/work-os-navigation/latest.json`、`test-results/work-os-runs-review/latest.json` 与 `test-results/work-os-runs-review-ui/latest.json`。该 fixture 不调用 Provider，也不等同真人验收。

- Electron main/preload/renderer 三层代码存在。
- 代码中已有 Provider 路由、Context Loader、Task/WorkItem、Workflow Ledger、Artifact、Evidence、Acceptance、Recovery、Project Workspace 和 Agent3D 投影相关模块。
- `package.json` 已有 `typecheck` 与 `build`，但当前阶段仍缺少旗舰任务的可重复端到端验收。
- Product Launch Fixture 已能在临时本地 Workspace 中创建 Goal、四个 WorkItem、TaskRun 快照、Workflow Ledger 投影和 Supervisor Run 绑定。
- Product Launch Fixture runtime 已接入 Mission Compiler，并在 Proof Pack/运行报告中记录稳定的 `missionDigest`，同时保持现有 canonical fixture 身份。
- Fixture runtime 已完成一个本地失败 Run 的 recovering 转换，写入真实 Artifact 文件和 Location，并将 Evidence 关联的 Acceptance 推进到 passed。
- Fixture runtime 已导出可独立读取的 `test-results/product-launch-fixture-runtime/proof-pack.json`。
- Fixture runtime 已为 build 岗位绑定不可变 Route Receipt，记录 frozen policy digest、Provider/Model/Protocol 和冻结时间，并通过独立进程读回验证。
- Fixture runtime 已验证 Context Pack 在 92% 使用率进入 critical，保留最近 4 条消息并以 user boundary 作为压缩边界；跨引擎 Remote continuation 门禁也已通过。
- Context Pack contract 已验证 provider-neutral digest、committed continuation、篡改 digest 阻断，以及 92% 临界压力下的压缩边界；持久化 Context Pack 也已验证 durable write、重启读回和篡改阻断；报告位于 `test-results/context-pack-contract/latest.json` 与 `test-results/context-pack-persistence/latest.json`。
- Electron main-process runtime 已用本地 mock summarizer 验证压缩写入、独立 Electron 进程重启读回和最近消息恢复；报告位于 `test-results/context-pack-electron-runtime/latest.json`。
- 计划确认契约已验证 pending、审批绑定、canonical 依赖回写、DAG 无环、版本改版失效和重启读回；报告位于 `test-results/plan-confirmation-contract/latest.json`。
- Mission Compiler 已将目标、约束、材料和交付物编译为业务线、四角色、WorkItem DAG 与 pending Acceptance；输入顺序和运行时间不改变摘要，空边界和重复材料 fail-closed；报告位于 `test-results/mission-compiler-contract/latest.json`。
- Mission Compiler 结果可通过纯函数映射为 `genesis` TaskPlan 草稿；草稿保留 DAG 依赖和 Acceptance 标准，明确用户确认前不得执行、投影或外发，不创建审批或执行授权；报告位于 `test-results/mission-task-plan-adapter/latest.json`。
- Work Inbox projection 已将 canonical Goal/WorkItem/Run/Artifact/Acceptance 纯投影为“待我确认、运行中、被阻塞、待交付、已完成”五个稳定分栏；已接入现有 ProjectInbox 与 Studio 根级 Work Inbox 的可折叠五栏展示，并支持按项目导航；首次进入 Studio 默认显示 Work Inbox；Inbox 已提供创建目标入口，Goal 表单包含目标、约束、验收标准和交付物；`test:goal-contract:required` 现已覆盖生产 Electron 中的 Goal 创建、编辑、revision 冲突、归档、重启读回与恢复，报告位于 `test-results/goal-contract/`；Run 行可按 canonical session 打开现有计划确认工作台；待交付行和 Run 详情均可打开现有 Delivery/Acceptance Workbench，并严格携带 canonical project/WorkItem 身份；统一 Run 详情页已接入 Inbox 的 Run 入口，并展示 Acceptance Gate / Recovery 状态；failed Run 在唯一匹配本地 snapshot 时可调用既有恢复动作并刷新 Ledger；不调用 Provider；共享投影对重复身份、非法时间戳和跨项目数据 fail-closed。报告位于 `test-results/work-inbox-projection/latest.json`、`test-results/cross-project-work-inbox/latest.json`、`test-results/work-inbox-first-screen/latest.json`、`test-results/goal-intake/latest.json`、`test-results/task-plan-inbox-entry/latest.json`、`test-results/delivery-acceptance-inbox-entry/latest.json` 与 `test-results/run-detail-acceptance-recovery/latest.json`。
- 宫苑投影契约已验证 WorkItem 身份、列表/时间线状态、操作性、标签和容量边界一致；报告位于 `test-results/palace-projection-contract/latest.json`。
- PalaceScene manifest 契约已验证场景清单为声明式数据：绑定指向规范实体，Action 受既有 CommandId 和 Policy 约束；纯 resolver 可输出确定性的 2D fallback projection 并保留 provenance；离线或事件延迟时显式输出 `freshness=stale`、原因和只读提示；脚本/网络请求和未知字段 fail-closed。新增 packaged runtime 门禁对源码和 `out/renderer` 的高/低质量 GLB、GLTFLoader.parse、哈希资产一致性和成功/失败边界完成 47/47 离线检查，报告位于 `test-results/palace-scene-manifest-contract/latest.json`、`test-results/palace-scene-runtime/latest.json` 与 `test-results/palace-scene-packaged-runtime/latest.json`。真实人工 3D 点击、视觉 fidelity、Provider/网络资产和发布签名仍未验收。
- PalaceScene Builder 第一阶段已验证 Zone/Role/View/Action 与布局版本的纯数据编辑、导入/导出解析、稳定摘要、原子拒绝和历史回滚；Studio 已提供对应声明式编辑 UI 与显式 2D fallback/3D capability 运行预览，编辑不创建 Effect，脚本/网络/未知 CommandId 继续由 manifest 边界阻断。受控 IPC/preload 仅开放本地声明式读写、编辑、导出和回滚。报告位于 `test-results/palace-scene-builder-contract/latest.json`、`test-results/palace-scene-builder-ui/latest.json`、`test-results/palace-scene-runtime-entry/latest.json` 与 `test-results/palace-scene-builder-ipc/latest.json`。本地持久化契约进一步使用现有 atomicWrite 验证写入、独立进程重启读回、摘要篡改拒绝和版本回滚，报告位于 `test-results/palace-scene-builder-persistence/latest.json`；packaged GLB/runtime 解析已通过 47/47，不涉及真实 Provider 或网络资产。真实人工点击、3D 资产导入和 packaged 视觉场景运行仍未验收。
- 历史本地 built/unsigned packaged Electron UI click smoke 曾覆盖 Work Inbox、项目工作区、PalaceScene Builder、Golden Tasks、Runs/Review fixture 行点击和只读 canonical IPC；门禁 `npm run test:packaged-ui-click:required`，目录包可传 `--artifact dist/mac/CaoGen.app --fixture runs-review`，报告位于 `test-results/packaged-ui-click/latest.json`。该 smoke 不把空用户数据伪造为运行记录，也不调用 Provider。
- Provider connection identity rotation 契约已验证首次生成、展示字段不轮换、连接语义/凭据/授权池变更递增、外部身份忽略和非法身份 fail-closed；Provider onboarding/health 门禁已验证模型探测、健康回读、失败可见性、配置指引和无凭据复制；报告位于 `test-results/provider-identity-rotation/latest.json` 与 `test-results/provider-onboarding/latest.json`。
- Provider Capability Card/health contract 已接入 required gate：Capability Card 将声明与 generation verification 分离，health projection 将 closed/half-open/open、unprobed、probe failure 映射为 automatic/probe-only/blocked；UI 复用同一状态合同并保留无密钥投影。报告位于 `test-results/provider-capability-card/latest.json`，说明位于 `docs/PROVIDER-CAPABILITY-HEALTH-CONTRACT.md`。该门禁为本地 synthetic contract，不调用 Provider，也不证明生产可用性。
- Provider integration harness 已验证四岗位真正 Promise 并行、Route Receipt 与 opaque identity 锁定、身份 revision 轮换和 failover 边界；该 harness 默认网络请求数为零，四岗位真实 Provider 验收仍标为 blocked；本轮独立连通性探测已有单次 Responses 成功，不能替代该项。仅 `CAOGEN_RUN_REAL_PROVIDER=1` 才会读取 `~/.caogen-private/provider-parity.json`，运行 `npm run provider-integration:harness`；报告位于 `test-results/provider-integration-harness/latest.json` 与 `real-latest.json`。
- 本地 mock Provider runtime 已验证模型发现、缓存隔离、认证/限流/服务端/网络错误归因，以及 OpenAI 错误中的 Provider、脱敏 Base URL、Model 和 Protocol；报告位于 `test-results/provider-restart-recheck/latest.json`。
- Recovery Route 契约已验证 pause、same-target、allowed-targets、attempt/retryOn 和协议边界；本地 Recovery runtime 已验证审批失效、未知工具结果、幂等恢复和 failed snapshot successor；报告位于 `test-results/native-recovery-route-contract/latest.json` 与 `test-results/recovery-runtime-contract/latest.json`。
- 变更影响契约已验证 Artifact Graph 传递影响、局部重跑集合、人工修改保护、不确定关系 review、Acceptance 重验和 revision fencing；报告位于 `test-results/change-impact-contract/latest.json`。
- 既有 Verified Delivery 强杀恢复门禁已通过 28 项检查，覆盖 8 个阶段、8 个 Run、9 条 Evidence、8 个 Acceptance、13 次新进程读回和 8 个强杀检查点；报告位于 `test-results/verified-delivery-flow/latest.json`。
- Remote continuation 门禁已通过，验证跨引擎文本续聊的未知 Attempt 阻断、单次后续请求、累计成本和 committed continuation；路由性能门禁已通过 100 个候选、1000 次采样，最新报告 P95 为 8.242ms，网络 I/O fail-closed。

## 当前阻塞

- Product Launch Fixture 只证明本地脱敏 fixture 的交付账本闭环；独立 Provider 探测已取得一次成功生成，但尚无 CaoGen 主流程/四岗位交付、failover、外部发布或生产可用性证据。
- 变更影响切片已增加受限 source snapshot 依赖召回：相对 import、Rust `mod`、Python 相对模块可生成 Artifact 边，缺失/歧义/路径越界/语法错误 fail-closed；Ledger 原子提交和幂等重放已有 Electron 事务证据，产品操作入口仍未闭合，生产源索引与真实用户影响召回未覆盖。
- 五用户黄金任务的脱敏证据采集器和 monotonic 计时门禁已建立，并新增 `golden-tasks:session` 真实用户 session 入口（list/start/status/mark-first-useful/finish/cancel/report）；`report --out` 可导出只含 session、参与者数、证据种类和阻塞原因的主持人状态报告，发现 synthetic、未知任务或坏 timing 会 fail-closed。尚未产生真实用户记录，真实 Provider 连接身份轮换和真实 Provider 换路由也仍无本轮证据。 Studio 已提供“黄金任务”页签作为主持入口；页面新增主持人证据桥接，可复制 report/status/finish 命令并下载脱敏生命周期状态，仍不会在 renderer 生成证据；桥接门禁使用 `npm run test:golden-task-evidence-bridge:required`。历史 x64 macOS unsigned preview `CaoGen.app` 曾完成启动 smoke，本轮修改后的目录包待重验，但签名、公证和发布仍未验证。
- 当前工作树是否干净、具体检查耗时和输出，以 `test-results/baseline/latest.json` 为准。

## 下一步

1. 完成本轮整机 Recovery/Delivery、Mission 编译/审批和既有 UI 重验，重新构建 unsigned 目录包并运行启动/点击 smoke，再完成完整 `npm test`。
2. 补齐 Change Impact 产品操作入口、生产源索引与影响召回链路。
3. 在明确 opt-in 后取得四岗位真实 Provider 交付、换路由与依赖回写证据，并组织五个真实用户黄金场景；签名、公证和公开发布仍需单独验收。
- 0915 Policy Plane：远程 `trigger_routine` 命令现在对 `bypassPermissions` 例程 fail-closed，返回失败并要求回到本地审批工作台；远程签名本身不再被当作权限授予。新增 `npm run test:remote-policy-plane:required` 源码合约门禁，未调用 Provider 或外部服务。
