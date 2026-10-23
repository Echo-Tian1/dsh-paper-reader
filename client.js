/**
 * 文献阅读坞（Paper Reader）— DSH 客户端薄壳。
 *
 * 只做四件事：
 *  1. 在 DSH 窗口左侧开一条「坞」：给 AppFrame 加 padding-left 把三栏整体右推，
 *     坞面板绝对定位占住让出来的那条空档（iframe 里是阅读器页面）。
 *  2. 拖动边界调宽 / 收起 / 记忆宽度。
 *  3. 把 DSH 主题色下发给 iframe。
 *  4. 把 iframe 发来的「转到对话」文本填进当前会话输入框。
 *
 * 本文件是普通 CJS 工厂（客户端模块加载器只保证 require('react') 可用），
 * 不用 JSX、不引第三方库。唯一依赖 DSH 内部 DOM 的代码集中在「布局适配」一节，
 * DSH 改版只需要改那一节。
 */
window.__ModuleLoader__.load({
  id: '@local/paper-reader',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'paper-reader'
    const APP_URL = '/dsh-paper-reader/app/?embed=1'
    const LS_WIDTH = 'dsh.paper-reader.width'
    const LS_OPEN = 'dsh.paper-reader.open'
    const DEFAULTS = {
      dockWidthRatio: 0.46,
      dockMinWidth: 720,
      dockMaxWidth: 1280,
      autoCollapseSidebar: true,
    }

    const DICTS = {
      zh: {
        open: '打开/收起文献阅读坞',
        collapse: '收起阅读坞',
        expand: '展开阅读坞',
        drag: '拖动调整宽度',
        floating: '布局适配失效：阅读坞以浮层模式打开（DSH 改版后需要修 client.js 的「布局适配」一节）',
        copyOnly: '已复制到剪贴板：先打开一个会话再粘贴',
        bridgeFail: '没能填进输入框，已复制到剪贴板',
      },
      en: {
        open: 'Toggle the paper reader dock',
        collapse: 'Collapse the dock',
        expand: 'Expand the dock',
        drag: 'Drag to resize',
        floating: 'Layout adapter unavailable: dock opened as a floating panel (fix the "layout adapter" block in client.js)',
        copyOnly: 'Copied to clipboard: open a session and paste it',
        bridgeFail: 'Could not fill the composer; copied to clipboard',
      },
    }

    const CSS = `
.pr-dock{position:absolute;left:0;top:0;bottom:0;display:flex;flex-direction:row;
  background:var(--dsw-alias-bg-base,#fff);z-index:21;
  border-right:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));
  box-shadow:2px 0 18px rgba(0,0,0,.06)}
.pr-dock[data-floating]{z-index:2147483000;box-shadow:0 10px 40px rgba(0,0,0,.28)}
.pr-dock-frame{flex:1;min-width:0;border:0;width:100%;height:100%;display:block;background:transparent}
.pr-rail{flex:0 0 20px;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:10px;border-left:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));
  color:var(--dsw-alias-label-secondary,#6b6b6b)}
.pr-rail-btn{border:0;background:transparent;color:inherit;cursor:pointer;border-radius:6px;
  width:16px;height:22px;display:flex;align-items:center;justify-content:center;font-size:11px;
  line-height:1;padding:0}
.pr-rail-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));
  color:var(--dsw-alias-label-primary,#1a1a1a)}
.pr-grip{position:absolute;right:-4px;top:0;bottom:0;width:9px;cursor:col-resize;z-index:4;
  touch-action:none;background:transparent}
.pr-grip:hover,.pr-grip[data-dragging]{background:var(--dsw-alias-brand-primary,#4d6bfe);opacity:.22}
.pr-warn{position:absolute;left:8px;right:28px;bottom:8px;z-index:5;padding:6px 8px;border-radius:8px;
  font-size:11px;line-height:1.4;color:var(--dsw-alias-label-primary,#1a1a1a);
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1))}
.pr-tool{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;
  border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#6b6b6b);
  cursor:pointer;padding:0}
.pr-tool:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));
  color:var(--dsw-alias-label-primary,#1a1a1a)}
.pr-tool[aria-pressed="true"]{color:var(--dsw-alias-brand-primary,#4d6bfe);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 12%,transparent)}
.pr-tool svg{display:block}
`

    /* ------------------------------------------------------------------ *
     * 极简全局状态（坞的开关 / 宽度 / 是否浮层模式）
     * ------------------------------------------------------------------ */
    // 注意：React 的 useSyncExternalStore 按 Object.is 比较快照引用，
    // 所以状态必须是不可变的——patch 每次产生新对象，否则订阅者不会重渲染。
    let state = { open: false, width: 0, floating: false, warn: null }
    const listeners = new Set()
    function readState() { return state }
    function subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } }
    function patch(next) {
      let changed = false
      for (const key of Object.keys(next)) {
        if (state[key] !== next[key]) { changed = true; break }
      }
      if (!changed) return
      state = Object.assign({}, state, next)
      for (const fn of listeners) fn()
    }

    function clampWidth(px, ratio) {
      const vw = window.innerWidth
      const min = DEFAULTS.dockMinWidth
      const max = Math.min(MAXW(), Math.round(vw * 0.62))
      const want = Number.isFinite(px) && px > 0 ? px : Math.round(vw * ratio)
      return Math.max(min, Math.min(max, Math.round(want)))
    }
    let MAXW = () => DEFAULTS.dockMaxWidth

    /** 唯一的开关写入口：状态与 localStorage 一起更新。 */
    function setOpen(open) {
      patch({ open })
      try { window.localStorage.setItem(LS_OPEN, open ? '1' : '0') } catch { /* 隐私模式 */ }
    }

    function loadPrefs() {
      let width = 0
      let open = false
      try {
        const w = Number(window.localStorage.getItem(LS_WIDTH))
        if (Number.isFinite(w) && w > 0) width = w
        open = window.localStorage.getItem(LS_OPEN) === '1'
      } catch { /* 隐私模式：用默认值 */ }
      return { width, open }
    }

    /* ------------------------------------------------------------------ *
     * 布局适配 —— 唯一依赖 DSH 内部 DOM 的地方。
     * AppFrame 是 CSS Grid，`[data-shell-overlay]` 是它内部 inset:0 的绝对定位层。
     * 给 frame 加 padding-left 后，网格列整体右移；overlay 层的 left:0 仍在 frame
     * 左缘，于是坞面板正好覆盖让出来的空档，不遮住聊天。
     * DSH 改版后若要修，只改这个函数。
     * ------------------------------------------------------------------ */
    function attachLayout(width) {
      const layer = document.querySelector('[data-shell-overlay]')
      const frame = layer && layer.parentElement
      if (!frame) return null
      const prevPadding = frame.style.paddingLeft
      let style = document.getElementById('pr-adapter-style')
      if (!style) {
        style = document.createElement('style')
        style.id = 'pr-adapter-style'
        // 左拖拽把手是相对 padding box 绝对定位的，会被 padding 顶到坞中央，
        // 坐标错位且会挡住论文，故开坞期间隐藏；关坞即恢复。
        style.textContent = '[data-side="sidebar"]{display:none!important}'
        document.head.append(style)
      }
      const apply = (w) => { frame.style.paddingLeft = w + 'px' }
      apply(width)
      let disposed = false
      return {
        setWidth(w) { if (!disposed) apply(w) },
        /** 侧栏是否已折叠（AppFrame 渲染的 data-sidebar-collapsed 属性） */
        sidebarCollapsed() { return frame.hasAttribute('data-sidebar-collapsed') },
        restore() {
          if (disposed) return
          disposed = true
          frame.style.paddingLeft = prevPadding
          const el = document.getElementById('pr-adapter-style')
          if (el) el.remove()
        },
      }
    }

    /* ------------------------------------------------------------------ *
     * 主题：DSH 把 token 以 inline CSS 变量写在 body 上，深色走 body[data-ds-dark-theme]。
     * ------------------------------------------------------------------ */
    function readTheme() {
      const body = document.body
      const cs = window.getComputedStyle(body)
      const pick = (name, fallback) => {
        const value = (cs.getPropertyValue(name) || '').trim()
        return value === '' ? fallback : value
      }
      return {
        mode: body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light',
        bg: pick('--dsw-alias-bg-base', '#ffffff'),
        fg: pick('--dsw-alias-label-primary', '#1a1a1a'),
        muted: pick('--dsw-alias-label-secondary', '#6b6b6b'),
        border: pick('--dsw-alias-border-l1', 'rgba(0,0,0,.1)'),
        brand: pick('--dsw-alias-brand-primary', '#4d6bfe'),
        hover: pick('--dsw-alias-bg-layer-2', 'rgba(0,0,0,.04)'),
      }
    }

    /** 把一段文本放进剪贴板，失败也不抛（回退用 textarea）。 */
    function copyText(text) {
      try {
        if (navigator.clipboard && window.isSecureContext) { void navigator.clipboard.writeText(text); return }
      } catch { /* 走下面的回退 */ }
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.append(ta)
        ta.select()
        document.execCommand('copy')
        ta.remove()
      } catch { /* 复制也失败就只能算了 */ }
    }

    /* ------------------------------------------------------------------ *
     * 组件：坞本体
     * ------------------------------------------------------------------ */
    function createDock(ctx) {
      return function PaperDock() {
        const snap = React.useSyncExternalStore(subscribe, readState)
        const t = React.useMemo(() => ctx.locale.bind(NS), [ctx])
        const dockRef = React.useRef(null)
        const iframeRef = React.useRef(null)
        const adapterRef = React.useRef(null)
        const widthRef = React.useRef(0)
        const collapsedByUs = React.useRef(false)
        const dragRef = React.useRef(null)

        const sendToApp = React.useCallback((msg) => {
          const frame = iframeRef.current
          if (!frame || !frame.contentWindow) return
          try { frame.contentWindow.postMessage(msg, window.location.origin) } catch { /* iframe 还没就绪 */ }
        }, [])

        const sendInit = React.useCallback(() => {
          sendToApp({ source: 'pr-host', type: 'init', theme: readTheme() })
        }, [sendToApp])

        // 打开/关闭：挂上或撤掉布局适配
        React.useEffect(() => {
          const dock = dockRef.current
          if (!snap.open) {
            if (adapterRef.current) { adapterRef.current.restore(); adapterRef.current = null }
            if (state.warn) patch({ warn: null })
            if (collapsedByUs.current) {
              collapsedByUs.current = false
              try { ctx.layout.toggleSidebar() } catch { /* 服务未就绪 */ }
            }
            return
          }
          const width = clampWidth(widthRef.current, DEFAULTS.dockWidthRatio)
          widthRef.current = width
          patch({ width })
          if (dock) dock.style.width = width + 'px'
          const adapter = attachLayout(width)
          adapterRef.current = adapter
          sendInit()
          if (!adapter) {
            patch({ floating: true, warn: '布局适配失效：阅读坞以浮层模式打开。DSH 改版后需要修 client.js 的「布局适配」一节。' })
            return
          }
          patch({ floating: false, warn: null })
          if (DEFAULTS.autoCollapseSidebar && !adapter.sidebarCollapsed()) {
            try { ctx.layout.toggleSidebar(); collapsedByUs.current = true } catch { /* ignore */ }
          }
          return () => {
            if (adapterRef.current) { adapterRef.current.restore(); adapterRef.current = null }
          }
        }, [snap.open])

        // 主题：init 时下发 + 监听 body 变化重发
        React.useEffect(() => {
          const observer = new MutationObserver(() => {
            if (snap.open) sendToApp({ source: 'pr-host', type: 'theme', theme: readTheme() })
          })
          observer.observe(document.body, { attributes: true, attributeFilter: ['style', 'data-ds-dark-theme', 'class'] })
          return () => observer.disconnect()
        }, [snap.open, sendToApp])

        // iframe 消息
        React.useEffect(() => {
          const onMessage = (event) => {
            if (event.origin !== window.location.origin) return
            const data = event.data
            if (!data || data.source !== 'pr-app') return
            if (data.type === 'ready' || data.type === 'ping') { sendInit(); return }
            if (data.type === 'toChat') { void handleToChat(ctx, data, t, sendToApp) }
          }
          window.addEventListener('message', onMessage)
          return () => window.removeEventListener('message', onMessage)
        }, [ctx, t, sendToApp])

        // 窗口变化：重新夹取宽度
        React.useEffect(() => {
          const onResize = () => {
            if (!snap.open) return
            const next = clampWidth(widthRef.current, DEFAULTS.dockWidthRatio)
            if (next === widthRef.current) return
            widthRef.current = next
            patch({ width: next })
            if (dockRef.current) dockRef.current.style.width = next + 'px'
            if (adapterRef.current) adapterRef.current.setWidth(next)
          }
          window.addEventListener('resize', onResize)
          return () => window.removeEventListener('resize', onResize)
        }, [snap.open])

        // 拖动边界
        const onGripDown = (event) => {
          if (event.button !== 0) return
          event.preventDefault()
          const startX = event.clientX
          const startWidth = widthRef.current
          dragRef.current = { startX, startWidth }
          event.currentTarget.setPointerCapture(event.pointerId)
          event.currentTarget.setAttribute('data-dragging', '')
        }
        const onGripMove = (event) => {
          const drag = dragRef.current
          if (!drag) return
          const next = clampWidth(drag.startWidth + (event.clientX - drag.startX), DEFAULTS.dockWidthRatio)
          widthRef.current = next
          if (dockRef.current) dockRef.current.style.width = next + 'px'
          if (adapterRef.current) adapterRef.current.setWidth(next)
        }
        const onGripUp = (event) => {
          if (!dragRef.current) return
          dragRef.current = null
          try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* 已释放 */ }
          event.currentTarget.removeAttribute('data-dragging')
          patch({ width: widthRef.current })
          try { window.localStorage.setItem(LS_WIDTH, String(widthRef.current)) } catch { /* ignore */ }
        }

        const close = () => setOpen(false)

        return h('div', {
          ref: dockRef,
          className: 'pr-dock',
          style: { display: snap.open ? 'flex' : 'none' },
          'data-floating': snap.floating ? '' : undefined,
        },
          h('iframe', {
            ref: iframeRef,
            className: 'pr-dock-frame',
            src: APP_URL,
            title: '文献阅读坞',
            onLoad: sendInit,
          }),
          h('div', { className: 'pr-rail' },
            h('button', {
              className: 'pr-rail-btn',
              type: 'button',
              title: t('collapse'),
              'aria-label': t('collapse'),
              onClick: close,
            }, '»'),
          ),
          h('div', {
            className: 'pr-grip',
            title: t('drag'),
            onPointerDown: onGripDown,
            onPointerMove: onGripMove,
            onPointerUp: onGripUp,
            onPointerCancel: onGripUp,
          }),
          snap.warn ? h('div', { className: 'pr-warn' }, snap.warn) : null,
        )
      }
    }

    /** 「转到对话」：把 iframe 给的文本填进当前会话输入框。 */
    async function handleToChat(ctx, data, t, sendToApp) {
      const payload = typeof data.payload === 'string' ? data.payload : ''
      const mode = data.mode === 'send' ? 'send' : 'draft'
      const ack = (ok, reason) => sendToApp({ source: 'pr-host', type: 'chat-ack', ok, mode, reason })
      if (payload === '') { ack(false, 'empty'); return }
      try {
        const sessions = ctx.sessions
        const current = sessions && sessions.list ? sessions.list.getSnapshot().current : undefined
        if (!current) { copyText(payload); ack(false, 'no-session'); return }
        const actx = sessions.scope(current)
        if (!actx) { copyText(payload); ack(false, 'no-session'); return }
        const input = ctx.conversation.input.for(actx)
        input.setDraft(payload)
        if (mode === 'send') input.submit()
        ack(true)
      } catch (error) {
        copyText(payload)
        ack(false, 'bridge-failed')
      }
    }

    /* ------------------------------------------------------------------ *
     * 组件：输入框工具行里的入口按钮（会话作用域）
     * ------------------------------------------------------------------ */
    function createToolButton(ctx) {
      return function PaperToolButton() {
        const snap = React.useSyncExternalStore(subscribe, readState)
        const t = React.useMemo(() => ctx.locale.bind(NS), [ctx])
        const toggle = () => setOpen(!snap.open)
        return h('button', {
          type: 'button',
          className: 'pr-tool',
          title: t('open'),
          'aria-label': t('open'),
          'aria-pressed': snap.open ? 'true' : 'false',
          onClick: toggle,
        }, h('svg', { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
          h('path', { d: 'M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z' }),
          h('path', { d: 'M14 3v4h4' }),
          h('path', { d: 'M9 12h6M9 16h6' }),
        ))
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx, config) {
        const cfg = Object.assign({}, DEFAULTS, config || {})
        MAXW = () => cfg.dockMaxWidth
        DEFAULTS.dockWidthRatio = Number(cfg.dockWidthRatio) || DEFAULTS.dockWidthRatio
        DEFAULTS.dockMinWidth = Number(cfg.dockMinWidth) || DEFAULTS.dockMinWidth
        DEFAULTS.dockMaxWidth = Number(cfg.dockMaxWidth) || DEFAULTS.dockMaxWidth
        DEFAULTS.autoCollapseSidebar = cfg.autoCollapseSidebar !== false

        const prefs = loadPrefs()
        state = Object.assign({}, state, {
          width: clampWidth(prefs.width, DEFAULTS.dockWidthRatio),
          open: prefs.open,
        })

        ctx.effect(() => {
          const style = document.createElement('style')
          style.id = 'paper-reader-shell-style'
          style.textContent = CSS
          document.head.append(style)
          return () => style.remove()
        })

        for (const [id, dict] of Object.entries(DICTS)) {
          ctx.effect(() => ctx.locale.register(NS, id, dict))
        }

        const Dock = createDock(ctx)
        const ToolButton = createToolButton(ctx)

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'paper-reader/dock', order: 40 }, Dock))

        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register({ name: 'conversation.input.left', id: 'paper-reader/button', order: 40 }, ToolButton))
      },
    }
  },
})
