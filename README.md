# EastGenesis

<p align="center">
  <strong>智能模型路由 AI 助手</strong><br>
  本地优先 · 模型中立 · 自动选择最优模型
</p>

<p align="center">
  <a href="https://github.com/opengenesishq/EastGenesis/releases">
    <img src="https://img.shields.io/github/v/release/opengenesishq/EastGenesis?include_prereleases&label=version" alt="Release">
  </a>
  <a href="https://github.com/opengenesishq/EastGenesis/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/opengenesishq/EastGenesis" alt="License">
  </a>
  <a href="https://github.com/opengenesishq/EastGenesis/stargazers">
    <img src="https://img.shields.io/github/stars/opengenesishq/EastGenesis" alt="Stars">
  </a>
</p>

---

## 🎯 核心特性：智能模型路由

**EastGenesis 的核心差异化优势**：不再需要手动选择模型，系统自动为每个任务选择最优模型。

### 🧠 任务智能识别
```
"用 Python 实现快速排序"  →  识别为编码任务
"总结这份 50 页 PDF"      →  识别为长文本处理
"设计电商网站架构"        →  识别为推理+规划任务
```

### 🎯 多维度自动评分
系统综合考虑：
- ✅ **能力匹配** - 编码/推理/工具使用/视觉/长文本
- 💰 **成本优化** - 简单任务用便宜模型，复杂任务用强模型
- ⚡ **性能权衡** - 延迟、可靠性、健康度
- 📊 **预算控制** - 自动降级，不超预算

### 🔄 自动故障切换
- Provider 故障？自动切换备用模型
- 模型限流？自动使用其他可用模型
- 保留上下文，对话不中断

### 🌐 多 Provider 支持
- OpenAI (GPT-4, GPT-4o, o1)
- Anthropic (Claude Opus, Sonnet, Haiku)
- 国产模型 (通义千问、文心一言、智谱 GLM 等)

---

## 📦 下载安装

### macOS (Intel/Apple Silicon)

