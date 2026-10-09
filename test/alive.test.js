import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_STALE_MINUTES,
  describe,
  guardPs1Body,
  parseSchtasksPresent,
  schtasksCreateArgs,
  schtasksDeleteArgs,
  staleness,
  verdict,
} from "../lib/alive.js";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

test("心跳新鲜时判为活着", () => {
  assert.equal(verdict(NOW - 1 * MIN, NOW), "alive");
  assert.equal(verdict(NOW - 2.9 * MIN, NOW), "alive");
});

test("超过阈值判为已死", () => {
  assert.equal(verdict(NOW - 3.1 * MIN, NOW), "stale");
  assert.equal(verdict(NOW - 60 * MIN, NOW), "stale");
});

test("没有日志文件判为 missing，而不是 stale", () => {
  assert.equal(verdict(null, NOW), "missing");
  assert.equal(verdict(undefined, NOW), "missing");
});

test("阈值可覆盖", () => {
  assert.equal(verdict(NOW - 5 * MIN, NOW, 10), "alive");
  assert.equal(verdict(NOW - 5 * MIN, NOW, 1), "stale");
});

test("staleness 给出分钟数与已知性", () => {
  const s = staleness(NOW - 4 * MIN, NOW);
  assert.equal(s.known, true);
  assert.equal(Math.round(s.ageMinutes), 4);
  assert.equal(staleness(null, NOW).known, false);
});

test("describe 把判决说成人话", () => {
  assert.match(describe("alive", 1.2), /活着/);
  assert.match(describe("stale", 9), /已死/);
  assert.match(describe("missing", null), /从未启动/);
});

test("默认阈值是心跳间隔的三倍", () => {
  assert.equal(DEFAULT_STALE_MINUTES, 3);
});

// ── 守护脚本：今晚定因的那一条必须钉住 ──────────────────────────────

const PS1 = guardPs1Body({
  watcherWin: "C:\\Users\\x\\.dsh\\tray\\dsh-ui-watcher.ps1",
  logWin: "C:\\Users\\x\\dsh-ui-watcher.log",
  guardLogWin: "C:\\Users\\x\\dsh-ui-alive.log",
});

test("守护重启常驻者时【不得】带 -WindowStyle Hidden", () => {
  // 实测：Hidden 启动的 watcher 100 秒零心跳，静默死；最小化能活。这是整个插件存在的理由。
  const startProcessLine = PS1.split("\n").filter((l) => l.includes("Start-Process")).join("\n");
  assert.ok(startProcessLine.length > 0, "生成物里必须有 Start-Process");
  assert.ok(
    !/-WindowStyle\s+Hidden/.test(startProcessLine),
    "重启常驻者时带了 -WindowStyle Hidden —— 那正是它静默死掉的原因",
  );
  assert.match(PS1, /-WindowStyle Minimized/);
});

test("守护只按日志最后写入时间判断，不去匹配进程", () => {
  assert.match(PS1, /LastWriteTime/);
  assert.ok(
    !/CommandLine/.test(PS1),
    "守护不该用命令行字符串匹配进程 —— 那会匹配到正在查询的自己",
  );
  assert.ok(!/Get-Process/.test(PS1), "守护不该查进程列表");
});

test("守护在活着的时候不写日志（避免刷屏）", () => {
  assert.match(PS1, /if \(\$ageMin -le \$staleMin\) \{ exit 0 \}/);
});

test("守护也检查 dsh 本身，而不只看常驻者", () => {
  const body = guardPs1Body({
    watcherWin: "C:\\w.ps1",
    logWin: "C:\\l.log",
    guardLogWin: "C:\\g.log",
    distro: "D",
    kitReviveSh: "/kit/scripts/revive-dsh.sh",
    dshPort: 3080,
  });
  assert.match(body, /Test-DshPort 3080/);
  assert.match(body, /wsl\.exe -d 'D' -- bash '\/kit\/scripts\/revive-dsh\.sh'/);
  assert.ok(!/Get-Process/.test(body), "判据用 TCP，不用进程列表");
});

test("没有 kit 脚本时不假装能救 dsh", () => {
  const body = guardPs1Body({
    watcherWin: "C:\\w.ps1",
    logWin: "C:\\l.log",
    guardLogWin: "C:\\g.log",
    distro: "",
    kitReviveSh: "",
  });
  assert.match(body, /cannot revive dsh/);
});

test("守护记录了上次心跳是多久之前", () => {
  assert.match(PS1, /last heartbeat/);
});

test("路径里的单引号被转义成两个", () => {
  const body = guardPs1Body({
    watcherWin: "C:\\it's here\\w.ps1",
    logWin: "C:\\it's here\\l.log",
    guardLogWin: "C:\\it's here\\g.log",
  });
  assert.match(body, /it''s here/);
  assert.ok(!/it's here/.test(body), "未转义的单引号会提前结束 PowerShell 字符串");
});

test("阈值被写进脚本", () => {
  const body = guardPs1Body({
    watcherWin: "C:\\w.ps1",
    logWin: "C:\\l.log",
    guardLogWin: "C:\\g.log",
    staleMinutes: 7,
  });
  assert.match(body, /\$staleMin\s+= 7/);
});

// ── 计划任务 ────────────────────────────────────────────────────

test("注册计划任务用 schtasks，当前用户级，不需要管理员", () => {
  const args = schtasksCreateArgs({ taskName: "T", guardPs1Win: "C:\\g.ps1", intervalMinutes: 5 });
  assert.equal(args[0], "/Create");
  assert.ok(args.includes("/SC") && args.includes("MINUTE"));
  assert.ok(args.includes("/MO") && args.includes("5"));
  assert.ok(args.includes("/F"), "幂等：重装要能覆盖");
  const tr = args[args.indexOf("/TR") + 1];
  assert.ok(tr.includes("powershell.exe"));
  assert.ok(tr.includes('"C:\\g.ps1"'), "路径带空格时要引起来");
});

test("删除计划任务的参数", () => {
  assert.deepEqual(schtasksDeleteArgs({ taskName: "T" }), ["/Delete", "/TN", "T", "/F"]);
});

test("parseSchtasksPresent：找不到就是没装", () => {
  assert.equal(parseSchtasksPresent("", "", 0), false);
  assert.equal(parseSchtasksPresent("ERROR: cannot find", "", 1), false);
  assert.equal(parseSchtasksPresent("TaskName  Next Run Time\nT   ...", "", 0), true);
  assert.equal(parseSchtasksPresent("", "找不到", 1), false);
});
