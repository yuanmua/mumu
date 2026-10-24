# 沐沐 (Mumu)

AI 数字角色内核。一切即插件 · 流式可打断 · 主大脑不说话。

沐沐不是聊天机器人框架，而是一个「活着的角色」：大脑只决定做什么、不说话，发言、动作、表情都是并行的插件；
说话途中随时可以被打断，日志只记对方真正看到 / 听到的那一段。她可以在网页里以 Live2D 形象和你聊天，
也可以接 QQ 进群「读空气」，还能操作一台 Windows 电脑替你做事。

## 能做什么

- **内核**：服务容器、事件与 waterfall、贡献集合、append-only 日志、模型网关、流式解析、心跳调度、动作、提示词、输入输出——零运行时依赖，契约冻结（handbook §4）
- **大脑 + 脊椎**：每条消息先过大脑决定回不回、怎么回、要不要起动作；脊椎只管合流、硬闸和兜底
- **表现端**：终端、网页（Vue + Live2D / 立绘舞台、流式字幕、语音、思考可视化、可视化设置）、QQ（NapCat / OneBot v11）、桌宠
- **群聊**：按「在聊 / 没在聊」读空气、认得群里的机器人、按人记脾气、她自己维护的兴趣表（本机句向量打分）
- **角色**：人设、记忆、情绪、时间感、生活状态、表情包；角色包一键切换人设 / 舞台 / 声音
- **动作**：搜索、发图、操作电脑（Windows 身体服务）、委托编码代理；`guard` 按「谁让她做的」把关
- **模型路由**：OpenAI 兼容端点通吃（DeepSeek / OpenAI / 本地推理），按角色绑定、失败自动改用另一家

## 快速开始

需要 Node.js 22.15+。

```bash
npm install
npm start                    # 终端里对话；网页传输层在 http://127.0.0.1:3939
```

第一次启动后在终端里存模型密钥（存进本地 SQLite，永不进文件）：

```
/secret set deepseek sk-…
```

想用网页和 Live2D 角色聊天：

```bash
npm run build:web            # 构建前端，之后浏览器打开 http://127.0.0.1:3939
```

**没有配置文件**：内核裸启动，装什么插件由 `plugins/` 目录决定，各插件的默认配置写在自己的 `package.json`（`mumu.defaults`），
运行期用 `/config set` 或网页「设置」改，存进本地库并即时生效。说话途中回车插话即可打断；`/plugins` 看插件，`/quit` 退出。

### Live2D 资源

仓库不带 Live2D 的运行时和模型：

- **Cubism Core** 默认从 Live2D 官方 CDN 加载；想离线用见 `apps/web/index.html` 里的说明。
- **模型**从 [Live2D/CubismWebSamples](https://github.com/Live2D/CubismWebSamples) 取（`Samples/Resources/` 下的 Hiyori / Haru 等），放到 `apps/web/public/live2d/models/<id>/`，见 [apps/web/README.md](apps/web/README.md)。

这两样受 Live2D 自己的许可约束（[Live2D Proprietary Software License](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)、免费素材许可），不在本项目的 MIT 协议范围内。

## 目录

```
src/            内核（src/kernel）+ 装配层（src/loader），对外只经 src/index.ts 导出
plugins/        插件（有 package.json 的目录即插件），官方插件在 plugins/official/
apps/web        网页前端（只认 docs/web-protocol.md 的 JSON 契约，不 import src/）
apps/desktop    桌宠（Electron）
apps/body       Windows 身体服务（Python，让她能操作电脑）
scripts/        对话探针、假 NapCat 模拟器、回放与压测
test/           node:test，含三条边界测试
docs/           设计文档
```

## 文档

| 文档 | 内容 |
|---|---|
| [CLAUDE.md](CLAUDE.md) | **协作规则**：阅读顺序、边界、工作流、禁止项、文档维护责任。改代码前先读 |
| [docs/handbook.md](docs/handbook.md) | **项目手册**：定位、全部约定、决策记忆（否决过什么、为什么）、当前状态 |
| [docs/architecture-paper.md](docs/architecture-paper.md) | 内核论文：机制论述、失效模型、**§9 冻结契约** |
| [docs/kernel.md](docs/kernel.md) | 内核手册：每个机制怎么用、扩展点、已知取舍 |
| [docs/periphery.md](docs/periphery.md) | 外围方案：插件套件 + 网页 + Live2D，目录、投影规则、里程碑 |
| [docs/web-protocol.md](docs/web-protocol.md) | 网页协议：插件与浏览器之间的唯一契约 |
| [docs/mindcore-architecture.md](docs/mindcore-architecture.md) | 上层架构方案（含尚未实现的部分） |
| [docs/mindcore-requirements.md](docs/mindcore-requirements.md) | 原始需求 |
| `plugins/official/<id>/README.md` | 各插件自己的说明 |

## 开发

```bash
npm run check && npm test                                  # 类型检查 + 测试
npm run check:web && npm run test:web && npm run build:web # 前端
npx tsx scripts/probe.ts                                   # 改了对话行为后跑对话探针
```

## 协议

[MIT](LICENSE)
