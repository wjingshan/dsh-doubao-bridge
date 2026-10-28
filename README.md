# dsh-doubao-bridge

在 DeepSeek Harness 里直接驱动本机 **豆包（Doubao）桌面客户端**：读对话、发任务、
把项目移交给豆包做、做完再收回。附带一个界面状态徽章，告诉你现在是 DeepSeek 在执行
还是豆包在干。

不经过豆包网页版，不需要火山方舟 API Key——走的是豆包客户端自己的 DevTools 接口。

**支持 Windows / macOS / Linux。** 已在 Windows 11 + 豆包 2.33.3 上完整验证；
macOS 路径依赖 Homebrew cask 的 `Doubao.app`，代码与 Windows 版共用同一份，
但**尚未在 macOS 实机上跑过**（见下方「已知限制」）。

## 前置条件

| 条件 | 说明 |
| --- | --- |
| Windows 10/11 **或** macOS 12+ | 豆包桌面客户端的可用平台 |
| 豆包桌面客户端，已登录 | Windows 2.33.3 验证通过；macOS 用 `brew install --cask doubao` |
| Node.js ≥ 22 | 需要内置的全局 `WebSocket`；DSH 本身也依赖 Node |
| DSH profile | 装到哪个 profile 都行 |

## 安装

三步，第一步只需要做一次。

### 1. 拿到插件

```bash
git clone https://github.com/<你的用户名>/dsh-doubao-bridge.git
cd dsh-doubao-bridge
```

或者直接下载 zip 解压。

### 2. 装进 profile

如果该 profile 由 `dsh` CLI 管理：

```bash
dsh plugin --profile <profile> add /完整路径/dsh-doubao-bridge
```

> Windows 下如果 profile 由 DSH 桌面应用管理（`desktop` 就是这样，CLI 会拒绝），
> 在 DSH 的插件页里从本地目录安装，或让 agent 调 `plugin_manager install_bundle`
> 并以包目录为 target。

### 3. 让豆包开启调试端口

**macOS / Linux（推荐，只需要 Node）：**

```bash
node tools/start-doubao-cdp.mjs
```

