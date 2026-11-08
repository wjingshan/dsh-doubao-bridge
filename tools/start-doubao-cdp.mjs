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
// same thing. The actual find/kill/launch logic lives in lib/doubao-launcher.mjs
// because the MCP server restarts Doubao the same way when the port is gone.
//
// Environment:
//   DOUBAO_EXE       explicit path to the Doubao binary (skips auto-detection)
//   DOUBAO_CDP_PORT  DevTools port (default 9225)

import { portOpen, findDoubao, killExisting, launchWithCdp } from '../lib/doubao-launcher.mjs';

const PORT = Number(process.env.DOUBAO_CDP_PORT || 9225);
const isWindows = process.platform === 'win32';

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

  // cwd = the binary's own directory. The .ps1 already did this and the .sh used
  // two levels up, so the three launchers disagreed; Electron does not need the
  // extra hop and a stable rule is easier to reason about.
  console.log(`豆包：${exe}`);

  console.log('关闭正在运行的豆包进程（未发送的草稿会丢失）...');
  await killExisting();

  console.log(`以 --remote-debugging-port=${PORT} 启动...`);
  const res = await launchWithCdp({ port: PORT });

  if (!res.ok) {
    console.error(`失败：${res.message || res.error}`);
    if (res.error === 'EACCES') {
      console.error('  该文件不可执行。检查 DOUBAO_EXE 是否指向真实的二进制文件。');
    }
    return 1;
  }

  console.log(`成功：127.0.0.1:${PORT} 已就绪（约 ${Math.round(res.waitedMs / 1000)}s）。`);
  try {
    const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    console.log(`CDP: ${v.Browser || v['User-Agent'] || 'unknown'}`);
  } catch { /* version probe is optional */ }
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(String((err && err.message) || err));
  process.exit(1);
});
