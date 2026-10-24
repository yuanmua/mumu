# @mumu/characters

**是什么**：角色包。把「她是谁（persona）、站在哪个舞台上（live2d / tachie）、用什么声音（tts）」打包成一个目录，一条命令整体切换。

```
plugins/official/characters/
├─ index.ts              命令 + web/meta 水线
├─ pack.ts               character.json 的形状与校验（纯函数）
└─ characters/
   ├─ mumu/character.json     沐沐（默认角色）：persona 默认人设原样搬来；舞台 live2d（暂用 Hiyori 皮肤，无表情文件、全靠参数姿态；想换回 Haru 改 stage.profile）
   └─ yuanmu/character.json   原木：书灵少女；舞台 tachie（立绘，图在 apps/web/public/characters/yuanmu/）
```

`persona.style` 只写**她自己的腔调**（口头禅、句尾习惯、被夸了怎么反应）。「像真人说话」的底线（短、口语、不列条目、不客服腔、`[旁白]` 不是对方说的……）由 persona 插件统一追加，角色包里不要再抄一遍。

`character.json` 的形状：

```json
{
  "id": "yuanmu",
  "name": "原木",
  "persona": { "prompt": "…", "style": "…", "markers": { "emo": ["脸红"], "act": ["翻书"] }, "aliases": { "qq": "网名（可省）" } },
  "stage": { "kind": "live2d" | "tachie", "profile": "<相对 apps/web/public 的目录>" },
  "voice": { "voice": "FunAudioLLM/CosyVoice2-0.5B:bella" }
}
```

`stage.profile` 是前端去取舞台档案的目录：`/<profile>/profile.json`。live2d 的档案见 `apps/web/public/live2d/models/<id>/profile.json`，tachie 的见 `apps/web/public/characters/<id>/profile.json`（格式在 `apps/web/README.md`「舞台实现」）。
`persona.markers` 里的角色专属词必须同时写进舞台档案的映射，否则到了舞台只会降级成通用小动作。

**暴露什么**

- 命令 `/character list`：列出全部角色包，标出当前。
- 命令 `/character use <id>`：切换。它只是「一次写多处」：
  - `plugins.persona.{name,prompt,style,markers,aliases}` ← persona（persona 插件自动重载，下一句话起生效）；包里没写 `aliases` 就存 `null` 清掉，免得别的角色顶着上一个角色的网名
  - `plugins.tts.voice` ← voice.voice（有才写）
  - `plugins.surface-web.character` ← `{ id, stage }`（surface-web 自动重载；网页重连后换舞台）
- 命令 `/character skin <profile> [live2d|tachie]`：**只换当前角色的舞台**，不动人设与声音（「名字不换、皮肤暂用这个」）。
  只写 `plugins.surface-web.character.stage`（`id` 保留），`kind` 缺省 `live2d`；`profile` 与角色包里的 `stage.profile` 同一校验（`pack.ts` 的 `parseStage`，不许 `..`）。
  下次 `/character use` 会回到角色包自己的舞台。`/character list` 在当前角色后标出换过的皮肤。
- `web/meta` 水线：把 `plugins.surface-web.character.stage` 放进 `meta.character.stage`、当前包 id 放进 `meta.character.id`，
  全部角色包 `[{ id, name, stage }]` 放进 `meta.characters`，前端据此选舞台实现、画「角色」下拉。surface-web 本身不认识角色包。
- 网页「设置 → 面板 → 角色包」与状态页「角色」卡（`web.ts`）：认领 `GET /api/characters/packs`、`POST /api/characters/use`（体 `{ item: { id } }`），
  经 `web/meta` 报 `panels`、经 `web/status` 报卡片——也是「插件如何上网页」（协议文档 §7）的最小样例。

本插件不持有角色状态：它消失了角色也还在，配置都在各自插件名下。

**怎么改它**

- 加角色：新建 `characters/<id>/character.json`，重启（新目录要重新扫描；已有包改内容只需 `/plugin reload characters`）。
- 坏掉的包会被跳过并在终端告警，不影响别的包。
- 角色包目录可配：`/config set plugins.characters.dir 别的目录`（相对插件目录）。
- 为什么 surface-web 的配置延后 300ms 才写：写入即重载 surface-web，重载会立刻断开全部连接——包括正在跑这条命令的那个 HTTP 请求（Web 调试页）。先让回复发出去。
- 为什么 persona 先整棵写再写一个叶子：顶层路径不触发重载，叶子触发恰好一次；逐个叶子写会触发多次并发重载互相打架。