**[下载 v0.1.9-beta](https://github.com/opengenesishq/EastGenesis/releases/latest)**

⚠️ **首次打开**：右键点击 → "打开"（绕过未签名警告）

### Windows
构建中，即将发布

### Linux
暂不支持

---

## 🚀 快速开始

### 1. 配置模型 Provider

首次启动时配置至少一个 Provider：

```
支持的 Provider:
- OpenAI
- Anthropic  
- Azure OpenAI
- 国产模型（通过 OpenAI 兼容接口）
```

**推荐**：配置 2-3 个 Provider，让系统自动选择和切换。

### 2. 输入任务，自动路由

```
输入: "帮我重构这段代码，提高可读性"

系统自动：
→ 识别任务类型：代码重构（编码能力要求高）
→ 评估复杂度：中等
→ 选择模型：Claude Sonnet（编码能力强 + 性价比高）
→ 开始执行
```

### 3. 查看路由决策

点击对话中的"路由决策"查看：
- 为什么选择这个模型？
- 评分依据是什么？
- 还有哪些备选方案？
- 成本和延迟估算

---

## ✨ 其他功能

### 📄 Office 文件生成
- Word 文档（DOCX）
- Excel 表格（XLSX）
- PowerPoint 演示（PPTX）
- PDF 文档

### 🌐 内置浏览器
- 网页浏览和搜索
- 内容提取
- 截图分析

### 💻 开发工具
- 文件编辑
- 终端集成
- Git 操作
- 代码审查

### 🔧 高级功能
- MCP 工具集成
- 自定义路由规则
- 项目级配置
- 成本预算控制

---

## 🎬 使用场景

### 场景 1：编程助手
```
任务：实现一个复杂算法
系统选择：Claude Opus（推理能力强）
成本：较高，但质量有保证
```

### 场景 2：文档处理
```
任务：总结 100 页会议记录
系统选择：GPT-4 Turbo（长上下文窗口）
成本：中等，性价比最优
```

### 场景 3：日常问答
```
任务：简单问题快速回答
系统选择：Claude Haiku（快速且便宜）
成本：极低，响应迅速
```

---

## 🆚 与竞品对比

| 功能 | EastGenesis | Cursor | Claude Desktop | ChatGPT |
|------|-------------|--------|----------------|---------|
| 智能路由 | ✅ 自动 | ❌ | ❌ | ❌ |
| 多模型支持 | ✅ | ⚠️ 有限 | ❌ 单一 | ❌ 单一 |
| 自动故障切换 | ✅ | ❌ | ❌ | ❌ |
| 成本优化 | ✅ 自动 | ❌ | ❌ | ❌ |
| 本地优先 | ✅ | ✅ | ⚠️ 部分 | ❌ |
| Office 生成 | ✅ | ❌ | ⚠️ 有限 | ⚠️ 有限 |

---

## 📊 项目状态

**当前版本**: v0.1.9-beta (Community Edition)

**测试状态**: 81/91 门禁通过 (89%)

**已验证**:
- ✅ 智能路由核心系统
- ✅ 多 Provider 管理
- ✅ 自动故障切换
- ✅ Office 文件生成
- ✅ 本地环境完整测试

**待完善**:
- ⚠️ 真实 Provider 大规模验证
- ⚠️ 真实用户场景测试
- ⚠️ macOS/Windows 签名

---

## 🛠️ 开发

### 环境要求
- Node.js 22+
- npm 10+

### 本地开发
```bash
# 安装依赖
npm ci

# 类型检查
npm run typecheck

# 构建
npm run build

# 运行测试
npm test

# 启动开发模式
npm run dev
```

### 测试
```bash
# 完整测试套件
npm test

# 单个门禁测试
npm run test:provider-integration:required
npm run test:office-delivery:required
npm run test:packaged-ui-click:required
```

详细开发文档见 [CONTRIBUTING.md](CONTRIBUTING.md)

---

## 🤝 贡献

欢迎贡献代码、报告问题或提供反馈！

- **报告 Bug**: [GitHub Issues](https://github.com/opengenesishq/EastGenesis/issues)
- **功能建议**: [GitHub Discussions](https://github.com/opengenesishq/EastGenesis/discussions)
- **贡献代码**: 提交 Pull Request

### 特别欢迎的贡献
- 🐛 Bug 修复
- 📝 文档改进
- 🌍 国际化翻译
- ✨ 新功能实现
- 🧪 测试用例

---

## 📄 许可证

EastGenesis 采用双重许可：
- **社区版**: 开源协议（见 [LICENSE](LICENSE)）
- **商业版**: 商业许可协议

---

## 🔗 相关链接

- **官网**: [opengenesis.dev](https://opengenesis.dev)（待建立）
- **文档**: [docs.opengenesis.dev](https://docs.opengenesis.dev)（待建立）
- **博客**: [blog.opengenesis.dev](https://blog.opengenesis.dev)（待建立）
- **Twitter**: [@EastGenesisHQ](https://twitter.com/EastGenesisHQ)（待建立）

---

## 🙏 致谢

感谢所有贡献者和早期用户的支持！

特别感谢：
- [Claude Code](https://claude.ai/code) - 协助开发与测试
- 开源社区 - 提供反馈与建议

---

## 📮 联系我们

- **Email**: hello@opengenesis.dev
- **GitHub**: [@opengenesishq](https://github.com/opengenesishq)
- **Issues**: [提交问题](https://github.com/opengenesishq/EastGenesis/issues)
- **Discussions**: [参与讨论](https://github.com/opengenesishq/EastGenesis/discussions)

---

<p align="center">
  <strong>让 AI 自动选择最优模型，专注创造价值</strong> 🚀
</p>

<p align="center">
  Made with ❤️ by the EastGenesis Team
</p>
