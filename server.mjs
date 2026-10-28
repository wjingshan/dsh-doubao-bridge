#!/usr/bin/env node
// Doubao desktop bridge: MCP server (stdio) + CLI.
// Drives the local Doubao PC app over the Chrome DevTools Protocol.
//
// CLI mode:  node server.mjs <cmd> [args]
//   status | list | read | open <t> | new | send <text> | ask <text>
//   mode | new-task | run-task <text> | handoff <project> <task> | return | who
// MCP mode:  node server.mjs --mcp
//
// No runtime dependencies: Node >= 22 ships a global WebSocket.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Handoff state lives under the harness home so it survives moving the package.
const HANDOFF_DIR = process.env.DOUBAO_HANDOFF_DIR || path.join(os.homedir(), '.dsh', 'doubao-handoff');
const STATE_FILE = path.join(HANDOFF_DIR, 'state.json');

// Every knob can be overridden from the bundle config's `env` block.
const ENDPOINT = process.env.DOUBAO_CDP || 'http://127.0.0.1:9225';
const BADGE_PORT = Number(process.env.DOUBAO_BADGE_PORT || 9226);
const CHAT_PAGE = 'doubao-chat/chat';

// ---------- CDP plumbing ----------
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', () => rej(new Error('CDP websocket error')));
  });
  const send = (method, params = {}, ms = 20000) => {
    const mid = ++id;
    const p = new Promise((resolve, reject) => {
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('CDP timeout: ' + method)), ms))]);
  };
  return { ws, ready, send };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "Who is working right now" is NOT the same as "what did the last handoff do".
// Every call into Doubao touches this clock; the UI treats Doubao as the current
// owner only while a run is active or this was touched very recently.
let lastDoubaoTouch = 0;
const DOUBAO_FRESH_MS = 30_000;

async function withPage(fn) {
  let targets;
  try {
    const res = await fetch(`${ENDPOINT}/json/list`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    targets = await res.json();
  } catch (err) {
    throw new Error(`Cannot reach Doubao CDP at ${ENDPOINT}. Restart Doubao with --remote-debugging-port=9225. (${err.message})`);
  }
  const page = targets.find((t) => t.type === 'page' && t.url.includes(CHAT_PAGE))
    || targets.find((t) => t.type === 'page' && t.url.includes('doubao-launcher'));
  if (!page) throw new Error('Doubao chat page not found among CDP targets');
  const { ws, ready, send } = connect(page.webSocketDebuggerUrl);
  await ready;
  lastDoubaoTouch = Date.now();
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate failed');
    }
    return r.result?.value;
  };
  try {
    return await fn({ page, send, evalJs });
  } finally {
    lastDoubaoTouch = Date.now();
    try { ws.close(); } catch {}
  }
}

