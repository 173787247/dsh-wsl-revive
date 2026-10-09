/**
 * dsh-wsl-revive —— 报告 dsh web 的 Windows 侧常驻者还活着没有，
 * 并可安装一个【进程外】的守护，让它在没人看着的时候自己活回来。
 *
 * 为什么守护必须在进程外：插件跑在 dsh 进程里，dsh 死了插件跟着死，
 * 它没法重启它自己所在的那个东西。所以这个插件负责【安装与管理】，
 * 而干活的那个脚本由 Windows 计划任务拉起 —— 属于 DSH，但不和 DSH 同生共死。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_STALE_MINUTES,
  describe,
  guardPs1Body,
  parseSchtasksPresent,
  schtasksCreateArgs,
  schtasksDeleteArgs,
  schtasksQueryArgs,
  verdict,
} from "./lib/alive.js";

const run = promisify(execFile);

export const name = "dsh-wsl-revive";
export const inject = ["tools", "systemPrompt"];

const TASK_NAME = "DSH WSL Resident Revive";

function positive(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 跑一个 Windows 可执行文件；wslinterop 不在时给出可判读的失败。 */
async function win(exe, args, timeoutMs) {
  try {
    const { stdout, stderr } = await run(exe, args, { timeout: timeoutMs, windowsHide: true });
    return { ok: true, stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (e) {
    return {
      ok: false,
      stdout: String(e?.stdout ?? ""),
      stderr: String(e?.stderr ?? e?.message ?? ""),
      code: typeof e?.code === "number" ? e.code : 1,
    };
  }
}

/** Windows 用户目录（`C:\Users\x`）。 */
async function windowsProfile(timeoutMs) {
  const r = await win("powershell.exe", ["-NoProfile", "-Command", "$env:USERPROFILE"], timeoutMs);
  return r.ok ? r.stdout.trim().replace(/\r?\n/g, "") : "";
}

/** WSL 路径 → Windows 路径；失败时返回空串。 */
async function toWindowsPath(p, timeoutMs) {
  const r = await win("wslpath", ["-w", p], timeoutMs);
  return r.ok ? r.stdout.trim() : "";
}

/**
 * `/mnt/c/Users/x` 与 `C:\Users\x` 互转。心跳日志在 Windows 家目录下，
 * 而 WSL 能直接 stat 它 —— 所以读时间不需要经过 powershell。
 */
function winPathToWsl(winPath) {
  const m = /^([A-Za-z]):\\(.*)$/.exec(String(winPath || ""));
  if (!m) return "";
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

function wslPathToWin(p) {
  const m = /^\/mnt\/([a-z])\/(.*)$/.exec(String(p || ""));
  if (!m) return "";
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
}

/** 常驻者脚本与心跳日志的位置：配置优先，否则按 kit 的默认位置推导。 */
function paths(config, profileWin) {
  const trayWsl = join(homedir(), ".dsh", "tray");
  const watcherWsl = config.watcherPath
    ? String(config.watcherPath)
    : join(trayWsl, "dsh-ui-watcher.ps1");
  const logWin = config.heartbeatLog
    ? String(config.heartbeatLog)
    : profileWin
      ? `${profileWin}\\dsh-ui-watcher.log`
      : "";
  const guardDirWsl = join(homedir(), ".dsh", "revive");
  return {
    watcherWsl,
    watcherWin: wslPathToWin(watcherWsl),
    logWin,
    logWsl: winPathToWsl(logWin),
    guardDirWsl,
    guardPs1Wsl: join(guardDirWsl, "dsh-ui-alive.ps1"),
    guardLogWin: profileWin ? `${profileWin}\\dsh-ui-alive.log` : "",
  };
}

export function parameters(config = {}) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: ["status", "install_guard", "uninstall_guard"],
        description:
          "status: 报告常驻者活着没有、守护装没装（不改任何东西）。" +
          "install_guard: 写入守护脚本并注册 Windows 计划任务（幂等，不需要管理员）。" +
          "uninstall_guard: 删除计划任务（保留日志）。",
      },
      staleMinutes: {
        type: "number",
        description: `超过多少分钟没有心跳就判为已死（默认 ${positive(config.staleMinutes, DEFAULT_STALE_MINUTES)}）。`,
      },
      intervalMinutes: {
        type: "number",
        description: `守护自身的检查间隔，分钟（默认 ${positive(config.intervalMinutes, DEFAULT_INTERVAL_MINUTES)}）。`,
      },
    },
  };
}

