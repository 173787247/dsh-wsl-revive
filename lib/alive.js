/**
 * dsh-wsl-revive —— 让 Windows 侧的常驻者（dsh-ui-watcher）保持可用。
 *
 * ★ 这个插件不重新发明任何东西。
 *
 * 常驻者脚本、它的安装器、启动方式，全部沿用 dsh-wsl-kit 里已有的两个文件：
 *
 *   kit/bootstrap/windows/dsh-ui-watcher.ps1    常驻者本体：轮询 /tmp/dsh-ui-url，token 一变就开浏览器
 *   kit/bootstrap/windows/install-watcher.ps1   安装器：写启动快捷方式 → 收掉已有实例 → 起一份 → 验证
 *
 * 这个文件只放【不碰系统】的纯逻辑，任何平台都能单元测试：找 kit、判断常驻者死活、
 * 把安装器的输出翻译给人看。真正执行命令的部分在 index.js。
 *
 * ── 判断死活为什么只看日志 ──────────────────────────────────────────
 * 常驻者每分钟往 dsh-ui-watcher.log 写一行 `alive; last=…`。那个文件的最后写入时间是唯一
 * 可靠的存活信号。
 *
 * 不要用命令行字符串匹配进程：它会匹配到正在查询的自己。kit 的 install-watcher.ps1:30-37
 * 正是为此写了两条排除（`-notlike '*Get-CimInstance*'` 与 `-notlike '*-like*'`）。
 * 这个插件不重复那个易错的判断，只读文件的修改时间。
 *
 * ── 一条写在这里免得后人重犯的错 ────────────────────────────────────
 * 曾经有过一个结论：「常驻者以 `-WindowStyle Hidden` 启动会静默死掉，所以必须改用最小化」。
 * **那是错的。** 依据是"从 WSL 里临时 Start-Process 起会死"，而那与"登录时由启动文件夹拉起"
 * 不是同一个上下文 —— 换上下文的实测不能用来否定另一个上下文里的设计。
 *
 * 事实是：kit 的安装器在 install-watcher.ps1:58（写快捷方式）和 :75-76（当场起一份）**都**用
 * `-WindowStyle Hidden`，而且它工作：2026-09-29 那天常驻者连续写了 86 分钟心跳、零中断，
 * 还接住过一次真实重启。所以安装器怎么起，就照它怎么起；这个插件不传任何启动参数。
 */

/** 心跳间隔（秒）——常驻者写 `alive; last=…` 的周期。 */
export const HEARTBEAT_SECONDS = 60;

/** 超过这个分钟数没有心跳才判为已死。三倍心跳间隔，容忍一次调度抖动。 */
export const DEFAULT_STALE_MINUTES = 3;

/** kit 里的两个文件，相对于 kit 根。 */
export const KIT_WATCHER_REL = "bootstrap/windows/dsh-ui-watcher.ps1";
export const KIT_INSTALLER_REL = "bootstrap/windows/install-watcher.ps1";

/**
 * 从环境与常见位置里找 kit 根目录。
 * `DSH_WSL_KIT` 优先，其次 `~/src/dsh-wsl-kit` —— 与常驻者脚本自己的推导顺序一致。
 */
export function kitCandidates({ home, env = {} } = {}) {
  const out = [];
  const fromEnv = String(env.DSH_WSL_KIT || "").trim();
  if (fromEnv) out.push(fromEnv.replace(/\/+$/, ""));
  if (home) out.push(`${home}/src/dsh-wsl-kit`);
  return out.filter((p, i) => p && out.indexOf(p) === i);
}

/**
 * 给常驻者下一个判决。
 *
 * @param {number|null} lastWriteMs 心跳日志最后写入时间（epoch 毫秒）；文件不在传 null
 * @param {number} nowMs
 * @returns {'alive'|'stale'|'missing'}
 */
export function verdict(lastWriteMs, nowMs, staleMinutes = DEFAULT_STALE_MINUTES) {
  if (lastWriteMs === null || lastWriteMs === undefined || !Number.isFinite(lastWriteMs)) {
    return "missing";
  }
  if (!Number.isFinite(nowMs)) return "stale";
  return (nowMs - lastWriteMs) / 60000 > staleMinutes ? "stale" : "alive";
}

export function ageMinutes(lastWriteMs, nowMs) {
  if (lastWriteMs === null || lastWriteMs === undefined || !Number.isFinite(lastWriteMs)) return null;
  return (nowMs - lastWriteMs) / 60000;
}

/** 人能读的一句话。 */
export function describe(v, minutes) {
  const m = minutes === null ? "?" : minutes.toFixed(1);
  if (v === "missing") return "常驻者没有心跳日志 —— 它从未在这台机器上跑过";
  if (v === "alive") return `常驻者活着（上次心跳 ${m} 分钟前）`;
  return `常驻者已死（上次心跳 ${m} 分钟前）—— 用 install 让它回来`;
}

/**
 * 心跳内容是 `alive; last=(none)` 时，说明常驻者活着但读不到 token 文件。
 * 那通常意味着 WSL 刚重启过（/tmp 被清空），不是常驻者坏了。
 */
export function heartbeatNote(line) {
  const s = String(line || "");
  if (!s.includes("alive;")) return "";
  if (/last=\(none\)/.test(s)) {
    return "心跳里 last=(none)：常驻者读不到 /tmp/dsh-ui-url，通常是 WSL 刚重启过，等 dsh 把该文件写回来即可";
  }
  return "";
}

/**
 * 判断装没装：看启动快捷方式的参数。
 * 判据是它有没有指向常驻者脚本；`-WindowStyle Hidden` 是 kit 安装器的既定设计
 * （install-watcher.ps1:58），出现它是正常的，不是要修的东西。
 */
export function shortcutVerdict(args) {
  const s = String(args || "");
  if (!s.trim()) return { installed: false, detail: "启动快捷方式不存在或参数为空" };
  if (!/dsh-ui-watcher\.ps1/i.test(s)) {
    return { installed: false, detail: "快捷方式没有指向常驻者脚本" };
  }
  return {
    installed: true,
    detail: /-WindowStyle\s+Hidden/i.test(s)
      ? "已安装：启动快捷方式指向常驻者，并带 -WindowStyle Hidden（与 kit 安装器一致）"
      : "已安装，但参数与 kit 安装器写的不一致 —— 重跑一次 install 会由安装器修正",
  };
}

/** 安装器是否已就位（两个文件都在）。 */
export function kitReady(paths = {}) {
  const missing = [];
  if (!paths.watcher) missing.push(KIT_WATCHER_REL);
  if (!paths.installer) missing.push(KIT_INSTALLER_REL);
  return { ok: missing.length === 0, missing };
}

/** 把安装器的标准输出翻译成一句人话（它自己会打印装了什么）。 */
export function summarizeInstaller(stdout, exitCode) {
  const s = String(stdout || "");
  const started = /running pid (\d+)/.exec(s);
  const stopped = [...s.matchAll(/stopped old pid (\d+)/g)].map((m) => m[1]);
  if (exitCode !== 0) {
    return { ok: false, detail: `安装器退出码 ${exitCode}，把上面的输出发出来看` };
  }
  const parts = [];
  if (stopped.length) parts.push(`收掉了 ${stopped.length} 个已有实例`);
  if (started) parts.push(`起了新的 pid ${started[1]}`);
  return {
    ok: true,
    detail: parts.length ? parts.join("，") : "安装器已运行（输出里没有 pid 行，可能只更新了快捷方式）",
  };
}
