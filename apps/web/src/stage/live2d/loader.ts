/**
 * 加载：等 Cubism Core 就绪 → 建 PixiJS 应用 → 加载模型 → 按视口适配。
 * 这里只管「把模型放到画布上」，怎么动是 driver 的事。
 */
import type { Cubism4InternalModel } from 'pixi-live2d-display/cubism4'
import { Live2DModel } from 'pixi-live2d-display/cubism4'
import { Application, Ticker } from 'pixi.js'
import type { Profile } from './profile.ts'

export type Model = Live2DModel<Cubism4InternalModel>

export interface Loaded {
  app: Application
  model: Model
  fit: () => void
  destroy: () => void
}

/** Core 由 index.html 的 script 标签加载（本地优先，官方 CDN 兜底）；这里最多等 6 秒 */
export async function waitForCore(timeoutMs = 6000): Promise<boolean> {
  const w = window as unknown as { Live2DCubismCore?: unknown, __live2dCoreMissing?: boolean }
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (w.Live2DCubismCore)
      return true
    if (w.__live2dCoreMissing)
      return false
    await new Promise(r => setTimeout(r, 100))
  }
  return !!w.Live2DCubismCore
}

let tickerRegistered = false

export async function loadModel(canvas: HTMLCanvasElement, host: HTMLElement, dir: string, profile: Profile): Promise<Loaded> {
  if (!tickerRegistered) {
    Live2DModel.registerTicker(Ticker)
    tickerRegistered = true
  }
  const app = new Application({
    view: canvas,
    backgroundAlpha: 0,
    resizeTo: host,
    autoDensity: true,
    resolution: Math.min(2, window.devicePixelRatio || 1),
    antialias: true,
  })
  const url = `/${dir}/${profile.model}`
  const model = await Live2DModel.from(url, { autoInteract: false }) as Model
  app.stage.addChild(model)

  const fit = (): void => {
    const w = host.clientWidth
    const h = host.clientHeight
    const heightRatio = profile.fit?.height ?? 1.3
    const scale = (h * heightRatio) / model.internalModel.originalHeight
    model.scale.set(scale)
    model.anchor.set(0.5, 0)
    model.x = w / 2
    model.y = h * (profile.fit?.y ?? -0.03)
  }
  fit()
  window.addEventListener('resize', fit)

  return {
    app,
    model,
    fit,
    destroy: () => {
      window.removeEventListener('resize', fit)
      model.destroy()
      app.destroy(false, { children: true })
    },
  }
}
