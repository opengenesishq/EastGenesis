# EastGenesis 状态

> 2026-09-15 重构实施覆盖说明：以 [完整重构方案](../CAOGEN-REFACTOR-MASTERPLAN-2026-09-15.md) 和 [R00—R14 清单](../planning/refactor-2026-09-15/BACKLOG.csv) 为后续实施顺序。新建默认皇帝、内阁、六部及相关机构；太子三省与四岗位为兼容/可选模板，旧身份、权限、记录及运行版本保留。下文 09-13 切片和既有报告保留原时间边界，不能作为本次重构完成证据。当前实施记录见 [执行进度](../planning/refactor-2026-09-15/PROGRESS.md)。

更新时间：2026-09-27

## 基线

- 当前源码 checkout（历史目录名：`CaoGen-source`）。
- 当前功能提交：`74c054a fix: make macOS preview builds explicitly unsigned`（工作树 clean）。
- 产品版本：`0.1.9`。
- 运行时：Electron `44.4.5`，TypeScript `5.9.3`。
- `npm test` 已统一为基线（类型检查/生产构建）、Product Launch Fixture、Context Pack（含 Electron 重启运行时）、Provider 身份/onboarding/首启快速配置、Capability Card/health contract、integration harness 与本地 mock runtime、Recovery Route 与本地 Recovery runtime、空验收 fail-closed、计划确认、Mission Compiler、Mission→TaskPlan 适配、Work Inbox、变更影响事务与 source recall、Golden evidence harness/session runner、Office 交付与 PDF 需求证据、packaged UI/task/failover loopback；各门禁均写入对应 `test-results/*/latest.json` 报告，未把这些报告当作 Provider、真人或签名发布证据。3D/宫苑不在当前产品路径。

## 0915 本轮代码进展与验证边界

