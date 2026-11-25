#!/usr/bin/env node
// bootstrap.mjs — install this bridge into a DSH profile without hand-editing JSON.
//
// The plugin is a Cordis bundle. Installing it means three things on the target
// machine, and forgetting any one of them looks like "the tools are not there":
//
//   1. the package is a dependency of the profile  (so node_modules/dsh-doubao-bridge exists)
//   2. the bundle is listed in dsh.profile.bundles (so DSH actually loads it)
//   3. the package manager ran                (so the link/copy is materialised)
//
// This script does all three, idempotently, with a backup of package.json.
//
// Usage:
//   node tools/bootstrap.mjs                 # install into the only profile
//   node tools/bootstrap.mjs --profile desktop
//   node tools/bootstrap.mjs --dry-run       # print the plan, change nothing
//   node tools/bootstrap.mjs --autostart      # Windows: also make Doubao cold-start with the port
//   node tools/bootstrap.mjs --start          # also cold-start Doubao with the port now
//   node tools/bootstrap.mjs --uninstall      # remove the dependency and the bundle entry
//
// Exit code 0 = done / nothing to do; 1 = stopped on a real problem.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';

import { findDoubao, portOpen, killExisting, launchWithCdp } from '../lib/doubao-launcher.mjs';

const PKG = 'dsh-doubao-bridge';
const isWindows = platform() === 'win32';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- args ----------
function parseArgs(argv) {
  const opts = {
    profile: null,
    port: Number(process.env.DOUBAO_CDP_PORT || 9225),
    install: true,
    autostart: false,
    start: false,
    dryRun: false,
    uninstall: false,
    json: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile') opts.profile = argv[++i];
    else if (a.startsWith('--profile=')) opts.profile = a.slice('--profile='.length);
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) opts.port = Number(a.slice('--port='.length));
    else if (a === '--no-install') opts.install = false;
    else if (a === '--autostart') opts.autostart = true;
    else if (a === '--start') opts.start = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--uninstall') opts.uninstall = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else {
      console.error(`未知参数: ${a}（--help 看用法）`);
      process.exit(1);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`用法: node tools/bootstrap.mjs [选项]

  --profile <名字>   目标 profile（~/.dsh/profiles/<名字>）；只有一个时可不填
  --port <端口>      豆包 DevTools 端口（默认 ${process.env.DOUBAO_CDP_PORT || 9225}）
  --no-install       只改 profile 配置，不跑包管理器
  --autostart        Windows：让豆包开机自启/开始菜单都带调试参数（幂等）
  --start            立刻冷启动豆包并带上调试参数（会关掉正在运行的豆包）
  --uninstall        从 profile 移除依赖与 bundle 条目
  --dry-run          只打印计划，不做任何修改
  --json             输出机器可读结果`);
}

// ---------- helpers ----------
const steps = [];
function step(name, ok, detail = '', hint = '') {
  steps.push({ name, ok, detail, hint });
  if (!opts.json) {
    const mark = ok === true ? '✅' : (ok === false ? '❌' : 'ℹ️ ');
    console.log(`${mark} ${name}${detail ? ' — ' + detail : ''}`);
    if (ok === false && hint) console.log(`     → ${hint}`);
  }
}

function toLinkSpec(dir) {
  // Forward slashes: pnpm treats backslashes in a `link:` spec as escapes.
  return 'link:' + dir.replace(/\\/g, '/');
}

function findProfiles() {
  const root = join(homedir(), '.dsh', 'profiles');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => {
      try { return existsSync(join(root, n, 'package.json')) && n !== 'node_modules'; } catch { return false; }
    })
    .map((n) => ({ name: n, dir: join(root, n) }));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// Run a command line through the platform shell.
//
// Deliberately never uses piped stdio: under a constrained sandbox (DSH's own
// tool chain is one) opening a pipe to a child is denied with EPERM, which makes
// a working pnpm look "not installed". `inherit` / `ignore` are always allowed,
// and the exit status is all this script needs.
function shellRun(commandLine, { cwd, stdio = 'inherit' } = {}) {
  if (isWindows) {
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], { cwd, stdio });
  }
  return spawnSync('/bin/sh', ['-c', commandLine], { cwd, stdio });
}

// pnpm on PATH, then the copy DSH ships, then corepack. A machine can run DSH
// without ever installing pnpm globally, so "not on PATH" is not fatal.
function findPnpm() {
  if (shellRun('pnpm --version', { stdio: 'ignore' }).status === 0) {
    return { label: 'pnpm（PATH）', installCmd: 'pnpm install' };
  }

  const resourceRoots = [
    process.env.DSH_RESOURCES_DIR,
    isWindows && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources')
      : null
  ].filter(Boolean);
  for (const root of resourceRoots) {
    for (const rel of [
      ['runtime', 'bin', 'pnpm.cmd'],
      ['runtime', 'bin', 'pnpm'],
      ['app.asar.unpacked', 'node_modules', '.bin', 'pnpm.cmd']
    ]) {
      const candidate = join(root, ...rel);
      if (existsSync(candidate)) {
        return { label: `pnpm（DSH 自带：${candidate}）`, installCmd: `"${candidate}" install` };
      }
    }
  }

  if (shellRun('corepack pnpm --version', { stdio: 'ignore' }).status === 0) {
    return { label: 'corepack pnpm', installCmd: 'corepack pnpm install' };
  }
  return null;
}

