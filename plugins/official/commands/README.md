# @mumu/commands

**是什么**：管理命令的注册表与分发器。`/plugins`、`/config`、`/secret` 这些命令不属于某个表现端，而是各插件登记到这里，任何表现端都能执行。

**暴露什么**：服务 `commands`

```ts
interface CommandService {
  register(cmd: { name, usage, description, run(args, io) }): Disposer
  list(): Command[]
  run(line: string, io: { print(line) }): Promise<boolean>   // 非命令返回 false
}
```

`/help` 内建，列出全部已登记命令。

**怎么改它**

- 登记新命令：`inject: ['commands']`，`ctx.effect(() => ctx.use<CommandService>('commands').register({...}))`。
- 新表现端执行命令：把用户输入交给 `run(line, io)`，`io.print` 决定输出去哪（终端、HTTP 响应、聊天消息）。
- 想拦截或审计所有命令：在自己的插件里包一层 `run` 再 provide 一个新服务名；本插件不开 waterfall，因为命令是运维面不是角色行为。