export function outputSchema() {
  return {
    type: "object",
    additionalProperties: true,
    properties: {
      ok: { type: "boolean" },
      action: { type: "string" },
      alive: { type: "string", description: "alive | stale | missing" },
      ageMinutes: { type: ["number", "null"] },
      guardInstalled: { type: "boolean" },
    },
  };
}

export async function execute(args = {}, config = {}) {
  const action = String(args.action || "status");
  const timeoutMs = positive(config.timeoutMs, 60_000);
  const staleMinutes = positive(args.staleMinutes ?? config.staleMinutes, DEFAULT_STALE_MINUTES);
  const intervalMinutes = positive(
    args.intervalMinutes ?? config.intervalMinutes,
    DEFAULT_INTERVAL_MINUTES,
  );

  const profileWin = await windowsProfile(timeoutMs);
  if (!profileWin) {
    return { ok: false, action, error: "windows_unreachable", advice: advice("windows_unreachable") };
  }
  const p = paths(config, profileWin);

  const guard = await win("schtasks.exe", schtasksQueryArgs({ taskName: TASK_NAME }), timeoutMs);
  const guardInstalled = parseSchtasksPresent(guard.stdout, guard.stderr, guard.code);

  // 读心跳：心跳日志在 Windows 家目录下，WSL 可以直接 stat，不必经过 powershell。
  let lastWriteMs = null;
  if (p.logWsl && existsSync(p.logWsl)) {
    try {
      lastWriteMs = statSync(p.logWsl).mtimeMs;
    } catch {
      lastWriteMs = null;
    }
  }
  const v = verdict(lastWriteMs, Date.now(), staleMinutes);
  const ageMinutes =
    lastWriteMs === null ? null : (Date.now() - lastWriteMs) / 60000;

  if (action === "uninstall_guard") {
    if (!guardInstalled) {
      return { ok: true, action, alive: v, ageMinutes, guardInstalled: false, note: "守护本来就没装" };
    }
    const del = await win("schtasks.exe", schtasksDeleteArgs({ taskName: TASK_NAME }), timeoutMs);
    return {
      ok: del.ok,
      action,
      alive: v,
      ageMinutes,
      guardInstalled: false,
      note: del.ok ? "已删除计划任务" : `删除失败: ${del.stderr.trim().slice(0, 200)}`,
    };
  }

  if (action === "install_guard") {
    if (!p.watcherWin) {
      return { ok: false, action, error: "watcher_path_not_translatable", path: p.watcherWsl };
    }
    if (!existsSync(p.watcherWsl)) {
      return {
        ok: false,
        action,
        error: "watcher_missing",
        path: p.watcherWsl,
        advice: advice("watcher_missing"),
      };
    }
    mkdirSync(p.guardDirWsl, { recursive: true });
    writeFileSync(
      p.guardPs1Wsl,
      guardPs1Body({
        watcherWin: p.watcherWin,
        logWin: p.logWin,
        guardLogWin: p.guardLogWin,
        staleMinutes,
      }),
      "utf8",
    );
    const guardWin = wslPathToWin(p.guardPs1Wsl);
    const created = await win(
      "schtasks.exe",
      schtasksCreateArgs({ taskName: TASK_NAME, guardPs1Win: guardWin, intervalMinutes }),
      timeoutMs,
    );
    return {
      ok: created.ok,
      action,
      alive: v,
      ageMinutes,
      guardInstalled: created.ok,
      guardPs1: p.guardPs1Wsl,
      guardLog: p.guardLogWin,
      intervalMinutes,
      staleMinutes,
      note: created.ok
        ? `守护已安装：每 ${intervalMinutes} 分钟检查一次，心跳超过 ${staleMinutes} 分钟没更新就重启常驻者`
        : `注册计划任务失败: ${created.stderr.trim().slice(0, 200)}`,
      advice: created.ok ? [] : advice("schtasks_failed"),
    };
  }

  return {
    ok: true,
    action: "status",
    alive: v,
    ageMinutes,
    summary: describe(v, ageMinutes),
    guardInstalled,
    taskName: TASK_NAME,
    watcher: p.watcherWsl,
    heartbeatLog: p.logWin,
    staleMinutes,
    advice: v === "alive" ? [] : advice(v === "missing" ? "missing" : "stale"),
  };
}

