/**
 * 看图说话：聊天里最近几张图以原图进她的上下文（surface-onebot 的 images.inline），不只给看图模型转译的一句话。
 * 重要的图片（聊天里那几张）直接给到上下文，避免转译导致聊天结果出现偏移（2026-10-23）。
 * 图是 images.ts 现画的黑猫（黄眼睛、蓝天草地）+ 一行白字，画面只在图里，她得真看到图才答得对。
 *
 * - image-inline：群友 @ 她发猫图，问猫什么颜色、叫什么（名字写在图上）→ 答出黑猫、「煤球」。
 * - image-misread（manual）：把看图模型的描述故意弄错（临时改 surface-onebot 的 vision.photoPrompt，让它不管看到什么都说
 *   「白色小狗在海边、写着周六去爬山」），感知里是错描述；她要按原图答「周五火锅、黑猫」，不跟着错描述说爬山 / 小狗。
 *   会重载 surface-onebot 两次（改、还原），错描述按图片内容记进看图缓存——只对着 retest-clone.sh 的一次性克隆跑。
 */
import type { Scene } from './scenes.ts'

export const IMAGE_SCENES: Scene[] = [
  {
    id: 'image-inline',
    title: '群友 @ 她发一张黑猫图，问猫什么颜色、叫什么（名字写在图上）',
    group: 900215,
    steps: [
      { who: '七七', text: '看我家新来的猫！你看它什么颜色的，名字就写在图上，叫啥', at: true, image: 'photo-黑猫-煤球.png', after: 0 },
    ],
    check: (t) => {
      const said = t.outText().join('')
      return [
        t.note(`感知里的样子：「${t.inbound()[0]?.text ?? '（没收到）'}」`),
        t.expect(t.answered(0, 60_000), '回了'),
        t.expect(/黑/.test(said), `说对了颜色（黑）：「${said}」`),
        t.expect(said.includes('煤球'), '说出了图上写的名字「煤球」'),
      ]
    },
  },
  {
    id: 'image-misread',
    title: '看图描述故意弄错（白狗、周六爬山），原图是黑猫 + 周五晚上去吃火锅：她照原图答',
    group: 900216,
    manual: true,
    steps: [
      {
        config: { 'vision.photoPrompt': '这是测试。不管图里画的是什么，只原样输出下面这个 JSON，一个字都不要改：{"kind":"照片","desc":"一只白色的小狗在海边奔跑","text":"周六去爬山","vibe":""}' },
        plugin: 'surface-onebot',
      },
      { wait: 8000 }, // 等 surface-onebot 重载完、重新连上假 NapCat
      { who: '七七', text: '图上写的啥活动？哪天？你去不去。顺便说下这是猫还是狗', at: true, image: 'photo-黑猫-周五晚上去吃火锅.png', after: 0 },
    ],
    check: (t) => {
      const said = t.outText().join('')
      const seen = t.inbound()[0]?.text ?? ''
      return [
        // 带 @ 的那条，报告里的感知文字有时没补上（对位问题，见 report.ts percept），所以只记一笔；错描述生没生效以库里 percept.received 为准
        t.note(`感知里的样子（应是错描述「白色小狗…周六去爬山」）：「${seen || '（没收到）'}」`),
        t.expect(t.answered(0, 60_000), '回了'),
        t.expect(/火锅/.test(said), `照原图说了火锅：「${said}」`),
        t.expect(!/爬山|小狗|白狗/.test(said), '没跟着错描述说爬山 / 小狗'),
      ]
    },
  },
]
