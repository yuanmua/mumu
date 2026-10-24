/**
 * 内核公共 API，对外唯一出口。
 * 外部只认本文件，内核内部目录结构与重构不外溢；新增机制在此补一行导出。
 */

// core：容器、总线、贡献集合
export { Bus } from './core/bus.ts'
export type { WaterfallMw } from './core/bus.ts'
export { Container, Ctx } from './core/container.ts'
export type { Disposer, Plugin } from './core/container.ts'
export { KernelError } from './core/error.ts'
export { Registry } from './core/registry.ts'

// session：唯一真源
export { LOG_OPENED, SessionLog } from './session/log.ts'
export type { LogStore } from './session/log.ts'
export { BLOB_SERVICE, blobRef } from './session/blob.ts'
export type { BlobStore } from './session/blob.ts'
export { FEEDBACK_EVENT, MAIN_CHANNEL } from './session/types.ts'
export type { Feedback, HistoryTurn, LogEvent, Sender } from './session/types.ts'

// llm：模型网关、流原语
export { ModelGateway } from './llm/gateway.ts'
export type {
  ChatMessage,
  ModelRequest,
  ModelStreamEvent,
  OutputPiece,
  ProviderAdapter,
  RoleBinding,
} from './llm/gateway.ts'
export { AsyncQueue, parseMarkers, sleep } from './llm/stream.ts'
export type { StreamChunk } from './llm/stream.ts'

// mind：心跳调度
export { Mind } from './mind/scheduler.ts'
export type {
  BeatMaterial,
  Decider,
  Decision,
  Intent,
  MaterialBlock,
  MindOptions,
  WakeInput,
  WakeReason,
} from './mind/scheduler.ts'

// actions：动作层
export { ActionRegistry } from './actions/registry.ts'
export type { ActionRun, ActionType, CatalogEntry, Outcome, RunningView } from './actions/registry.ts'

// prompt：段落组装、工作记忆
export { ALL_AUDIENCES, PromptAssembly } from './prompt/assembly.ts'
export type { Audience, Note, Section } from './prompt/assembly.ts'

// io：感知、表现、发声
export { IO } from './io/port.ts'
export type {
  Expression,
  IOOptions,
  IncomingView,
  MarkerDef,
  MediaFields,
  Perception,
  Part,
  Percept,
  Surface,
  SurfaceCapabilities,
  UtterOptions,
  Utterance,
  UtteranceResult,
} from './io/port.ts'

// 装配
export { KERNEL_VERSION, LOG_SCHEMA } from './version.ts'
export { Mumu } from './mumu.ts'
export type { KernelOptions } from './mumu.ts'
