# 换一台电脑：从 GitHub 装到能用

这份文档只回答一个问题：**在一台新电脑上，怎么让 DSH 能控制豆包**。
本机（已跑通的那台）的路径、profile 名、端口都不用照抄，脚本会自己探测。

前提：豆包桌面客户端已装好并**登录过**，Node.js ≥ 22，DSH 至少启动过一次
（它会在 `~/.dsh/profiles/` 下生成 profile）。

---

## 1. 拿到代码（放在固定位置）

```bash
git clone https://github.com/wjingshan/dsh-doubao-bridge.git
```

放到一个**以后不会挪动**的目录，比如：

| 平台 | 建议位置 |
| --- | --- |
| Windows | `H:\DSH\workbench\dsh-doubao-bridge` |
| macOS / Linux | `~/dsh-doubao-bridge` |

> 为什么强调固定：安装用的是 `link:`（软链接），profile 指向这个目录。
> 目录改名或删除，插件就随之失效，得重跑一次安装。

## 2. 先自检（还没装任何东西就能跑）

```bash
cd dsh-doubao-bridge
node tools/doctor.mjs
```

它会分层检查：Node → 全局 `WebSocket` → 找到豆包 → 调试端口 → CDP 响应 → 聊天页面。
**必需项全绿**才值得往下走；端口那项红着也没关系，那是第 4 步要解决的。

## 3. 一步装进 profile

```bash
# 看有哪些 profile（通常只有一个，或多个）
ls ~/.dsh/profiles          # Windows: dir %USERPROFILE%\.dsh\profiles

node tools/bootstrap.mjs --profile <profile名>
```

只有一个 profile 时可以省略 `--profile`。脚本做三件事，缺一件事工具就不会出现：

1. 把 `dsh-doubao-bridge` 写进 profile 的 `dependencies`（`link:` 指向当前目录）
2. 把它加进 `dsh.profile.bundles`（否则 DSH 不加载它）
3. 跑 `pnpm install` 把链接真正建立起来

改 `package.json` 前会自动备份成 `package.json.bak-bootstrap-<时间戳>`。

先看看它打算做什么，不修改任何文件：

```bash
node tools/bootstrap.mjs --profile <profile名> --dry-run
```

重复执行是安全的：已经是目标状态时它只报告「无需修改」。想撤掉：

```bash
node tools/bootstrap.mjs --profile <profile名> --uninstall
```

## 4. 让豆包带上调试端口

```bash
# 跨平台（推荐）
node tools/start-doubao-cdp.mjs
```

Windows 想一劳永逸（开机自启和开始菜单都带参数）：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\enable-autostart-cdp.ps1 -Apply
```

或者交给第 3 步的脚本一次做完：

```bash
node tools/bootstrap.mjs --profile <profile名> --autostart   # Windows
node tools/bootstrap.mjs --profile <profile名> --start       # 立刻冷启动一次
```

> 注意：**豆包是单实例**。已经有一个不带参数的豆包在跑时，新参数不生效，
> 必须让它冷启动一次。重启会关掉现有窗口，**未发送的草稿会丢**。

## 5. 重启 DSH，验收

重启 DSH 后，直接问它：

> 豆包在吗？

能列出 `doubao_*` 工具（`doubao_status` / `doubao_read_chat` / `doubao_handoff` …）
就说明桥接通了。再让它跑一句 `doubao_status`，能读到豆包版本和聊天页面即全部就绪。

## 排错：按症状找那一层

| 症状 | 大概率原因 | 处理 |
| --- | --- | --- |
| DSH 里**完全没有** `doubao_*` 工具 | 依赖没进 node_modules，或没登记进 bundles | 重跑 `bootstrap.mjs`，看「安装校验」是否 ✅；然后重启 DSH |
| 工具在，但报连不上 | 调试端口没开 | `node tools/doctor.mjs`，端口那项红 → 第 4 步 |
| 端口开着但读不到聊天页面 | 豆包停在启动页 | 在豆包窗口里打开任意一个对话，重跑 `doctor.mjs` |
| 昨天好好的，今天不行 | 豆包被别的入口冷启动，没带参数 | 跑一次启动脚本，或装上 `--autostart` |
| 换了目录后失效 | `link:` 指向的旧路径没了 | 回到新目录重跑 `bootstrap.mjs` |

细节日志：自愈/重启记录在 `~/.dsh/doubao-handoff/cdp-launch.log`。

## 以后更新

```bash
cd dsh-doubao-bridge
git pull
```

然后：

| 改的是 | 生效方式 |
| --- | --- |
| `server.mjs`（MCP 服务端） | 等 MCP 自动重连，或重启 DSH |
| `client.js`（界面徽章） | **必须重启 DSH** |
| `package.json` / `cordis.patch.yml` | 重跑 `bootstrap.mjs`，再重启 DSH |

## 多台机器共用一份代码？

如果两台机器能看到同一个目录（同步盘、网络盘），`link:` 可以都指向它。
但**别同时用**：豆包是单实例，两个 DSH 同时驱动会互相把页面切走
（详见 README「豆包是单实例」）。
