import { describe, expect, it } from 'vitest'
import { splitSentences } from './sentence.ts'

describe('分句', () => {
  it('终止符立即成句，尾巴留着', () => {
    expect(splitSentences('你好呀。今天怎么样？我在')).toEqual({ sentences: ['你好呀。', '今天怎么样？'], rest: '我在' })
  })
  it('连续标点并入同一句', () => {
    expect(splitSentences('真的吗？！太好了……嗯')).toEqual({ sentences: ['真的吗？！', '太好了……'], rest: '嗯' })
  })
  it('逗号只在够长时成句', () => {
    expect(splitSentences('嗯，好的')).toEqual({ sentences: [], rest: '嗯，好的' })
    const long = '这件事我前前后后想了很久很久一直都没有想明白到底是为什么，然后'
    expect(splitSentences(long).sentences).toEqual(['这件事我前前后后想了很久很久一直都没有想明白到底是为什么，'])
  })
  it('final 时剩余全部成句', () => {
    expect(splitSentences('嗯', true)).toEqual({ sentences: ['嗯'], rest: '' })
    expect(splitSentences('   ', true)).toEqual({ sentences: [], rest: '' })
  })
  it('换行算句尾', () => {
    expect(splitSentences('第一行\n第二行').sentences).toEqual(['第一行'])
  })
})
