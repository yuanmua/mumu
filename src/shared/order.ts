/**
 * 提示词与大脑材料的统一组装顺序。插件贡献段落（ctx.prompt.section）、调用方一次性附加段落（assemble 的 extras）、
 * 往 beat/gather 里推的材料块（MaterialBlock.order），都从这里取槽位，不各自写数字——
 * 顺序是外围的一条约定，不是每个插件的私事。两张表都是插件约定不是内核机制：内核只认 order 数字，不认识这些名字。
 */

/**
 * 段落（system prompt）的槽位。
 * 立场：模型记得最牢的是开头和结尾。开头放「我是谁」，结尾放「底线」，情境夹在中间；
 * 常变的（时间）靠后，别破坏开头的前缀缓存（本地引擎有 context cache）。
 */
export const PROMPT_ORDER = {
  identity: 0, // 我是谁
  voice: 10, // 怎么说话（腔调）
  state: 20, // 此刻状态（心情等）
  teaching: 30, // 能力教学（标记、工具）
  memory: 40, // 刚才发生的事（工作记忆）
  thought: 50, // 此刻心里想的（导演引导）
  time: 80, // 现在几点、沉默多久
  rules: 100, // 底线，永远最后
} as const

/**
 * 大脑材料块（beat/gather 的 MaterialBlock）的槽位。
 * 立场：先看身体（脊椎此刻在干什么）和别人要她做的事，再看自己的状态与记忆，场景与手头的活居中，可用素材最后。
 * 同一槽位里多块按 from 排（内核规则），所以一个插件推几块都落在自己的槽里。
 */
export const MATERIAL_ORDER = {
  spine: 0, // 脊椎：反射层此刻的状态
  tasks: 10, // 别人要她做的事、待确认的
  state: 20, // 自己的状态：心情、生活
  memory: 30, // 记忆：长期记忆、认识的人
  interests: 40, // 兴趣
  scene: 50, // 场景：群里的气氛、关系、规矩
  work: 60, // 手头的活：正在做的工程、电脑上的事
  assets: 70, // 可用素材：表情包等
} as const
