/**
 * dsh-wsl-revive 的核心：判断 Windows 侧的常驻者还活着没有，以及怎么把它救回来。
 *
 * 这个文件只放【不碰系统】的纯逻辑（判断、拼串、生成脚本），所以能在任何平台上单元测试；
 * 真正执行命令的部分在 index.js。
 *
 * 三条事实来自实测，不是推演 —— 它们是这个插件存在的理由：
 *
 *   1. 判据只能是【日志的最后写入时间】。用命令行字符串去匹配进程，会匹配到正在查询的自己，
 *      所以那办法给出过两次错误的「它还活着」。
 *   2. `dsh-ui-watcher.ps1` 以 `-WindowStyle Hidden` 启动时会静默死掉：前台跑 61 秒就写出心跳，
 *      隐藏启动 100 秒零心跳。所以救它回来时必须【不带 Hidden】，用最小化窗口。
 *   3. 心跳是每 60 秒一行，所以「超过 3 分钟没写入」就是一个安全的判死阈值。
 */

/** 心跳间隔（秒）——watcher 自己写 `alive; last=…` 的周期。 */
export const HEARTBEAT_SECONDS = 60;

/** 超过这个分钟数没有心跳，判为已死。三倍心跳间隔，容忍一次调度抖动。 */
export const DEFAULT_STALE_MINUTES = 3;

/** dsh 自己在监听的端口。relay 是它的对外入口，但 dsh 本体是这一个。 */
export const DEFAULT_DSH_PORT = 3080;

/** 守护自身的检查间隔（分钟）。 */
export const DEFAULT_INTERVAL_MINUTES = 5;

/**
 * 一个文件的「陈旧程度」。
 *
 * @param {number|null} lastWriteMs 最后写入时间（epoch 毫秒）；文件不存在时传 null
 * @param {number} nowMs 当前时间（epoch 毫秒）
 * @returns {{stale: boolean, ageMinutes: number|null, known: boolean}}
 */
export function staleness(lastWriteMs, nowMs) {
  if (lastWriteMs === null || lastWriteMs === undefined || !Number.isFinite(lastWriteMs)) {
    return { stale: true, ageMinutes: null, known: false };
  }
  if (!Number.isFinite(nowMs)) return { stale: false, ageMinutes: null, known: false };
  const ageMinutes = (nowMs - lastWriteMs) / 60000;
  return { stale: false, ageMinutes, known: true };
}

/**
 * 给常驻者下一个判决。
 *
 * @returns {'alive'|'stale'|'missing'} missing = 日志文件本身不在（从未起过，或被删了）
 */
export function verdict(lastWriteMs, nowMs, staleMinutes = DEFAULT_STALE_MINUTES) {
  const s = staleness(lastWriteMs, nowMs);
  if (!s.known) return lastWriteMs === null || lastWriteMs === undefined ? "missing" : "stale";
  return s.ageMinutes > staleMinutes ? "stale" : "alive";
}

/** 人能读的一句话，用于 status 的输出。 */
export function describe(verdictValue, ageMinutes) {
  if (verdictValue === "missing") return "常驻者没有留下日志，可能从未启动过";
  if (verdictValue === "alive") {
    const m = ageMinutes === null ? "?" : ageMinutes.toFixed(1);
    return `常驻者活着（上次心跳 ${m} 分钟前）`;
  }
  const m = ageMinutes === null ? "?" : ageMinutes.toFixed(1);
  return `常驻者已死（上次心跳 ${m} 分钟前）`;
}

/**
 * 守护脚本的内容。
 *
 * 由计划任务按 intervalMinutes 拉起；每次只做三件事：看日志、必要时救、记一行。
 * 它【不常驻】—— 常驻的是计划任务，这样脚本本身再怎么写错也拖不垮别的。
 *
 * @param {object} o
 * @param {string} o.watcherWin  watcher 脚本的 Windows 路径
 * @param {string} o.logWin      心跳日志的 Windows 路径
 * @param {string} o.guardLogWin 守护自己的记录文件（Windows 路径）
 * @param {number} o.staleMinutes
 */
