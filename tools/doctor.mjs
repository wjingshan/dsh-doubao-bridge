#!/usr/bin/env node
// doctor.mjs — preflight check for dsh-doubao-bridge.
//
// Runs BEFORE anything is installed, so you can tell whether the environment
// can work at all. Checks are ordered by dependency: Node → Doubao app →
// DevTools port → CDP pages → (optional) the bridge itself.
//
// Usage:
//   node tools/doctor.mjs
//
// Exit code 0 means every REQUIRED check passed; 1 means something must be
// fixed first. Optional checks never fail the run.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { homedir, platform, release } from 'node:os';
import net from 'node:net';

const PORT = Number(process.env.DOUBAO_CDP_PORT || 9225);
const BADGE_PORT = Number(process.env.DOUBAO_BADGE_PORT || 9226);
const ENDPOINT = process.env.DOUBAO_CDP || `http://127.0.0.1:${PORT}`;
const isWindows = platform() === 'win32';

const results = [];
function pass(name, detail = '') { results.push({ ok: true, required: true, name, detail }); }
function fail(name, detail = '', hint = '') { results.push({ ok: false, required: true, name, detail, hint }); }
function info(name, detail = '') { results.push({ ok: true, required: false, name, detail }); }
function warn(name, detail = '', hint = '') { results.push({ ok: false, required: false, name, detail, hint }); }

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
  } catch { /* unreadable */ }
  return hits;
}

function findDoubao() {
  if (process.env.DOUBAO_EXE && existsSync(process.env.DOUBAO_EXE)) {
    return { path: process.env.DOUBAO_EXE, from: 'DOUBAO_EXE' };
  }
  const home = homedir();
  const candidates = [];
  if (isWindows) {
    const lad = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    candidates.push(
      join(lad, 'Doubao', 'Application', 'Doubao.exe'),
      join(lad, 'Programs', 'Doubao', 'Doubao.exe'),
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
      '/usr/local/bin/doubao'
    );
  }
  for (const c of candidates) {
    if (c.includes('*')) {
      for (const hit of expandGlob(c)) if (existsSync(hit)) return { path: hit, from: 'auto' };
    } else if (existsSync(c)) {
      return { path: c, from: 'auto' };
    }
  }
  return null;
}

function findProfiles() {
  const root = join(homedir(), '.dsh', 'profiles');
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root).filter((n) => {
      try { return existsSync(join(root, n, 'package.json')); } catch { return false; }
    }).map((n) => ({ name: n, dir: join(root, n) }));
  } catch { return []; }
}

function bridgeInstalledIn(profileDir) {
  const self = join(profileDir, 'node_modules', 'dsh-doubao-bridge');
  if (existsSync(self)) return true;
  try {
    const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    return Object.keys(deps).includes('dsh-doubao-bridge');
  } catch { return false; }
}

