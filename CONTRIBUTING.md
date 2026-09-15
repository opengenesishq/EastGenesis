# 贡献指南

## 工作方式

先阅读 `STATUS.md` 与 `ARCHITECTURE-V2.md`。每个重构切片应保持单一契约边界，说明影响的 Goal、WorkItem、Run、Artifact、Evidence、Acceptance 或 Recovery 关系，并保留兼容旧标识的迁移路径。

## 验证

提交前至少运行：

```bash
npm test
```

涉及持久化、路由、上下文、交付或权限时，还应运行对应的 `scripts/*required*` 门禁，并把报告路径写入变更说明。不要把截图、类型检查或单个 UI 探针当作完整交付证据。

交付账本和跨进程恢复专项门禁可以使用：

```bash
npm run test:verified-delivery:required
npm run test:remote-continuation:required
npm run test:routing-performance:required
npm run test:context-pack:required
npm run test:provider-identity:required
npm run test:golden-tasks:required
npm run test:packaged-preview:required
npm run test:plan-confirmation:required
npm run test:palace-projection:required
```

## 提交边界

不要提交 `node_modules/`、`test-results/`、本地凭据、Provider 私有配置或真实用户资料。高风险副作用必须经过现有 Policy/Approval/Evidence 路径。
