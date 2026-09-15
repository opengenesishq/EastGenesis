# CaoGen V2 架构基线

## 设计主线

```text
BusinessLine → Palace → Goal → WorkItem → Run → Effect
  → Artifact → Evidence → Acceptance → Delivery → Recovery
```

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

V2 首发先完成“产品发布府”这一条纵向闭环：目标输入、太子计划、四类可用岗位、路由回执、Context Pack、统一成果、验收证据、失败恢复和 Proof Pack。新 UI 或 3D 区域必须调用既有契约，不得引入平行存储。

模型直调、代码 Agent、研究 Agent 和 Office/文件 Runtime 通过 Adapter 接入；Run 创建后锁定 Provider、Model、Runtime、Tool、Skill 与 Policy 版本，未授权 Provider 不得接收项目资料。
