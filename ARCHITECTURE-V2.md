# EastGenesis V2 架构基线

## 设计主线

```text
Goal → WorkItem → Run → Effect
  → Artifact → Evidence → Acceptance → Delivery → Recovery
```

BusinessLine、机构模板与 Palace 引用这条链，不是创建工作的必填前置层级。

这条链是同一份工作真相。宫苑、列表和时间线只能投影它，不能保存第二套任务、权限或审批状态。

## 当前代码映射

| 契约 | 当前代码区域 |
| --- | --- |
| Goal / WorkItem / Project | `src/main/project-workspace`、`src/shared/project-workspace-types.ts` |
| Run / Task | `src/main/task`、`src/shared/task-runtime-types.ts` |
| Provider / routing | `src/main` 中的 provider、routing 与 frozen-routing 模块 |
| Context Pack | `src/main/agent/context-loader.ts`、`context-compressor.ts` |
| Ledger / Artifact / Evidence / Acceptance | `src/main/task/workflow-*`、`artifact-*`、`task-evidence-*` |
| Recovery | `src/main/task/task-recovery.ts`、`task-snapshot-*` |
| Digital Worker | `src/main/digital-worker` |
| Palace projection | renderer 的 office/kit 与 Agent3D 相关组件 |

## V2 边界

2026-09-15 起以 [完整重构方案](../CAOGEN-REFACTOR-MASTERPLAN-2026-09-15.md) 为实施基线：现代自然语言入口与真实交付先行，故宫复用同一任务和命令。新建默认皇帝、内阁、六部及相关机构；旧太子三省模板保留身份、权限与运行记录，迁移先预览。机构按需参与，预算/权限/状态优先使用程序；“产品发布府”四岗位仍是可选模板。路由回执、Context Pack、成果、证据、验收与恢复沿用现有账本。新 UI 或 3D 区域必须调用既有契约，不得引入平行存储。

模型直调、代码 Agent、研究 Agent 和 Office/文件 Runtime 通过 Adapter 接入；Run 创建后锁定 Provider、Model、Runtime、Tool、Skill 与 Policy 版本，未授权 Provider 不得接收项目资料。