function runPnpm(pnpm, profileDir) {
  const res = shellRun(pnpm.installCmd, { cwd: profileDir, stdio: 'inherit' });
  return { ok: res.status === 0, status: res.status, error: res.error };
}

// ---------- plan ----------
function planPackageJson(pkg, { uninstall }) {
  const before = JSON.stringify(pkg, null, 2);
  const next = JSON.parse(before);
  next.dependencies = next.dependencies || {};
  next.dsh = next.dsh || {};
  next.dsh.profile = next.dsh.profile || {};
  const bundles = Array.isArray(next.dsh.profile.bundles) ? next.dsh.profile.bundles.slice() : [];

  let depChanged = false;
  let bundleChanged = false;

  if (uninstall) {
    if (PKG in next.dependencies) { delete next.dependencies[PKG]; depChanged = true; }
    const idx = bundles.indexOf(PKG);
    if (idx !== -1) { bundles.splice(idx, 1); bundleChanged = true; }
  } else {
    const want = toLinkSpec(repoRoot);
    if (next.dependencies[PKG] !== want) { next.dependencies[PKG] = want; depChanged = true; }
    if (!bundles.includes(PKG)) { bundles.push(PKG); bundleChanged = true; }
  }

  next.dsh.profile.bundles = bundles;
  return { next, depChanged, bundleChanged, changed: depChanged || bundleChanged };
}

function verifyInstalled(profileDir) {
  const entry = join(profileDir, 'node_modules', PKG, 'server.mjs');
  if (!existsSync(entry)) return { ok: false, reason: `缺少 ${entry}` };
  try {
    const v = readJson(join(profileDir, 'node_modules', PKG, 'package.json')).version;
    return { ok: true, version: v };
  } catch {
    return { ok: false, reason: 'node_modules 里的 package.json 读不出来' };
  }
}

// ---------- main ----------
const opts = parseArgs(process.argv.slice(2));

