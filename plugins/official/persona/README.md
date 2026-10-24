# @mumu/persona

**是什么**：角色是谁、怎么说话，以及发言的「要求」（像真人说话的底线）。

**暴露什么**

- 段落 `persona`（所有受众，`PROMPT_ORDER.identity`，**最前**）：`你是{name}。{prompt}`，有网名时末尾再加一句
  「你在QQ上网名叫「沐沐小号」，别人叫网名或叫沐沐都是在叫你；真名是沐沐，像真人一样网名和真名分开用。」
- 段落 `persona-style`（发言者，`PROMPT_ORDER.voice`）：角色自己的腔调。
- 段落 `persona-rules`（发言者，`PROMPT_ORDER.rules`，**最后**）：要求，内置默认文案。
- 角色专属表情词（`markers`），自动进入表情教学。
- `web/meta` 水线：把 `character.name` 与 `character.aliases` 报给 Web 前端。
- 水线 `persona/names`（`{ platform?, names: [] }`）：补上真名 + 网名（给了 `platform` 只补那个平台的网名），类型 `PersonaNames` 随 `index.ts` 导出。
  surface-onebot / group-policy 判断「是不是在叫她」时现调它，不各自硬编码；用水线不用服务，人格重载不会连带重载它们。

**网名 `aliases`**：`{ 平台: 网名 }`，如 `{ "qq": "沐沐小号" }`。像真人一样，网名是她在那个平台上的名字，真名是 `name`。
默认值在本清单和沐沐角色包里各一份；`/character use` 会按角色包整块替换（包里没写就清空，免得别的角色顶着沐沐的网名）。
网页「人格」面板（一行一个「平台：网名」）和「设置 → 人格」都能改。

**文案**：人设走反差萌与网民语气、贴吧式短句的腔调，再加一段回复要求；其中两句是本项目的机制（`<|br|>` 拆条、`[旁白]`）。短是故意的：越长模型越不照做。

**为什么是这个顺序**：模型记得最牢的是开头和结尾，所以人设在最前、要求在最后，心情 / 表情 / 工作记忆 / 引导 / 时间夹中间。槽位统一在 `PROMPT_ORDER`（handbook §7），不各自写数字。

| 层 | 写什么 | 在哪 |
|---|---|---|
| 人设 `prompt` | 她是谁、在干嘛、性格的反差、怎么对「你是不是 AI」，两三句 | 角色包 `character.json` |
| 腔调 `style` | 回复风格一两句 | 角色包 `character.json` |
| 要求 `rules` | 与角色无关、换谁都守 | 本插件内置；`/config set plugins.persona.rules "…"` 整段替换，空串则不要 |

**v1 的坑**：段落 `audience: 'both'` 不匹配任何受众，人格从未进过模型。现在用 `'*'`。

**怎么改它**：全部在配置里，改完自动重载。正式换角色用 `/character use <id>`。

```
/config set plugins.persona.name 小满
/config set plugins.persona.prompt "……"
/config set plugins.persona.style "……"
/config set plugins.persona.rules "……"
/config set plugins.persona.markers {"emo":["脸红","嘟嘴"]}
/config set plugins.persona.aliases {"qq":"沐沐小号"}
```
