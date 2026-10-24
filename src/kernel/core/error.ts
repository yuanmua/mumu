/**
 * 带原因码的内核错误。日志与唤醒只记 code（结构化、不分语言），message 只给开发者在控制台看。
 */
export class KernelError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'KernelError'
  }
}
