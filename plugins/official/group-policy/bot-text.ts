/**
 * 认机器人、给群消息打分时用的几个文字判断。看的都是群友发来的话（输入），不解析模型输出。
 */

/** 指令：去掉开头的 @ 之后以 / 开头（「/ccb @某人」「@幻梦 /打卡」） */
export function isCommand(text: string): boolean {
  return /^[/／]\S/.test(text.replace(/^(?:\s*@\S+)+\s*/, '').trim())
}

/** 在跟别人说：@ 了别人，或引用了别人的话（不是引用她的）。surface-onebot 把 @ 渲染成「@名字 」、引用渲染成「[回复 名字「…」]」 */
export function toOther(text: string): boolean {
  return /(?:^|\s)@\S/.test(text) || (text.startsWith('[回复 ') && !text.startsWith('[回复你'))
}

/** 历史里机器人的话、群友冲机器人说的话、机器人接她的话，说话人名字后加的标记（who.ts tagWho）；带名字，群里不止一个机器人时分得开 */
export const BOT_TAG = '（机器人）'
export const botTag = (): string => BOT_TAG
export const botAnswersTag = (): string => '（机器人，在接你的话）'
export const toBotTag = (name: string): string => `（在跟机器人${name}说）`
/** 她的网名出现在别人话里时，名字后面跟的标记 */
export const SELF_MARK = '（就是你）'
/** 历史里有标了的行时，给大脑 / 发言者的一句说明 */
export const BOT_NOTE_MIND = `【机器人的话】最近对话里名字后标「${BOT_TAG}」的是群里的机器人说的——程序的套话，当背景噪音看就行；想逗它一句也可以，但别把它当成在跟你认真聊，也别跟它斗嘴。标「${toBotTag('X')}」的是群友冲着机器人 X 说的，不是对你说的——群友提到它的名字、它的外号、它自称的东西（「群里在说话的人」里写着），说的是它不是你。标「${botAnswersTag()}」的是机器人在接你刚才的话：回不回看你想不想，它不会在意，不回也不失礼。你的网名后面标「${SELF_MARK}」的那几个字就是在说你自己。`
export const BOT_NOTE_PERFORMER = `【机器人的话】聊天记录里名字后标「${BOT_TAG}」的是群里的机器人在说程序的套话，标「${toBotTag('X')}」的是别人在跟机器人 X 说（群友提到它的名字、外号、它自称的东西，说的是它不是你），标「${botAnswersTag()}」的是机器人在接你的话——都不是人在跟你说：别接到这些话上去，照你心里想的那件事说；除非你本来就想逗它一句，回不回它都不会在意。记录里跟着「${SELF_MARK}」的名字是你自己的网名，别当成别人。`

/** 词在不在句子里：英文词要整词（StepStairs 里的 ai 不算 AI），中文直接找 */
export function hasWord(text: string, word: string): boolean {
  if (!word)
    return false
  if (!/^[a-z0-9]+$/i.test(word))
    return text.includes(word)
  return new RegExp(`(?:^|[^a-z0-9])${word}(?:$|[^a-z0-9])`, 'i').test(text)
}

/** markdown 排版：加粗、标题、列表、代码块——群友打字不会这样 */
export function hasMarkdown(text: string): boolean {
  if (/\*\*[^*\n]+\*\*|```|^#{1,4}\s/m.test(text))
    return true
  return (text.match(/^\s*(?:[-*•]|\d+[.、)])\s+\S/gm) ?? []).length >= 2
}
