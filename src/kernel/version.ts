/**
 * 内核与日志格式的版本号。每段日志以 log.opened 开头记下二者（见 session/log.ts），
 * 旧日志按当时的版本解读，训练素材据此判断字段含义。
 *
 * - KERNEL_VERSION：冻结契约（architecture-paper §9）变了就升；破坏性变更升主版本。
 * - LOG_SCHEMA：内核自己写的事件（action.* / utterance.* / perception.* / model.* / beat.* …）的字段含义变了就升。
 */
export const KERNEL_VERSION = '1.1.0'
export const LOG_SCHEMA = 1
