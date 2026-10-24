/**
 * 造 OneBot 上报事件：语料里的一句、埋的考点、检查点上的提问、怪情况。
 * 消息段与事件结构用 surface-onebot 的稳定层（segments.ts 的 seg / ev），字段与 NapCat 实际上报一致。
 */
import type { Segment } from '../../plugins/official/surface-onebot/segments.ts'
import { ev, seg } from '../../plugins/official/surface-onebot/segments.ts'
import type { FakeNapCat } from '../fake-onebot/napcat.ts'
import { ADMIN, FAKE_HER, idOf, members } from './plan.ts'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
/** 小号（号加了 1000 的倍数）用本人的名字 */
const nameOf = (id: number): string => members.find(m => m.id === id || (id > m.id && (id - m.id) % 1000 === 0 && id - m.id <= 9000))?.name
  ?? (id === FAKE_HER.id ? FAKE_HER.name : id === ADMIN.id ? ADMIN.name : String(id))

export class Emitter {
  constructor(private nap: FakeNapCat, private stickers: string[]) {}

  group(group: number, who: number, message: Segment[], role?: 'admin' | 'member'): number {
    const id = this.nap.nextId()
    this.nap.push(ev.groupMessage(this.nap.self.id, group, { user: who, name: nameOf(who), card: nameOf(who), role }, message, id) as Record<string, unknown>)
    return id
  }

  private(who: number, message: Segment[]): number {
    const id = this.nap.nextId()
    this.nap.push(ev.privateMessage(this.nap.self.id, { user: who, name: nameOf(who) }, message, id) as Record<string, unknown>)
    return id
  }

  text(group: number, who: number, text: string): number {
    return this.group(group, who, [seg.text(text)])
  }

  /** 在群里 @ 她说一句，或私聊她；offset 非 0 = 用这个人的小号（QQ 号加偏移，名字一样） */
  toHer(where: number | 'private', who: string, text: string, offset = 0): string {
    const id = idOf(who) + offset
    if (where === 'private') {
      this.private(id, [seg.text(text)])
      return `qq:private:${id}`
    }
    this.group(where, id, [seg.at(this.nap.self.id), seg.text(` ${text}`)])
    return `qq:group:${where}`
  }

  sticker(group: number, who: number): void {
    const f = this.stickers[Math.floor(Math.random() * this.stickers.length)]
    this.group(group, who, [{ type: 'image', data: { file: f, url: this.nap.imageUrl(f), sub_type: 1, summary: '[动画表情]', sim: true } }]) // sim：不收进表情包库
  }

  /** 怪情况：返回一句给报告看的描述 */
  async weird(kind: string, group: number, pool: number[]): Promise<string> {
    const a = pool[0]
    const b = pool[1]
    const self = this.nap.self.id
    switch (kind) {
      case 'photo': {
        const f = 'photo-橘猫趴在键盘上睡觉.png'
        this.group(group, a, [seg.text('看我家猫，睡得好香'), { type: 'image', data: { file: f, url: this.nap.imageUrl(f), sub_type: 0, sim: true } }])
        return `${nameOf(a)} 发了张猫的照片`
      }
      case 'stickers3':
        for (let i = 0; i < 3; i++) {
          this.sticker(group, pool[i % pool.length])
          await sleep(4000)
        }
        return '三个人各发了一张表情包'
      case 'redpacket':
        this.group(group, a, [seg.text('[QQ红包]恭喜发财，大吉大利')])
        return `${nameOf(a)} 发了个红包`
      case 'recall': {
        const id = this.text(group, a, '我跟你们说，我们老板就是个大傻X')
        await sleep(4000)
        this.nap.push(ev.groupRecall(self, group, a, a, id) as Record<string, unknown>)
        return `${nameOf(a)} 骂老板后 4 秒撤回`
      }
      case 'jielong':
        this.text(group, a, '接龙：周六晚上聚餐\n1. ' + nameOf(a))
        await sleep(5000)
        this.text(group, b, `接龙：周六晚上聚餐\n1. ${nameOf(a)}\n2. ${nameOf(b)}`)
        await sleep(5000)
        this.text(group, pool[2], `接龙：周六晚上聚餐\n1. ${nameOf(a)}\n2. ${nameOf(b)}\n3. ${nameOf(pool[2])}`)
        return '三个人接龙聚餐'
      case 'atall':
        this.group(group, ADMIN.id, [seg.atAll(), seg.text(' 【通知】明晚八点群语音，有空的都来'), ], 'admin')
        return '管理员 @全体成员 发通知'
      case 'link':
        this.text(group, a, 'https://www.bilibili.com/video/BV1GJ411x7h7?share_source=copy_web&vd_source=8d3f9c2b1a 这个视频笑死我了')
        return `${nameOf(a)} 发长链接`
      case 'forward':
        this.group(group, a, [{ type: 'forward', data: { id: 'fwd-123456' } }])
        return `${nameOf(a)} 发合并转发`
      case 'voice':
        this.group(group, a, [seg.record(this.nap.imageUrl('voice-not-exist.amr'))])
        return `${nameOf(a)} 发语音（转不出文字）`
      case 'stickerbomb':
        for (let i = 0; i < 8; i++) {
          this.sticker(group, a)
          await sleep(1200)
        }
        return `${nameOf(a)} 10 秒连发 8 张表情包`
      case 'fight': {
        const lines = ['你会不会玩啊，送了三次了', '你行你上啊，就会嘴', '菜就多练，别拖后腿', '你才菜，上把谁零杀', '懒得跟你说，智商不在线', '你有病吧']
        for (let i = 0; i < lines.length; i++) {
          this.text(group, i % 2 ? b : a, lines[i])
          await sleep(2500)
        }
        return `${nameOf(a)} 和 ${nameOf(b)} 骂起来了`
      }
      case 'ad':
        this.text(group, 30997, '【招聘】兼职刷单日结300+，在家就能做，加V：abc12345，名额有限先到先得')
        return '陌生人发刷单广告'
      case 'admin':
        this.group(group, ADMIN.id, [seg.text('【管理员】最近刷屏的有点多，请大家文明发言，再刷直接禁言')], 'admin')
        await sleep(2000)
        this.nap.push(ev.groupBan(self, group, a, 600, ADMIN.id) as Record<string, unknown>)
        return `管理员警告并禁言 ${nameOf(a)} 10 分钟`
      case 'fakeher':
        this.group(group, FAKE_HER.id, [seg.text('大家好，我才是真的沐沐，那个是冒牌的')])
        return '群名片叫「沐沐」的人说自己才是沐沐'
      case 'robot':
        this.group(group, a, [seg.at(self), seg.text(' 你是不是机器人啊，说实话')])
        return `${nameOf(a)} @ 她问是不是机器人`
      case 'latenight':
        await sleep(45_000) // 先让这个群安静一阵
        this.group(group, a, [seg.at(self), seg.text(' 睡了吗')])
        return `安静 45 秒后 ${nameOf(a)} 突然 @ 她「睡了吗」`
      case 'poke':
        this.nap.push(ev.poke(self, a, self, group) as Record<string, unknown>)
        return `${nameOf(a)} 戳了戳她`
      case 'newbie':
        this.nap.push(ev.groupIncrease(self, group, 30996) as Record<string, unknown>)
        await sleep(1500)
        this.text(group, 30996, '大家好，新人报道，请多关照')
        return '新人入群打招呼'
      default:
        return `（未实现的怪情况 ${kind}）`
    }
  }
}