async function main() {
  if (!opts.json) {
    console.log('== dsh-doubao-bridge 换机安装 ==');
    console.log(`源目录: ${repoRoot}`);
    console.log(opts.dryRun ? '模式: 预演（不修改任何文件）' : '模式: 执行');
    console.log('');
  }

  // 1. Node runtime
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    step('Node.js ≥ 22', false, `当前 v${process.versions.node}`, '升级 Node 到 22 或更高');
    return finish(1);
  }
  step('Node.js ≥ 22', true, `v${process.versions.node}`);
  if (typeof WebSocket !== 'function') {
    step('全局 WebSocket', false, '缺失', 'Node 22+ 自带；当前运行时不对');
    return finish(1);
  }

  // 2. Target profile
  const profiles = findProfiles();
  if (!profiles.length) {
    step('找到 DSH profile', false, `未发现 ${join(homedir(), '.dsh', 'profiles')}`, '先启动一次 DSH，让它生成 profile');
    return finish(1);
  }
  let target;
  if (opts.profile) {
    target = profiles.find((p) => p.name === opts.profile);
    if (!target) {
      step('找到 DSH profile', false, `没有名为 ${opts.profile} 的 profile`, `现有: ${profiles.map((p) => p.name).join(', ')}`);
      return finish(1);
    }
  } else if (profiles.length === 1) {
    target = profiles[0];
  } else {
    step('选择 DSH profile', false, `有多个: ${profiles.map((p) => p.name).join(', ')}`, `用 --profile <名字> 指定；本次未改动任何文件`);
    return finish(1);
  }
  step('目标 profile', true, `${target.name}（${target.dir}）`);

  const pkgFile = join(target.dir, 'package.json');
  const pkg = readJson(pkgFile);
  const plan = planPackageJson(pkg, opts);

  // 3. Report the plan
  if (opts.uninstall) {
    step('移除依赖条目', !plan.depChanged ? null : true, plan.depChanged ? PKG : '本来就没有');
    step('移除 bundle 条目', !plan.bundleChanged ? null : true, plan.bundleChanged ? PKG : '本来就没有');
  } else {
    step('写入依赖', true, `${PKG} = ${toLinkSpec(repoRoot)}${plan.depChanged ? '（新写入）' : '（已存在，未变）'}`);
    step('登记 bundle', true, plan.bundleChanged ? '已加入 dsh.profile.bundles 末尾' : '已在 dsh.profile.bundles 中');
  }

  const already = verifyInstalled(target.dir);
  const needInstall = opts.install && (plan.changed || !already.ok || opts.uninstall);

  if (opts.dryRun) {
    step('修改 package.json', null, plan.changed ? '会备份后写入' : '无需修改');
    step('运行包管理器', null, needInstall ? '会执行 pnpm install' : '不需要');
    if (!opts.uninstall) {
      const found = findDoubao();
      step('豆包客户端', found ? true : false, found || '未找到', '安装豆包客户端，或用 DOUBAO_EXE 指定路径');
      const open = await portOpen(opts.port);
      step(`调试端口 ${opts.port}`, open ? true : null,
        open ? '已在监听' : '未监听（用 --start 或 start-doubao-cdp 拉起）');
    }
    return finish(0);
  }

  // 4. Write package.json (with a backup next to it)
  if (plan.changed) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const backup = `${pkgFile}.bak-bootstrap-${stamp}`;
    copyFileSync(pkgFile, backup);
    writeFileSync(pkgFile, JSON.stringify(plan.next, null, 2) + '\n', 'utf8');
    step('修改 package.json', true, `已备份到 ${backup}`);
  } else {
    step('修改 package.json', null, '无需修改');
  }

  // 5. Materialise it
  if (needInstall) {
    const pnpm = findPnpm();
    if (!pnpm) {
      step('运行包管理器', false, '找不到 pnpm', '装 pnpm（npm i -g pnpm）后重跑，或在 DSH 插件页装一次');
    } else {
      step('运行包管理器', null, `${pnpm.label} · ${pnpm.installCmd}`);
      const res = runPnpm(pnpm, target.dir);
      if (res.ok) step('运行包管理器', true, 'pnpm install 成功');
      else step('运行包管理器', false, res.error ? String(res.error) : `退出码 ${res.status}`, '看上面的输出');
    }
  }

  // 6. Verify
  const after = verifyInstalled(target.dir);
  if (opts.uninstall) {
    step('卸载校验', after.ok ? false : true, after.ok ? `仍存在（${after.version}）` : '已不在 node_modules');
  } else if (!opts.install) {
    step('安装校验', null, '已按 --no-install 跳过（依赖还没装进 node_modules）');
  } else if (after.ok) {
    step('安装校验', true, `${PKG}@${after.version} 位于 node_modules`);
  } else {
    step('安装校验', false, after.reason, '包管理器可能没跑成；在 DSH 插件页手动装一次，或检查 pnpm 输出');
  }

  // 7. Doubao side (optional, only when asked)
  if (!opts.uninstall && opts.start) {
    const found = findDoubao();
    if (!found) {
      step('冷启动豆包', false, '找不到豆包可执行文件', '用 DOUBAO_EXE 指定路径');
    } else if (await portOpen(opts.port)) {
      step('冷启动豆包', null, `端口 ${opts.port} 已在监听，跳过重启`);
    } else {
      step('冷启动豆包', null, `正在用 ${found} 冷启动（会关掉现有豆包，草稿会丢）`);
      await killExisting();
      const res = await launchWithCdp({ port: opts.port });
      step('冷启动豆包', res.ok, res.ok ? `端口就绪，用时 ${res.waitedMs}ms` : (res.message || res.error));
    }
  }

  if (!opts.uninstall && opts.autostart) {
    if (!isWindows) {
      step('自启参数', null, '仅 Windows 有自启入口；macOS/Linux 用 start-doubao-cdp 脚本');
    } else {
      const ps = join(repoRoot, 'tools', 'enable-autostart-cdp.ps1');
      const out = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, '-Apply'], {
        stdio: 'inherit'
      });
      const ok = out.status === 0;
      step('自启参数', ok, ok ? '开机自启与开始菜单已带上调试参数' : `powershell 退出码 ${out.status}`);
    }
  }

  return finish(0);
}

function finish(code) {
  const failed = steps.filter((s) => s.ok === false);
  if (failed.length) code = 1;

  if (opts.json) {
    console.log(JSON.stringify({ ok: code === 0, dryRun: opts.dryRun, uninstall: opts.uninstall, steps }, null, 2));
    return code;
  }
  console.log('');
  if (code !== 0) {
    console.log(`结论：${failed.length} 项没通过，先修上面标 ❌ 的项：${failed.map((s) => s.name).join('、')}。`);
    return code;
  }
  if (opts.dryRun) {
    console.log('结论：预演完成，去掉 --dry-run 就会真正执行。');
    return code;
  }
  if (!opts.install) {
    console.log('结论：profile 配置已就位，但依赖还没安装（--no-install）。');
    console.log('跑一次 pnpm install（在 profile 目录里）或在 DSH 插件页装一次，然后重启 DSH。');
    return code;
  }
  if (opts.uninstall) {
    console.log('结论：已卸载。重启 DSH 后生效。');
    return code;
  }
  console.log('结论：装好了。**重启 DSH**，然后问它一句「豆包在吗」，出现 doubao_* 工具即成功。');
  if (steps.some((s) => s.name === '冷启动豆包' && s.ok === true) === false) {
    console.log('豆包侧还没拉起调试端口：跑 node tools/start-doubao-cdp.mjs（或 --start / --autostart）。');
  }
  console.log('如果工具在但连不上豆包：先 node tools/doctor.mjs 看是哪一层断了。');
  return code;
}

main().then((c) => {
  // Same reason as doctor.mjs: let the loop drain instead of process.exit().
  process.exitCode = c;
}).catch((err) => {
  console.error(String((err && err.stack) || err));
  process.exitCode = 1;
});
