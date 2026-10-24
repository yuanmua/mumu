# @mumu/surface-web

**是什么**：Web 传输层。零依赖 HTTP + SSE，实现 [docs/web-protocol.md](../../../docs/web-protocol.md) 的全部端点，并服务 `apps/web/dist` 的构建产物。**不含任何界面逻辑**，界面在 `apps/web`。

**端点**（详见协议文档）

| 端点 | 作用 |
|---|---|
| `GET /api/events` | SSE：先重放最近 `replay` 条日志，再 `__live__`，再直播；模型 chunk 走 `__stream__` |
| `GET /api/conversations` | 对话列表（`conversations.ts`）：每个频道的来源（频道名 `<platform>:<kind>:<id>` + 感知 `data.platform/chat/groupName` + 私聊 `sender.name`）、别人说过几句、她今天说了几条；不认识任何具体平台 |
| `GET /api/meta` | 协议版本、角色名（经 `web/meta` 水线由 persona 补）、舞台与角色列表（由 characters 补）、皮肤列表 `skins`（本插件扫 `dist/live2d/models/*/profile.json`）、语音是否可用、可用命令 |
| `GET` / `POST /api/persona` | 读 / 写 persona 的配置（`persona.ts`）：读的是清单 defaults 被配置库覆盖后的合并值；写入经 config 服务，persona 恰好重载一次 |
| `GET` / `POST /api/models` | 读 / 写 provider-openai 的角色绑定（模型路由，`models.ts`）：读合并值 + 出厂值 + 已存密钥名 + 一键填充预设；写入时提交完整 roles，这里用 `diffPatch` 只把和出厂不同的部分存进库，provider-openai 重载一次 |
| `POST /api/input` | 发一句话（urgent，打断正在说的） |
| `POST /api/delivered` | 回报已呈现字符数（I2 的落点） |
| `POST /api/clear` | 清除记忆（日志 + 工作记忆；配置库不动） |
| `POST /api/tts` | 文本 → 音频（需要 tts 插件就绪） |
| `POST /api/command` | 执行管理命令，返回输出行 |
| `POST /api/perception/start\|update\|end\|cancel` | 流式感知（浏览器语音识别） |
| `GET /api/plugins` · `GET`/`PUT /api/plugins/:id/config` · `POST /api/plugins/:id/enabled` | 通用设置（`admin.ts`）：插件列表与失败原因；任一插件的出厂值 / 库里补丁 / 合并值 + 清单 `mumu.ui` 提示；提交完整配置，`diffPatch` 落库后显式重载该插件一次（重载自己时先回响应） |
| `GET` / `POST /api/secrets` | 密钥只写不读：列表只有名字与时间（`admin.ts`） |
| `GET /api/status` | 状态卡片：网页连接、插件失败、在跑的动作，其余（模型路由由 provider-openai 报）由插件经 `web/status` 追加（`admin.ts`） |
| 其他 `/api/*` | 交给水线 `web/route` 由插件认领（`extend.ts`）；没人认领 404 |
| 其他路径 | 静态产物；无扩展名回 `index.html`；没构建时 503 说明 |

**暴露什么**：水线 `web/meta`（其他插件往 meta 里补字段，含 `panels` 面板定义）、`web/route`（插件自带接口）、`web/status`（状态卡片）；
类型 `WebRoute` / `WebPanel` / `PanelAction` / `StatusCard` 随 `index.ts` 导出（别的插件 `import type`）。写法见协议文档 §7。

**机制**：只在有浏览器连着时才向内核注册为有回执的表现端；`tts` 是可选服务，没装就 `voice.available=false`。

**怎么改它**

- 端口、重放条数、产物目录、兜底角色名：`mumu.defaults`。
- 模型面板的一键填充（常用端点，如 DeepSeek、本地 4090）：`modelPresets`，只影响界面，不进 provider。
- 「合并后视图」（人格、模型）一律用 `mergePatch`，与装配层同一规则；网页落库只存与出厂不同的部分（`diffPatch`）。
- 加端点：先改协议文档，再在 `api()` 里加分支，前端 `protocol/client.ts` 同步。逻辑多的拆到同目录小文件（如 `persona.ts`、`skins.ts`）。
- 别的插件要上网页：**不改本插件**，按协议文档 §7 认领 `web/route`、经 `web/meta` 报 `panels`、认领 `web/status`；样例见 `characters/web.ts`。
  用水线不用服务：本插件常被重载（换皮肤、改端口），服务一消失注入它的插件都要连带重载。
- 设置表单里的敏感字段（名字以 key / token / secret / password 结尾，或 `mumu.ui` 标 `secret`）一律回 `••••••`，原样提交 = 不改（`settings.ts`）。
- 为什么 `/api/persona` 不走 `/api/command` 拼 `/config set`：人设里常有引号与换行，命令行转义不可靠。
  persona 的清单默认值用 `scanPlugins('plugins')` 现扫（与装配层同一个根），内置的「要求」文案在 persona 代码里，不经本接口暴露（`rules: null` 表示用它）。
- 对外暴露（非本机）：另写一个反代/鉴权插件，本插件只绑回环地址。