- 2026-09-15 使用用户本轮授权的临时测试凭据取得有限真实 Provider 证据：`GET /v1/models` 返回 200、发现 34 个模型；`gpt-5.4-mini` 的 Chat 和 Responses 均返回 400，Responses 明确为 `model_not_found` / `unknown provider`；`gpt-5.6-luna` 的 Responses 返回 200，输出 `OK`，报告 `exactResponseMatched=true`。上游报告 usage 为输入 4391、输出 5、合计 4396 tokens，此数值不作为计费核验证据。总计 4 次请求，报告状态 `partial`；仅有一次成功生成，未覆盖 EastGenesis 主流程、四岗位执行、failover、真人任务或发布。证据：`test-results/provider-connection-probe/latest.json`。测试凭据未持久化；本次探测未读取或修改既有 private Provider 配置。
- 无 Provider 的本地规划 Session 门禁已通过 12/12：未初始化/已初始化的本地计划可经真实 active registry 持久化并恢复；initialPrompt 不执行，恢复后保持本地 idle，切换执行、固定目标、子任务和非法注册表写入仍受路由校验。该门禁使用生产生命周期/Engine 加本地 shell/parser fixture，`fetchCalls=0`；报告 `test-results/local-plan-session/latest.json`，命令 `npm run test:local-plan-session:required`。
- Goal starter 的显式“产品发布（四岗位）”模板接入 Mission 编译 → Session → `compileMissionTaskPlan`（`task-plan` / `compile-mission` IPC） → canonical Goal/Project/父 WorkItem 读取；默认自动规划继续走 `generateTaskPlan`，普通目标不强制四岗位；pending 版本保存来源摘要，审批和 dispatch 复核 Goal revision、资料授权及策略。`test-results/mission-task-plan-production/latest.json` 已报告本地存储/协调器 9/9；新增 `test-results/mission-compile-ui/latest.json` 的整机编译/审批点击门禁待本轮验证，尚不能宣称无执行的完整 UI 证据已取得。
- 审计导出以稳定 opaque digest 区分需要脱敏的事件身份，并同步映射 causationId，修复多次 Recovery 导出后的 `Duplicate Audit identity`；保留聚合身份校验。`test-results/workflow-audit-identity/latest.json` 本轮 8/8，覆盖导入/再次导出、序号变化与幂等性。
- Recovery 详情按 Run 身份隔离异步结果，旧 Promise 不回写新 Run；Ledger refresh 错误继续向恢复按钮回调传播，失败不显示“已刷新完成”；canonical 状态变化后仍可见回调结果，缺 Acceptance 仍保留正确 WorkItem 的 Delivery 导航。`test-results/recovery-ui-state/latest.json` 本轮真实 React/Electron 组件 harness 9/9；其 store/IPC 为本地 fixture，不是生产主进程恢复证据。
- 三个派生 UI wrapper 现在在启动 child 前替换旧状态；child 失败、缺报告、旧 runId/时间和错误 fixture 均不能沿用旧 passed。每次子报告保存在 wrapper 目录的独立 `nested-<id>.json`，避免共享 `packaged-ui-click/latest.json` 被后续运行覆盖。`test-results/ui-evidence-report/latest.json` 本轮 Node 子进程回归 36/36。
- 2026-09-27 已完成本轮重验：`npm test` 全量通过；`npm run dist:mac:x64` 重新生成 `dist/mac/EastGenesis.app`、DMG 和 ZIP；源码工作台与目录包点击 smoke 均通过，覆盖首启模型引导、EastGenesis 图标、隐藏旧入口、一句话输入和缺模型回填；独立 Office 交付门禁 44 项通过。上述门禁均不调用真实 Provider，也不替代真人或签名发布证据。
- PDF 交付需求现在解析普通 PDF 的 Catalog→Pages→Kids→Page 页面树、Count、FlateDecode 正文和 ToUnicode 映射；异常树、加密/对象流或截断内容 fail-closed。`test:office-delivery-requirements:required` 12/12、`test:office-delivery:required` 44/44 通过；解析范围限定为当前 PDFKit/普通 PDF，不宣称覆盖任意 PDF 方言。
- 新增本地合成 Provider 的 packaged task loopback：目录包实际完成首启配置、`/v1/models` 模型发现、保存 Provider、发送一句话和 `/v1/chat/completions` 流式结果渲染；源码与 `dist/mac/EastGenesis.app` 均通过，报告位于 `test-results/packaged-task-loopback/latest.json`。该证据只证明主流程闭环，不冒充外部 Provider 或生产可用性。
- packaged task loopback 现在还验证唯一非空 OOXML DOCX 已写入，并在成果→Artifacts 面板可见；本次报告记录 `8671` bytes，SHA-256 `806c6b1625b8dbdbb17dda76d63e9641ad829a36af1681458181fbe591408bbc`。
- 新增本地双 Provider 的 packaged failover loopback：源码与 `dist/mac/EastGenesis.app` 均通过，主端点返回明确 429 限流后，EastGenesis 在全局自动路由范围内切换到配置的备用 Provider，备用请求保留原始一句话上下文并渲染完成结果。报告位于 `test-results/packaged-failover-loopback/latest.json`；这是本地合成的限流恢复证据，不替代真实 Provider、5xx 暂停策略或生产可用性验收。
- 应用壳层头像已固定使用 EastGenesis 图标；旧本地个人资料仍可在设置中保留，但不会再覆盖产品标识。重建后的 x64 目录包点击 smoke 重新通过 10/10，截图位于 `test-results/packaged-ui-click/packaged-ui-click.png`。
- 3D 故宫/宫苑入口已从当前产品路径移除；相关实现只作为隔离兼容资产保留，普通用户不会在导航、首屏、任务创建或发布验收中遇到它。后续 3D 方向另行设计为仿古明朝风格游戏化空间。
- 正式 macOS 发布入口已补齐签名/公证/干净工作树 preflight；当前机器已发现 Developer ID 身份，工作树 clean，但缺少 App Store Connect 公证变量，且 `opengenesishq/EastGenesis` 公开仓库尚未建立，`node scripts/release-preflight.mjs --platform mac --arch x64` 正确阻断正式发布。未把 unsigned preview 当作正式版本。
- 正式发布配置已切换到 GitHub `opengenesishq/EastGenesis` 发布目标；preflight 会 fail-closed 校验 provider、owner、repo 和公开仓库可达性。当前账号只有推送权限，无法把现有 `opengenesishq/CaoGen` 仓库改名或建立别名，公开仓库不存在时会阻断，内部兼容标识不受影响。
- 最新 x64 unsigned macOS 预览产物：[`EastGenesis-0.1.9-mac-x64-unsigned-preview.zip`](dist/EastGenesis-0.1.9-mac-x64-unsigned-preview.zip) SHA-256 `6edf55731a3f5c5282f27ea7441da37e415db8e54e64487fd7ebb25df01c5319`；[`EastGenesis-0.1.9-mac-x64-unsigned-preview.dmg`](dist/EastGenesis-0.1.9-mac-x64-unsigned-preview.dmg) SHA-256 `a0b413c053567ae83dc0319be6e587c24dc95fda4e18bf83657b5455a7c5e336`。预览配置强制关闭证书发现、公证、发布，当前产物明确未签名，不能作为正式发布包。
- 自动更新链路已接入主进程、IPC、preload 和“状态”页：正式包可检查、下载并由用户确认重启安装；未签名预览或未配置更新通道会明确显示不可用，绝不静默下载。更新失败分类现在只有明确的 release feed 404 才标记为通道不可用，401/403/网络错误保留为脱敏错误；契约门禁 `test-results/updater-bridge/latest.json` 通过 10/10，行为门禁 `test-results/updater-failure/latest.json` 通过 8/8。
- Windows/macOS 发布入口已清理失效脚本引用：正式 Windows 保留强制签名和 `--publish never`，Windows 预览使用显式 unsigned 配置与启动 smoke，macOS Office diagnostics 使用现有 Office 交付和需求审计门禁；`test-results/release-workflow-contract/latest.json` 通过 246 项静态引用与发布边界检查。该合同只证明入口完整，不证明 Windows 签名或正式发布。

