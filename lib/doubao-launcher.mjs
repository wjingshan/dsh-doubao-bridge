// doubao-launcher.mjs
// Shared "find / kill / start Doubao with a DevTools port" logic.
//
// Extracted from tools/start-doubao-cdp.mjs so the MCP server can restart Doubao
// by itself when the debugging port is gone. Everything here is async: the old
// launcher used a blocking busy-wait for `taskkill`, which is fine in a one-shot
// CLI but would freeze the MCP event loop (and every in-flight tool call) when
// reached from a running server.
//
// Environment:
//   DOUBAO_EXE       explicit path to the Doubao binary (skips auto-detection)
//   DOUBAO_CDP_PORT  DevTools port (default 9225)

import { spawn, execFile, execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { homedir, platform } from 'node:os';
import net from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const isWindows = platform() === 'win32';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function portOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((res) => {
    const sock = net.connect({ host, port });
    const done = (v) => { sock.destroy(); res(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

// Expand a glob-ish pattern like /opt/homebrew/Caskroom/doubao/*/... by walking
// the first wildcard segment.
function expandGlob(pattern) {
  const parts = pattern.split(sep);
  let base = sep;
  let i = 1;
  for (; i < parts.length; i++) {
    if (parts[i].includes('*')) break;
    base = join(base, parts[i]);
  }
  if (i >= parts.length) return existsSync(pattern) ? [pattern] : [];
  if (!existsSync(base)) return [];
  let hits = [];
  try {
    for (const entry of readdirSync(base)) {
      const child = join(base, entry);
      const rest = parts.slice(i + 1).join(sep);
      const full = rest ? join(child, rest) : child;
      if (rest.includes('*')) hits = hits.concat(expandGlob(full));
      else if (existsSync(full)) hits.push(full);
    }
  } catch { /* unreadable dir */ }
  return hits;
}

export function findDoubao() {
  const explicit = process.env.DOUBAO_EXE;
  if (explicit && existsSync(explicit)) return explicit;

  const home = homedir();
  const candidates = [];

  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    candidates.push(
      join(localAppData, 'Doubao', 'Application', 'Doubao.exe'),
      join(localAppData, 'Programs', 'Doubao', 'Doubao.exe'),
      join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Doubao', 'Doubao.exe'),
      join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Doubao', 'Doubao.exe')
    );
  } else {
    candidates.push(
      '/Applications/Doubao.app/Contents/MacOS/Doubao',
      '/Applications/Doubao Browser.app/Contents/MacOS/Doubao',
      join(home, 'Applications', 'Doubao.app', 'Contents', 'MacOS', 'Doubao'),
      join(home, 'Applications', 'Doubao Browser.app', 'Contents', 'MacOS', 'Doubao'),
      '/opt/homebrew/Caskroom/doubao/*/Doubao.app/Contents/MacOS/Doubao',
      '/usr/local/Caskroom/doubao/*/Doubao.app/Contents/MacOS/Doubao',
      '/opt/homebrew/bin/doubao',
      '/usr/local/bin/doubao',
      '/opt/doubao/doubao',
      '/usr/bin/doubao'
    );
  }

  for (const c of candidates) {
    if (c.includes('*')) {
      for (const hit of expandGlob(c)) if (existsSync(hit)) return hit;
    } else if (existsSync(c)) {
      return c;
    }
  }

  // Windows only: the uninstall registry records the real install root.
  // Synchronous on purpose — it is a fast local registry read and keeps
  // findDoubao() usable from a plain CLI without awaiting.
  if (isWindows) {
    try {
      const ps = `Get-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '豆包|Doubao' -and $_.InstallLocation } | Select-Object -First 1 -ExpandProperty InstallLocation`;
      const root = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
      if (root) {
        for (const rel of ['Doubao.exe', 'Application\\Doubao.exe', 'Application\\app\\Doubao.exe']) {
          const p = join(root, rel);
          if (existsSync(p)) return p;
        }
      }
    } catch { /* registry unavailable */ }
  }

  return null;
}

// Stop every running instance. Two rounds on Windows: the app sometimes
// auto-restarts once after the first kill. The sleep only happens when the kill
// actually removed something, so a cold start is not delayed by six seconds.
export async function killExisting({ log = () => {} } = {}) {
  if (isWindows) {
    let killed = false;
    try {
      await execFileAsync('taskkill', ['/IM', 'Doubao.exe', '/T', '/F'], { timeout: 15000 });
      killed = true;
    } catch { /* nothing running */ }
    if (killed) await sleep(3500);

    let killedAgain = false;
    try {
      await execFileAsync('taskkill', ['/IM', 'Doubao.exe', '/T', '/F'], { timeout: 15000 });
      killedAgain = true;
    } catch { /* nothing left */ }
    if (killedAgain) await sleep(2500);
  } else {
    // Match the exact process name. `pkill -f Doubao` was too broad: it kills
    // any process whose command line merely contains "Doubao".
    let killed = false;
    try { await execFileAsync('pkill', ['-x', 'Doubao'], { timeout: 15000 }); killed = true; } catch {}
    if (killed) await sleep(2500);
    try { await execFileAsync('pkill', ['-9', '-x', 'Doubao'], { timeout: 15000 }); } catch {}
    await sleep(1000);
  }
  void log;
}

// Start Doubao detached with the debugging port open and wait for it to answer.
// Returns { ok, exe, waitedMs, error }.
export async function launchWithCdp({ port, timeoutMs = 30000, log = () => {} } = {}) {
  const exe = findDoubao();
  if (!exe) {
    return { ok: false, error: 'not-found', message: '找不到豆包可执行文件（可用 DOUBAO_EXE 指定）' };
  }

  const child = spawn(exe, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1'
  ], {
    cwd: dirname(exe),
    detached: true,
    stdio: 'ignore'
  });

  let spawnError = null;
  child.once('error', (err) => { spawnError = err; });
  child.unref();

  const started = Date.now();
  const deadline = started + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    if (spawnError) {
      return { ok: false, error: spawnError.code || 'spawn-failed', message: spawnError.message, exe };
    }
    if (await portOpen(port)) {
      const waitedMs = Date.now() - started;
      log(`port ${port} ready after ${waitedMs}ms (${exe})`);
      return { ok: true, exe, waitedMs };
    }
  }
  log(`port ${port} not ready after ${timeoutMs}ms (${exe})`);
  return { ok: false, error: 'timeout', message: `${timeoutMs}ms 内端口 ${port} 未就绪`, exe };
}

// ---------- self-healing entry point for the MCP server ----------
// Single-flight + cooldown: a burst of tool calls must not each kill and restart
// the app. The first caller does the work; everyone else waits on the same
// promise. A failed attempt blocks retries for minIntervalMs so a broken
// installation cannot enter a restart loop.
let inflight = null;
let lastAttemptAt = 0;

export function resetEnsureState() {
  inflight = null;
  lastAttemptAt = 0;
}

/**
 * Make sure the DevTools endpoint is reachable, restarting Doubao if needed.
 * @param {{ port: number, minIntervalMs?: number, timeoutMs?: number, log?: (s: string) => void }} opts
 * @returns {Promise<{ok: boolean, restarted: boolean, reason?: string, waitedMs?: number}>}
 */
export async function ensureCdp({ port, minIntervalMs = 60000, timeoutMs = 30000, log = () => {} } = {}) {
  if (await portOpen(port)) return { ok: true, restarted: false, reason: 'already-open' };

  if (inflight) return inflight;

  const since = Date.now() - lastAttemptAt;
  if (lastAttemptAt && since < minIntervalMs) {
    return {
      ok: false,
      restarted: false,
      reason: 'cooldown',
      retryAfterMs: minIntervalMs - since
    };
  }

  lastAttemptAt = Date.now();
  inflight = (async () => {
    log(`端口中未就绪，自动重启豆包（${new Date().toISOString()}）`);
    await killExisting({ log });
    const res = await launchWithCdp({ port, timeoutMs, log });
    if (res.ok) {
      log(`自动重启成功，等待 ${res.waitedMs}ms`);
      return { ok: true, restarted: true, waitedMs: res.waitedMs };
    }
    log(`自动重启失败：${res.message || res.error}`);
    return { ok: false, restarted: false, reason: res.error, message: res.message };
  })().finally(() => { inflight = null; });

  return inflight;
}
