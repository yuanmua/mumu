# 沐沐 · AI 协作规则

> 这份文件给**写代码的 AI**（Claude Code 等）看，也给人看。进入本仓库的任何会话先读它。
> 它只讲「怎么干活」。项目是什么、为什么这样设计，在 [docs/handbook.md](docs/handbook.md)。

## 0. 一句话

沐沐是一个 **AI 数字角色内核**：一切即插件、流式可打断、主大脑不说话。
TypeScript + Node 22.15+，ESM，内核零运行时依赖。代码由 AI 编写，由文档约束。

## 1. 阅读顺序

| 任务 | 先读 |
|---|---|
| 任何任务 | 本文 → [docs/handbook.md](docs/handbook.md)（§2 判据、§5 核心约定、§9 决策记忆） |
| 改内核 | 再读 [docs/kernel.md](docs/kernel.md) 与 [docs/architecture-paper.md](docs/architecture-paper.md) §9 冻结契约 |
| 写插件 | handbook §6 扩展点、§7 插件约定，再看一个最像的官方插件 |
| 做外围（插件 / Web 前端 / Live2D / QQ） | 切到 `bridge` 分支，读那边的 docs/periphery.md 与 docs/web-protocol.md |
| 不知道现状 | handbook §12 当前状态 |

读完再动手。**不要凭记忆猜 API**：类型在 `src/index.ts` 一处导出，打开看。

## 2. 不可逾越的边界（有测试守着，越界会红）

1. 内核对外只经 `src/kernel/index.ts` 一个出口。内核外任何文件不许 import `src/kernel/<子路径>`。
2. 插件只从 `src/index.ts` 导入，不许摸 `src/` 内部其他文件。
3. `apps/` 下的前端应用**不许 import `src/`**，只认 web-protocol.md 的 JSON 契约（`apps/` 与该文档在 `bridge` 分支）。
4. 内核里不出现：provider、动作名、表情、会话形态、模态、存储介质、任何一句中文渲染。
   判据：**换一个插件能不能换掉它？** 能 → 它是插件，不进内核。
5. [architecture-paper.md §9](docs/architecture-paper.md) 列的契约是冻结的。要改，先改 handbook §9.3 写清为什么，再改代码。
6. 插件之间只许 `import type`（服务契约随提供方的 `index.ts` 导出，如 `CommandService`、`SecretsService`）；
   运行时协作一律走服务（`inject` + `ctx.use`）、水线、事件，不许 import 另一个插件的实现。

## 3. 工作流（每次改动都走一遍）

1. **先说做什么**：一两句话写出改动范围与不改的范围，再动手。
2. **改**：一次只做一件事。顺手发现的别的问题记到汇报里，不混进来。
3. **验证**：
   ```bash
   npm run check && npm test
   ```
   不许为了让测试过而删测试或放宽断言；测试红了先搞清为什么。
4. **更新文档**（见 §5 表）。代码与文档不一致 = 没做完。
5. **汇报**：做了什么、验证结果原样贴（失败就说失败）、没做什么与为什么、下一步建议。

## 4. 禁止

- 往任何文件里写密钥、token。密钥只经 `/secret set` 存进本地库，配置里只写密钥的名字（`apiKeyRef`）。
- 新增全局配置文件或环境变量（内核裸启动是定档决定）。
- 给 `src/` 加运行时依赖。插件与 `apps/` 可以有自己的依赖，但每个新依赖要在该包 README 写一行理由。
- 引入「最近一次…」式的全局可变态（handbook §5.7）。
- 用正则解析模型输出（handbook §9.2）。
- 大改目录结构、重命名公共 API、删除文档——这些先问用户。
- `git push`、`git commit`、`rm -rf` 数据目录——先问用户。
- **测试工具整库清空**（用户定的规矩，2026-10-22）：探针、模拟器、压测、清理脚本一律不许调 `/api/clear` 或清 events / 记忆表；
  要「没有历史」就开新的测试频道（`c:probe-*`、模拟器每轮的新群号、压测里同一个人的新小号）。压测要在不断累积的状态下量，不清。
