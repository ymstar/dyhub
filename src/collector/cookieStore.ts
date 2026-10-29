/**
 * 运行时 Cookie 存储 —— 两种采集内核共用的登录态注入点
 *
 * 用户可在 Dashboard（POST /api/cookie）或启动时（DYHUB_COOKIE 环境变量）设置 cookie。
 * 轻量内核将其拼入 wss 握手头与 HTTP 请求；浏览器内核将其注入 BrowserContext。
 * 含 sessionid_ss / sid_tt 等登录 cookie 时，webcast 服务端会推送礼物事件。
 *
 * 持久化：网页登录成功后，cookie 写入 data/cookie.json，Docker 重新部署后自动恢复，
 * 直到 cookie 过期或用户手动清除。支持从 Cookie 请求头（k=v; k=v）和 Set-Cookie 响应头
 * （含 Expires/Max-Age 属性）两种格式解析过期时间。
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 判定登录态的 cookie 键名 */
const LOGIN_KEYS = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard'];

/** Set-Cookie 属性名，不作为 cookie 键 */
const COOKIE_ATTRS = new Set(['expires', 'max-age', 'path', 'domain', 'secure', 'httponly', 'samesite']);

/** 持久化文件路径（相对 cwd；Docker 中 cwd=/app，挂载 data/ 卷即可持久化） */
const DATA_DIR = join(process.cwd(), 'data');
const COOKIE_FILE = join(DATA_DIR, 'cookie.json');
/** 每房间 cookie 持久化目录 */
const ROOM_COOKIE_DIR = join(DATA_DIR, 'room-cookies');

let store = new Map<string, string>();
/** 最早过期时间（ms 时间戳），null 表示未知 */
let expiresAt: number | null = null;
/** 持久化保存时间（ms 时间戳），null 表示未持久化 */
let savedAt: number | null = null;
/** 是否已从文件加载（用于区分"文件 cookie"与"环境变量 cookie"） */
let persisted = false;

// ---- 每房间独立 cookie 存储 ----
interface RoomCookieEntry {
  store: Map<string, string>;
  expiresAt: number | null;
  savedAt: number | null;
}
const roomStores = new Map<string, RoomCookieEntry>();

/** 从 "k=v; k=v" 或 Set-Cookie 响应头解析 cookie 键值对与过期时间 */
function parseCookieStr(str: string): { store: Map<string, string>; expiresAt: number | null } {
  const store = new Map<string, string>();
  let earliestExpires: number | null = null;

  const lines = str.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    // 去除 "Set-Cookie:" 前缀（用户可能从响应头复制）
    const cookieLine = line.replace(/^set-cookie:\s*/i, '');
    const parts = cookieLine.split(';');
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue; // 无值属性如 Secure / HttpOnly
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      const lowerKey = key.toLowerCase();
      if (COOKIE_ATTRS.has(lowerKey)) {
        // Cookie 属性 —— 提取过期时间
        if (lowerKey === 'expires') {
          const ts = Date.parse(value);
          if (!isNaN(ts) && (earliestExpires === null || ts < earliestExpires)) earliestExpires = ts;
        } else if (lowerKey === 'max-age') {
          const secs = parseInt(value, 10);
          if (!isNaN(secs) && secs >= 0) {
            const ts = Date.now() + secs * 1000;
            if (earliestExpires === null || ts < earliestExpires) earliestExpires = ts;
          }
        }
      } else if (key) {
        // Cookie 键值对
        store.set(key, value);
      }
    }
  }
  return { store, expiresAt: earliestExpires };
}

/** 从磁盘加载持久化 cookie（启动时调用） */
function loadFromDisk(): void {
  try {
    if (!existsSync(COOKIE_FILE)) return;
    const raw = readFileSync(COOKIE_FILE, 'utf8');
    const data = JSON.parse(raw) as { cookie?: string; expiresAt?: number | null; savedAt?: number };
    if (!data.cookie || !data.cookie.trim()) return;
    // 已过期则不加载
    if (data.expiresAt && data.expiresAt < Date.now()) {
      console.log('[dyhub] 持久化 cookie 已过期，跳过加载');
      // 清理过期文件
      try { unlinkSync(COOKIE_FILE); } catch { /* noop */ }
      return;
    }
    const { store: parsed } = parseCookieStr(data.cookie);
    if (parsed.size === 0) return;
    store = parsed;
    expiresAt = data.expiresAt ?? null;
    savedAt = data.savedAt ?? null;
    persisted = true;
    console.log('[dyhub] 已从 data/cookie.json 恢复 cookie');
  } catch (e) {
    console.warn('[dyhub] 加载持久化 cookie 失败:', (e as Error).message);
  }
}

/** 将 cookie 写入磁盘 */
function saveToDisk(cookieStr: string, exp: number | null): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const now = Date.now();
    writeFileSync(COOKIE_FILE, JSON.stringify({ cookie: cookieStr, expiresAt: exp, savedAt: now }, null, 2));
    savedAt = now;
    persisted = true;
  } catch (e) {
    console.warn('[dyhub] 持久化 cookie 失败:', (e as Error).message);
  }
}

/** 删除磁盘上的 cookie 文件 */
function deleteFromDisk(): void {
  try {
    if (existsSync(COOKIE_FILE)) unlinkSync(COOKIE_FILE);
  } catch { /* noop */ }
}

// 启动时初始化：环境变量优先，其次磁盘文件
const envCookie = process.env.DYHUB_COOKIE;
if (envCookie) {
  const { store: parsed, expiresAt: exp } = parseCookieStr(envCookie);
  store = parsed;
  expiresAt = exp;
} else {
  loadFromDisk();
}

