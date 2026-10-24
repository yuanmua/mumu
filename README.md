# 沐沐 (Mumu) · 内核

AI 数字角色内核。一切即插件 · 流式可打断 · 主大脑不说话。

这个分支（`main`）只放内核和装配层。内核不认识任何模型提供方、动作、表情、会话形态、存储介质，也不写一句面向人的文案——这些全是插件的事。

| 分支 | 是什么 |
|---|---|
| `main` | 内核主线。往「进出都是带类型的多模态流」演进：媒体片段、内容寻址的 blob、训练级日志轨迹已经定了形状 |
| `bridge` | 在这个内核上靠 API 接入外界的完整产品：大脑与发言插件、记忆、网页 + Live2D、QQ（NapCat）、操作电脑。想直接用、直接聊，切到这个分支 |

## 内核有什么

| 机制 | 一句话 |
|---|---|
| container | 服务容器 + 依赖注入；注册即可撤销 |
| bus | `emit`（通知）+ `waterfall`（环绕中间件，可短路）——插件改插件的落点 |
| registry | 通用贡献集合，插件也能开自己的 |
| log | append-only 日志，唯一真源；模型历史、界面、回放都从它投影 |
| gateway | 插件声明模型**角色**，配置绑定具体模型，用量记账 |
| stream | 流式片段 + `<\|track:值\|>` 标记的流式安全解析 |
| scheduler | 心跳：合流 / 退避 / 熔断 + 决策器槽位 + 开放材料 |
| actions | 动作类型、实例多开、生命周期、频道流转 |
| prompt | 段落贡献 + 工作记忆（双重衰减） |
| io | 感知进、表现出、发声流、送达回执 |

几条底线：

- **主大脑不说话**：决策器只产出意图，说话、做事都是动作实例，可以并行、可以被打断。
- **只记对方真正收到的那段**：说到一半被打断，日志记的是送达的前缀，下一轮不会以为自己说完了。
- **日志是唯一真源**：不存在第二份状态；每段日志以 `log.opened` 开头，记下内核版本与日志格式版本。
- **内核零运行时依赖**，对外只经 `src/index.ts` 一个出口；插件之间只许 `import type`。

## 运行

需要 Node.js 22.15+。

```bash
npm install
npm run check && npm test   # 类型检查 + 测试（含边界测试）
npm start                   # 裸启内核
```

裸启的内核没有输入输出：装什么插件由 `plugins/` 目录决定，有 `package.json` 的目录即插件，改插件文件自动热重载。
官方插件（终端、网页、模型适配、大脑、发言……）在 `bridge` 分支的 `plugins/official/`，写自己的插件可以照着看。

## 文档

| 文档 | 内容 |
|---|---|
| [CLAUDE.md](CLAUDE.md) | 协作规则：阅读顺序、边界、工作流、禁止项、文档维护责任 |
| [docs/architecture-paper.md](docs/architecture-paper.md) | 内核论文：机制论述、失效模型、**§9 冻结契约** |
| [docs/kernel.md](docs/kernel.md) | 内核手册：每个机制怎么用、扩展点、已知取舍 |
| [docs/handbook.md](docs/handbook.md) | 项目手册：定位、全部约定、决策记忆（插件部分对应 `bridge` 分支） |
| [docs/mindcore-architecture.md](docs/mindcore-architecture.md) | 上层架构方案（含尚未实现的部分） |
| [docs/mindcore-requirements.md](docs/mindcore-requirements.md) | 原始需求 |

## 协议

[MIT](LICENSE)