## 已确认

- 现行产品侧导航已收敛为 EastGenesis、新任务、活动、最近任务和个人设置；Work Inbox、Projects、Runs、Review、Library、Studio 等旧入口不再作为一级入口。旧投影、组件和 fixture 只保留为兼容回归，不参与首屏或默认任务路径。当前收敛证据为 `test-results/simple-workspace-ui/latest.json`、`test-results/packaged-ui-click/latest.json` 和 `test-results/work-os-navigation/latest.json`。

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
- 当前本地 built/unsigned packaged Electron UI click smoke 已切换为 EastGenesis 一句话工作台：覆盖首启模型引导、品牌图标、隐藏旧入口、输入保留和缺模型回填；门禁 `npm run test:packaged-ui-click:required`，目录包可传 `--artifact dist/mac/EastGenesis.app`，报告位于 `test-results/packaged-ui-click/latest.json`。该 smoke 不把空用户数据伪造为运行记录，也不调用 Provider。旧 Studio/Work OS fixture 仅作为历史数据兼容测试保留。
- Provider connection identity rotation 契约已验证首次生成、展示字段不轮换、连接语义/凭据/授权池变更递增、外部身份忽略和非法身份 fail-closed；Provider onboarding/health 门禁已验证模型探测、健康回读、失败可见性、配置指引和无凭据复制；报告位于 `test-results/provider-identity-rotation/latest.json` 与 `test-results/provider-onboarding/latest.json`。
- Provider Capability Card/health contract 已接入 required gate：Capability Card 将声明与 generation verification 分离，health projection 将 closed/half-open/open、unprobed、probe failure 映射为 automatic/probe-only/blocked；UI 复用同一状态合同并保留无密钥投影。报告位于 `test-results/provider-capability-card/latest.json`，说明位于 `docs/PROVIDER-CAPABILITY-HEALTH-CONTRACT.md`。该门禁为本地 synthetic contract，不调用 Provider，也不证明生产可用性。
- Provider integration harness 已验证四岗位真正 Promise 并行、Route Receipt 与 opaque identity 锁定、身份 revision 轮换和 failover 边界；该 harness 默认网络请求数为零，四岗位真实 Provider 验收仍标为 blocked；本轮独立连通性探测已有单次 Responses 成功，不能替代该项。仅 `EASTGENESIS_RUN_REAL_PROVIDER=1` 才会读取 `~/.caogen-private/provider-parity.json`，运行 `npm run provider-integration:harness`；旧版 `CAOGEN_RUN_REAL_PROVIDER=1` 仅作为迁移别名保留。报告位于 `test-results/provider-integration-harness/latest.json` 与 `real-latest.json`。
- 本地 mock Provider runtime 已验证模型发现、缓存隔离、认证/限流/服务端/网络错误归因，以及 OpenAI 错误中的 Provider、脱敏 Base URL、Model 和 Protocol；报告位于 `test-results/provider-restart-recheck/latest.json`。
- Recovery Route 契约已验证 pause、same-target、allowed-targets、attempt/retryOn 和协议边界；本地 Recovery runtime 已验证审批失效、未知工具结果、幂等恢复和 failed snapshot successor；报告位于 `test-results/native-recovery-route-contract/latest.json` 与 `test-results/recovery-runtime-contract/latest.json`。
- 变更影响契约已验证 Artifact Graph 传递影响、局部重跑集合、人工修改保护、不确定关系 review、Acceptance 重验和 revision fencing；报告位于 `test-results/change-impact-contract/latest.json`。
- 既有 Verified Delivery 强杀恢复门禁已通过 28 项检查，覆盖 8 个阶段、8 个 Run、9 条 Evidence、8 个 Acceptance、13 次新进程读回和 8 个强杀检查点；报告位于 `test-results/verified-delivery-flow/latest.json`。
- Remote continuation 门禁已通过，验证跨引擎文本续聊的未知 Attempt 阻断、单次后续请求、累计成本和 committed continuation；路由性能门禁已通过 100 个候选、1000 次采样，最新报告 P95 为 8.242ms，网络 I/O fail-closed。