- **清理前不备份**：任何会删数据的操作（网页的清除按钮、清理脚本、手工删库）之前必须先自动备份整库到 `data/backups/`
  （`backup` 服务 / `VACUUM INTO`）；备份失败就不删。

## 5. 哪个改动更新哪个文档

| 改了什么 | 必须同步 |
|---|---|
| 内核机制 / 公共类型 | `docs/kernel.md` 对应小节；若触及冻结契约，还有 `docs/architecture-paper.md` §9 与 handbook §9.3 |
| 新扩展点（waterfall / emit / 服务键） | handbook §6 表 + `docs/kernel.md` 表 |
| 新增 / 删除 / 改职责的插件 | 该插件 `README.md` + handbook §7 官方插件表 |
| Web 协议（端点、事件、字段） | `bridge` 分支：**先改** `docs/web-protocol.md`，再改 `plugins/official/surface-web` 与 `apps/web` |
| 外围结构、里程碑完成 | `bridge` 分支：`docs/periphery.md` 进度表 + 对应插件 / `apps/web` 的 README |
| 做完一个阶段 / 改了方向 | handbook §12 当前状态 |
| 否决或推迟了一个方案 | handbook §9 决策记忆（这是文档存在的主要理由） |

文档里**不写会过期的数字**（行数、测试数、日期以外的统计）；写「以 `npm test` 为准」。

## 6. 代码风格

- 中文注释，写**为什么**，不写代码在干嘛；文件头 JSDoc 说清该模块的契约与立场。
- 错误与控制台文案用英文：抛错写 `<发生了什么>: <标识>`（小写开头、不加句号、不加模块前缀）；控制台写 `[模块] <发生了什么>: <标识>`，模块名即目录名，不用 ✓ ✗ 这类符号。原因写注释，文案只留定位用的标识（插件 id、服务名、路径…）。
- 早返回、少嵌套；不为「以后可能用」预留抽象。
- 空 `catch` 必须写清吞了什么、为什么安全。
- 单文件超过约 300 行（前端组件约 200 行）就拆。
- 单引号、无分号、两空格缩进，与现有代码一致。
- 不用 `any`；类型从 `src/index.ts` 导入，不自己再声明一份。

## 7. 命令

```bash
npm start              # 裸启内核；有输入输出要往 plugins/ 放插件（官方插件在 bridge 分支）
npm run check          # tsc 严格模式
npm test               # node:test，含三条边界测试
```

运行期命令（终端或调试页「命令」）：`/help` · `/plugins` · `/plugin enable|disable|reload <id>` · `/config get|set <路径> [值]` · `/secret set|del|list` · `/log [n]` · `/stream <话>` · `/quit`

**改了对话行为（mind / reflex / reply / persona / group-policy，都在 `bridge` 分支）要测**，但分两层（用户定的规矩，2026-10-22）：
- **单项改动**：只跑与自己改动相关的场景（`probe.ts <场景>`、`fake-onebot.ts <场景>`），**不跑全量**探针 / 模拟器全场景 / 压测——全量一轮至少半小时。
- **全量聊天测试**（探针全场景、模拟器全场景、`replay.ts` 压测）在几处改动都收尾后单独跑一次并出报告。
- **真实聊天里暴露的问题必须进测试集**：按日志原样做成 `scripts/fake-onebot/` 的场景（谁说了什么、她当时错在哪、现在要求什么），不能只口头修。

> 收尾时确认进程真的退了：`pgrep -f 'tsx src/main.ts'`。残留进程会占住端口。

## 8. 提交约定（用户要求提交时才提交）

- 一个改动一个提交；信息中文，格式 `范围: 做了什么`，例：`surface-web: 传输层改为只服务 /api 与静态产物`。
- 提交前确认没有 `data/`、没有 `node_modules/`。
- 含密钥的文件永远不提交。
