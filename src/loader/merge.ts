/**
 * 插件配置的合并规则：配置库 `plugins.<id>` 是打在清单 `mumu.defaults` 上的一份
 * JSON Merge Patch（RFC 7386）。装配层下发配置、读「合并后视图」的地方（如网页人格面板）都用这一个函数，
 * 两边看到的才是同一个东西。
 *
 * - 对象按键递归合并：只改 `roles.performer.model` 不会冲掉 `roles.default`。
 * - 数组、字符串、数字、布尔整块替换：数组没有「按下标合并」的直觉含义。
 * - 值为 `null` = 删掉这个键，连同它的默认值（如人格面板删掉一个默认表情通道）。
 *   这不是「恢复默认」：恢复默认是把库里那一项去掉，让补丁不再碰它。
 */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch))
    return patch
  const out: Record<string, unknown> = isPlainObject(target) ? { ...target } : {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === null)
      delete out[k]
    else
      out[k] = mergePatch(out[k], v)
  }
  return out
}

/**
 * mergePatch 的反函数：给出默认值和「想要的完整配置」，算出最小的补丁，
 * 使 `mergePatch(base, diffPatch(base, want))` 等于 want。
 * 界面编辑完整配置后用它落库：库里只留和出厂不同的部分，改回出厂值即自动从库里消失。
 * 返回 undefined 表示没有差别（这一项不必写进库）。
 */
export function diffPatch(base: unknown, want: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(want))
    return sameJson(base, want) ? undefined : want
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(base)) {
    if (!(k in want))
      out[k] = null
  }
  for (const [k, v] of Object.entries(want)) {
    const d = diffPatch(base[k], v)
    if (d !== undefined)
      out[k] = d
  }
  return Object.keys(out).length ? out : undefined
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
