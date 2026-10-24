/**
 * 脊椎的判定（纯函数，单测直接测）：一句话轻不轻、合流结束后大脑没及时决定时脊椎能不能替它先应一声。
 * 计时、唤醒、起 reply 这些有副作用的在 index.ts。
 *
 * 2026-10-22 起每条消息都先到大脑（大脑门控），这里不再决定「谁来回」：
 * 只给大脑贴提示（像要她做事、是主人说的、很简单），并圈出兜底白名单。
 */

export interface RouteConfig {
  lightMaxChars: number
  sticker: RegExp // 表情包占位片段，全局匹配
  lightCooldownMs: number
  lightReplyChance: number
  actionWords: string[] // 含这些词 = 像是要她动手做事：只是给大脑的提示，并且不进兜底白名单
}

/** 「像是要她做事」的提示名：大脑材料里据此提醒「应一声 + 起动作」 */
export const ACTION_WHY = '要她做事'
/** 主人说的：一律不兜底，等大脑 */
export const OWNER_WHY = '主人说的'

/**
 * 轻 = 不用想：纯表情包，或不带问号、不超过 lightMaxChars 字。理由给日志和大脑看。
 * 像要她做事的话一律不轻：脊椎兜底只会嘴上应一句，动作得大脑起（真群：「用电脑试试看」被反射抢着回了
 * 「电脑碰不到嘛」，大脑信了，computer 没起）。词表宁宽勿窄，误判的代价只是这句不兜底。
 */
export function classify(text: string, cfg: Pick<RouteConfig, 'lightMaxChars' | 'sticker' | 'actionWords'>): { light: boolean, why: string } {
  // 群里 @ 她时表现端把「@名字」写进正文：不算字数，否则「@沐沐 在吗」成了长句
  const rest = text.replace(cfg.sticker, '').replace(/@\S+/g, '').trim()
  if (!rest)
    return { light: true, why: text.replace(cfg.sticker, '') !== text ? '表情包' : '只叫了一声' }
  if (cfg.actionWords.some(w => w && rest.includes(w)))
    return { light: false, why: ACTION_WHY }
  if (rest.includes('?') || rest.includes('？'))
    return { light: false, why: '问句' }
  if ([...rest].length > cfg.lightMaxChars)
    return { light: false, why: '长句' }
  return { light: true, why: '短句' }
}

/**
 * 合流结束：这几句能不能进兜底白名单（大脑 fallbackMs 内没决定时脊椎先应一声）。
 * 有重的、连发、主人说的 → 不能，只等大脑；全轻时她刚说过话或没掷中接话概率也不兜底（交给大脑，常常就不接了）。
 */
export function spineCandidate(
  p: { heavy: boolean, burst: boolean, owner: boolean, count: number, why: string[], sinceReplyMs: number, roll: number },
  cfg: Pick<RouteConfig, 'lightCooldownMs' | 'lightReplyChance'>,
): { spine: boolean, why: string[] } {
  const why = [...p.why]
  if (p.burst)
    why.push(`连发 ${p.count} 条`)
  if (p.owner)
    why.push(OWNER_WHY)
  if (p.heavy || p.burst || p.owner)
    return { spine: false, why }
  if (p.sinceReplyMs < cfg.lightCooldownMs)
    return { spine: false, why: [...why, '她刚说过话'] }
  if (p.roll >= cfg.lightReplyChance)
    return { spine: false, why: [...why, '没掷中接话概率'] }
  return { spine: true, why }
}

export function stickerPattern(prefix: string): RegExp {
  return new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\]]*\\]`, 'g')
}
