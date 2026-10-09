/**
 * dsh-wsl-revive —— 报告 dsh web 的 Windows 侧常驻者还活着没有，并可按 kit 既定的方式把它装回来。
 *
 * ★ 这个插件不重新发明任何东西，也不加自己的常驻进程。
 *
 * 它只调 kit 已有的安装器，并把结果翻译成人话：
 *
 *   kit/bootstrap/windows/install-watcher.ps1   写启动快捷方式 → 收掉已有实例 → 起一份 → 验证
 *                                               （-Uninstall 卸载）
 *   kit/bootstrap/windows/dsh-ui-watcher.ps1    常驻者本体
 *
 * 曾经这个插件自带一个「守护脚本 + Windows 计划任务」，用最小化窗口去重启常驻者。那套是基于
 * 一个错误结论（"Hidden 启动会死"）写的，而且它缺了安装器里的「先收掉已有实例」——
 * 两份常驻者会开两次浏览器。已经删掉，全部改用安装器。
 *
 * 传给 powershell 的参数走 execFile 的数组形式，不经过 shell ——
 * 拿 bash 拼引号去调 PowerShell 会静默出错，那条路不要走。
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { distroName } from "./lib/wsl-host.js";

import {
  DEFAULT_STALE_MINUTES,
  KIT_INSTALLER_REL,
  KIT_WATCHER_REL,
  ageMinutes,
  describe,
  heartbeatNote,
  kitCandidates,
  kitReady,
  shortcutVerdict,
  summarizeInstaller,
  verdict,
} from "./lib/alive.js";

const run = promisify(execFile);

export const name = "dsh-wsl-revive";
export const inject = ["tools", "systemPrompt"];

function positive(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 跑一个 Windows 可执行文件。数组传参，不经 shell。 */
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

/** Windows 用户目录，用来定位心跳日志。 */
async function windowsProfile(timeoutMs) {
  const r = await win("powershell.exe", ["-NoProfile", "-Command", "$env:USERPROFILE"], timeoutMs);
  return r.ok ? r.stdout.trim().replace(/\r?\n/g, "") : "";
}

/** `/mnt/c/Users/x` ↔ `C:\Users\x`。心跳日志在 Windows 家目录，WSL 能直接 stat，不必经 powershell。 */
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

/** WSL 内部文件系统里的路径，Windows 只能经 UNC 访问。 */
function wslInternalToUnc(p, distro) {
  const abs = String(p || "");
  if (!abs.startsWith("/") || !distro) return "";
  return `\\\\wsl.localhost\\${distro}${abs.replace(/\//g, "\\")}`;
}

/** 找一个存在的 kit 根目录。 */
function resolveKit(config) {
  const candidates = [
    ...(config.kitPath ? [String(config.kitPath)] : []),
    ...kitCandidates({ home: homedir(), env: process.env }),
  ];
  for (const c of candidates) {
    const watcher = join(c, KIT_WATCHER_REL);
    const installer = join(c, KIT_INSTALLER_REL);
    if (existsSync(watcher) && existsSync(installer)) {
      return { root: c, watcher, installer, tried: candidates };
    }
  }
  return { root: "", watcher: "", installer: "", tried: candidates };
}

/** 启动文件夹里那个快捷方式的参数。 */
async function shortcutArgs(timeoutMs, distro) {
  const ps =
    "$s=New-Object -ComObject WScript.Shell;" +
    "$p=Join-Path ([Environment]::GetFolderPath('Startup')) 'DSH UI Watcher.lnk';" +
    "if(Test-Path $p){$s.CreateShortcut($p).Arguments}else{''}";
  const r = await win("powershell.exe", ["-NoProfile", "-Command", ps], timeoutMs);
  return r.ok ? r.stdout.trim() : "";
}

/** 心跳日志的最后写入时间（经 WSL 直接 stat）。 */
function heartbeatMtime(logWsl) {
  try {
    if (logWsl && existsSync(logWsl)) return statSync(logWsl).mtimeMs;
  } catch {}
  return null;
}

/** 心跳日志最后一行，用来看 last=(none) 这种情况。 */
function heartbeatTail(logWsl) {
  try {
    if (!logWsl || !existsSync(logWsl)) return "";
    const text = readFileSync(logWsl, "utf8");
    const lines = text.trimEnd().split("\n");
    return lines[lines.length - 1] || "";
  } catch {
    return "";
  }
}

export function parameters(config = {}) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: ["status", "install", "uninstall"],
        description:
          "status: 只报告 —— 常驻者活着没有、装没装、kit 在哪（不改任何东西）。" +
          "install: 跑 kit 的 install-watcher.ps1（写快捷方式 → 收掉已有实例 → 起一份 → 验证）。" +
          "uninstall: 跑同一个安装器的 -Uninstall（删快捷方式、停掉常驻者）。",
      },
      staleMinutes: {
        type: "number",
        description: `超过多少分钟没有心跳判为已死（默认 ${positive(config.staleMinutes, DEFAULT_STALE_MINUTES)}）。`,
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
      resident: { type: "string", description: "alive | stale | missing" },
      installed: { type: "boolean" },
      detail: { type: "string" },
    },
  };
}