**Windows：**

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\start-doubao-cdp.ps1
```

**或者纯 shell（macOS / Linux）：**

```bash
chmod +x tools/start-doubao-cdp.sh
./tools/start-doubao-cdp.sh
```

三个脚本做的事一样：重启豆包一次（**未发送的草稿会丢**），带上
`--remote-debugging-port=9225 --remote-debugging-address=127.0.0.1`，
然后等端口就绪。端口已在监听时它们什么都不做。

找不到豆包时，用环境变量指定：

```bash
export DOUBAO_EXE="/Applications/Doubao.app/Contents/MacOS/Doubao"
```

装完重启 DSH 生效。

## 每次重启豆包后

豆包退出/重启后调试端口就没了，`doubao_*` 工具会返回连接错误。
再跑一次第 3 步的脚本即可。

## 已知限制

- **macOS 未经实机验证。** 启动脚本覆盖了 Homebrew cask 的安装位置
  （`/Applications/Doubao.app/Contents/MacOS/Doubao`）和常见路径，但豆包 macOS 版
  是个 Electron 应用，**是否接受 `--remote-debugging-port` 取决于它的启动实现**。
  如果 `node tools/start-doubao-cdp.mjs` 报「30 秒内端口未就绪」，就是这条路走不通，
  届时可以用 `DOUBAO_EXE` 指向真实可执行文件再试。
- **豆包 macOS 版是 "Doubao Browser"**（Homebrew cask 的 `uninstall` 写的是
  `/Applications/Doubao Browser.app`），任务模式的 GUI 自动化能力可能与 Windows 版不同。
- **任务模式会中途反问。** 豆包在信息不足时可能停下来问，这时 `doubao_handoff`
  返回 `needsUserInput: true`，用 `doubao_reply` 把答案送回去。
- **对话气泡需要 DSH 的「对话视图」设为 verbose。** 见下方「豆包气泡怎么显示」。


## 提供的工具

### 对话

| 工具 | 作用 |
| --- | --- |
| `doubao_status` | 连接检查 + 当前页面状态 |
| `doubao_list_chats` | 侧边栏对话列表（标题 + 对话 id） |
| `doubao_read_chat` | 读当前对话（转成 Markdown，保留表格与代码块） |
| `doubao_open_chat` | 按序号或 id 打开对话 |
| `doubao_new_chat` | 新建对话 |
| `doubao_send` | 发消息，不等回复 |
| `doubao_ask` | 发消息并等回复完成 |

### 任务模式与项目交接

| 工具 | 作用 |
| --- | --- |
| `doubao_mode` | 当前模式（对话/任务）+ 交接归属状态 |
| `doubao_new_task` | 切到「新工作任务」（可操作本机文件） |
| `doubao_run_task` | 开新任务、发指令、等完成、返回报告 |
| `doubao_handoff` | **移交项目**：记录归属 + 按目录下发 + 等完成 |
| `doubao_return` | **收回**：读最终报告 + 归属切回 DeepSeek |

### 借用豆包独有的能力

| 工具 | 作用 |
| --- | --- |
| `doubao_image` | 让豆包生成图片，返回**原图 CDN 地址**（实测可拿到 2048×2048） |
| `doubao_consult` | 把问题（+ 你自己的思路）交给豆包独立分析，用它的结论做交叉验证 |
| `doubao_read_steps` | **读任务执行过程**：它读了什么、调了什么工具、看到什么、下一步决定 |

`doubao_image` 返回的是真实 CDN URL（`rc_gen_image/...`），带 `x-expires` 过期参数，
所以要尽快下载。豆包一次通常生成多张候选，全部返回。

`doubao_consult` 会先新建一个对话，避免旧上下文干扰。实测：给一个含漏洞的
「含负数数组用滑动窗口」思路，它能指出错误、给出反例 `[1,-1,0], k=0` 和正确解法。
但**它的答案仍需你自己验证**——它只是第二意见，不是裁判。

`doubao_read_steps` 解决的是「只看得到最终报告、看不到怎么做」的问题。任务模式的
过程叙述默认折叠在一个 `<section data-testid="preamble-elapsed">` 里，内容区
`height: 0` 且带 `inert`，**必须用真实指针事件点那个 header 按钮**（`el.click()` 无效）
才会渲染。展开后能拿到完整轨迹，例如实测一次 GUI 任务读到：

```
我先读取 computer-use-automation 技能文档...
屏幕上有一个错误弹窗挡住了视线，计算器在后面。先关闭这个错误对话框。
Close error dialog
计算器显示 123，前三个按钮点击成功。现在点击 +、4、5、6。
...
让我再回读一下最终截图，确认里面确实显示的是 579。
```

注意：这是它**自己写的叙述**，不是原始操作日志——具体每次点击的坐标、截图内容，
只有它写下来你才看得到。

## 豆包气泡怎么显示

插件会在 DSH 对话流里、**你的提问之后、我的总结之前**，插入一个带「豆包」标签的气泡，
显示豆包这一轮说了什么（只显示本轮新增，不重复历史）。

实现方式：注册 DSH 的 `tool.call.toolview` 槽位，key 是工具的 **wire name**，
也就是 `mcp__doubao__doubao_ask` 这种带 server 前缀的形式（裸名 `doubao_ask`
永远匹配不上）。`/live` 接口额外返回 `since`（本轮开始时已有的消息数），
气泡只渲染 `msgs.slice(since)`。

### ⚠️ 必须把「对话视图」设成 verbose

DSH 默认把**已完成的整轮**折叠掉（`foldCompletedTurns: true`），工具卡片所在的
flowItem 会被打上 `hidden` 属性。表现是：你只能看到一行「已完成，用时 X 秒」，
气泡内容在隐藏区里。

**设置 → 通用 → 对话视图 → verbose**（`foldCompletedTurns: false`），
所有已完成轮次保持展开，气泡就露出来了。

四种模式对照（DSH 源码 `dsh-client-ui-chat`）：

| 模式 | `foldCompletedTurns` | 已完成轮次 |
| --- | --- | --- |
| `compact` | `true` | 折叠 |
| `standard` | `true` | 折叠（桌面版默认） |
| `detailed` | `true` | 折叠 |
| `verbose` | `false` | **展开** |

### 不要试图用代码展开它

试过并且**都失败了**的几种办法，列在这里省得再走一遍：

- `props.useDisclosure()` —— 它是 **hook 工厂**，在自己组件里调用创建的是
  **私有的一份** `expanded` 状态，改不动外层卡片。hook 状态不能跨组件共享。
- `root.closest('[data-chat-call-id]').querySelector('button[aria-expanded="false"]').click()`
  —— 卡片子树里根本没有展开按钮（我们的视图已经替换掉了工具行）。
  真正能移除 `hidden` 的是**轮次组**的折叠按钮，DOM 路径是
  `[data-chat-flow-kind="turn-process"][data-chat-turn="<turn>"] button`，
  但那个按钮在轮次**结束**时才出现，时序很难卡准。

## 豆包到底带了什么

除了模型本身，豆包的 agent 模式自带 **117 个技能**，位置：

- Windows：`%LOCALAPPDATA%\Doubao\User Data\Default\.doubao\agent_mode\workspace\.skills\`
- macOS：`~/Library/Application Support/Doubao/...`（路径随版本变化，用
  `doubao_run_task` 让它自己找更稳）

| 类别 | 代表技能 |
| --- | --- |
| 桌面/浏览器控制 | `computer-use-automation`、`general-computer-use`、`browser-use`、`browser-record-replay` |
| 媒体生成 | `seedream-50`、`seedance-25`、`seed-audio`、`byted-mediakit-image/video/audio/editing`、`dreamina-canvas-cli` |
| 办公文档 | `word`、`pdf`、`ppt`、`sheet`、`html` |
| 飞书全家桶 | `lark-base/doc/im/mail/meeting/calendar/task/wiki/okr/approval/attendance/contact/drive/whiteboard` |
| 专业流程 | 金融（`doubao-daily-stock`、`doubao-earnings-analysis`）、医疗（`doubao-medical-literature-search`、`doubao-clinical-decision-support`）、法律（`doubao-contract-reviewer`、`doubao-patent-drafting`）、电商、营销 |
| 元技能 | `skill-creator-for-work`（造技能）、`record-operations-to-skill`（把一次操作录成技能） |

同目录还有 `.user_skills`（用户自定义槽位，默认空）。

这意味着：**这些领域的问题交给豆包，它不是在"通用对话"，而是在按对应技能的流程走。**
通过 `doubao_run_task` 可以借用，但要注意技能内部会读写文件、调外部工具。

## 交接是怎么工作的

```
DSH  ──doubao_handoff(项目目录, 任务)──▶  豆包任务模式（在该目录真实改文件）
DSH  ◀──doubao_return()──────────────  最终报告 + 归属切回 DeepSeek
```

- 归属状态写在 `~/.dsh/doubao-handoff/state.json`
- 只读接口 `http://127.0.0.1:9226/state`，供界面徽章轮询
- 完成判断：等**最后一条助手消息**出现 `HANDOFF-DONE`。任务文本里也带这个标记，
  所以判定要求「至少两条消息 + 最后一条不是右侧用户气泡 + 含标记」，
  否则任务刚发出就会被误判成完成。

