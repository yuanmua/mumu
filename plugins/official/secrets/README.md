# @mumu/secrets

**是什么**：密钥服务。API key 存在 SQLite 的独立表 `secrets` 里，与配置树物理分离；任何文件、任何 `/config get`、任何调试页都看不到值。

**暴露什么**

- 服务 `secrets`：`get(name)` · `set(name, value)` · `del(name)` · `list()`（只返回名字与更新时间）。
- 命令 `/secret set <名字> <值>` · `/secret del <名字>` · `/secret list`。

**约定**：用密钥的插件（provider-openai、tts）配置里只写 `apiKeyRef: "<名字>"`，请求时才 `secrets.get()`。改了密钥不用重载插件。

**怎么改它**

- 换存储：provide 同名服务即可，契约只有上面四个方法。
- 想加密落盘：在 `set` / `get` 两处包一层；本插件刻意没做，因为本地单用户场景下加密钥匙无处可放。