function advice(kind) {
  if (kind === "windows_unreachable") {
    return ["powershell.exe 不可达：确认 WSL 的 interop 开着，且当前是 WSL 内的 dsh"];
  }
  if (kind === "watcher_missing") {
    return [
      "常驻者脚本不在，先用 dsh-wsl-tray 的 install_scripts 生成它",
      "或设 DSH_WSL_KIT 指向 kit 检出后重试",
    ];
  }
  if (kind === "missing") {
    return [
      "心跳日志不存在 = 常驻者从未在这台机器上跑过",
      "用 dsh-wsl-tray 的 install_tray 装上它，再回来 install_guard",
    ];
  }
  if (kind === "stale") {
    return [
      "先跑 install_guard —— 之后它会自己把常驻者救回来",
      "注意：用 -WindowStyle Hidden 启动的常驻者会静默死掉，守护用的是最小化窗口",
    ];
  }
  if (kind === "schtasks_failed") {
    return [
      "schtasks 注册失败通常是权限或策略限制",
      "手动跑一次 schtasks /Create /? 看本机是否允许当前用户建计划任务",
    ];
  }
  return [];
}

export function format(value) {
  if (!value || typeof value !== "object") return String(value);
  const lines = [];
  if (value.summary) lines.push(value.summary);
  else if (value.alive) lines.push(`常驻者状态: ${value.alive}`);
  if (value.guardInstalled !== undefined) {
    lines.push(`守护: ${value.guardInstalled ? "已安装" : "未安装"}`);
  }
  if (value.note) lines.push(value.note);
  if (value.error) lines.push(`错误: ${value.error}`);
  if (Array.isArray(value.advice)) for (const a of value.advice) lines.push(`- ${a}`);
  return lines.join("\n");
}

/** 给运行时用的：安装守护需要知道常驻者脚本在哪。 */
export const internals = { paths, winPathToWsl, wslPathToWin, TASK_NAME };

export function apply(ctx, config = {}) {
  const timeoutMs = positive(config.timeoutMs, 60_000);

  ctx.systemPrompt.section({
    name: "tool:wsl_revive",
    order: 118,
    text:
      "Use wsl_revive to check whether the dsh web resident (the Windows-side watcher that reopens " +
      "the UI after a restart) is still alive, and to install a process-external guard that revives " +
      "it. The guard runs from a Windows scheduled task, not inside dsh, because a plugin cannot " +
      "restart the process it lives in.",
  });

  ctx.tools.register({
    name: "wsl_revive",
    description:
      "Report whether the dsh web resident is still alive in WSL (by the heartbeat log's last write " +
      "time), and install or remove a Windows-side guard that revives it. The guard lives outside " +
      "the dsh process on purpose.",
    parameters: parameters(config),
    output: {
      schema: outputSchema(),
      render: (_args, value) => [{ type: "text", text: format(value) }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args) {
      return execute(args, config);
    },
  });
}
