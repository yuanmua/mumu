# @mumu/surface-cli

**是什么**：终端表现端。打字机呈现（`paceMs`）、逐字回报送达、说话途中回车即打断、`<|br|>` 分段换行。也是管理命令的主入口。

**暴露什么**

- 水线 `cli/render`：每段输出前经过，拦截改 `styled` 即改样式。
- 登记到 `commands` 的命令：

| 命令 | 作用 |
|---|---|
| `/plugins` | 列出插件（装不上的带 ✗ 原因） |
| `/plugin enable\|disable\|reload <id>` | 启停、重载 |
| `/plugin scan` | 重扫插件目录：新插件不重启就装上，装失败过的再试一次 |
| `/config get\|set <路径> [值]` | 读写配置库，set 后自动重载对应插件 |
| `/log [n]` | 看最近 n 条日志 |
| `/stream <话>` | 模拟逐字语音输入 |
| `/quit` | 退出 |

`/secret` 由 secrets 插件登记，`/help` 由 commands 内建。

**怎么改它**：换样式写一个拦截 `cli/render` 的插件；加命令去 commands 登记，不用动这里。
