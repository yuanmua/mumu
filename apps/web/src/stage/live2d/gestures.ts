/**
 * 程序化动作：不依赖模型自带的动作文件，只用标准参数（头角度、身体角度、眼睛）。
 * 每个动作是「时长 + 进度 p∈[0,1] → 参数偏移」。偏移是加在当前值上的，所以和待机动作叠得住。
 */
export interface Gesture {
  duration: number // 秒
  at: (p: number) => Record<string, number>
}

const env = (p: number): number => Math.sin(Math.PI * p) // 起落平滑的包络
const TAU = Math.PI * 2

export const GESTURES: Record<string, Gesture> = {
  nod: { duration: 1.0, at: p => ({ ParamAngleY: -14 * Math.sin(TAU * 2 * p) * env(p) }) },
  shake: { duration: 1.0, at: p => ({ ParamAngleX: 16 * Math.sin(TAU * 2 * p) * env(p) }) },
  tilt: { duration: 1.6, at: p => ({ ParamAngleZ: 16 * env(p) ** 0.6, ParamEyeBallX: 0.2 * env(p) }) },
  bounce: { duration: 0.7, at: p => ({ ParamAngleY: 8 * Math.sin(TAU * p) * env(p), ParamBodyAngleY: 6 * Math.sin(TAU * p) * env(p) }) },
  sway: { duration: 2.2, at: p => ({ ParamBodyAngleX: 7 * Math.sin(TAU * p) * env(p), ParamAngleZ: 5 * Math.sin(TAU * p) * env(p) }) },
  think: { duration: 1.8, at: p => ({ ParamAngleZ: 10 * env(p) ** 0.5, ParamAngleY: 6 * env(p) ** 0.5, ParamEyeBallX: 0.6 * env(p) ** 0.5, ParamEyeBallY: 0.5 * env(p) ** 0.5 }) },
  sigh: { duration: 1.8, at: p => ({ ParamAngleY: -10 * env(p) ** 0.7, ParamBodyAngleY: -4 * env(p) ** 0.7, ParamEyeLOpen: -0.3 * env(p), ParamEyeROpen: -0.3 * env(p) }) },
  shrug: { duration: 1.0, at: p => ({ ParamAngleZ: -8 * env(p), ParamBodyAngleZ: 5 * env(p), ParamBrowLY: 0.4 * env(p), ParamBrowRY: 0.4 * env(p) }) },
  wave: { duration: 1.4, at: p => ({ ParamBodyAngleZ: 8 * Math.sin(TAU * 3 * p) * env(p), ParamAngleZ: -6 * env(p) }) },
  flinch: { duration: 0.5, at: p => ({ ParamAngleY: 8 * env(p), ParamEyeLOpen: 0.35 * env(p), ParamEyeROpen: 0.35 * env(p) }) },
}
