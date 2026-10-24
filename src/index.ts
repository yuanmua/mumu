/**
 * 公共 API 单一入口，三块来源各自独立：
 * - kernel/：内核机制，出口见 kernel/index.ts
 * - loader/：装配层，扫描插件、热重载、启停
 * - shared/：插件共享助手
 */
export * from './kernel/index.ts'
export { PluginLoader } from './loader/loader.ts'
export type { ConfigService, ScanResult } from './loader/loader.ts'
export { scanPlugins } from './loader/manifest.ts'
export { diffPatch, mergePatch } from './loader/merge.ts'
export type { PluginManifest } from './loader/manifest.ts'
export { formatElapsed, renderNotes } from './shared/format.ts'
export { PROMPT_ORDER } from './shared/order.ts'
