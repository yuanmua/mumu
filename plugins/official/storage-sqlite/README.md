# @mumu/storage-sqlite

**是什么**：SQLite 存储后端，`node:sqlite` 内置模块，零依赖。一个库文件 `data/mumu.db` 装三样东西：会话日志（`events` 表）、配置库（`config` 表）、以及别的插件自己开的表。

**暴露什么**

| 服务 | 类型 | 用途 |
|---|---|---|
| `config` | `ConfigService` | 点路径读写配置覆盖值；`onChange` 通知装配层精确重载插件 |
| `db` | `DatabaseSync` | 裸句柄。需要自己的表的插件（如 secrets）用它建表，不往配置树里塞 |

同时把日志落盘挂到内核 `log.attachPersistence`：冷启动重放、热重载续写、`log.reset()` 时清表。

**怎么改它**

- 换库文件位置：`mumu.defaults` 的 `dataDir` / `file`（引导期插件，配置只认自己的 defaults）。
- 换存储介质：写一个新插件 provide 同名的 `config` 与 `db`（`db` 的契约是 `node:sqlite` 的 `DatabaseSync`；换成别的库时让依赖它的插件一起换）。
