# V2-002 计划确认 Fixture

运行 `npx tsx scripts/plan-confirmation-contract-required.mjs` 可在临时
ProjectWorkspace 中验证太子计划确认契约。

门禁覆盖：

- 计划生成后保持 `pending`，未确认计划不能获得执行授权；
- 审批事件绑定当前版本、摘要、审批主体和 canonical 投影回执；
- 审批后将步骤依赖回写到 canonical WorkItem，并验证 DAG 无环；
- 计划改版自动使旧审批失效，循环依赖和篡改摘要都会被拒绝；
- 新进程重新读取计划状态，并检查 Workflow Ledger 中的计划事件。

Fixture 只使用脱敏的临时数据。真实用户审批、Electron renderer 点击路径、
Provider 调用和远程多用户审批仍需单独验收。
