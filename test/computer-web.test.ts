import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { LogEvent } from '../src/index.ts'
import { prune, saveShot, SHOT_PREFIX, shotId } from '../plugins/official/action-computer/shots.ts'
import { shotsOf, statusText, taskLines, tasksOf } from '../plugins/official/action-computer/view.ts'

let seq = 0
const ev = (type: string, data: Record<string, unknown>, at: number): LogEvent => ({ seq: ++seq, at, type, data })

function sample(): LogEvent[] {
  const t0 = 1_760_000_000_000
  return [
    ev('action.started', { id: 'reply#1', type: 'reply', params: {}, channel: 'main' }, t0),
    ev('action.started', { id: 'computer#1', type: 'computer', params: { task: '在桌面建文件夹 test' }, channel: 'c:abc' }, t0 + 1000),
    ev('computer.step', { actionId: 'computer#1', step: 1, say: '先看桌面在哪', tool: 'exec', args: {}, observation: '{"exitCode":0,"stdout":"C:\\\\Users\\\\me\\\\Desktop"}', shot: 'cshot-000000001-aaaaaaaa.jpg' }, t0 + 3000),
    ev('computer.step', { actionId: 'computer#1', step: 2, say: '看一眼', tool: 'look', args: {}, observation: '【看到的】桌面上有个文件夹' }, t0 + 6000),
    ev('computer.step', { actionId: 'computer#1', step: 3, done: true, ok: true, result: '建好了 C:\\Users\\me\\Desktop\\test', shot: 'cshot-000000002-bbbbbbbb.jpg' }, t0 + 8000),
    ev('percept.received', { kind: 'computer.result', channel: 'c:abc', text: '…', data: { actionId: 'computer#1', ok: true, steps: 3, result: '建好了 C:\\Users\\me\\Desktop\\test' } }, t0 + 8100),
    ev('action.ended', { id: 'computer#1', outcome: 'done' }, t0 + 8200),
    ev('action.started', { id: 'computer#2', type: 'computer', params: { task: '打开记事本' } }, t0 + 20_000),
    ev('computer.step', { actionId: 'computer#2', step: 1, say: '开记事本', tool: 'apps', args: {}, observation: '{"ok":true}' }, t0 + 22_000),
  ]
}

test('电脑任务投影：从 action.started / computer.step / action.ended 算出每次任务、步骤、结果、耗时', () => {
  const tasks = tasksOf(sample(), 10)
  assert.equal(tasks.length, 2)
  const [a, b] = tasks
  assert.equal(a.id, 'computer#1')
  assert.equal(a.task, '在桌面建文件夹 test')
  assert.equal(a.channel, 'c:abc')
  assert.equal(a.steps.length, 2) // done 那条不算步骤
  assert.equal(a.steps[0].shot, 'cshot-000000001-aaaaaaaa.jpg')
  assert.equal(a.ok, true)
  assert.match(a.result ?? '', /建好了/)
  assert.equal(a.finalShot, 'cshot-000000002-bbbbbbbb.jpg')
  assert.equal(a.endedAt! - a.startedAt, 7200)
  assert.equal(statusText(a), '做完了 ✓')
  assert.equal(b.endedAt, undefined)
  assert.equal(statusText(b), '进行中（已做 1 步）')
})

test('电脑任务投影：limit 只留最近几次；别的动作不混进来', () => {
  const tasks = tasksOf(sample(), 1)
  assert.deepEqual(tasks.map(t => t.id), ['computer#2'])
})

test('电脑任务面板：行里有任务、每一步、截图链接、结果', () => {
  const [a] = tasksOf(sample(), 10)
  const lines = taskLines(a)
  assert.match(lines[0], /computer#1 .* 做完了 ✓ · 2 步 · 7秒 · 对话 c:abc/)
  assert.equal(lines[1], '任务：在桌面建文件夹 test')
  assert.match(lines[2], /^ +1\. .* exec｜先看桌面在哪 → /)
  assert.equal(lines[3].trim(), '📷 /api/media/cshot-000000001-aaaaaaaa.jpg')
  assert.match(lines.find(l => l.startsWith('结果：')) ?? '', /做成了——建好了/)
  assert.ok(lines.some(l => l.includes('/api/media/cshot-000000002-bbbbbbbb.jpg')))
})

test('截图列表：新的在前，id 是去掉扩展名的文件名', () => {
  const shots = shotsOf(tasksOf(sample(), 10))
  assert.deepEqual(shots.map(s => s.id), ['cshot-000000002-bbbbbbbb', 'cshot-000000001-aaaaaaaa'])
  assert.equal(shots[1].url, '/api/media/cshot-000000001-aaaaaaaa.jpg')
  assert.equal(shots[1].actionId, 'computer#1')
  assert.equal(shotId('cshot-x-y.png'), 'cshot-x-y')
})

test('截图落盘：文件名合乎 /api/media 的规则、按时间排序；超过 keep 张删最老的，不碰别人的文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cshot-'))
  try {
    const names: string[] = []
    for (let i = 0; i < 3; i++)
      names.push(await saveShot(dir, { bytes: Buffer.from(`img${i}`), mime: 'image/jpeg' }, 10))
    for (const n of names) {
      assert.match(n, /^[\w.-]+\.jpg$/)
      assert.ok(n.startsWith(SHOT_PREFIX))
    }
    assert.deepEqual([...names].sort(), names)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'someone-else.jpg'), 'x')
    const removed = await prune(dir, 1)
    assert.deepEqual(removed, names.slice(0, 2))
    const left = (await readdir(dir)).sort()
    assert.deepEqual(left, [names[2], 'someone-else.jpg'].sort())
  }
  finally {
    await rm(dir, { recursive: true, force: true })
  }
})
