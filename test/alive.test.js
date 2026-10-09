import assert from "node:assert/strict";
import { test } from "node:test";

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

test("阈值可覆盖，默认是心跳间隔的三倍", () => {
  assert.equal(verdict(NOW - 5 * MIN, NOW, 10), "alive");
  assert.equal(verdict(NOW - 5 * MIN, NOW, 1), "stale");
  assert.equal(DEFAULT_STALE_MINUTES, 3);
});

test("ageMinutes 与 describe", () => {
  assert.equal(Math.round(ageMinutes(NOW - 4 * MIN, NOW)), 4);
  assert.equal(ageMinutes(null, NOW), null);
  assert.match(describe("alive", 1.2), /活着/);
  assert.match(describe("stale", 9), /已死/);
  assert.match(describe("missing", null), /从未/);
});

test("last=(none) 要解释成 WSL 刚起过，而不是常驻者坏了", () => {
  const s = "2026-01-01 00:00:00  alive; last=(none)";
  const note = heartbeatNote(s);
  assert.match(note, /WSL 刚重启/);
  assert.equal(heartbeatNote("2026-01-01 00:00:00  alive; last=http://x/?token=a"), "");
  assert.equal(heartbeatNote("2026-01-01 00:00:00  ==== watcher start ===="), "");
});

// ── 启动快捷方式：Hidden 是 kit 安装器的既定设计，不是缺陷 ──────────────

test("快捷方式指向常驻者就算已安装 —— 带 Hidden 也是正常的", () => {
  const v = shortcutVerdict(
    '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "\\\\wsl.localhost\\D\\home\\u\\kit\\bootstrap\\windows\\dsh-ui-watcher.ps1"',
  );
  assert.equal(v.installed, true, "kit 安装器就是这么写的（install-watcher.ps1:58）");
  assert.match(v.detail, /-WindowStyle Hidden/);
});

test("指向别的东西、或参数为空，都算未安装", () => {
  assert.equal(shortcutVerdict("").installed, false);
  assert.equal(shortcutVerdict("-File something-else.ps1").installed, false);
});

test("参数与安装器不一致时给出「重跑 install 会修正」", () => {
  const v = shortcutVerdict('-File "\\\\wsl.localhost\\D\\home\\u\\kit\\bootstrap\\windows\\dsh-ui-watcher.ps1"');
  assert.equal(v.installed, true);
  assert.match(v.detail, /重跑/);
});

// ── kit 定位 ────────────────────────────────────────────────────

test("DSH_WSL_KIT 优先，其次 ~/src/dsh-wsl-kit", () => {
  assert.deepEqual(kitCandidates({ home: "/home/u", env: { DSH_WSL_KIT: "/opt/kit/" } }), [
    "/opt/kit",
    "/home/u/src/dsh-wsl-kit",
  ]);
  assert.deepEqual(kitCandidates({ home: "/home/u", env: {} }), ["/home/u/src/dsh-wsl-kit"]);
});

test("kit 缺文件时列清楚缺哪个", () => {
  assert.equal(kitReady({ watcher: "w", installer: "i" }).ok, true);
  const r = kitReady({ watcher: "w" });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, [KIT_INSTALLER_REL]);
  assert.equal(KIT_WATCHER_REL.endsWith("dsh-ui-watcher.ps1"), true);
});

// ── 安装器输出 ──────────────────────────────────────────────────

test("安装器输出被翻译成人话：收掉几个、起了哪个", () => {
  const out = [
    "  autostart: C:\\...\\Startup\\DSH UI Watcher.lnk",
    "  stopped old pid 58564",
    "  running pid 23916",
    "  log tail:",
    "    2026-10-09 21:47:00  ==== watcher start (pid 23916, distro MyDistro) ====",
  ].join("\n");
  const s = summarizeInstaller(out, 0);
  assert.equal(s.ok, true);
  assert.match(s.detail, /收掉了 1 个已有实例/);
  assert.match(s.detail, /pid 23916/);
});

test("安装器非零退出码要报出来", () => {
  const s = summarizeInstaller("", 1);
  assert.equal(s.ok, false);
  assert.match(s.detail, /退出码 1/);
});

test("安装器没有 pid 行时也不假装成功", () => {
  const s = summarizeInstaller("  autostart: ...\\DSH UI Watcher.lnk", 0);
  assert.equal(s.ok, true);
  assert.match(s.detail, /没有 pid 行/);
});