export async function execute(args = {}, config = {}) {
  const action = String(args.action || "status");
  const timeoutMs = positive(config.timeoutMs, 60_000);
  const staleMinutes = positive(args.staleMinutes ?? config.staleMinutes, DEFAULT_STALE_MINUTES);

  const kit = resolveKit(config);
  if (!kit.root) {
    return {
      ok: false,
      action,
      error: "kit_not_found",
      tried: kit.tried,
      advice: [
        "设 DSH_WSL_KIT 指向 kit 检出，或在配置里给 kitPath",
        `需要这两个文件: ${KIT_WATCHER_REL} · ${KIT_INSTALLER_REL}`,
      ],
    };
  }

  const ready = kitReady({ watcher: kit.watcher, installer: kit.installer });
  const profileWin = await windowsProfile(timeoutMs);
  const logWin = profileWin ? `${profileWin}\\dsh-ui-watcher.log` : "";
  const logWsl = winPathToWsl(logWin);
  const lastMs = heartbeatMtime(logWsl);
  const now = Date.now();
  const resident = verdict(lastMs, now, staleMinutes);
  const mins = ageMinutes(lastMs, now);
  const args2 = await shortcutArgs(timeoutMs);
  const link = shortcutVerdict(args2);

  // ── status：只读 ────────────────────────────────────────────────
  if (action === "status") {
    const notes = [];
    const hb = heartbeatNote(heartbeatTail(logWsl));
    if (hb) notes.push(hb);
    if (!ready.ok) notes.push(`kit 里缺: ${ready.missing.join(", ")}`);
    return {
      ok: true,
      action,
      resident,
      ageMinutes: mins === null ? null : Number(mins),
      summary: describe(resident, mins),
      installed: link.installed,
      installDetail: link.detail,
      kitRoot: kit.root,
      heartbeatLog: logWin,
      staleMinutes,
      notes,
      advice:
        resident === "alive"
          ? []
          : ["跑 install 会让 kit 的安装器把常驻者带回来（它会先收掉已有实例）"],
    };
  }

  // ── install / uninstall：都交给 kit 的安装器 ────────────────────
  if (!ready.ok) {
    return { ok: false, action, error: "kit_incomplete", missing: ready.missing, kitRoot: kit.root };
  }

  // 发行版名不要只信环境变量：dsh 进程、非登录 shell、子进程里它可能为空。
  // wsl-host.js 的 distroName() 会去问 Windows（wslpath），那才是可靠的来源。
  const distro = process.env.WSL_DISTRO_NAME || distroName({ env: process.env }) || "";
  const installerWin = wslPathToWin(kit.installer) || wslInternalToUnc(kit.installer, distro);
  if (!installerWin) {
    return {
      ok: false,
      action,
      error: "path_not_translatable",
      path: kit.installer,
      advice: ["installer 在 WSL 内部文件系统里，需要 WSL_DISTRO_NAME 才能转成 UNC 路径"],
    };
  }

  const psArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installerWin];
  if (action === "uninstall") psArgs.push("-Uninstall");
  const res = await win("powershell.exe", psArgs, timeoutMs * 3);
  const sum = summarizeInstaller(res.stdout, res.code);

  // 只放能无损序列化的值：undefined 会让工具输出被判为非法 JSON。
  const out = {
    ok: Boolean(res.ok && sum.ok),
    action,
    resident,
    ageMinutes: mins === null ? null : Number(mins),
    installed: action === "install",
    detail: sum.detail,
    kitRoot: kit.root,
    advice: res.ok && sum.ok ? [] : ["把 installerOutput 发出来看"],
  };
  const stdoutTail = res.stdout.trim().slice(-800);
  if (stdoutTail) out.installerOutput = stdoutTail;
  if (!res.ok) {
    const errTail = res.stderr.trim().slice(-400);
    if (errTail) out.installerError = errTail;
  }
  return out;
}

export function format(value) {
  if (!value || typeof value !== "object") return String(value);
  const lines = [];
  if (value.summary) lines.push(value.summary);
  else if (value.resident) lines.push(`常驻者: ${value.resident}`);
  if (value.installed !== undefined) lines.push(`启动快捷方式: ${value.installed ? "已装" : "未装"}`);
  if (value.installDetail) lines.push(value.installDetail);
  if (value.detail) lines.push(value.detail);
  if (Array.isArray(value.notes)) for (const n of value.notes) lines.push(`注: ${n}`);
  if (value.error) lines.push(`错误: ${value.error}`);
  if (Array.isArray(value.advice)) for (const a of value.advice) lines.push(`- ${a}`);
  return lines.join("\n");
}

export const internals = { resolveKit, winPathToWsl, wslPathToWin, wslInternalToUnc };

export function apply(ctx, config = {}) {
  const timeoutMs = positive(config.timeoutMs, 60_000);

  ctx.systemPrompt.section({
    name: "tool:wsl_revive",
    order: 118,
    text:
      "Use wsl_revive to check whether the dsh web resident (the Windows-side watcher that reopens " +
      "the UI after a restart) is alive, and to install or remove it. It calls the kit's own " +
      "install-watcher.ps1 rather than reimplementing the watcher: that installer writes the startup " +
      "shortcut, stops any existing instance, starts one, and verifies it.",
  });

  ctx.tools.register({
    name: "wsl_revive",
    description:
      "Report whether the dsh web resident is alive in WSL (judged by the heartbeat log's last write " +
      "time), and install or uninstall it through the kit's install-watcher.ps1.",
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