// ---------- DOM operations ----------
const JS = {
  status: `(() => ({
    href: location.href,
    title: document.title,
    editorReady: !!document.querySelector('div.tiptap[contenteditable="true"]'),
    conversationCount: document.querySelectorAll('a[class*="conversation-item"]').length
  }))()`,

  list: `(() => [...document.querySelectorAll('a[class*="conversation-item"]')].map((a, i) => {
    const t = (a.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
    const href = a.getAttribute('href') || '';
    return { index: i, title: t[0] || '', id: (href.match(/\\/chat\\/(\\d+)/) || [])[1] || null };
  }))()`,

  // Serializes each message to markdown so tables and code fences survive the trip.
  // Code fences are built via String.fromCharCode(96) because a literal backtick
  // cannot appear inside this template literal.
  read: `(() => {
    const FENCE = String.fromCharCode(96,96,96);

    function tableToMd(t) {
      const rows = [...t.querySelectorAll('tr')].map(tr =>
        [...tr.querySelectorAll('th,td')].map(c => (c.innerText || '').trim().replace(/\\s*\\n\\s*/g, ' ')));
      if (!rows.length) return '';
      const head = rows[0];
      const sep = head.map(() => '---');
      return [head, sep, ...rows.slice(1)].map(r => '| ' + r.join(' | ') + ' |').join('\\n');
    }

    function serialize(node) {
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeType !== 1) return '';
      const tag = node.tagName.toLowerCase();
      const cls = (node.className || '').toString();
      if (tag === 'svg' || tag === 'button' || tag === 'path' || tag === 'img') return '';
      if (/table-header|actions-|action-btn/i.test(cls)) return '';
      if (tag === 'br') return '\\n';
      if (tag === 'table') return '\\n\\n' + tableToMd(node) + '\\n\\n';
      if (tag === 'pre') {
        const code = node.querySelector('code');
        const lang = ((code && code.className) || '').toString().match(/language-([\\w+-]+)/);
        const text = ((code ? code.textContent : node.textContent) || '').replace(/\\n+$/, '');
        return '\\n\\n' + FENCE + (lang ? lang[1] : '') + '\\n' + text + '\\n' + FENCE + '\\n\\n';
      }
      const inner = [...node.childNodes].map(serialize).join('');
      if (['p','div','li','ul','ol','h1','h2','h3','h4','h5','h6','blockquote','tr'].includes(tag)) {
        return '\\n' + inner + '\\n';
      }
      return inner;
    }

    const msgs = [...document.querySelectorAll('div[class*="md-box-root"]')]
      .map(n => [...n.childNodes].map(serialize).join('')
        .replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim())
      .filter(Boolean);

    // Assistant messages only. Doubao wraps them in [data-testid="message_content"];
    // user messages are right-aligned bubbles without that marker.
    const assistant = [...document.querySelectorAll('[data-testid="message_content"]')]
      .map(el => {
        const box = el.querySelector('div[class*="md-box-root"]') || el;
        return [...box.childNodes].map(serialize).join('')
          .replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
      })
      .filter(Boolean);

    const stopBtn = document.querySelector('[data-testid="chat_input_stop_button"]');
    return { count: msgs.length, generating: !!stopBtn, messages: msgs.slice(-20),
             assistantCount: assistant.length, assistant: assistant.slice(-10), format: 'markdown' };
  })()`,

  newChat: `(() => {
    const byNav = [...document.querySelectorAll('div[class*="sidebar_nav_item"]')]
      .find(d => (d.innerText || '').replace(/\\s+/g, '').includes('新对话'));
    if (byNav) { byNav.click(); return { ok: true, via: 'sidebar_nav_item' }; }
    const byBtn = [...document.querySelectorAll('button')].find(b => (b.innerText || '').trim() === '新对话');
    if (byBtn) { byBtn.click(); return { ok: true, via: 'button' }; }
    return { ok: false, error: 'new-chat control not found' };
  })()`,

  openByIndex: (idx) => `(() => {
    const items = [...document.querySelectorAll('a[class*="conversation-item"]')];
    const el = items[${idx}];
    if (!el) return { ok: false, error: 'index out of range', available: items.length };
    el.click();
    return { ok: true, clicked: (el.innerText || '').trim().split('\\n')[0] };
  })()`,

  openById: (cid) => `(() => {
    const items = [...document.querySelectorAll('a[class*="conversation-item"]')];
    const el = items.find(a => (a.getAttribute('href') || '').includes(${JSON.stringify(String(cid))}));
    if (!el) return { ok: false, error: 'conversation id not in visible list' };
    el.click();
    return { ok: true, clicked: (el.innerText || '').trim().split('\\n')[0] };
  })()`,

  focusEditor: `(() => {
    const ed = document.querySelector('div.tiptap[contenteditable="true"]');
    if (!ed) return { ok: false, error: 'editor not found' };
    ed.focus();
    const r = document.createRange();
    r.selectNodeContents(ed); r.collapse(false);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    return { ok: true, active: document.activeElement === ed };
  })()`,

  clearEditor: `(() => {
    const ed = document.querySelector('div.tiptap[contenteditable="true"]');
    if (!ed) return { ok: false };
    ed.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    return { ok: true, text: ed.innerText.trim() };
  })()`,

  clickSend: `(() => {
    const b = document.querySelector('[data-testid="chat_input_send_button"]');
    if (!b) return { ok: false, error: 'send button not found' };
    if (b.disabled) return { ok: false, error: 'send button disabled' };
    b.click();
    return { ok: true };
  })()`,

  editorText: `(() => {
    const ed = document.querySelector('div.tiptap[contenteditable="true"]');
    return ed ? ed.innerText : null;
  })()`
};

// ---------- high-level actions ----------
async function cmdStatus() {
  return withPage(async ({ page, evalJs }) => ({
    target: { title: page.title, url: page.url },
    state: await evalJs(JS.status)
  }));
}

async function cmdList() {
  return withPage(async ({ evalJs }) => ({ conversations: await evalJs(JS.list) }));
}

async function cmdRead() {
  return withPage(async ({ page, evalJs }) => ({
    title: page.title,
    url: page.url,
    ...(await evalJs(JS.read))
  }));
}

async function cmdOpen(target) {
  return withPage(async ({ evalJs }) => {
    const t = String(target);
    // Sidebar indexes are small (0-99); conversation ids are long numeric
    // timestamps (14-17 digits). A 16-digit id was being read as an index.
    const looksLikeIndex = /^\d{1,3}$/.test(t);
    let r = looksLikeIndex
      ? await evalJs(JS.openByIndex(Number(t)))
      : await evalJs(JS.openById(t));
    // Fall back to the other interpretation rather than failing outright.
    if ((!r || !r.ok) && looksLikeIndex) r = await evalJs(JS.openById(t));
    if ((!r || !r.ok) && !looksLikeIndex) r = await evalJs(JS.openByIndex(Number(t)));
    if (r && r.ok) await sleep(2200);
    return { open: r, url: await evalJs('location.href') };
  });
}

async function cmdNew() {
  return withPage(async ({ evalJs }) => {
    const r = await evalJs(JS.newChat);
    await sleep(2200);
    return { newChat: r, url: await evalJs('location.href'), title: await evalJs('document.title') };
  });
}

async function cmdSend(text) {
  return withPage(async ({ page, send, evalJs }) => {
    const focus = await evalJs(JS.focusEditor);
    if (!focus.ok) throw new Error(focus.error || 'cannot focus editor');
    const before = await evalJs(JS.read);
    liveWindow = { url: page.url, startCount: before.count, at: Date.now() };
    await send('Input.insertText', { text });
    await sleep(400);
    const typed = await evalJs(JS.editorText);
    const click = await evalJs(JS.clickSend);
    if (!click.ok) throw new Error(click.error || 'send failed');
    await sleep(1200);
    return { typed, send: click, url: await evalJs('location.href') };
  });
}

