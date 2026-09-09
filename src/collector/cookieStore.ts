/**
 * 运行时 Cookie 存储 —— 两种采集内核共用的登录态注入点
 *
 * 用户可在 Dashboard（POST /api/cookie）或启动时（DYHUB_COOKIE 环境变量）设置 cookie。
 * 轻量内核将其拼入 wss 握手头与 HTTP 请求；浏览器内核将其注入 BrowserContext。
 * 含 sessionid_ss / sid_tt 等登录 cookie 时，webcast 服务端会推送礼物事件。
 */

/** 判定登录态的 cookie 键名 */
const LOGIN_KEYS = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard'];

let store = new Map<string, string>();

/** 从 "k=v; k=v" 字符串解析为 Map */
function parseCookieStr(str: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of str.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (k) m.set(k, v);
    }
  }
  return m;
}

// 启动时从环境变量初始化
const envCookie = process.env.DYHUB_COOKIE;
if (envCookie) {
  store = parseCookieStr(envCookie);
}

/** 设置 cookie（覆盖） */
export function setCookie(str: string): void {
  store = parseCookieStr(str);
}

/** 清空 cookie */
export function clear(): void {
  store = new Map();
}

/** 完整 cookie 字符串，用于 HTTP / wss Cookie 头 */
export function getCookieStr(): string {
  return [...store].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** cookie 键值 Map，供浏览器内核逐条注入 */
export function getCookieMap(): Map<string, string> {
  return new Map(store);
}

/** 是否已设置 cookie */
export function isSet(): boolean {
  return store.size > 0;
}

/** 是否包含登录态 cookie */
export function hasLoginCookie(): boolean {
  return LOGIN_KEYS.some((k) => store.has(k));
}

/** 状态摘要（不暴露 cookie 值） */
export function getStatus(): { set: boolean; hasLogin: boolean; keys: string[] } {
  return {
    set: store.size > 0,
    hasLogin: hasLoginCookie(),
    keys: [...store.keys()],
  };
}
