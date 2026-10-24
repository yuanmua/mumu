# action-extend · 她给自己加功能

## 是什么

主人说「给自己加一个功能：每天晚上十一点提醒我睡觉」，她真的能做：写一个小插件、自己检查、装上，然后用自己的话说加了什么。
坏了也能自己修：类型检查不过、装上时报错，报错原文喂回去让她改。

## 流程

```
导演 start extend {name, purpose}
  → task.agent 按插件契约写 plugins/user/<name>/{package.json,index.ts,README.md}   （author.ts 的提示词：契约 + API 速查 + clock 做模板）
  → 护栏检查（不过 → 把违反的条目喂回去重写）
  → 落盘 → npm run check（只认这个插件目录里的报错）
  → loader.scan()（新目录不重启就装上；已装过的 reload）——apply 抛错也算失败
  → 成功：extend.result 感知唤醒导演 + 工作记忆，她开口说加了什么、怎么用
     失败：同样回报，说卡在哪
```

每一步的错误都会喂回给模型改，最多 `maxFixes` 次（默认 3）。日志：`extend.attempt { name, n, problem }`、`extend.installed { name, tries, summary }`。

## 护栏（第一版）

- 只写 `plugins/user/<name>/` 下的平铺文件：`package.json`、`index.ts`、`README.md`、至多 4 个 `.ts`；名字只许小写字母、数字、短横线。
- 只许 `import '../../../src/index.ts'`（和同目录子模块）；`require(`、动态 `import(`、`child_process`、`fs`、`process.exit`、`eval` 都不许出现。
- `package.json` 不许有任何依赖，`mumu.id` 必须等于 name；不能用官方插件的名字，不碰 `plugins/official`。
- 只有主人能让她用：动作描述里标了「（需要主人）」，guard 插件在 `intent/pre-dispatch` 上拦。
- 装配层失败隔离：用户插件装不上只跳过它（`/plugins` 里带 ✗ 原因），不影响她本身。

## 暴露什么

- 动作 `extend`，参数 `{ name, purpose }`；`name` 写已有的用户插件 = 在它基础上改（修 bug）。
- 感知 `extend.result`（唤醒导演）。
- 段落：发言者「你能给自己加功能、加过哪些」；导演「怎么用 extend、结果怎么回来」。
- 命令 `/extend`：她加过的功能与最近的尝试。
- 网页面板「她给自己加的功能」：每个功能的用途、状态、最近尝试，按钮停用 / 启用 / 卸载（卸载 = 挪到 `data/extend-trash/`，不直接删）。

## 怎么改

`/config set plugins.action-extend.<键>`：`role`（写代码用的模型角色，默认 `task.agent`）、`maxFixes`、`checkTimeoutSec`、`userDir`。
想放宽护栏（比如允许 import 某个官方插件的类型）：改 `author.ts` 的 `audit`，并在这里写清为什么。
