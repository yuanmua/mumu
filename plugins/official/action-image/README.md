# @mumu/action-image

**是什么**：两个动作（handbook §9.4「工具即动作」）——
- `image`：把她电脑里的一张图片发进当前对话。参数 `{ path: "图片完整路径", alt?: "一句话说图里是什么" }`。
  图要先存好：网上的图由 `search` 动作（kind:image，[action-search](../action-search/README.md)）搜好、下载到本地，`search.result` 列着路径；
  电脑里某张图不知道在哪时才用 `computer` 找到完整路径。拿到路径再 `start image`。
- `screenshot`：截她桌面此刻的样子直接发进当前对话，不用先 computer。参数 `{ alt? }`。**只听主人的**（描述里带 guard 的「（需要主人）」标记）。

## 怎么走

```
导演 start image {path}                         导演 start screenshot
  └ 后端本机有这个文件：读它（校验类型、大小）       └ 身体服务 GET /screenshot?scale=&fmt=jpeg&q=
    没有：经身体服务 GET /image?path=&max= 取
  └ 存进媒体目录 data/media/<内容摘要前 16 位>.<扩展名>（同一张图只存一份，名字不变）
  └ 同一对话两分钟内发过同一张就不再发
  └ a.utter() 发一个 Part { kind: 'image', data: { media, mime, alt? } }，立刻结束这条发声
  └ a.remember「刚把图发给对方了」→ 动作结束唤醒导演，导演再起 reply 说两句
```

「主人 @ 她截图桌面发群里」「搜一张猫的图片发群里」整条链：
reflex 认出「要她做事」不反射 → 导演同一拍 `start reply`（应一声）+ `start screenshot` / `start search {kind:"image"}`
→（screenshot 由 guard 认号放行或拦下，拦下的用自己的话拒绝；search 谁都能用）→ search.result 回来 → `start image {path}`
→ surface-onebot 把 image Part 发成 QQ 图片消息（`compose.ts` 的 `mediaItem`）。2026-10-22 之前网上找图走 computer 开浏览器，几分钟才回、常失败。

- **为什么 screenshot 单列、image 不标「需要主人」**：截桌面发群里 = 把主人的屏幕给群里看，必须认人。image 发的是 computer 存下的文件，
  computer 本身已经只听主人的；而网上找图常要两三分钟，guard 往回找「是谁让做的」只看最近 `requesterWindowSec`（120 秒），
  标了的话 computer.result 那拍已经找不到主人那句，主人自己的图会被误拦。
- **日志里只有文件名**：图片本体不进日志（日志要重放给每个浏览器）。网页经 surface-web 的 `GET /api/media/<name>`
  取图（[web-protocol.md](../../../docs/web-protocol.md) §3），前端在消息气泡和字幕里显示。
- **内核不认识 image**：哪个表现端认识就显示，不认识的忽略（handbook §5.1 的能力降级规则）。
- **图片不计送达账**：只有 `Part.text` 计入 delivered，所以这条发声没有字、立刻结算；网页对「只有图没有字」的消息不当成空气泡删掉。
- **先读本机路径，没有再问身体服务**：后端与她的电脑同机时（`C:\mumu` 在 VM 上）直接读；后端在别处跑（Mac 上的测试实例）时经身体服务 `/image` 取，
  取回来的是缩过的 JPEG（长边 `imageMax`）。
- **频道兜底**：同 action-computer，意图不带频道时取最近一条对方消息所在的对话。
- 不说话：为什么发、觉得怎么样交给随后的 reply。

> 没发出去时工作记忆里只写「电脑那边连不上」这类她能说的话（2026-10-22 全量测试：她在群里原话「截图没发出去，连不上身体服务」）；
> 技术原因记日志 `image.failed { what, why }`。

> **不是图片就抛错**（扩展名不是 png / jpg / webp / gif，或身体服务回的类型不是图片）：动作结局 `error`，内核以「动作 image#n 出错：…」唤醒大脑，
> 文案直接指路「发文件用 `qq.send {"op":"file","path":…}`，发语音用 `qq.send {"op":"voice","path":…}`」。
> 2026-10-23 真群：电脑动作把一首 mp3 下到了 Pictures，大脑交给 image，这边只记一句「不是图片」、结局 done，大脑想不到换 qq.send，
> 她跟主人说「你直接去我电脑那个路径拿吧」。别的失败（没路径、文件不在、连不上）仍是记工作记忆、结局 done。

## 教学段落

| 段落 | 受众 | 内容 |
|---|---|---|
| `image-teaching-mind` | mind | 【发图片 / 文件】要看桌面 / 截图 → screenshot；要网上的图 → search（kind:image），结果回来挑一张 image；电脑里不知道在哪的图 → computer 找到路径再 image；image 只发图片，mp3 / zip / pdf 这类用 `qq.send` file、语音用 voice；发完 reply 说两句 |
| `image-teaching` | performer | 能截桌面、发电脑里的图；记忆里写着已发才算发了，没发前只说「这就去弄」 |

## 配置（`plugins.action-image.*`）

| 键 | 默认 | 说明 |
|---|---|---|
| `dir` | `data/media` | 媒体目录，相对后端工作目录；要和 surface-web 的 `media` 一致 |
| `maxMB` | 15 | 单张上限 |
| `bodyUrl` | `http://127.0.0.1:8765` | 身体服务地址；和 action-computer 的 `url` 一致 |
| `bodyTokenSecret` | `""` | secrets 里身体服务 token 的名字；没开 token 留空 |
| `imageMax` | 2048 | 经身体服务取图时长边缩到多少像素 |
| `shotScale` / `shotQuality` | 1 / 85 | 截桌面的缩放与 JPEG 质量 |

## 依赖

无（Node 自带 `fs` / `crypto` / `fetch`）；注入 `secrets`（身体服务开了 token 时取 token）。
