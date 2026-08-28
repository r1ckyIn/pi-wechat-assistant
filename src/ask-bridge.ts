// ============================================================================
// AskUserQuestion 微信接管 — 桥接激活时把提问转到微信，一题一条顺序问答
//
// 问题数据来自 @juicesharp/rpiv-ask-user-question 的公开事件
// `rpiv:ask-user:prompt`（频道名与 payload 有稳定性承诺，见该包 events.ts）。
// 答案结构与该包的 QuestionAnswer / QuestionnaireResult 兼容——它的
// isQuestionnaireResult 守卫只要求 { answers: [], cancelled: boolean }。
// ============================================================================

export interface AskQuestionOption {
  label: string
  description: string
}

export interface AskQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: AskQuestionOption[]
}

export interface AskAnswer {
  questionIndex: number
  question: string
  kind: 'option' | 'custom' | 'multi'
  answer: string | null
  selected?: string[]
}

export interface AskResult {
  answers: AskAnswer[]
  cancelled: boolean
}

// --- 题目排版（微信与终端共用同一份文本） ---

export function formatQuestion(q: AskQuestion, index: number, total: number): string {
  const lines = [`❓ 问题 ${index + 1}/${total}「${q.header}」${q.multiSelect ? '（可多选）' : ''}`, q.question, '']
  q.options.forEach((o, i) => {
    lines.push(`${i + 1}. ${o.label}`)
    if (o.description) lines.push(`   ${o.description}`)
  })
  lines.push('')
  lines.push(
    q.multiSelect
      ? '回复数字选择（多选用空格隔开，如: 1 3），直接打字=自定义答案，回 0 取消'
      : '回复数字选择，直接打字=自定义答案，回 0 取消',
  )
  return lines.join('\n')
}

// --- 答案解析 ---

export type ParsedReply =
  | { kind: 'cancel' }
  | { kind: 'invalid'; hint: string }
  | { kind: 'answer'; answer: AskAnswer }

export function parseReply(text: string, q: AskQuestion, questionIndex: number): ParsedReply {
  const trimmed = text.trim()
  if (trimmed === '0' || trimmed === '取消') return { kind: 'cancel' }

  const tokens = trimmed.split(/[\s,，、]+/).filter(Boolean)
  const allNumeric = tokens.length > 0 && tokens.every(t => /^\d+$/.test(t))
  if (!allNumeric) {
    return { kind: 'answer', answer: { questionIndex, question: q.question, kind: 'custom', answer: trimmed } }
  }

  const indices = tokens.map(Number)
  const bad = indices.filter(n => n < 1 || n > q.options.length)
  if (bad.length > 0) {
    return { kind: 'invalid', hint: `没有选项 ${bad.join(' ')}，本题共 ${q.options.length} 个选项，请重新回复` }
  }
  if (q.multiSelect) {
    const unique = [...new Set(indices)]
    return {
      kind: 'answer',
      answer: { questionIndex, question: q.question, kind: 'multi', answer: null, selected: unique.map(n => q.options[n - 1].label) },
    }
  }
  if (indices.length > 1) return { kind: 'invalid', hint: '本题是单选，请只回复一个数字' }
  return { kind: 'answer', answer: { questionIndex, question: q.question, kind: 'option', answer: q.options[indices[0] - 1].label } }
}

// --- 问卷会话 ---

type SendText = (userId: string, text: string) => Promise<void>

interface ActiveSession {
  questions: AskQuestion[]
  userId: string
  current: number
  answers: AskAnswer[]
  resolve: (r: AskResult) => void
  sendText: SendText
}

export class AskBridge {
  private session: ActiveSession | null = null

  get active(): boolean {
    return this.session !== null
  }

  /** 开始问卷：发第一题到微信，全部答完或取消后 resolve */
  run(questions: AskQuestion[], userId: string, sendText: SendText): Promise<AskResult> {
    // ponytail: 同时只有一个问卷；agent 循环里工具顺序执行，天然满足
    this.cancelAll()
    return new Promise<AskResult>(resolve => {
      this.session = { questions, userId, current: 0, answers: [], resolve, sendText }
      void this.sendCurrent()
    })
  }

  private async sendCurrent(): Promise<void> {
    const s = this.session
    if (!s) return
    await s.sendText(s.userId, formatQuestion(s.questions[s.current], s.current, s.questions.length)).catch(() => {})
  }

  /** 微信入站文本尝试作为答案消费；返回 true 表示已消费，调用方不要再入队 */
  handleReply(userId: string, text: string): boolean {
    const s = this.session
    if (!s || userId !== s.userId || !text.trim()) return false

    const parsed = parseReply(text, s.questions[s.current], s.current)
    if (parsed.kind === 'cancel') {
      this.finish({ answers: s.answers, cancelled: true }, '❌ 已取消提问，agent 将在没有答案的情况下继续')
      return true
    }
    if (parsed.kind === 'invalid') {
      const current = s
      void current.sendText(current.userId, `⚠️ ${parsed.hint}`).catch(() => {})
      return true
    }
    s.answers.push(parsed.answer)
    s.current++
    if (s.current < s.questions.length) {
      void this.sendCurrent()
    } else {
      this.finish({ answers: s.answers, cancelled: false }, `✅ 已提交 ${s.answers.length} 题答案，agent 继续处理…`)
    }
    return true
  }

  private finish(result: AskResult, farewell: string): void {
    const s = this.session
    if (!s) return
    this.session = null
    void s.sendText(s.userId, farewell).catch(() => {})
    s.resolve(result)
  }

  /** 桥接停止或回合异常结束时兜底：取消进行中的问卷（resolve 成 cancelled） */
  cancelAll(): void {
    const s = this.session
    if (!s) return
    this.session = null
    s.resolve({ answers: s.answers, cancelled: true })
  }
}
