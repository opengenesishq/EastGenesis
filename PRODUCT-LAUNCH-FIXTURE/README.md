# Product Launch Fixture

这是 V2 首个黄金任务的脱敏、可重复 fixture。目标固定为“本周上线一个产品”，用于验证 Goal → WorkItem → Run → Artifact → Evidence → Acceptance → Recovery 的纵向闭环。

当前目录只保存契约输入和预期输出，不包含真实 Provider 凭据、外部项目文件或不可逆动作。执行 `npm run test:fixture:runtime` 会在 `test-results/product-launch-fixture-runtime/` 生成运行报告、Proof Pack 和脱敏产品说明文件。
