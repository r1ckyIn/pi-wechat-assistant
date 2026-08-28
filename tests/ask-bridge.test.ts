import { describe, it, expect } from 'vitest'
import { AskBridge, formatQuestion, parseReply, type AskQuestion } from '../src/ask-bridge.js'

const single: AskQuestion = {
  question: '重点分析什么？',
  header: '分析重点',
  multiSelect: false,
  options: [
    { label: '综合判断（推荐）', description: '同时分析画面与真实性' },
    { label: '真假与可行性', description: '判断说法是否可信' },
    { label: '复现方案', description: '倒推制作流程' },
  ],
}

const multi: AskQuestion = {
  question: '输出哪些部分？',
  header: '输出深度',
  multiSelect: true,
  options: [
    { label: '结论', description: '' },
    { label: '依据', description: '' },
    { label: '步骤', description: '' },
  ],
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('formatQuestion', () => {
  it('渲染编号选项和单选提示', () => {
    const text = formatQuestion(single, 0, 2)
    expect(text).toContain('问题 1/2「分析重点」')
    expect(text).toContain('1. 综合判断（推荐）')
    expect(text).toContain('3. 复现方案')
    expect(text).toContain('回 0 取消')
    expect(text).not.toContain('可多选')
  })

  it('多选题带多选提示', () => {
    const text = formatQuestion(multi, 1, 2)
    expect(text).toContain('（可多选）')
    expect(text).toContain('如: 1 3')
  })
})

describe('parseReply', () => {
  it('单选数字选中对应选项', () => {
    const r = parseReply('2', single, 0)
    expect(r).toEqual({
      kind: 'answer',
      answer: { questionIndex: 0, question: single.question, kind: 'option', answer: '真假与可行性' },
    })
  })

  it('0 和「取消」都是取消', () => {
    expect(parseReply('0', single, 0).kind).toBe('cancel')
    expect(parseReply('取消', single, 0).kind).toBe('cancel')
  })

  it('越界数字要求重答', () => {
    const r = parseReply('9', single, 0)
    expect(r.kind).toBe('invalid')
  })

  it('单选题回多个数字要求重答', () => {
    expect(parseReply('1 2', single, 0).kind).toBe('invalid')
  })

  it('非数字文本是自定义答案', () => {
    const r = parseReply('都不要，帮我看灯光', single, 0)
    expect(r).toEqual({
      kind: 'answer',
      answer: { questionIndex: 0, question: single.question, kind: 'custom', answer: '都不要，帮我看灯光' },
    })
  })

  it('多选支持空格、逗号、顿号分隔并去重', () => {
    for (const input of ['1 3', '1,3', '1、3', '1 3 1']) {
      const r = parseReply(input, multi, 1)
      expect(r).toEqual({
        kind: 'answer',
        answer: { questionIndex: 1, question: multi.question, kind: 'multi', answer: null, selected: ['结论', '步骤'] },
      })
    }
  })
})

describe('AskBridge', () => {
  function makeBridge() {
    const sent: string[] = []
    const bridge = new AskBridge()
    const sendText = async (_userId: string, text: string) => { sent.push(text) }
    return { bridge, sent, sendText }
  }

  it('两题顺序问答后 resolve 全部答案', async () => {
    const { bridge, sent, sendText } = makeBridge()
    const promise = bridge.run([single, multi], 'u1', sendText)
    await flush()
    expect(sent[0]).toContain('问题 1/2')

    expect(bridge.handleReply('u1', '1')).toBe(true)
    await flush()
    expect(sent[1]).toContain('问题 2/2')

    expect(bridge.handleReply('u1', '2 3')).toBe(true)
    const result = await promise
    expect(result.cancelled).toBe(false)
    expect(result.answers).toHaveLength(2)
    expect(result.answers[0].answer).toBe('综合判断（推荐）')
    expect(result.answers[1].selected).toEqual(['依据', '步骤'])
    expect(bridge.active).toBe(false)
    await flush()
    expect(sent.at(-1)).toContain('已提交 2 题')
  })

  it('无效回复发提示且停留在当前题', async () => {
    const { bridge, sent, sendText } = makeBridge()
    void bridge.run([single], 'u1', sendText)
    await flush()

    expect(bridge.handleReply('u1', '7')).toBe(true)
    await flush()
    expect(sent.at(-1)).toContain('⚠️')
    expect(bridge.active).toBe(true)
  })

  it('回 0 取消整个问卷', async () => {
    const { bridge, sendText } = makeBridge()
    const promise = bridge.run([single, multi], 'u1', sendText)
    await flush()

    expect(bridge.handleReply('u1', '0')).toBe(true)
    const result = await promise
    expect(result.cancelled).toBe(true)
    expect(bridge.active).toBe(false)
  })

  it('其他用户或空文本不消费', async () => {
    const { bridge, sendText } = makeBridge()
    void bridge.run([single], 'u1', sendText)
    await flush()

    expect(bridge.handleReply('u2', '1')).toBe(false)
    expect(bridge.handleReply('u1', '  ')).toBe(false)
    expect(bridge.active).toBe(true)
  })

  it('cancelAll 把挂起的问卷 resolve 成 cancelled', async () => {
    const { bridge, sendText } = makeBridge()
    const promise = bridge.run([single], 'u1', sendText)
    await flush()

    bridge.cancelAll()
    const result = await promise
    expect(result.cancelled).toBe(true)
    expect(bridge.active).toBe(false)
  })
})