async function main() {
  console.log('== dsh-doubao-bridge 自检 ==');
  console.log(`平台: ${platform()} ${release()}`);
  console.log('');

  // --- 1. Node ---
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) pass('Node.js ≥ 22', `v${process.versions.node}`);
  else fail('Node.js ≥ 22', `当前 v${process.versions.node}`, '升级 Node：https://nodejs.org 或 nvm install 22');
  if (typeof WebSocket === 'function') pass('全局 WebSocket 可用');
  else fail('全局 WebSocket 可用', '缺失', 'Node 版本过低，升级到 22+');

  // --- 2. Doubao app ---
  const found = findDoubao();
  if (found) {
    pass('找到豆包可执行文件', `${found.path}（${found.from}）`);
  } else {
    fail(
      '找到豆包可执行文件',
      '未找到',
      isWindows
        ? '确认已安装豆包 PC 版；或用 DOUBAO_EXE 指定路径'
        : 'brew install --cask doubao；或用 DOUBAO_EXE 指定路径'
    );
  }

  // --- 3. DevTools port ---
  const open = await portOpen(PORT);
  if (open) {
    pass(`调试端口 ${PORT} 在监听`);
  } else {
    fail(
      `调试端口 ${PORT} 在监听`,
      '未监听',
      `先跑：node tools/start-doubao-cdp.mjs（或用 DOUBAO_EXE 指定豆包路径）`
    );
  }

  // --- 4. CDP responds ---
  if (open) {
    try {
      const res = await fetch(`${ENDPOINT}/json/version`, { signal: AbortSignal.timeout(5000) });
      const v = await res.json();
      pass('CDP 响应', v.Browser || v['User-Agent'] || 'ok');
    } catch (err) {
      fail('CDP 响应', String((err && err.message) || err), '端口在监听但 HTTP 不通，豆包可能启动异常');
    }

    // --- 5. A Doubao page is reachable ---
    try {
      const res = await fetch(`${ENDPOINT}/json/list`, { signal: AbortSignal.timeout(5000) });
      const targets = await res.json();
      const pages = (targets || []).filter((t) => t.type === 'page');
      const doubao = pages.find((p) => String(p.url || '').includes('doubao-chat'));
      if (doubao) {
        pass('找到豆包聊天页面', String(doubao.url || '').slice(0, 80));
      } else if (pages.length) {
        warn(
          '找到豆包聊天页面',
          `有 ${pages.length} 个页面，但没有 doubao-chat`,
          '豆包可能停在启动页；在豆包窗口里打开任意对话再试'
        );
      } else {
        fail('找到豆包聊天页面', 'CDP 没有任何 page target', '豆包未正确启动，重跑启动器');
      }
    } catch (err) {
      fail('读取 CDP 页面列表', String((err && err.message) || err));
    }
  }

  // --- 6. Badge port (optional: only exists once MCP runs) ---
  const badgeOpen = await portOpen(BADGE_PORT);
  if (badgeOpen) {
    info(`徽章端口 ${BADGE_PORT} 在监听`, '说明 MCP server 已启动');
    try {
      const res = await fetch(`http://127.0.0.1:${BADGE_PORT}/env`, { signal: AbortSignal.timeout(5000) });
      const e = await res.json();
      info('徽章接口', `platform=${e.platform} node=${e.nodeVersion}`);
    } catch { /* optional */ }
  } else {
    info(`徽章端口 ${BADGE_PORT} 未监听`, 'MCP server 未运行（装好插件并重启 DSH 后才会出现）');
  }

  // --- 7. Is the bundle installed in any profile? ---
  const profiles = findProfiles();
  if (!profiles.length) {
    info('DSH profile', '未发现 ~/.dsh/profiles/*');
  } else {
    const installed = profiles.filter((p) => bridgeInstalledIn(p.dir));
    if (installed.length) {
      pass('插件已装进 profile', installed.map((p) => p.name).join(', '));
    } else {
      info(
        '插件尚未装进任何 profile',
        `已发现: ${profiles.map((p) => p.name).join(', ')}`,
        // not a failure: the launcher checks above are the whole point of this script
      );
      results[results.length - 1].hint =
        '装法见 README「安装」一节；这一项不影响上面的探测结果';
    }
  }

  // --- report ---
  console.log('');
  let requiredFailed = 0;
  for (const r of results) {
    const mark = r.info ? 'ℹ️ ' : (r.ok ? '✅' : (r.required ? '❌' : '⚠️ '));
    if (!r.ok && r.required) requiredFailed++;
    console.log(`${mark} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
    if (!r.ok && r.hint) console.log(`     → ${r.hint}`);
  }

  console.log('');
  if (requiredFailed === 0) {
    console.log('结论：前置条件全部通过，可以安装插件了。');
    const hasPage = results.some((r) => r.name === '找到豆包聊天页面' && r.ok);
    if (hasPage) console.log('下一步：按 README「安装」把包装进 profile，重启 DSH。');
    else console.log('下一步：先在豆包窗口里打开一个对话，再重跑本脚本。');
    return 0;
  }
  console.log(`结论：${requiredFailed} 项必需条件未通过，先修上面标 ❌ 的项。`);
  return 1;
}

main().then((c) => {
  // Do NOT call process.exit() here: fetch leaves keep-alive sockets in the
  // pool, and exiting on top of them trips a libuv assertion on Windows
  // ("UV_HANDLE_CLOSING ... async.c"). Setting exitCode and letting the loop
  // drain is the documented way out.
  process.exitCode = c;
}).catch((err) => {
  console.error(String((err && err.message) || err));
  process.exitCode = 1;
});
