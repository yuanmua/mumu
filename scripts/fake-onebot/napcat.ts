/**
 * 假 NapCat 的协议层：OneBot v11 正向 WS 服务端 + 图片 HTTP，fake-onebot.ts（剧本）和 replay.ts（真实语料回放）共用。
 *
 * 应答 surface-onebot 会调的接口（见 surface-onebot README「给模拟器的协议层」）：
 * get_login_info、send_group_msg / send_private_msg（回 message_id）、get_msg、get_group_list、get_group_info、
 * get_group_member_info、get_group_member_list、get_stranger_info、upload_group_file / upload_private_file（记成一个 file 段）；其余（set_input_status 之类）假装成功。
 * 图片放在 /img/<文件名>：服务监听 0.0.0.0，图片地址用虚拟机的局域网 IP，Mac 上的网页也能直接打开。
 */
import { existsSync, readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { WsConn } from './ws.ts'
import { startWsServer } from './ws.ts'

export interface Sent { channel: string, messageId: number, message: unknown }
interface Member { name: string, role?: 'owner' | 'admin' | 'member' }

export class FakeNapCat {
  readonly self = { id: 10000, name: '沐沐' }
  readonly groups = new Map<number, string>() // 群号 → 群名
  readonly members = new Map<number, Member>()
  private conn?: WsConn
  private seq = 1000
  private messages = new Map<number, unknown>() // message_id → 事件（get_msg 用）
  private server?: { close: () => Promise<void> }
  onSent?: (s: Sent) => void
  onConnect?: () => void

  constructor(private port: number, private imageDir: string, readonly imageHost = lanIp()) {}

  get open(): boolean {
    return !!this.conn?.open
  }

  nextId(): number {
    return ++this.seq
  }

  imageUrl(file: string): string {
    return `http://${this.imageHost}:${this.port}/img/${encodeURIComponent(file)}`
  }

  /** 推一条上报事件（消息、通知）；有 message_id 的记下来给 get_msg */
  push(event: Record<string, unknown>): void {
    if (typeof event.message_id === 'number') {
      this.messages.set(event.message_id, event)
      if (this.messages.size > 5000)
        this.messages.delete(this.messages.keys().next().value!)
    }
    this.conn?.send(JSON.stringify(event))
  }

  async start(): Promise<void> {
    this.server = await startWsServer({
      port: this.port,
      host: '0.0.0.0',
      onConnect: (c) => {
        this.conn = c
        c.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect', self_id: this.self.id, time: now() }))
        this.onConnect?.()
      },
      onClose: (c) => {
        if (this.conn === c)
          this.conn = undefined
      },
      onMessage: (c, text) => this.answer(c, text),
      onHttp: (req, res) => {
        const name = decodeURIComponent((req.url ?? '').replace(/^\/img\//, '').split('?')[0])
        const file = join(this.imageDir, name)
        if (!name || name.includes('..') || !existsSync(file)) {
          res.writeHead(404).end()
          return
        }
        res.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*' }).end(readFileSync(file))
      },
    })
  }

  async close(): Promise<void> {
    await this.server?.close()
  }

  private answer(c: WsConn, text: string): void {
    let call: { action?: string, params?: Record<string, unknown>, echo?: string }
    try {
      call = JSON.parse(text)
    }
    catch {
      return // 不是 OneBot 调用，忽略
    }
    const ok = (data: unknown = {}): void => c.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: call.echo }))
    const fail = (msg: string): void => c.send(JSON.stringify({ status: 'failed', retcode: 1404, message: msg, wording: msg, echo: call.echo }))
    const p = call.params ?? {}
    const member = (id: number, group?: number): Record<string, unknown> => {
      const m = this.members.get(id)
      return { user_id: id, nickname: m?.name ?? String(id), card: m?.name ?? '', role: m?.role ?? 'member', ...(group ? { group_id: group } : {}) }
    }
    switch (call.action) {
      case 'get_login_info':
        return ok({ user_id: this.self.id, nickname: this.self.name })
      case 'send_group_msg':
      case 'send_private_msg': {
        const channel = call.action === 'send_group_msg' ? `qq:group:${p.group_id}` : `qq:private:${p.user_id}`
        const id = this.nextId()
        this.messages.set(id, { message_id: id, message: p.message, sender: { user_id: this.self.id, nickname: this.self.name } })
        this.onSent?.({ channel, messageId: id, message: p.message })
        return ok({ message_id: id })
      }
      case 'get_msg': {
        const m = this.messages.get(Number(p.message_id))
        return m ? ok(m) : fail('消息不存在')
      }
      case 'get_group_list':
        return ok([...this.groups].map(([group_id, group_name]) => ({ group_id, group_name, member_count: this.members.size, max_member_count: 2000 })))
      case 'get_group_info': {
        const id = Number(p.group_id)
        return ok({ group_id: id, group_name: this.groups.get(id) ?? `群 ${id}`, member_count: this.members.size, max_member_count: 2000 })
      }
      case 'get_group_member_info':
        return ok(member(Number(p.user_id), Number(p.group_id)))
      case 'get_group_member_list':
        return ok([...this.members.keys()].map(id => member(id, Number(p.group_id))))
      case 'get_stranger_info':
        return ok(member(Number(p.user_id)))
      // 传文件不经 send_*_msg：记成她在那个对话里发了一个 file 段，场景才看得见（不查文件在不在，真 NapCat 在她电脑上读）
      case 'upload_group_file':
      case 'upload_private_file': {
        const channel = call.action === 'upload_group_file' ? `qq:group:${p.group_id}` : `qq:private:${p.user_id}`
        this.onSent?.({ channel, messageId: this.nextId(), message: [{ type: 'file', data: { file: p.file, name: p.name } }] })
        return ok()
      }
      default:
        return ok() // set_input_status 之类：假装成功
    }
  }
}

/** 虚拟机的局域网地址：局域网 10.x / 192.168.x，找不到就 127.0.0.1 */
function lanIp(): string {
  const all = Object.values(networkInterfaces()).flat()
    .filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a!.address)
  return all.find(a => a.startsWith('10.') || a.startsWith('192.168.')) ?? '127.0.0.1'
}

function now(): number {
  return Math.floor(Date.now() / 1000)
}
