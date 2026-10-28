#!/usr/bin/env node
// start-doubao-cdp.mjs
// Cross-platform launcher: start the local Doubao (豆包) desktop app with its
// DevTools endpoint open, so dsh-doubao-bridge can drive it.
//
// Usage:
//   node tools/start-doubao-cdp.mjs
//
// This is the recommended entry point on macOS and Linux (Node only). The
// PowerShell script remains for Windows users who prefer it, but both do the
// same thing.
//
// Environment:
//   DOUBAO_EXE       explicit path to the Doubao binary (skips auto-detection)
//   DOUBAO_CDP_PORT  DevTools port (default 9225)

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { homedir, platform } from 'node:os';
import net from 'node:net';

const PORT = Number(process.env.DOUBAO_CDP_PORT || 9225);
const isWindows = platform() === 'win32';

function portOpen(port) {
  return new Promise((res) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { sock.destroy(); res(v); };
    sock.setTimeout(800);
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

function findDoubao() {
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

function killExisting() {
  if (isWindows) {
    for (let round = 0; round < 2; round++) {
      try {
        execFileSync('taskkill', ['/IM', 'Doubao.exe', '/T', '/F'], { stdio: 'ignore' });
      } catch { /* nothing running */ }
      sleepSync(3500);
    }
  } else {
    try {
      execFileSync('pkill', ['-f', 'Doubao'], { stdio: 'ignore' });
    } catch { /* nothing running */ }
    sleepSync(2500);
    try {
      execFileSync('pkill', ['-9', '-f', 'Doubao'], { stdio: 'ignore' });
    } catch { /* nothing running */ }
    sleepSync(1000);
  }
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait, short */ }
}

async function main() {
  console.log('== 豆包 CDP 启动器 ==');

  if (await portOpen(PORT)) {
    console.log(`端口 ${PORT} 已在监听，豆包无需重启。`);
    return 0;
  }

  const exe = findDoubao();
  if (!exe) {
    console.error('失败：找不到豆包可执行文件。');
    if (!isWindows) console.error('  macOS: brew install --cask doubao');
    console.error('  或用 DOUBAO_EXE 环境变量指定完整路径。');
    return 1;
  }

  const workDir = resolve(dirname(exe), '..');
  console.log(`豆包：${exe}`);

  console.log('关闭正在运行的豆包进程（未发送的草稿会丢失）...');
  killExisting();

  console.log(`以 --remote-debugging-port=${PORT} 启动...`);
  const child = spawn(exe, [
    `--remote-debugging-port=${PORT}`,
    '--remote-debugging-address=127.0.0.1'
  ], {
    cwd: workDir,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  for (let i = 1; i <= 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await portOpen(PORT)) {
      console.log(`成功：127.0.0.1:${PORT} 已就绪（约 ${i}s）。`);
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
        const v = await res.json();
        console.log(`CDP: ${v.Browser || v['User-Agent'] || 'unknown'}`);
      } catch { /* version probe is optional */ }
      return 0;
    }
  }

  console.error(`失败：30 秒内端口 ${PORT} 未就绪。`);
  return 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(String((err && err.message) || err));
  process.exit(1);
});
