/**
 * 入口：裸启内核，其余由插件提供。
 * 无全局配置文件；装载范围由 plugins/ 目录决定，默认配置写在各插件
 * package.json 的 mumu.defaults，运行期改动存入配置库。
 */
import process from 'node:process'
import { Mumu } from './kernel/index.ts'
import { PluginLoader } from './loader/loader.ts'

const mumu = Mumu.create()
const loader = new PluginLoader(mumu)

let closing = false
mumu.container.registerService('app', {
  shutdown: async () => {
    if (closing)
      return
    closing = true
    loader.stop()
    await mumu.dispose()
    process.exit(0)
  },
})

await loader.start()
mumu.assertReady()

console.log('沐沐已上线，我要给她完整的一生')
console.log('唯有代码陪伴永恒')

process.once('SIGINT', () => {
  void mumu.container.get<{ shutdown: () => Promise<void> }>('app').shutdown()
})