async function cmdAsk(text, timeoutMs = 180000) {
  return withPage(async ({ page, send, evalJs }) => {
    const before = await evalJs(JS.read);
    liveWindow = { url: page.url, startCount: before.count, at: Date.now() };
    const focus = await evalJs(JS.focusEditor);
    if (!focus.ok) throw new Error(focus.error || 'cannot focus editor');
    await send('Input.insertText', { text });
    await sleep(400);
    const typed = await evalJs(JS.editorText);
    const click = await evalJs(JS.clickSend);
    if (!click.ok) throw new Error(click.error || 'send failed');

    // Count assistant bubbles only. In a brand-new conversation the sole
    // rendered bubble right after sending is our own right-aligned message;
    // treating that as the reply made this return in a few seconds.
    const ASSISTANT_COUNT = `(() => {
      const nodes = [...document.querySelectorAll('div[class*="md-box-root"]')];
      return nodes.filter(n => !n.closest('[class*="justify-end"]')).length;
    })()`;
    const beforeAssistant = await evalJs(ASSISTANT_COUNT);

    const started = Date.now();
    let prev = '';
    let stable = 0;
    while (Date.now() - started < timeoutMs) {
      await sleep(1500);
      const now = await evalJs(JS.read);
      const assistantCount = await evalJs(ASSISTANT_COUNT);
      if (assistantCount > beforeAssistant) {
        const tail = now.messages[now.messages.length - 1] || '';
        // The last bubble must be an assistant one before we trust it.
        const lastIsAssistant = await evalJs(`(() => {
          const nodes = [...document.querySelectorAll('div[class*="md-box-root"]')];
          if (!nodes.length) return false;
          return !nodes[nodes.length - 1].closest('[class*="justify-end"]');
        })()`);
        if (lastIsAssistant && tail && tail === prev && !now.generating) stable++;
        else stable = 0;
        prev = tail;
        if (stable >= 2) {
          return {
            typed,
            elapsedMs: Date.now() - started,
            reply: tail,
            messages: now.messages.slice(-4)
          };
        }
      }
    }
    const final = await evalJs(JS.read);
    return {
      typed,
      elapsedMs: Date.now() - started,
      timedOut: true,
      generating: final.generating,
      reply: final.messages[final.messages.length - 1] || null
    };
  });
}

// ---------- task trace: read Doubao's step-by-step narration ----------
// In task mode each run has a collapsible <section data-testid="preamble-elapsed">.
// The body is height:0 + inert until the header <button> is clicked with REAL
// pointer events (el.click() does nothing), after which the narration renders.
const PREAMBLE_INFO = `(() => {
  const secs = [...document.querySelectorAll('[data-testid="preamble-elapsed"]')];
  return secs.map((s, i) => {
    const btn = s.querySelector('button');
    return {
      i,
      expanded: btn ? btn.getAttribute('aria-expanded') === 'true' : false,
      elapsed: (s.querySelector('[data-testid="preamble-elapsed-timer"]')?.innerText || '').trim()
    };
  });
})()`;

const PREAMBLE_TEXT = `(() => {
  const secs = [...document.querySelectorAll('[data-testid="preamble-elapsed"]')];
  return secs.map((s) => {
    const body = s.querySelector('[class*="bodySlot"]');
    return {
      elapsed: (s.querySelector('[data-testid="preamble-elapsed-timer"]')?.innerText || '').trim(),
      steps: body ? (body.innerText || '').trim() : ''
    };
  });
})()`;

async function cmdReadSteps({ expand = true } = {}) {
  return withPage(async ({ send, evalJs }) => {
    const before = await evalJs(PREAMBLE_INFO);
    if (!before.length) {
      return { found: 0, note: 'No task-mode narration blocks in this conversation.' };
    }

    if (expand) {
      // Expand every collapsed block with a real pointer click.
      const collapsed = before.filter((x) => !x.expanded);
      for (const item of collapsed) {
        const rect = await evalJs(`(() => {
          const s = document.querySelectorAll('[data-testid="preamble-elapsed"]')[${item.i}];
          const b = s && s.querySelector('button');
          if (!b) return null;
          b.scrollIntoView({ block: 'center' });
          const r = b.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return null;
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        })()`);
        if (!rect) continue;
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
        await sleep(900);
      }
    }

    const blocks = await evalJs(PREAMBLE_TEXT);
    return {
      found: blocks.length,
      expandedFrom: before.filter((x) => !x.expanded).length,
      blocks
    };
  });
}

// ---------- capability extension: image generation & peer consultation ----------
// Doubao's generated images sit in the assistant bubble as real CDN URLs
// (rc_gen_image/..., naturalWidth up to 2048). UI chrome also lives on the same
// CDN, so filter by natural size instead of by host.
const GEN_IMAGE_JS = `(() => {
  const out = [];
  for (const i of document.querySelectorAll('img')) {
    const src = i.currentSrc || i.src || '';
    if (!src || !src.includes('byteimg.com')) continue;
    if (i.naturalWidth < 512) continue;
    out.push(src);
  }
  return [...new Set(out)];
})()`;

