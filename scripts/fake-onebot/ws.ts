/**
 * 最小 WebSocket 服务端（RFC 6455 的子集，零依赖），只够假 NapCat 用：
 * 握手、收文本帧（客户端帧必带掩码）、发文本帧、回 pong、关连接。
 * 不支持分片与扩展——Node 自带的 WebSocket 客户端发 OneBot 调用用不到它们。
 * 同一个端口另服务普通 HTTP（假 NapCat 的图片地址就挂在这里）。
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { Duplex } from 'node:stream'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export interface WsConn {
  send: (text: string) => void
  close: () => void
  readonly open: boolean
}

export interface WsServerOptions {
  port: number
  host?: string
  onConnect: (conn: WsConn, req: IncomingMessage) => void
  onMessage: (conn: WsConn, text: string) => void
  onClose: (conn: WsConn) => void
  onHttp?: (req: IncomingMessage, res: ServerResponse) => void
}

export function startWsServer(o: WsServerOptions): Promise<{ close: () => Promise<void> }> {
  const sockets = new Set<Duplex>()
  const server = createServer((req, res) => {
    if (o.onHttp)
      return o.onHttp(req, res)
    res.writeHead(404).end()
  })

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'))
    sockets.add(socket)

    let open = true
    const conn: WsConn = {
      get open() { return open },
      send: (text) => {
        if (open)
          socket.write(frame(0x1, Buffer.from(text, 'utf8')))
      },
      close: () => {
        if (!open)
          return
        open = false
        socket.write(frame(0x8, Buffer.alloc(0)))
        socket.end()
      },
    }

    let buf = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      while (true) {
        const f = parse(buf)
        if (!f)
          break
        buf = buf.subarray(f.used)
        if (f.opcode === 0x1)
          o.onMessage(conn, f.payload.toString('utf8'))
        else if (f.opcode === 0x9)
          socket.write(frame(0xA, f.payload))
        else if (f.opcode === 0x8)
          conn.close()
      }
    })
    const gone = (): void => {
      if (!sockets.delete(socket))
        return
      open = false
      o.onClose(conn)
    }
    socket.on('close', gone)
    socket.on('error', gone)
    o.onConnect(conn, req)
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.port, o.host ?? '127.0.0.1', () => resolve({
      close: () => new Promise<void>((r) => {
        for (const s of sockets) s.destroy()
        server.close(() => r())
      }),
    }))
  })
}

function frame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length
  const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10)
  head[0] = 0x80 | opcode
  if (n < 126) {
    head[1] = n
  }
  else if (n < 65536) {
    head[1] = 126
    head.writeUInt16BE(n, 2)
  }
  else {
    head[1] = 127
    head.writeBigUInt64BE(BigInt(n), 2)
  }
  return Buffer.concat([head, payload])
}

function parse(b: Buffer): { opcode: number, payload: Buffer, used: number } | undefined {
  if (b.length < 2)
    return undefined
  const opcode = b[0] & 0x0F
  const masked = (b[1] & 0x80) !== 0
  let len = b[1] & 0x7F
  let at = 2
  if (len === 126) {
    if (b.length < 4)
      return undefined
    len = b.readUInt16BE(2)
    at = 4
  }
  else if (len === 127) {
    if (b.length < 10)
      return undefined
    len = Number(b.readBigUInt64BE(2))
    at = 10
  }
  const maskAt = at
  if (masked)
    at += 4
  if (b.length < at + len)
    return undefined
  const payload = Buffer.from(b.subarray(at, at + len))
  if (masked) {
    for (let i = 0; i < payload.length; i++)
      payload[i] ^= b[maskAt + (i % 4)]
  }
  return { opcode, payload, used: at + len }
}
