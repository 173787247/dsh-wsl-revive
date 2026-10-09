# dsh-wsl-revive

> **Install set:** part of [dsh-wsl-kit](https://github.com/173787247/dsh-wsl-kit).

DeepSeek Harness plugin: report whether the **dsh web resident** is alive in WSL, and install or
remove it.

It does not reimplement the resident. It calls the kit's own installer.

[中文说明 → README.zh.md](./README.zh.md)

## What it drives

| file in the kit | what it is |
|---|---|
| `bootstrap/windows/dsh-ui-watcher.ps1` | the resident: polls `/tmp/dsh-ui-url` and opens the browser when the token changes |
| `bootstrap/windows/install-watcher.ps1` | the installer: writes the startup shortcut → stops any existing instance → starts one → verifies it |

The plugin adds no process of its own. `install` and `uninstall` run that installer; `status` only reads.

## Judging liveness

The resident writes one line a minute to `dsh-ui-watcher.log`:

```
2026-01-01 00:00:00  alive; last=http://127.0.0.1:3081/?token=…
```

**The last write time of that file is the signal.** Do not match the process by its command-line
string — that finds the process doing the asking. The kit's installer already handles this in
`Find-WatcherProcesses` with two exclusions; this plugin does not repeat the mistake, it reads the
file's mtime and nothing else.

If the line says `alive; last=(none)`, the resident is up but cannot read `/tmp/dsh-ui-url` — usually
because WSL just restarted and cleared `/tmp`. Wait for dsh to write that file back.

## Tools

| action | effect |
|---|---|
| `status` | reports the resident's verdict, whether the shortcut is installed, and where the kit is. Changes nothing. |
| `install` | runs the kit installer: shortcut → stop existing → start one → verify. |
| `uninstall` | runs the same installer with `-Uninstall`. |

```
wsl_revive
wsl_revive action=install
wsl_revive action=uninstall
```

## Requirements

- Windows with WSL, and DeepSeek Harness running inside it.
- `powershell.exe` reachable (standard in WSL).
- A `dsh-wsl-kit` checkout. `DSH_WSL_KIT` says where; otherwise `~/src/dsh-wsl-kit`.

## Configuration

```yaml
- id: dsh-wsl-revive
  config:
    timeoutMs: 60000
    staleMinutes: 3    # 3 × the heartbeat interval
    kitPath: ""        # default: $DSH_WSL_KIT, then ~/src/dsh-wsl-kit
```

## Tests

```
npm test
```

Pure logic only — verdicts, kit discovery, shortcut parsing, installer-output parsing. Runs anywhere,
touches nothing.

## License

MIT