export function guardPs1Body({
  watcherWin,
  logWin,
  guardLogWin,
  staleMinutes = DEFAULT_STALE_MINUTES,
  distro = "",
  kitReviveSh = "",
  dshPort = DEFAULT_DSH_PORT,
}) {
  const esc = (s) => String(s).replace(/'/g, "''");
  return `# dsh-wsl-revive —— 守护脚本，由计划任务按间隔拉起。
# 它检查的是 ${esc(logWin)} 的最后写入时间，不是进程列表：
# 用命令行字符串匹配进程会匹配到正在查询的自己，那个办法给出过错误的「它还活着」。
$ErrorActionPreference = 'Continue'
$log       = '${esc(logWin)}'
$guardLog  = '${esc(guardLogWin)}'
$watcher   = '${esc(watcherWin)}'
$staleMin  = ${Number(staleMinutes)}

function Write-GuardLog([string]$msg) {
  try {
    Add-Content -Path $guardLog -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $msg) -ErrorAction SilentlyContinue
  } catch { }
}

try {
  if (-not (Test-Path $log)) {
    Write-GuardLog 'no heartbeat log yet; nothing to judge'
    exit 0
  }
  $last = (Get-Item $log).LastWriteTime
  $ageMin = ((Get-Date) - $last).TotalMinutes
  if ($ageMin -le $staleMin) { exit 0 }   # 活着，不写日志以免刷屏

  Write-GuardLog ('resident is dead: last heartbeat ' + [math]::Round($ageMin,1) + ' min ago; reviving')

  if (-not (Test-Path $watcher)) {
    Write-GuardLog ('watcher script missing: ' + $watcher)
    exit 1
  }

  # 关键：不带 -WindowStyle Hidden。实测 Hidden 启动活不过 60 秒，最小化能活。
  # WindowStyle 7 = Minimized
  Start-Process powershell.exe -ArgumentList @(
    '-NoProfile','-ExecutionPolicy','Bypass','-File',$watcher
  ) -WindowStyle Minimized

  Start-Sleep -Seconds 5
  $after = if (Test-Path $log) { (Get-Item $log).LastWriteTime } else { $null }
  if ($after -and $after -gt $last) {
    Write-GuardLog 'revived ok: heartbeat resumed'
  } else {
    Write-GuardLog 'revived, but no new heartbeat yet (it may need up to one interval)'
  }
} catch {
  Write-GuardLog ('guard error: ' + $_)
}

# ── 第二段：dsh 本身还在吗 ────────────────────────────────────────────
# 常驻者活着不代表 dsh 活着。WSL 重启会把 dsh 带走，而常驻者（Windows 侧）不受影响，
# 于是它的心跳照写、界面却什么都没有 —— 观察对象太窄就是这样。
#
# 判据用 TCP 能不能连上 dsh 的端口，不用进程列表：进程匹配会匹配到正在查询的自己。
function Test-DshPort([int]$port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(2000)) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch { return $false } finally { $client.Close() }
}

try {
  if (Test-DshPort ${Number(dshPort)}) { exit 0 }
  Write-GuardLog ('dsh is not listening on ${Number(dshPort)}; reviving dsh')
  ${distro && kitReviveSh ? `$rc = & wsl.exe -d '${esc(distro)}' -- bash '${esc(kitReviveSh)}' 2>&1 | Out-String
  Write-GuardLog ('revive-dsh.sh exit=' + $LASTEXITCODE)
  Start-Sleep -Seconds 8
  if (Test-DshPort ${Number(dshPort)}) {
    Write-GuardLog 'dsh revived ok'
  } else {
    Write-GuardLog 'dsh still not listening after revive; see the revive log'
  }` : `Write-GuardLog 'no kit revive script configured; cannot revive dsh'`}
} catch {
  Write-GuardLog ('dsh check error: ' + $_)
}
`;
}

/**
 * 注册计划任务的参数（当前用户级，不需要管理员）。
 *
 * 用 schtasks 而不是 Register-ScheduledTask：后者在普通用户下报「拒绝访问」，
 * 而这一层必须能被普通用户装上 —— 否则守护本身就成了需要提权的负担。
 */
export function schtasksCreateArgs({ taskName, guardPs1Win, intervalMinutes = DEFAULT_INTERVAL_MINUTES }) {
  return [
    "/Create",
    "/TN", taskName,
    "/SC", "MINUTE",
    "/MO", String(intervalMinutes),
    "/TR", `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${guardPs1Win}"`,
    "/F",
  ];
}

export function schtasksDeleteArgs({ taskName }) {
  return ["/Delete", "/TN", taskName, "/F"];
}

export function schtasksQueryArgs({ taskName }) {
  return ["/Query", "/TN", taskName];
}

/**
 * 解析 schtasks 的输出判断任务在不在。
 * 退出码非 0 或者输出里没有任务名，都当作没装。
 */
export function parseSchtasksPresent(stdout, stderr, exitCode) {
  if (exitCode !== 0) return false;
  const text = String(stdout || "");
  if (!text.trim()) return false;
  return !/cannot find|找不到|ERROR/i.test(text + String(stderr || ""));
}

// ── 链条的不变量 ────────────────────────────────────────────────────
//
// 这条保活链上的每一环都靠【人工保持一致】，而断掉时不报错，只是慢慢死掉。
// 下面这些检查把"应该成立的事"写成可断言的，让下一次改动之后有人能立刻知道。

/**
 * 启动快捷方式的参数里不该有 -WindowStyle Hidden。
 * 那是常驻者静默死掉的原因，而且会被下一次重装悄悄写回去。
 */
export function checkShortcutArgs(args) {
  const s = String(args || "");
  if (!s.trim()) return { ok: false, detail: "快捷方式参数为空" };
  if (/-WindowStyle\s+Hidden/i.test(s)) {
    return { ok: false, detail: "参数里带着 -WindowStyle Hidden —— 常驻者会静默死掉" };
  }
  if (!/ui-watcher|watcher/i.test(s)) {
    return { ok: false, detail: "参数里没有指向常驻者脚本" };
  }
  return { ok: true, detail: "参数不带 Hidden，且指向常驻者" };
}

/**
 * profile 的三处必须一致：bundles 列表、dependencies 键、node_modules 目录。
 * 改名时漏掉任何一处，表现都是「插件不见了」，而不是报错指路。
 */
export function checkProfileConsistency({ bundles = [], dependencies = {}, installed = [] }) {
  const third = bundles.filter((b) => !b.startsWith("@"));
  const depSet = new Set(Object.keys(dependencies).filter((k) => !k.startsWith("@")));
  const dirSet = new Set(installed);
  const missingDep = third.filter((b) => !depSet.has(b));
  const missingDir = third.filter((b) => !dirSet.has(b));
  const extraDep = [...depSet].filter((d) => !third.includes(d));
  const problems = [];
  if (missingDep.length) problems.push(`bundles 里有但依赖里没有: ${missingDep.join(", ")}`);
  if (missingDir.length) problems.push(`bundles 里有但没装: ${missingDir.join(", ")}`);
  if (extraDep.length) problems.push(`装了但不在 bundles 里（不会启用）: ${extraDep.join(", ")}`);
  return {
    ok: problems.length === 0,
    detail: problems.length ? problems.join("；") : `${third.length} 个 bundle 三处一致`,
  };
}

/**
 * 一个 patch 里写着的 name 必须等于对应仓里 package.json 的 name。
 * `name:` 是 Cordis 解析 node_modules 的键；写错了整行加载不了，而错误信息不会指路。
 */
export function checkPatchNames(patchNames = [], packageNamesByRepo = {}) {
  const bad = [];
  for (const { name, repo } of patchNames) {
    const actual = packageNamesByRepo[repo];
    if (actual === undefined) continue; // 仓不存在就不用这条判
    if (actual !== name) bad.push(`${repo}: patch 写 ${name}，仓里实际 ${actual}`);
  }
  return {
    ok: bad.length === 0,
    detail: bad.length ? bad.join("；") : `${patchNames.length} 条的 name 与仓一致`,
  };
}
