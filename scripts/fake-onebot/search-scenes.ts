/**
 * 搜索：查资料、找图走 search 动作（直接调搜索 API），不再开电脑浏览器。
 * 真群 2026-10-22：主人说「网上搜一下可爱大肥鱼图片给群友看看」，她起 computer 开浏览器搜图，几分钟才回、常失败。
 * 现在要求：search 找到图 → image 发进群 → 说两句；整个过程不起 computer；不重复起 image。
 * 「大肥鱼」网上多指 DeepSeek 的蓝鲸吉祥物，图源常给王者荣耀的鲲：图全对不上时她该换个更准的词再搜，而不是硬发。
 * 会真的联网（360 图片搜索）并调看图模型，不动她的电脑。
 * send-file 是同一条「发东西」链的另一头：图片以外的文件走 qq.send file，不联网。
 */
import type { Scene } from './scenes.ts'

const OWNER = 'qq:20009' // scenes.ts 的「主人」（大远）

export const SEARCH_SCENES: Scene[] = [
  {
    id: 'search-image',
    title: '主人 @ 她「网上搜一下可爱大肥鱼图片给群友看看」→ search 找图 → image 发群里，不起 computer',
    group: 900190,
    settleMs: 120_000,
    steps: [
      { config: { owners: [OWNER] }, plugin: 'guard' },
      { who: '主人', text: '网上搜一下可爱大肥鱼图片给群友看看', at: true, after: 0 },
    ],
    check: (t) => {
      const search = t.actions.find(a => a.type === 'search' && !!a.ch && t.has(a.ch))
      const images = t.actions.filter(a => a.type === 'image' && !!a.ch && t.has(a.ch))
      const image = images[0]
      const pics = t.outText().filter(s => s.startsWith('[图片'))
      return [
        t.expect(!!search, `起了 search${search ? `（主人说完 ${Math.round((search.t - (t.ins[0]?.t ?? 0)) / 1000)}s）` : ''}`),
        t.expect(!t.actionStarted('computer'), '没起 computer（不开浏览器）'),
        t.expect(!!image && (!search || image.t > search.t), `search 之后起了 image${t.blockedList().length ? `（拦下过 ${t.blockedList().join('、')}）` : ''}`),
        t.expect(pics.length >= 1, `群里收到图片：${pics.join('；') || '没有'}`),
        // search 结果那拍起了 image，search 结束那拍又起一个（2026-10-22 两次实测都有）：起几次就该发出几张
        t.expect(images.length === pics.length, `没重复起 image（起了 ${images.length} 次，发出 ${pics.length} 张）`),
        t.expect(t.outText().some(s => !s.startsWith('[图片')), `嘴上也说了：${t.outText().filter(s => !s.startsWith('[图片')).map(s => `「${s}」`).join('') || '没说'}`),
      ]
    },
  },
  {
    // 真群甲 2026-10-23 16:12：电脑动作把洛天依《反乌托邦》下到了 Pictures 目录，大脑把 mp3 交给 image，
    // image 只记了一句「不是图片」就 done，她说「MP3 没法当图发，你直接去我电脑那个路径拿吧」。文件要走 qq.send file。
    // 当时还卡在 guard 的确认上（qq.send 在 confirm 里，主人在群里下令也先问一句）：她先问确认、主人回「确认」没叫醒她、过后起 qq.send 又被拦一次。
    // 现在 guard 的 askOwner（发文件 / 图 / 语音）主人要就直接做，场景用 guard 出厂的 confirm（含 qq.send），要求第一拍就发、不问确认
    id: 'send-file',
    title: '主人 @ 她把电脑里的 mp3 发群里 → 第一拍 qq.send {op:file}，不问确认、不交给 image',
    group: 900191,
    steps: [
      { config: { owners: [OWNER] }, plugin: 'guard' },
      { who: '主人', text: '你刚下的洛天依《反乌托邦》在 C:\\Users\\me\\Pictures\\luotianyi_antiutopia.mp3，发群里大家听听', at: true, after: 0 },
    ],
    check: (t) => {
      const mine = t.actions.filter(a => !!a.ch && t.has(a.ch))
      const file = mine.find(a => a.type === 'qq.send' && a.params?.op === 'file')
      const asImage = mine.filter(a => a.type === 'image' && /\.mp3$/i.test(String(a.params?.path ?? '')))
      const files = t.outText().filter(s => s.startsWith('[文件'))
      return [
        t.expect(!!file, `起了 qq.send file${file ? `（${String(file.params?.path)}，主人说完 ${Math.round((file.t - (t.ins[0]?.t ?? 0)) / 1000)}s）` : `；起过的动作：${mine.map(a => `${a.type} ${JSON.stringify(a.params)}`).join('、') || '无'}`}`),
        t.expect(t.guards.length === 0, `guard 没拦（没先问确认）${t.guards.length ? `：${t.blockedList().join('、')}` : ''}`),
        t.expect(!!file && mine[0] === file, `第一个动作就是 qq.send file${mine[0] && mine[0] !== file ? `（先起了 ${mine[0].type}）` : ''}`),
        t.expect(files.some(s => s.includes('luotianyi_antiutopia.mp3')), `假 NapCat 收到 upload_group_file：${files.join('；') || '没有'}`),
        t.expect(!asImage.length, `没把 mp3 交给 image${asImage.length ? `（交了 ${asImage.length} 次）` : ''}`),
        t.expect(t.outText().some(s => !s.startsWith('[文件')), `嘴上也说了：${t.outText().filter(s => !s.startsWith('[文件')).map(s => `「${s}」`).join('') || '没说'}`),
      ]
    },
  },
]
