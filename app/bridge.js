/**
 * bridge.js — 阅读器（iframe）与 DSH 薄壳之间的 postMessage 桥。
 *
 * 契约（CONTRACT.md §3）：
 *   阅读器 → 宿主：{source:'pr-app', type:'ready'|'toChat'|'height'}
 *   宿主 → 阅读器：{source:'pr-host', type:'init'|'theme'|'chat-ack'|'ping'}
 * 所有消息都带 source 字段；发送端用 window.parent。
 *
 * 独立打开（window.parent === window，例如浏览器直接访问 /app/）时：
 *   - post / toChat 返回 false，由上层禁用「转到对话」；
 *   - 仍然接受同源页面发来的 pr-host 消息（便于本地自测主题）。
 */

export const SOURCE_APP = 'pr-app';
export const SOURCE_HOST = 'pr-host';

/** 是否嵌在 DSH 里（iframe 内）。 */
export const embedded = typeof window !== 'undefined' && window.parent !== window;

const THEME_VARS = {
  bg: '--pr-bg',
  fg: '--pr-fg',
  muted: '--pr-muted',
  border: '--pr-border',
  brand: '--pr-brand',
  hover: '--pr-hover',
};

let handlers = {
  onTheme: null,
  onChatAck: null,
  onPing: null,
};

/** 向宿主薄壳发一条消息；不在 iframe 内时返回 false。 */
export function post(type, data) {
  if (!embedded) return false;
  try {
    window.parent.postMessage({ source: SOURCE_APP, type, ...(data || {}) }, location.origin);
    return true;
  } catch (err) {
    console.warn('[paper-reader] postMessage 失败', type, err);
    return false;
  }
}

/** iframe 启动后通知宿主：请求主题与状态。 */
export function postReady() {
  return post('ready');
}

/** 通知宿主坞的开合状态。 */
export function notifyHeight(opened) {
  return post('height', { opened: !!opened });
}

/** 把完整中文文本转到 DSH 对话（mode: 'draft' | 'send'）。 */
export function toChat(payload, mode = 'draft') {
  return post('toChat', { payload, mode });
}

/** 把宿主下发的主题写到 :root 的 --pr-* 变量上。 */
export function applyTheme(theme) {
  if (typeof document === 'undefined' || !theme) return;
  const root = document.documentElement;
  for (const [key, cssVar] of Object.entries(THEME_VARS)) {
    if (typeof theme[key] === 'string' && theme[key]) root.style.setProperty(cssVar, theme[key]);
  }
  if (theme.mode === 'dark' || theme.mode === 'light') root.dataset.theme = theme.mode;
}

/** 清掉内联主题变量，回到 CSS 里的默认 / prefers-color-scheme。 */
export function resetTheme() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const cssVar of Object.values(THEME_VARS)) root.style.removeProperty(cssVar);
  delete root.dataset.theme;
}

function onMessage(event) {
  // 同源校验：消息必须来自本页面所在 origin。
  if (event.origin && event.origin !== location.origin) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.source !== SOURCE_HOST) return;

  switch (data.type) {
    case 'init':
    case 'theme':
      if (data.theme) applyTheme(data.theme);
      if (handlers.onTheme) handlers.onTheme(data.theme || null, data.type);
      break;
    case 'chat-ack':
      if (handlers.onChatAck) handlers.onChatAck(data);
      break;
    case 'ping':
      // 薄壳探活：回 'ready'
      postReady();
      if (handlers.onPing) handlers.onPing();
      break;
    default:
      break;
  }
}

/** 注册宿主消息处理函数（可多次调用，合并配置）。 */
export function initBridge(nextHandlers) {
  handlers = { ...handlers, ...(nextHandlers || {}) };
  if (typeof window === 'undefined') return;
  window.addEventListener('message', onMessage);
}