/**
 * 设置 cookie（覆盖）并写入磁盘。
 * expiresAt 用于调用方已知过期时间的场景（如扫码登录从浏览器读到的 cookie）。
 */
export function setCookie(str: string, opts?: { expiresAt?: number | null }): void {
  const { store: parsed, expiresAt: parsedExp } = parseCookieStr(str);
  const exp = opts?.expiresAt ?? parsedExp;
  store = parsed;
  expiresAt = exp;
  saveToDisk(str, exp);
}

/** 清空 cookie（同时删除磁盘文件） */
export function clear(): void {
  store = new Map();
  expiresAt = null;
  savedAt = null;
  persisted = false;
  deleteFromDisk();
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
export function getStatus(): {
  set: boolean;
  hasLogin: boolean;
  keys: string[];
  expiresAt: number | null;
  savedAt: number | null;
  persisted: boolean;
} {
  return {
    set: store.size > 0,
    hasLogin: hasLoginCookie(),
    keys: [...store.keys()],
    expiresAt,
    savedAt,
    persisted,
  };
}

// ==================== 每房间独立 Cookie ====================

/** 从磁盘加载所有房间的持久化 cookie（启动时调用） */
function loadRoomCookiesFromDisk(): void {
  try {
    if (!existsSync(ROOM_COOKIE_DIR)) return;
    for (const file of readdirSync(ROOM_COOKIE_DIR)) {
      if (!file.endsWith('.json')) continue;
      const roomId = file.slice(0, -5);
      try {
        const raw = readFileSync(join(ROOM_COOKIE_DIR, file), 'utf8');
        const data = JSON.parse(raw) as { cookie?: string; expiresAt?: number | null; savedAt?: number };
        if (!data.cookie || !data.cookie.trim()) continue;
        if (data.expiresAt && data.expiresAt < Date.now()) {
          try { unlinkSync(join(ROOM_COOKIE_DIR, file)); } catch { /* noop */ }
          continue;
        }
        const { store: parsed } = parseCookieStr(data.cookie);
        if (parsed.size === 0) continue;
        roomStores.set(roomId, {
          store: parsed,
          expiresAt: data.expiresAt ?? null,
          savedAt: data.savedAt ?? null,
        });
      } catch { /* skip bad file */ }
    }
    if (roomStores.size) console.log(`[dyhub] 已从 data/room-cookies/ 恢复 ${roomStores.size} 个房间的 cookie`);
  } catch { /* noop */ }
}

/** 将某房间 cookie 写入磁盘 */
function saveRoomCookieToDisk(roomId: string, cookieStr: string, exp: number | null): void {
  try {
    mkdirSync(ROOM_COOKIE_DIR, { recursive: true });
    writeFileSync(join(ROOM_COOKIE_DIR, `${roomId}.json`), JSON.stringify({ cookie: cookieStr, expiresAt: exp, savedAt: Date.now() }, null, 2));
  } catch (e) {
    console.warn(`[dyhub] 持久化房间 ${roomId} cookie 失败:`, (e as Error).message);
  }
}

/** 删除某房间的磁盘 cookie 文件 */
function deleteRoomCookieFromDisk(roomId: string): void {
  try {
    const f = join(ROOM_COOKIE_DIR, `${roomId}.json`);
    if (existsSync(f)) unlinkSync(f);
  } catch { /* noop */ }
}

// 启动时加载房间 cookie（仅当未通过环境变量设置全局 cookie 时，房间 cookie 仍独立加载）
loadRoomCookiesFromDisk();

/** 设置某房间的独立 cookie（覆盖） */
export function setRoomCookie(roomId: string, str: string): void {
  const { store: parsed, expiresAt: exp } = parseCookieStr(str);
  roomStores.set(roomId, { store: parsed, expiresAt: exp, savedAt: Date.now() });
  saveRoomCookieToDisk(roomId, str, exp);
}

/** 某房间的完整 cookie 字符串（无则返回空串） */
export function getRoomCookieStr(roomId: string): string {
  const entry = roomStores.get(roomId);
  if (!entry) return '';
  return [...entry.store].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** 某房间的 cookie 键值 Map（无则返回空 Map） */
export function getRoomCookieMap(roomId: string): Map<string, string> {
  const entry = roomStores.get(roomId);
  if (!entry) return new Map();
  return new Map(entry.store);
}

/** 清除某房间的独立 cookie */
export function clearRoomCookie(roomId: string): void {
  roomStores.delete(roomId);
  deleteRoomCookieFromDisk(roomId);
}

/** 某房间是否设置了独立 cookie */
export function hasRoomCookie(roomId: string): boolean {
  return roomStores.has(roomId);
}

/** 某房间的独立 cookie 是否包含登录态 */
export function hasRoomLoginCookie(roomId: string): boolean {
  const entry = roomStores.get(roomId);
  if (!entry) return false;
  return LOGIN_KEYS.some((k) => entry.store.has(k));
}

/** 某房间 cookie 状态摘要 */
export function getRoomCookieStatus(roomId: string): {
  set: boolean;
  hasLogin: boolean;
  keys: string[];
  expiresAt: number | null;
} {
  const entry = roomStores.get(roomId);
  if (!entry) return { set: false, hasLogin: false, keys: [], expiresAt: null };
  return {
    set: entry.store.size > 0,
    hasLogin: LOGIN_KEYS.some((k) => entry.store.has(k)),
    keys: [...entry.store.keys()],
    expiresAt: entry.expiresAt,
  };
}

/** 列出所有设置了独立 cookie 的房间 ID */
export function listRoomCookies(): string[] {
  return [...roomStores.keys()];
}