async function cmdImage({ prompt, timeoutMs = 240000 }) {
  if (!prompt) throw new Error('prompt is required');
  return withPage(async ({ page, send, evalJs }) => {
    const opened = await realClick(send, evalJs,
      `[...document.querySelectorAll('div[class*="sidebar_nav_item"]')].find(d => (d.innerText||'').replace(/\\s+/g,'').includes('新对话'))`);
    if (!opened.ok) throw new Error('cannot start a new chat');
    await sleep(2200);

    const before = await evalJs(JS.read);
    liveWindow = { url: page.url, startCount: before.count, at: Date.now() };
    const focus = await evalJs(JS.focusEditor);
    if (!focus.ok) throw new Error(focus.error || 'editor not ready');
    await send('Input.insertText', { text: prompt });
    await sleep(500);
    const click = await evalJs(JS.clickSend);
    if (!click.ok) throw new Error(click.error || 'send failed');

    const started = Date.now();
    let urls = [];
    while (Date.now() - started < timeoutMs) {
      await sleep(2500);
      urls = (await evalJs(GEN_IMAGE_JS)) || [];
      if (urls.length) break;
    }
    return {
      prompt,
      elapsedMs: Date.now() - started,
      imageCount: urls.length,
      images: urls,
      url: await evalJs('location.href'),
      note: urls.length
        ? 'Direct CDN URLs. They carry an expiry (x-expires), so download promptly; re-ask if expired.'
        : 'No image appeared before the timeout.'
    };
  });
}

function buildConsultText({ question, myAnalysis, focus }) {
  const lines = ['【交叉验证请求】', '', '问题：', question, ''];
  if (myAnalysis) {
    lines.push('另一个 AI 的初步思路是：', myAnalysis, '');
    lines.push('请你先独立分析，不要被这段思路带偏；然后明确指出它错在哪、漏了什么、或有没有更好的方案。');
  } else {
    lines.push('请给出你的分析和结论。');
  }
  if (focus) lines.push('', '请特别注意：' + focus);
  lines.push('', '如果你和上面那段思路结论不同，说明各自成立的依据。');
  return lines.join('\n');
}

async function cmdConsult({ question, myAnalysis, focus, timeoutMs = 300000 }) {
  if (!question) throw new Error('question is required');
  const text = buildConsultText({ question, myAnalysis, focus });
  // A fresh conversation keeps the answer free of unrelated history.
  await cmdNew();
  await sleep(1500);
  const answer = await cmdAsk(text, timeoutMs);
  return {
    question,
    myAnalysis: myAnalysis || null,
    focus: focus || null,
    answer: answer.reply,
    elapsedMs: answer.elapsedMs,
    timedOut: !!answer.timedOut,
    url: answer.url
  };
}

// ---------- task mode + handoff ----------
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { owner: 'deepseek', since: null, task: null, project: null, status: 'idle', taskUrl: null }; }
}