## 当前阻塞

- Product Launch Fixture 只证明本地脱敏 fixture 的交付账本闭环；独立 Provider 探测已取得一次成功生成，但尚无 EastGenesis 主流程/四岗位交付、failover、外部发布或生产可用性证据。
- 变更影响切片已增加受限 source snapshot 依赖召回：相对 import、Rust `mod`、Python 相对模块可生成 Artifact 边，缺失/歧义/路径越界/语法错误 fail-closed；Ledger 原子提交和幂等重放已有 Electron 事务证据，产品操作入口仍未闭合，生产源索引与真实用户影响召回未覆盖。
- 五用户黄金任务的脱敏证据采集器和 monotonic 计时门禁已建立，并新增 `golden-tasks:session` 真实用户 session 入口（list/start/status/mark-first-useful/finish/cancel/report）；`report --out` 可导出只含 session、参与者数、证据种类和阻塞原因的主持人状态报告，发现 synthetic、未知任务或坏 timing 会 fail-closed。尚未产生真实用户记录，真实 Provider 连接身份轮换和真实 Provider 换路由也仍无本轮证据。当前 x64 macOS unsigned preview 目录包已完成 10/10 点击 smoke，但签名、公证和公开发布仍未验证。
- 当前工作树 clean；具体检查耗时和输出以 `test-results/baseline/latest.json`、`test-results/packaged-ui-click/latest.json`、`test-results/packaged-task-loopback/latest.json`、`test-results/packaged-failover-loopback/latest.json` 与 `test-results/office-delivery/latest.json` 为准。旧快照中的“有未提交改动”仅代表历史时间点。

## 下一步

1. 保持完整回归、unsigned 目录包 smoke 和正式发布 preflight 作为每次发布前的必要门禁。
2. 补齐 Change Impact 产品操作入口、生产源索引与影响召回链路。
3. 在明确 opt-in 后取得四岗位真实 Provider 交付、换路由与依赖回写证据，并组织五个真实用户黄金场景；签名、公证和公开发布仍需单独验收。
- 0915 Policy Plane：远程 `trigger_routine` 命令现在对 `bypassPermissions` 例程 fail-closed，返回失败并要求回到本地审批工作台；远程签名本身不再被当作权限授予。新增 `npm run test:remote-policy-plane:required` 源码合约门禁，未调用 Provider 或外部服务。
