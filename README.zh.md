# dsh-wsl-revive

> **安装集:** 属于 [dsh-wsl-kit](https://github.com/173787247/dsh-wsl-kit)。

DeepSeek Harness 插件：报告 WSL 里 **dsh web 的 Windows 侧常驻者**活着没有，并可装它、卸它。

它不重新实现常驻者 —— 只调 kit 里已有的安装器。

[English → README.md](./README.md)

## 它驱动的是 kit 里的哪两个文件

| kit 里的文件 | 是什么 |
|---|---|
| `bootstrap/windows/dsh-ui-watcher.ps1` | 常驻者：轮询 `/tmp/dsh-ui-url`，token 一变就开浏览器 |
| `bootstrap/windows/install-watcher.ps1` | 安装器：写启动快捷方式 → 收掉已有实例 → 起一份 → 验证 |

这个插件自己没有常驻进程。`install` / `uninstall` 跑那个安装器；`status` 只读。

## 怎么判断死活

常驻者每分钟往 `dsh-ui-watcher.log` 写一行：

```
2026-01-01 00:00:00  alive; last=http://127.0.0.1:3081/?token=…
```

**这个文件的最后写入时间就是判据。** 不要用命令行字符串去匹配进程 —— 那会匹配到正在查询的自己。
kit 的安装器已经在 `Find-WatcherProcesses` 里用两条排除处理了这件事；这个插件不重复那个错，
只读文件的修改时间。

如果那行是 `alive; last=(none)`，说明常驻者活着但读不到 `/tmp/dsh-ui-url` —— 通常是 WSL 刚重启、
`/tmp` 被清空。等 dsh 把该文件写回来即可。

## 工具

| action | 作用 |
|---|---|
| `status` | 报常驻者的判决、快捷方式装没装、kit 在哪。不改任何东西。 |
| `install` | 跑 kit 的安装器：快捷方式 → 收掉已有实例 → 起一份 → 验证。 |
| `uninstall` | 同一个安装器加 `-Uninstall`。 |

```
wsl_revive
wsl_revive action=install
wsl_revive action=uninstall
```

## 要求

- Windows + WSL，且 DeepSeek Harness 跑在 WSL 里。
- `powershell.exe` 可达（WSL 默认就有）。
- 一份 `dsh-wsl-kit` 检出。`DSH_WSL_KIT` 指定位置，否则找 `~/src/dsh-wsl-kit`。

## 配置

```yaml
- id: dsh-wsl-revive
  config:
    timeoutMs: 60000
    staleMinutes: 3    # 心跳间隔的三倍
    kitPath: ""        # 默认 $DSH_WSL_KIT，其次 ~/src/dsh-wsl-kit
```

## 测试

```
npm test
```

只有纯逻辑 —— 判决、找 kit、解析快捷方式参数、解析安装器输出。任何平台都能跑，不碰系统。

## License

MIT
