import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NewlineMode } from '../plugins/official/action-reply/br.ts'
import { historyBr, normalizeBr, selfSegments } from '../plugins/official/action-reply/br.ts'

async function run(chunks: string[], mode?: NewlineMode): Promise<string> {
  async function* src(): AsyncGenerator<string> {
    for (const c of chunks) yield c
  }
  let out = ''
  for await (const s of normalizeBr(src(), mode)) out += s
  return out
}

test('字面 <br> 归一成 <|br|>：各种写法、大小写、被切在两个 chunk 之间', async () => {
  assert.equal(await run(['方块合到 512 了<br>最后还是 Game Over']), '方块合到 512 了<|br|>最后还是 Game Over')
  assert.equal(await run(['a<br/>b<BR />c']), 'a<|br|>b<|br|>c')
  assert.equal(await run(['好呀<', 'b', 'r', '>走吧']), '好呀<|br|>走吧')
  assert.equal(await run(['<|emo:开心|>嗯', '<|br|>好']), '<|emo:开心|>嗯<|br|>好', '本来就对的标记不动')
  assert.equal(await run(['1 < 2，', '<b>不是换行']), '1 < 2，<b>不是换行', '别的尖括号原样')
  assert.equal(await run(['结尾留着半个<b']), '结尾留着半个<b', '流结束时没凑齐的原样吐出')
})

test('残缺的分段标记也认：<|br>、<br|>、<|br|、|br| 等，跨 chunk 也认', async () => {
  assert.equal(await run(['叫可乐好可爱<|br>三岁了还黏人']), '叫可乐好可爱<|br|>三岁了还黏人', '实测')
  assert.equal(await run(['a<br|>b<|br|c|br|d|BR>e']), 'a<|br|>b<|br|>c<|br|>d<|br|>e')
  assert.equal(await run(['a<|br', '|>b']), 'a<|br|>b', '正确写法被切开，别当成 <|br| 换掉再漏出 >')
  assert.equal(await run(['a<|', 'br', '>b']), 'a<|br|>b')
  assert.equal(await run(['a<|br|', '>b']), 'a<|br|>b')
  assert.equal(await run(['a|b', 'r|b']), 'a<|br|>b')
  assert.equal(await run(['好呀<|br']), '好呀', '结尾的残缺标记当分段，结尾分段丢掉')
  assert.equal(await run(['<|emo:开心|>嗯', '|', '>']), '<|emo:开心|>嗯|>', '别的竖线原样')
  assert.equal(await run(['a | b，brown <b>']), 'a | b，brown <b>', '正文里的竖线、br 字母不动')
  assert.equal(await run(['a<br', 'own']), 'a<brown', '<br 只有一边不认')
})

test('换行归一成 <|br|>：连着几个算一个、跨 chunk、开头结尾丢掉、紧挨已有标记不重复', async () => {
  assert.equal(await run(['一起起哄\n\n周五九点我记着呢\n\n到时候叫你']), '一起起哄<|br|>周五九点我记着呢<|br|>到时候叫你')
  assert.equal(await run(['好呀\n走吧']), '好呀<|br|>走吧', '单个换行默认也算')
  assert.equal(await run(['好呀\r\n\r\n走吧']), '好呀<|br|>走吧')
  assert.equal(await run(['好呀\n', '\n走', '吧']), '好呀<|br|>走吧', '\\n\\n 被切开')
  assert.equal(await run(['好呀\n', '\n', '\n', '走吧']), '好呀<|br|>走吧')
  assert.equal(await run(['\n\n嗯', '嗯\n\n']), '嗯嗯', '开头结尾的换行')
  assert.equal(await run(['嗯\n<|br|>好']), '嗯<|br|>好')
  assert.equal(await run(['嗯<|br|>', '\n好']), '嗯<|br|>好', '上一块以标记结尾')
  assert.equal(await run(['嗯<br>\n\n好']), '嗯<|br|>好')
  assert.equal(await run(['嗯\n', '<|br|>好']), '嗯<|br|>好')
  assert.equal(await run(['嗯\n\n<|b', 'r|>\n\n好']), '嗯<|br|>好', '标记被切开也认得出')
  assert.equal(await run(['嗯<|br', '|>\n好']), '嗯<|br|>好')
})

test('newline 配置：double 只认空行、none 不管换行', async () => {
  assert.equal(await run(['第一行\n第二行\n\n另一条'], 'double'), '第一行 第二行<|br|>另一条')
  assert.equal(await run(['第一行\n第二行'], 'none'), '第一行\n第二行')
  assert.equal(await run(['a<br>b'], 'none'), 'a<|br|>b', '<br> 照样归一')
})

test('喂回模型的她的历史：段间换行与旧 <br> 都写成 <|br|>', () => {
  assert.equal(historyBr('折腾半天没进去<br>要不再试一次嘛'), '折腾半天没进去<|br|>要不再试一次嘛')
  assert.equal(historyBr('一起起哄\n\n周五九点我记着呢'), '一起起哄<|br|>周五九点我记着呢')
  assert.equal(historyBr('嗯\n'), '嗯')
  assert.equal(historyBr('没有'), '没有')
  assert.equal(historyBr('第一行\n第二行', 'none'), '第一行\n第二行')
})

test('从日志找回分段位置：delivered 粘在一起的话插回 <|br|>', () => {
  let seq = 0
  const ev = (at: number, type: string, data: Record<string, unknown>) => ({ seq: ++seq, at, type, data })
  const part = (at: number, id: string, kind: string, text?: string) => ev(at, 'utterance.part', { id, part: text ? { kind, text } : { kind } })
  const events = [
    ev(100, 'utterance.started', { id: 'utt#1', channel: 'g' }),
    part(101, 'utt#1', 'text', '老早的'),
    part(102, 'utt#1', 'break'),
    part(103, 'utt#1', 'text', '一句'),
    ev(104, 'utterance.settled', { id: 'utt#1', channel: 'g', delivered: '老早的一句' }),
    ev(200, 'utterance.started', { id: 'utt#2', channel: 'g' }),
    part(201, 'utt#2', 'text', '什么冒牌，'),
    part(202, 'utt#2', 'text', '我才是原装的'),
    part(203, 'utt#2', 'break'),
    part(204, 'utt#2', 'marker'),
    part(205, 'utt#2', 'break'),
    part(206, 'utt#2', 'text', '你才机器人呢'),
    part(207, 'utt#2', 'break'),
    part(208, 'utt#2', 'text', '被打断没说出去'),
    ev(209, 'percept.received', { channel: 'g', text: '插话' }),
    ev(300, 'utterance.settled', { id: 'utt#2', channel: 'g', delivered: '什么冒牌，我才是原装的你才机器人呢' }),
    ev(400, 'utterance.started', { id: 'utt#3', channel: 'g' }),
    part(401, 'utt#3', 'text', '没分段'),
    ev(402, 'utterance.settled', { id: 'utt#3', channel: 'g', delivered: '没分段' }),
  ]
  const segs = selfSegments(events, 150)
  assert.equal(segs.get('g|300'), '什么冒牌，我才是原装的<|br|>你才机器人呢', '连着的 break 只算一个，打断后没送达的不算')
  assert.equal(segs.has('g|104'), false, 'since 之前定稿的不看')
  assert.equal(segs.has('g|402'), false, '没分段的不登记')
  assert.equal(selfSegments(events, 0).get('g|104'), '老早的<|br|>一句')
})