function writeState(patch) {
  const next = { ...readState(), ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(HANDOFF_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

const MODE_JS = `(() => {
  const t = document.body.innerText || '';
  const workLanding = t.includes('今天有什么工作要处理');
  const taskWorkspace = /对话产物/.test(t) && /最近文件/.test(t);
  return {
    href: location.href,
    workLanding,
    taskWorkspace,
    mode: (workLanding || taskWorkspace) ? 'task' : 'chat'
  };
})()`;

// Task mode changes React state on trust: real pointer events, not el.click().
async function realClick(send, evalJs, expr) {
  const rect = await evalJs(`(() => {
    const el = ${expr};
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!rect) return { ok: false, error: 'element not found or zero-size' };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  return { ok: true, at: rect };
}

async function cmdMode() {
  return withPage(async ({ page, evalJs }) => ({
    target: { title: page.title, url: page.url },
    ...(await evalJs(MODE_JS)),
    handoff: readState()
  }));
}

async function cmdNewTask() {
  return withPage(async ({ send, evalJs }) => {
    const clicked = await realClick(send, evalJs,
      `[...document.querySelectorAll('div[class*="sidebar_nav_item"]')].find(d => (d.innerText||'').replace(/\\s+/g,'').includes('新工作任务'))`);
    if (!clicked.ok) throw new Error('new-task entry not clickable');
    await sleep(2500);
    return { clicked, state: await evalJs(MODE_JS) };
  });
}

// Shared driver: open a fresh task, submit text, wait for the run to settle.
// Completion is detected by an explicit end-marker that the handoff prompt asks
// Doubao to print, because task-mode intermediate steps look like final replies.
// Doubao's task mode sometimes stops and asks the caller a question. When it
// does, the run sits at "正在询问用户" forever with nobody to answer. We detect
// that state and hand the question up, so the harness can ask the real user.
//
// NOTE: the composer's stop button exists even after a run finishes, so it is
// NOT a reliable "is generating" signal. The timer text is: "已处理 N 秒" while
// running, "共用时 N 秒" once finished.
const RUN_STATE_JS = `(() => {
  const ml = document.querySelector('[data-testid="message-list"]');
  const txt = ml ? (ml.innerText || '') : '';
  const secs = [...document.querySelectorAll('[data-testid="preamble-elapsed"]')];
  const lastSec = secs.length ? secs[secs.length - 1] : null;
  const elapsed = lastSec
    ? ((lastSec.querySelector('[data-testid="preamble-elapsed-timer"]')?.innerText || '').trim())
    : '';
  const nodes = [...document.querySelectorAll('div[class*="md-box-root"]')];
  const assistants = nodes.filter(n => !n.closest('[class*="justify-end"]'));
  const lastAssistant = assistants.length
    ? (assistants[assistants.length - 1].innerText || '').trim()
    : '';
  return {
    asking: /正在询问用户/.test(txt),
    running: /已处理/.test(elapsed),
    finished: /共用时/.test(elapsed),
    thinking: txt.includes('正在思考'),
    executing: /正在执行代码/.test(txt),
    elapsed,
    lastAssistant,
    trace: txt
  };
})()`;

async function waitForRun({ evalJs }, { marker, timeoutMs, startedAt }) {
  const t0 = startedAt || Date.now();
  let snapshot = null;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(3000);
    snapshot = await evalJs(RUN_STATE_JS);
    const busy = snapshot.running || snapshot.thinking || snapshot.executing;

    if (snapshot.lastAssistant.includes(marker) && !busy) {
      await sleep(2000);
      snapshot = await evalJs(RUN_STATE_JS);
      return { status: 'done', snapshot, elapsedMs: Date.now() - t0 };
    }
    if (snapshot.asking && !busy) {
      return { status: 'needs-user', snapshot, elapsedMs: Date.now() - t0 };
    }
    if (snapshot.finished && !busy && snapshot.lastAssistant.includes(marker)) {
      return { status: 'done', snapshot, elapsedMs: Date.now() - t0 };
    }
  }
  return { status: 'timeout', snapshot, elapsedMs: Date.now() - t0 };
}

async function driveTask({ send, evalJs, page }, text, timeoutMs, marker = 'HANDOFF-DONE') {
  const opened = await realClick(send, evalJs,
    `[...document.querySelectorAll('div[class*="sidebar_nav_item"]')].find(d => (d.innerText||'').replace(/\\s+/g,'').includes('新工作任务'))`);
  if (!opened.ok) throw new Error('cannot open a new task: ' + (opened.error || ''));
  await sleep(2600);

  // The fresh task page has settled; remember how many messages it had before
  // we submit, so the live view can show only this run's output.
  const before = await evalJs(JS.read);
  liveWindow = { url: page.url, startCount: before.count, at: Date.now() };

  const focus = await evalJs(JS.focusEditor);
  if (!focus.ok) throw new Error(focus.error || 'editor not ready in task mode');
  await send('Input.insertText', { text });
  await sleep(600);
  const typed = await evalJs(JS.editorText);

  const clicked = await realClick(send, evalJs, `document.querySelector('[data-testid="chat_input_send_button"]')`);
  if (!clicked.ok) throw new Error('send button not clickable');

  const r = await waitForRun({ evalJs }, { marker, timeoutMs, startedAt: Date.now() });
  return {
    typed,
    elapsedMs: r.elapsedMs,
    url: await evalJs('location.href'),
    completed: r.status === 'done',
    needsUserInput: r.status === 'needs-user',
    timedOut: r.status === 'timeout',
    question: r.status === 'needs-user' ? (r.snapshot.lastAssistant || '') : null,
    reply: (r.snapshot && r.snapshot.lastAssistant) || null
  };
}

// Feed an answer back into a run that is waiting at "正在询问用户".
async function cmdReply({ answer, timeoutMs = 900000, marker = 'HANDOFF-DONE' }) {
  if (!answer) throw new Error('answer is required');
  return withPage(async ({ page, send, evalJs }) => {
    const focus = await evalJs(JS.focusEditor);
    if (!focus.ok) throw new Error(focus.error || 'editor not ready');
    const before = await evalJs(JS.read);
    liveWindow = { url: page.url, startCount: before.count, at: Date.now() };
    await send('Input.insertText', { text: answer });
    await sleep(500);
    const clicked = await realClick(send, evalJs, `document.querySelector('[data-testid="chat_input_send_button"]')`);
    if (!clicked.ok) throw new Error('send button not clickable');

    const started = Date.now();
    const r = await waitForRun({ evalJs }, { marker, timeoutMs, startedAt: started });
    return {
      answered: answer,
      elapsedMs: r.elapsedMs,
      completed: r.status === 'done',
      needsUserInput: r.status === 'needs-user',
      timedOut: r.status === 'timeout',
      question: r.status === 'needs-user' ? (r.snapshot.lastAssistant || '') : null,
      reply: (r.snapshot && r.snapshot.lastAssistant) || null,
      url: await evalJs('location.href')
    };
  });
}

async function cmdRunTask({ task, timeoutMs = 600000 }) {
  if (!task) throw new Error('task text is required');
  return withPage(async (ctx) => {
    const result = await driveTask(ctx, task, timeoutMs);
    writeState({ owner: 'doubao', status: 'done', task, since: new Date().toISOString(), taskUrl: result.url });
    return result;
  });
}

function buildHandoffText({ project, task }) {
  const lines = [
    '【DSH 移交任务】',
    project ? `工作目录：${project}` : null,
    '',
    '任务：',
    task,
    '',
    '要求：',
    '1. 只在' + (project ? `上述目录（${project}）` : '指定的工作目录') + '内改动文件，不要触碰其他路径。',
    '2. 完成后用一句话总结你实际改动了哪些文件、做了什么。',
    '3. 如果无法完成，直接说明原因，不要假装完成。',
    '4. 遇到信息不足、数量对不上、选项不明确这类情况，按最合理的方式自行决定并说明你的依据，然后继续；',
    '   但涉及删除、覆盖、不可逆修改，或你无法确定会影响哪些文件时，必须停下来向调用方确认，不要自行决定。',
    '5. 全部工作结束后，在回复的最后一行单独输出这个标记（必须原样输出，不要加引号或解释）：',
    'HANDOFF-DONE'
  ];
  return lines.filter((l) => l !== null).join('\n');
}

async function cmdHandoff({ project, task, timeoutMs = 900000 }) {
  if (!task) throw new Error('task text is required');
  if (project && !fs.existsSync(project)) throw new Error('project directory does not exist: ' + project);

  writeState({
    owner: 'doubao',
    status: 'running',
    task,
    project: project || null,
    since: new Date().toISOString(),
    taskUrl: null
  });

  try {
    const result = await withPage(async (ctx) => driveTask(ctx, buildHandoffText({ project, task }), timeoutMs));
    writeState({
      owner: 'doubao',
      status: result.completed ? 'done' : (result.needsUserInput ? 'waiting-user' : 'waiting'),
      taskUrl: result.url
    });
    return { ...result, handoff: readState() };
  } catch (err) {
    writeState({ owner: 'doubao', status: 'failed', error: String(err && err.message || err) });
    throw err;
  }
}

// Read what Doubao produced and hand ownership back to DeepSeek.
async function cmdReturn() {
  const result = await withPage(async ({ page, evalJs }) => ({
    title: page.title,
    url: page.url,
    ...(await evalJs(JS.read))
  }));
  const before = readState();
  const state = writeState({
    owner: 'deepseek',
    status: 'returned',
    returnedAt: new Date().toISOString()
  });
  return {
    handoff: state,
    doubaoReport: result.messages.slice(-1),
    messageCount: result.count,
    messages: result.messages.slice(-6),
    url: result.url
  };
}

// ---------- state endpoint for the Web UI badge ----------
// The harness page is a different origin, so this is a tiny CORS-enabled,
// read-only JSON endpoint. It exposes the handoff state plus a live view of
// what Doubao is currently saying, so the UI can show its words verbatim
// instead of only the agent's summary.
let liveCache = { at: 0, data: null };
const LIVE_TTL_MS = 900;

// "Live window" for one Doubao write call: which chat it ran in and how many
// messages already existed when it started. /live returns `since` so a tool
// card renders only the messages that appeared DURING this call, never the
// whole reused conversation.
let liveWindow = { url: null, startCount: 0, at: 0 };

// While a task RUNS, the live trace is rendered directly inside
// [data-testid="message-list"] and grows in place: the narration lines, then
// "正在执行代码 ..." lines. The preamble-elapsed section only holds the timer —
// its bodySlot stays empty (height 0) even while running, so reading that was
// the wrong tree. After the run finishes the trace collapses and unloads.
const LIVE_JS = `(() => {
  const ml = document.querySelector('[data-testid="message-list"]');
  const full = ml ? (ml.innerText || '').trim() : '';
  const secs = [...document.querySelectorAll('[data-testid="preamble-elapsed"]')];
  const lastSec = secs.length ? secs[secs.length - 1] : null;
  const elapsed = lastSec
    ? ((lastSec.querySelector('[data-testid="preamble-elapsed-timer"]')?.innerText || '').trim())
    : '';
  const bubbles = [...document.querySelectorAll('div[class*="md-box-root"]')]
    .map(n => (n.innerText || '').trim()).filter(Boolean);
  // Structured turn list so the UI can draw them as chat bubbles.
  const messages = [...document.querySelectorAll('div[class*="md-box-root"]')]
    .map(n => ({
      role: n.closest('[class*="justify-end"]') ? 'user' : 'assistant',
      text: (n.innerText || '').trim()
    }))
    .filter(m => m.text);
  const mlText = ml ? (ml.innerText || '') : '';
  // Historical messages keep phrases like "正在执行代码" forever, so only look at
  // the tail; and trust the timer wording first.
  const tailText = mlText.slice(-300);
  return {
    active: /已处理/.test(elapsed) || (!elapsed && /正在思考|正在询问用户/.test(tailText)),
    thinking: tailText.includes('正在思考'),
    trace: full,
    elapsed,
    bubbles,
    messages
  };
})()`;

async function readLive() {
  const now = Date.now();
  if (liveCache.data && now - liveCache.at < LIVE_TTL_MS) return liveCache.data;

  let data;
  // Probing for display must NOT count as "Doubao is working". The UI polls this
  // every 1.5 s; letting it touch the activity clock pinned the lamp to Doubao
  // forever.
  const touchBefore = lastDoubaoTouch;
  try {
    data = await withPage(async ({ page, evalJs }) => {
      const r = await evalJs(LIVE_JS);
      const bubbles = r.bubbles || [];
      const trace = r.trace || '';
      return {
        ok: true,
        active: !!r.active,
        thinking: !!r.thinking,
        elapsed: r.elapsed || '',
        steps: trace,
        messages: r.messages || [],
        last: bubbles[bubbles.length - 1] || '',
        count: bubbles.length,
        since: page.url === liveWindow.url ? liveWindow.startCount : 0,
        url: page.url,
        title: page.title
      };
    });
  } catch (err) {
    data = { ok: false, active: false, error: String((err && err.message) || err) };
  } finally {
    lastDoubaoTouch = touchBefore;
  }
  data.at = new Date().toISOString();
  liveCache = { at: now, data };
  return data;
}

function startStateServer(port = 9226) {
  const srv = http.createServer(async (req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const route = (req.url || '').split('?')[0];
    if (route === '/state') {
      // Report the CURRENT owner, derived from activity, not from whatever the
      // last handoff left behind. The raw file stays available as `owner`.
      const s = readState();
      const idleMs = lastDoubaoTouch ? Date.now() - lastDoubaoTouch : Number.MAX_SAFE_INTEGER;
      const running = s.status === 'running';
      const fresh = idleMs < DOUBAO_FRESH_MS;
      const effectiveOwner = (running || fresh) ? 'doubao' : 'deepseek';
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        ...s,
        effectiveOwner,
        reason: running ? 'run-active' : fresh ? 'recent-touch' : 'idle',
        idleMs: Number.isFinite(idleMs) ? idleMs : null
      }));
      return;
    }
    // Live view of Doubao's current output, polled by the UI panel.
    if (route === '/live') {
      const data = await readLive();
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
      return;
    }
    // Diagnostic: report the environment the harness handed this server.
    if (route === '/env') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        cwd: process.cwd(),
        argv: process.argv,
        execPath: process.execPath,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        env: {
          DOUBAO_CDP: process.env.DOUBAO_CDP || null,
          DOUBAO_BADGE_PORT: process.env.DOUBAO_BADGE_PORT || null,
          DOUBAO_EXE: process.env.DOUBAO_EXE || null,
          // Both spellings: USERPROFILE on Windows, HOME everywhere.
          USERPROFILE: process.env.USERPROFILE || null,
          HOME: process.env.HOME || null,
          LOCALAPPDATA: process.env.LOCALAPPDATA || null,
          DSH_PROFILE: process.env.DSH_PROFILE || null,
          DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR || null
        }
      }));
      return;
    }
    res.writeHead(404, cors);
    res.end('not found');
  });
  // If another instance already holds the port, keep serving MCP over stdio.
  srv.on('error', () => {});
  srv.listen(port, '127.0.0.1');
  return srv;
}

// ---------- MCP stdio server ----------
const TOOLS = [
  {
    name: 'doubao_status',
    description: 'Check whether the local Doubao desktop app is reachable over CDP and report the current chat page state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'doubao_list_chats',
    description: 'List conversations visible in the Doubao sidebar, with title and conversation id.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'doubao_read_chat',
    description: 'Read the currently open Doubao conversation (most recent messages rendered in the window).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'doubao_open_chat',
    description: 'Open a Doubao conversation by sidebar index or conversation id so its messages can be read.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Sidebar index (e.g. "3") or numeric conversation id.' }
      },
      required: ['target'],
      additionalProperties: false
    }
  },
  {
    name: 'doubao_new_chat',
    description: 'Start a fresh conversation in the Doubao desktop app.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'doubao_send',
    description: 'Send a message into the currently open Doubao conversation without waiting for the reply.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Message text to send.' } },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'doubao_ask',
    description: 'Send a message to Doubao and wait until its reply has finished streaming, then return the reply text.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Question or task to send.' },
        timeoutMs: { type: 'number', description: 'Max wait in milliseconds (default 180000).' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'doubao_mode',
    description: 'Report whether the open Doubao window is in chat mode or task (work) mode, plus the current handoff ownership state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'doubao_new_task',
    description: 'Switch the Doubao window into task mode ("新工作任务"), where it can operate local files and run multi-step work.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'doubao_run_task',
    description: 'Open a fresh Doubao task, submit the given task text, wait for the run to settle, and return its report. Use for one-off task-mode work.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task instructions.' },
        timeoutMs: { type: 'number', description: 'Max wait in milliseconds (default 600000).' }
      },
      required: ['task'],
      additionalProperties: false
    }
  },
  {
    name: 'doubao_handoff',
    description: 'Hand the current project over to Doubao task mode: records ownership state, opens a fresh task scoped to the project directory, submits the task, and waits for the run to settle. Use this when the user wants Doubao to do the work.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Absolute path of the project/working directory Doubao may modify.' },
        task: { type: 'string', description: 'What Doubao should do in that directory.' },
        timeoutMs: { type: 'number', description: 'Max wait in milliseconds (default 900000).' }
      },
      required: ['project', 'task'],
      additionalProperties: false
    }
  },
  {
    name: 'doubao_return',
    description: 'Take ownership back from Doubao: reads its latest report, switches the handoff state back to DeepSeek, and returns what it said it did. Follow with your own diff/verification.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'doubao_image',
    description: 'Generate an image with Doubao in a fresh chat and return the direct CDN URLs of the generated originals (up to 2048px). Download the URL promptly: it carries an expiry.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Image description.' },
        timeoutMs: { type: 'number', description: 'Max wait in milliseconds (default 240000).' }
      },
      required: ['prompt'],
      additionalProperties: false
    }
  },
  {
    name: 'doubao_consult',
    description: 'Ask Doubao to independently analyse a problem, optionally passing your own reasoning so it can challenge it. Use when a programming or design question is uncertain and a second, independent opinion with cross-checking is worth the round trip.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The problem to analyse.' },
        myAnalysis: { type: 'string', description: 'Your own current reasoning, so Doubao can challenge it.' },
        focus: { type: 'string', description: 'A specific aspect to pay attention to.' },
        timeoutMs: { type: 'number', description: 'Max wait in milliseconds (default 300000).' }
      },
      required: ['question'],
      additionalProperties: false
    }
  },
  {
    name: 'doubao_read_steps',
    description: 'Read Doubao task mode\'s step-by-step narration (what it read, which tools it called, what it observed, what it decided next). The blocks are collapsed by default; this expands them with a real click so the text renders. Use it to see HOW a task was done, not just the final report.',
    inputSchema: {
      type: 'object',
      properties: {
        expand: { type: 'boolean', description: 'Expand collapsed blocks first (default true). False reads only already-open ones.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'doubao_reply',
    description: 'Answer a Doubao task that stopped to ask a question. Call this AFTER doubao_handoff (or a previous doubao_reply) returned needsUserInput=true, and after you asked the real user. It sends the answer and keeps waiting for completion, returning the same shape (so it can be chained if it asks again).',
    inputSchema: {
      type: 'object',
      properties: {
        answer: { type: 'string', description: 'The answer to send to Doubao, in its language and phrasing.' },
        timeoutMs: { type: 'number', description: 'Max wait after answering (default 900000).' }
      },
      required: ['answer'],
      additionalProperties: false
    }
  }
];

async function callTool(name, args) {
  switch (name) {
    case 'doubao_status': return await cmdStatus();
    case 'doubao_list_chats': return await cmdList();
    case 'doubao_read_chat': return await cmdRead();
    case 'doubao_open_chat': return await cmdOpen(args.target);
    case 'doubao_new_chat': return await cmdNew();
    case 'doubao_send': return await cmdSend(args.text);
    case 'doubao_ask': return await cmdAsk(args.text, args.timeoutMs || 180000);
    case 'doubao_mode': return await cmdMode();
    case 'doubao_new_task': return await cmdNewTask();
    case 'doubao_run_task': return await cmdRunTask({ task: args.task, timeoutMs: args.timeoutMs });
    case 'doubao_handoff': return await cmdHandoff({ project: args.project, task: args.task, timeoutMs: args.timeoutMs });
    case 'doubao_return': return await cmdReturn();
    case 'doubao_image': return await cmdImage({ prompt: args.prompt, timeoutMs: args.timeoutMs });
    case 'doubao_consult': return await cmdConsult({ question: args.question, myAnalysis: args.myAnalysis, focus: args.focus, timeoutMs: args.timeoutMs });
    case 'doubao_read_steps': return await cmdReadSteps({ expand: args.expand !== false });
    case 'doubao_reply': return await cmdReply({ answer: args.answer, timeoutMs: args.timeoutMs });
    default: throw new Error('unknown tool: ' + name);
  }
}

function writeMsg(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function mcpMain() {
  const rl = await import('node:readline');
  const iface = rl.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of iface) {
    const raw = line.trim();
    if (!raw) continue;
    let msg;
    try { msg = JSON.parse(raw); } catch { continue; }
    const { id, method, params } = msg;

    if (method === 'initialize') {
      writeMsg({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'doubao-desktop', version: '1.0.0' }
        }
      });
    } else if (method === 'notifications/initialized' || method === 'initialized') {
      // no reply for notifications
    } else if (method === 'tools/list') {
      writeMsg({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      try {
        const out = await callTool(name, args);
        writeMsg({
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: false }
        });
      } catch (err) {
        writeMsg({
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: 'Error: ' + (err && err.message || String(err)) }], isError: true }
        });
      }
    } else if (id !== undefined) {
      writeMsg({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
    }
  }
}

// ---------- entry ----------
async function cliMain() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    console.log(JSON.stringify({ ok: false, error: 'usage: status|list|read|open <t>|new|send <text>|ask <text>' }));
    process.exit(2);
  }
  let out;
  if (cmd === 'status') out = await cmdStatus();
  else if (cmd === 'list') out = await cmdList();
  else if (cmd === 'read') out = await cmdRead();
  else if (cmd === 'open') out = await cmdOpen(rest[0]);
  else if (cmd === 'new') out = await cmdNew();
  else if (cmd === 'send') out = await cmdSend(rest.join(' '));
  else if (cmd === 'ask') out = await cmdAsk(rest.join(' '));
  else if (cmd === 'mode') out = await cmdMode();
  else if (cmd === 'new-task') out = await cmdNewTask();
  else if (cmd === 'run-task') out = await cmdRunTask({ task: rest.join(' ') });
  else if (cmd === 'handoff') out = await cmdHandoff({ project: rest[0], task: rest.slice(1).join(' ') });
  else if (cmd === 'return') out = await cmdReturn();
  else if (cmd === 'image') out = await cmdImage({ prompt: rest.join(' ') });
  else if (cmd === 'consult') out = await cmdConsult({ question: rest.join(' ') });
  else if (cmd === 'steps') out = await cmdReadSteps({ expand: !rest.includes('--no-expand') });
  else if (cmd === 'reply') out = await cmdReply({ answer: rest.join(' ') });
  else if (cmd === 'who') out = readState();
  else out = { ok: false, error: 'unknown command: ' + cmd };
  console.log(JSON.stringify(out, null, 2));
}

const isMcp = process.argv.includes('--mcp');
if (isMcp) {
  startStateServer(BADGE_PORT);
  mcpMain().catch((e) => { console.error('fatal:', e); process.exit(1); });
} else {
  cliMain().catch((e) => { console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) }, null, 2)); process.exit(1); });
}