## 命令行（排错用）

同一份 `server.mjs` 也能直接跑：

```bash
node server.mjs status
node server.mjs list
node server.mjs read
node server.mjs mode
node server.mjs handoff "/path/to/project" "把 X 改成 Y"
node server.mjs return
node server.mjs who
```

## 改代码 / 调试

这是一个 **Cordis bundle**，改完要让 DSH 重新加载。

### 开发时用 link 安装

最省事的方式是让 profile 直接指向你的工作目录，改完刷新即可，不用反复重装：

```bash
cd ~/.dsh/profiles/<profile>
# 把 package.json 的 dependencies 里加一行：
#   "dsh-doubao-bridge": "link:/绝对路径/dsh-doubao-bridge"
```

Windows 用 `link:H:/path/dsh-doubao-bridge`（正斜杠）。

### 两种改动的生效方式不一样

| 改了什么 | 怎么生效 |
| --- | --- |
| `server.mjs`（MCP 服务端） | 杀掉 MCP 进程即可，`reconnect.enabled` 会自动重启它 |
| `client.js`（界面） | **需要重启 DSH**。client bundle 是启动时加载的 |

调试界面的技巧：把版本号显示出来。`client.js` 里的 `BUILD` 常量会渲染在输入框下方
状态点旁边（形如 `v32`），一眼就能确认跑的是哪一版。

