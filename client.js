window.__ModuleLoader__.load({
  id: 'dsh-doubao-bridge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const STATE_URL = 'http://127.0.0.1:9226/state';
    const LIVE_URL = 'http://127.0.0.1:9226/live';
    const STATE_POLL_MS = 3000;
    const LIVE_POLL_MS = 1500;

    // Bump on every change. Shown next to the status dot so the user can SEE
    // which build is actually loaded (the frameless window hides document.title).
    const BUILD = 'b33';

    function label(s) {
      // effectiveOwner is computed server-side from real activity, so the lamp
      // means "who is working NOW" rather than "what the last handoff left".
      const owner = (s && s.effectiveOwner) || (s && s.owner) || 'deepseek';
      const status = (s && s.status) || '';
      if (owner === 'doubao') {
        if (status === 'running') return { text: '豆包正在执行', tone: '--dsw-alias-state-warn-primary' };
        if (status === 'failed') return { text: '豆包任务失败', tone: '--dsw-alias-state-error-primary' };
        return { text: '豆包刚有响应', tone: '--dsw-alias-state-success-primary' };
      }
      return { text: 'DeepSeek 在执行', tone: '--dsw-alias-brand-primary' };
    }

    function Badge() {
      const [state, setState] = React.useState(null);
      const [reachable, setReachable] = React.useState(true);

      // Ownership state only. The in-flow bubbles handle Doubao's words, so this
      // stays a single dot; details live in the hover title.
      React.useEffect(() => {
        let alive = true;
        const tick = async () => {
          try {
            const res = await fetch(STATE_URL, { cache: 'no-store' });
            if (!res.ok) throw new Error('http ' + res.status);
            const next = await res.json();
            if (!alive) return;
            setState(next);
            setReachable(true);
          } catch {
            if (alive) setReachable(false);
          }
        };
        tick();
        const id = setInterval(tick, STATE_POLL_MS);
        return () => { alive = false; clearInterval(id); };
      }, []);

      const info = label(state);
      const tone = reachable ? info.tone : '--dsw-alias-state-idle-primary';
      const text = reachable ? info.text : '状态服务未连接';
      const task = state && state.task ? String(state.task).replace(/\s+/g, ' ').slice(0, 60) : '';
      const title = task ? text + '\n' + task : text;

      // Short label beside the dot: who is working, one or two characters' worth.
      const owner = reachable ? ((state && state.effectiveOwner) || 'deepseek') : null;
      const running = !!(state && state.status === 'running');
      const shortText = !reachable
        ? '未连接'
        : owner === 'doubao'
          ? (running ? '豆包执行中' : '豆包')
          : 'DeepSeek';

      return h('div', {
        'data-doubao-handoff-badge': '1',
        title,
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          height: 16,
          padding: '1px 0 3px',
          userSelect: 'none',
          cursor: 'default',
        },
      },
        h('span', {
          style: {
            width: 6,
            height: 6,
            borderRadius: '50%',
            flex: 'none',
            background: 'var(' + tone + ')',
            boxShadow: '0 0 0 2px color-mix(in srgb, var(' + tone + ') 22%, transparent)',
          },
        }),
        h('span', {
          'aria-label': text,
          style: {
            fontSize: 11,
            lineHeight: '14px',
            color: 'var(--dsw-alias-label-secondary)',
            whiteSpace: 'nowrap',
          },
        }, shortText),
        // Visible build stamp: proves which client bundle is live.
        h('span', {
          title: 'client build ' + BUILD,
          style: {
            fontSize: 10,
            lineHeight: '14px',
            opacity: 0.45,
            color: 'var(--dsw-alias-label-secondary)',
            whiteSpace: 'nowrap',
          },
        }, BUILD.replace(/^b/, 'v'))
      );
    }

    // ---- in-flow conversation view: Doubao's turns as chat bubbles ----
    // Registered on tool.call.toolview, which dispatches by wire tool name, so
    // these render exactly where the tool call sits in the conversation.
    function DoubaoTurn({ role, text }) {
      const isUser = role === 'user';
      return h('div', {
        style: {
          display: 'flex',
          justifyContent: isUser ? 'flex-end' : 'flex-start',
          alignItems: 'flex-start',
          gap: 6,
          margin: '4px 0',
        },
      },
        !isUser
          ? h('span', {
              style: {
                flex: 'none',
                marginTop: 2,
                padding: '0 6px',
                borderRadius: 6,
                fontSize: 11,
                lineHeight: '18px',
                color: 'var(--dsw-alias-brand-primary)',
                background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent)',
                whiteSpace: 'nowrap',
              },
            }, '豆包')
          : null,
        h('div', {
          style: {
            maxWidth: '82%',
            padding: '6px 10px',
            borderRadius: 10,
            fontSize: 12,
            lineHeight: '19px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: isUser ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-primary)',
            background: isUser
              ? 'color-mix(in srgb, var(--dsw-alias-label-secondary) 10%, transparent)'
              : 'var(--dsw-alias-bg-layer-1)',
            border: '1px solid var(--dsw-alias-border-l1)',
          },
        }, text)
      );
    }

    function DoubaoTaskView(props) {
      // Never fail silently: if rendering throws, say so on screen instead of
      // degrading into the generic tool row where nobody can tell.
      try {
        return DoubaoTaskViewBody(props);
      } catch (err) {
        return h('div', {
          style: {
            fontSize: 11,
            padding: '4px 6px',
            color: 'var(--dsw-alias-state-error-primary)',
            border: '1px solid var(--dsw-alias-state-error-primary)',
            borderRadius: 6,
          },
        }, '豆包视图出错：' + String((err && err.message) || err));
      }
    }

    function DoubaoTaskViewBody(props) {
      // NOTE: props.useDisclosure is a hook factory — calling it here creates this
      // component's OWN expanded state, which does NOT control the hosting card
      // (verified by experiment: toggle() changed nothing on the card).
      // Visibility comes from DSH's presentation mode instead: with the
      // "verbose" work-details mode, foldCompletedTurns is false, so settled
      // turns stay open and this card's content is visible without any click.
      const disclosure = props && typeof props.useDisclosure === 'function'
        ? props.useDisclosure()
        : null;
      void disclosure; // keep the hook call order stable

      const phase = props && props.phase;
      const running = phase === 'start' || phase === 'preparing';
      const [live, setLive] = React.useState(null);
      const [open, setOpen] = React.useState(true);

      React.useEffect(() => {
        let alive = true;
        const tick = async () => {
          try {
            const res = await fetch(LIVE_URL, { cache: 'no-store' });
            const j = await res.json();
            if (alive) setLive(j);
          } catch { /* keep last */ }
        };
        tick();
        // Only poll while the call is in flight; afterwards one final read is enough.
        if (!running) return () => { alive = false; };
        const id = setInterval(tick, 1500);
        return () => { alive = false; clearInterval(id); };
      }, [running]);

      const msgs = (live && live.messages) || [];
      // The server tags every /live payload with `since`: how many messages
      // already existed when THIS tool call began. Slicing there keeps a card
      // limited to what this round added instead of the whole reused chat.
      const since = (live && typeof live.since === 'number' && live.since > 0) ? live.since : 0;
      const active = !!(live && live.active);
      const elapsed = (live && live.elapsed) || '';

      // Fall back to the tool result itself when the live view has nothing (for
      // example the run finished and Doubao's window moved on). Returning null
      // here silently erased the whole card.
      const resultText = (() => {
        const block = props && props.block;
        if (!block) return '';
        try {
          if (typeof block.text === 'string') return block.text;
          if (typeof block.result === 'string') return block.result;
          const content = (block.result && block.result.content) || block.content;
          if (Array.isArray(content)) {
            return content.map((c) => (c && c.text) || '').filter(Boolean).join('\n');
          }
        } catch { /* ignore */ }
        return '';
      })();

      // Only messages that appeared after this call began. The first one in the
      // window is the prompt we just sent; repeating it as a bubble adds noise.
      const inWindow = since > 0 ? msgs.slice(since) : msgs;
      const shown = inWindow.filter((m, i) => !(i === 0 && m.role === 'user'));
      const empty = !shown.length && !resultText && !active;

      // Auto-expand the hosting "turn process" so our bubbles are visible by
      // default, without the user opening any fold.
      //
      // WHY the old attempts failed: the tool card is a member node of the
      // conversation's turn-process group. When a turn settles, DSH collapses
      // the whole group (the "已完成，用时 X 秒" row IS that group's disclosure
      // button, TurnProcessNodeView) and hides every member flow item — our
      // card included — with the `hidden` attribute. props.useDisclosure() is a
      // hook, so calling it here creates a PRIVATE expanded state that does not
      // control the group; and the card subtree contains no real disclosure
      // button, so clicking inside it did nothing. The only switch that removes
      // `hidden` is the group button's onClick (it writes the chat store via
      // turnProcess.setOpen). So: find OUR turn's group button (same
      // data-chat-turn) and click it. Guarded so we never toggle it closed.
      const rootRef = React.useRef(null);
      const clicked = React.useRef(false);
      React.useEffect(() => {
        if (clicked.current) return;
        const root = rootRef.current;
        if (!root) return;
        const flow = root.closest('[data-chat-flow-key]');
        const turn = flow && flow.getAttribute('data-chat-turn');
        const parent = flow && flow.parentElement;
        if (!turn || !parent) return;
        const esc = String(turn).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        let tries = 0;
        const attempt = () => {
          if (clicked.current) return true;
          let btn = null;
          try {
            btn = parent.querySelector(
              '[data-chat-flow-kind="turn-process"][data-chat-turn="' + esc + '"] button'
            );
          } catch { return false; }
          if (!btn || btn.disabled) return false;
          // Already open: mark done instead of toggling it shut.
          if (btn.getAttribute('aria-expanded') === 'true') {
            clicked.current = true;
            return true;
          }
          clicked.current = true;
          try {
            btn.click();
          } catch { /* ignore */ }
          return true;
        };
        if (attempt()) return;
        // The group button appears when the turn CLOSES, which can be long
        // after this view mounted (we mount at call start). Re-arm on phase
        // change below; the interval only covers same-commit races.
        const id = setInterval(() => { if (attempt() || ++tries > 10) clearInterval(id); }, 250);
        return () => clearInterval(id);
      }, [phase]);

      return h('div', {
        ref: rootRef,
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          padding: '8px 10px',
          borderRadius: 10,
          background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-1) 55%, transparent)',
          border: '1px solid var(--dsw-alias-border-l1)',
        },
      },
        h('div', {
          role: 'button',
          onClick: () => setOpen((v) => !v),
          style: {
            display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
            fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4,
          },
        },
          h('span', {
            style: {
              width: 6, height: 6, borderRadius: '50%', flex: 'none',
              background: active ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)',
            },
          }),
          h('span', null, active ? '豆包正在执行' : '豆包对话'),
          elapsed ? h('span', { style: { opacity: 0.6 } }, '· ' + elapsed) : null,
          h('span', { style: { marginLeft: 'auto', opacity: 0.6 } }, open ? '收起' : '展开')
        ),
        open
          ? h('div', {
              style: {
                display: 'flex', flexDirection: 'column', gap: 2,
                maxHeight: 320, overflowY: 'auto',
              },
            },
              ...shown.map((m, i) => h(DoubaoTurn, { key: i, role: m.role, text: m.text })),
              // When the live view is gone, still show what the tool returned.
              !shown.length && resultText
                ? h(DoubaoTurn, { key: 'result', role: 'assistant', text: resultText })
                : null,
              // Nothing yet (live view empty, no result): say so instead of
              // silently erasing the whole card.
              empty
                ? h('div', { style: { fontSize: 11, opacity: 0.55, padding: '4px 2px' } }, '豆包任务（无内容）')
                : null,
              active
                ? h('div', { style: { fontSize: 11, opacity: 0.6, paddingLeft: 4 } }, '…')
                : null
            )
          : null
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Build stamp is rendered in the badge (the frameless window hides
        // document.title, so title tagging was useless evidence).
        try { window.__doubaoBridgeBuild = BUILD; } catch { /* ignore */ }

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'doubao-handoff-badge', order: 20 },
            Badge
          )
        );

        // Doubao's turns render on the tool-call card, which sits BEFORE the
        // assistant's own reply — that is the only position that gives the user
        // Doubao's answer without waiting for the summary.
        //
        // Two things are required here and both were wrong before:
        //  1. The inject callback MUST RETURN the register() result. A block
        //     callback returning undefined silently never mounts.
        //  2. The key is the wire tool name: mcp__doubao__<raw> (confirmed from
        //     the session log: "name":"mcp__doubao__doubao_ask").
        // The component auto-expands the turn-process group so Doubao's words
        // are visible immediately, in place, before the assistant's summary.
        const RAW = ['doubao_handoff', 'doubao_run_task', 'doubao_consult', 'doubao_ask'];
        for (const raw of RAW) {
          ctx.slots.inject('tool.call.toolview', () =>
            ctx.slots.register(
              { name: 'tool.call.toolview', key: 'mcp__doubao__' + raw },
              DoubaoTaskView
            )
          );
        }
      },
    };
  },
});