### 一个能自证的证据通道

界面在 Electron 渲染进程里，agent 拿不到 DOM。所以：

- **MCP 侧**：用 `node server.mjs who` 或 `curl http://127.0.0.1:9226/env` 直接读
- **界面侧**：把要观察的东西写进 `document.title`，然后用
  `GetWindowText`（Windows）或 `osascript`（macOS）读窗口标题

```bash
# macOS: 读前台窗口标题
osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'
```

**注意**：DSH 是 frameless 窗口，系统标题栏不显示，但 API 读得到。

### 会话日志

DSH 的会话记录是 zstd 压缩的 jsonl，能查到工具调用的**真实 wire name**：

```bash
python3 -c "
import zstandard, json, sys
p = '~/.dsh/sessions/<session>/session.v4.jsonl.zstd'
d = zstandard.ZstdDecompressor()
with open(p,'rb') as f:
    for line in d.stream_reader(f):
        try: o = json.loads(line)
        except: continue
        if o.get('type') == 'tool/call':
            print(o['data']['name'])
" | sort -u
```

排「key 注册了却不渲染」这类问题时，这是唯一可靠的真相来源。

## 配置项

MCP 条目的 `env` 里可以覆盖（默认值见括号）：

| 变量 | 说明 |
| --- | --- |
| `DOUBAO_CDP` | CDP 地址（`http://127.0.0.1:9225`） |
| `DOUBAO_BADGE_PORT` | 徽章状态接口端口（`9226`） |
| `DOUBAO_HANDOFF_DIR` | 交接状态目录（`~/.dsh/doubao-handoff`） |
| `DOUBAO_EXE` | 豆包可执行文件路径（跳过自动探测） |
| `DOUBAO_CDP_PORT` | 启动脚本用的调试端口（`9225`） |

## 已知限制

- **豆包看不到 DSH 的对话历史**：移交时它只看到任务文本 + 目录路径，
  所以复杂任务的背景要写进 `task`。
- **任务模式较慢**：单次文件改动 21～48 秒，冷启动那次约 5 分钟。
- **只能读窗口内已渲染的消息**：聊天区是虚拟滚动，更早的内容要现在豆包界面往上滚。
- **只支持纯文本下发**：贴不了附件。
- **豆包更新可能改 DOM**：工具按 `data-testid` 和消息结构定位，豆包改版可能失效。
- **macOS 未实机验证**：见上方「已知限制」。
- **安全边界**：9225 只绑 `127.0.0.1`，但本机任意进程都能借此控制豆包。
  不用的时侯关掉豆包或不用调试端口启动即可。

## 目录内容

| 文件 | 说明 |
| --- | --- |
| `server.mjs` | MCP server + CLI，全部逻辑 |
| `client.js` / `index.js` | 界面状态徽章 + 对话气泡（Client 插件） |
| `cordis.patch.yml` | 挂载 MCP 与徽章 |
| `tools/start-doubao-cdp.mjs` | **跨平台**启动器（Node，macOS/Linux 推荐） |
| `tools/start-doubao-cdp.sh` | 跨平台 shell 版 |
| `tools/start-doubao-cdp.ps1` | Windows PowerShell 版 |
| `package.json` | 包清单（bundle + client） |
