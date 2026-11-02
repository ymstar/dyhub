/**
 * 账号存储 —— 多账号管理的核心
 *
 * 每个账号 = 一个抖音登录态（cookie）+ 元信息。账号间互相隔离：
 *  - 浏览器内核：每个账号的每个房间创建独立 BrowserContext
 *  - 轻量内核：每个账号维护独立 cookie jar
 *
 * 房间与账号绑定：连接房间时指定 accountId，该房间使用此账号的 cookie。
 * roomId 全局唯一：同一房间不能被多个账号同时订阅（避免多账号竞争同一直播间）。
 *
 * 迁移：启动时把旧 cookieStore 的全局 cookie（data/cookie.json）和
 * 每房间 cookie（data/room-cookies/*.json）导入为账号，旧文件备份为 .bak。
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(process.cwd(), 'data');
const ACCOUNT_DIR = join(DATA_DIR, 'accounts');
const LEGACY_COOKIE_FILE = join(DATA_DIR, 'cookie.json');
const LEGACY_ROOM_COOKIE_DIR = join(DATA_DIR, 'room-cookies');

// ---- cookie 解析工具（自包含，避免依赖 cookieStore）----

/** 判定登录态的 cookie 键名 */
const LOGIN_KEYS = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard'];

/** Set-Cookie 属性名，不作为 cookie 键 */
const COOKIE_ATTRS = new Set(['expires', 'max-age', 'path', 'domain', 'secure', 'httponly', 'samesite']);

/** 从 "k=v; k=v" 或 Set-Cookie 响应头解析 cookie 键值对与过期时间 */
function parseCookieStr(str: string): { store: Map<string, string>; expiresAt: number | null } {
  const store = new Map<string, string>();
  let earliestExpires: number | null = null;

  const lines = str.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const cookieLine = line.replace(/^set-cookie:\s*/i, '');
    const parts = cookieLine.split(';');
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      const lowerKey = key.toLowerCase();
      if (COOKIE_ATTRS.has(lowerKey)) {
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
        store.set(key, value);
      }
    }
  }
  return { store, expiresAt: earliestExpires };
}

// ---- 账号数据模型 ----

export interface Account {
  id: string;
  name: string;
  cookie: string;
  cookieExpiresAt: number | null;
  createdAt: number;
}

export interface AccountStatus {
  id: string;
  name: string;
  hasCookie: boolean;
  hasLogin: boolean;
  keys: string[];
  cookieExpiresAt: number | null;
  createdAt: number;
}

// ---- 内存存储 ----

const accounts = new Map<string, Account>();

// ---- 磁盘读写 ----

function accountFile(id: string): string {
  return join(ACCOUNT_DIR, `${id}.json`);
}

function loadAccountFromDisk(id: string): Account | null {
  try {
    if (!existsSync(accountFile(id))) return null;
    const raw = readFileSync(accountFile(id), 'utf8');
    const data = JSON.parse(raw) as Account;
    if (!data.id || !data.name) return null;
    return data;
  } catch {
    return null;
  }
}

function saveAccountToDisk(acc: Account): void {
  try {
    mkdirSync(ACCOUNT_DIR, { recursive: true });
    writeFileSync(accountFile(acc.id), JSON.stringify(acc, null, 2));
  } catch (e) {
    console.warn(`[dyhub] 持久化账号 ${acc.id} 失败:`, (e as Error).message);
  }
}

function deleteAccountFromDisk(id: string): void {
  try {
    if (existsSync(accountFile(id))) unlinkSync(accountFile(id));
  } catch {
    /* noop */
  }
}

// ---- 启动时加载所有账号 ----

function loadAllFromDisk(): void {
  try {
    if (!existsSync(ACCOUNT_DIR)) return;
    for (const file of readdirSync(ACCOUNT_DIR)) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -5);
      const acc = loadAccountFromDisk(id);
      if (acc) accounts.set(id, acc);
    }
    if (accounts.size) console.log(`[dyhub] 已从 data/accounts/ 恢复 ${accounts.size} 个账号`);
  } catch {
    /* noop */
  }
}

// ---- 迁移：从旧 cookieStore 导入 ----

function migrateFromLegacy(): void {
  if (accounts.size > 0) return; // 已有账号，不迁移

  let migrated = 0;

  // 1. 全局 cookie → 默认账号
  try {
    if (existsSync(LEGACY_COOKIE_FILE)) {
      const raw = readFileSync(LEGACY_COOKIE_FILE, 'utf8');
      const data = JSON.parse(raw) as { cookie?: string; expiresAt?: number | null; savedAt?: number };
      if (data.cookie && data.cookie.trim()) {
        const acc = createAccount('默认');
        setAccountCookie(acc.id, data.cookie, data.expiresAt ?? null);
        migrated++;
      }
      renameSync(LEGACY_COOKIE_FILE, LEGACY_COOKIE_FILE + '.bak');
    }
  } catch (e) {
    console.warn('[dyhub] 迁移全局 cookie 失败:', (e as Error).message);
  }

  // 2. 每房间 cookie → 独立账号（名字用房间号）
  try {
    if (existsSync(LEGACY_ROOM_COOKIE_DIR)) {
      for (const file of readdirSync(LEGACY_ROOM_COOKIE_DIR)) {
        if (!file.endsWith('.json')) continue;
        const roomId = file.slice(0, -5);
        try {
          const raw = readFileSync(join(LEGACY_ROOM_COOKIE_DIR, file), 'utf8');
          const data = JSON.parse(raw) as { cookie?: string; expiresAt?: number | null; savedAt?: number };
          if (!data.cookie || !data.cookie.trim()) continue;
          const acc = createAccount(`房间 ${roomId}`);
          setAccountCookie(acc.id, data.cookie, data.expiresAt ?? null);
          migrated++;
        } catch {
          /* skip bad file */
        }
      }
      renameSync(LEGACY_ROOM_COOKIE_DIR, LEGACY_ROOM_COOKIE_DIR + '.bak');
    }
  } catch (e) {
    console.warn('[dyhub] 迁移房间 cookie 失败:', (e as Error).message);
  }

  if (migrated > 0) console.log(`[dyhub] 已从旧 cookie 数据迁移 ${migrated} 个账号`);
}

// ---- 账号 CRUD ----

function genId(): string {
  return `acc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export function createAccount(name: string): Account {
  const id = genId();
  const acc: Account = { id, name: name.trim() || '未命名', cookie: '', cookieExpiresAt: null, createdAt: Date.now() };
  accounts.set(id, acc);
  saveAccountToDisk(acc);
  return acc;
}

export function getAccount(id: string): Account | null {
  return accounts.get(id) ?? null;
}

export function deleteAccount(id: string): void {
  accounts.delete(id);
  deleteAccountFromDisk(id);
}

export function listAccounts(): Account[] {
  return [...accounts.values()];
}

/** 默认账号：优先名为"默认"的，否则第一个 */
export function getDefaultAccountId(): string | null {
  const def = [...accounts.values()].find((a) => a.name === '默认');
  return (def ?? [...accounts.values()][0])?.id ?? null;
}

// ---- Cookie 管理 ----

export function setAccountCookie(id: string, cookieStr: string, expiresAt?: number | null): void {
  const acc = accounts.get(id);
  if (!acc) return;
  const { expiresAt: parsedExp } = parseCookieStr(cookieStr);
  acc.cookie = cookieStr;
  acc.cookieExpiresAt = expiresAt ?? parsedExp;
  saveAccountToDisk(acc);
}

export function clearAccountCookie(id: string): void {
  const acc = accounts.get(id);
  if (!acc) return;
  acc.cookie = '';
  acc.cookieExpiresAt = null;
  saveAccountToDisk(acc);
}

export function getAccountCookieStr(id: string): string {
  return accounts.get(id)?.cookie ?? '';
}

export function getAccountCookieMap(id: string): Map<string, string> {
  const acc = accounts.get(id);
  if (!acc || !acc.cookie) return new Map();
  return parseCookieStr(acc.cookie).store;
}

export function hasAccountCookie(id: string): boolean {
  return (accounts.get(id)?.cookie ?? '').trim() !== '';
}

export function hasAccountLoginCookie(id: string): boolean {
  const acc = accounts.get(id);
  if (!acc || !acc.cookie) return false;
  return LOGIN_KEYS.some((k) => parseCookieStr(acc.cookie).store.has(k));
}

export function getAccountStatus(id: string): AccountStatus {
  const acc = accounts.get(id);
  if (!acc) {
    return { id, name: '', hasCookie: false, hasLogin: false, keys: [], cookieExpiresAt: null, createdAt: 0 };
  }
  const parsed = parseCookieStr(acc.cookie);
  return {
    id: acc.id,
    name: acc.name,
    hasCookie: parsed.store.size > 0,
    hasLogin: LOGIN_KEYS.some((k) => parsed.store.has(k)),
    keys: [...parsed.store.keys()],
    cookieExpiresAt: acc.cookieExpiresAt,
    createdAt: acc.createdAt,
  };
}

/** 状态摘要列表（不暴露 cookie 值） */
export function listAccountStatuses(): AccountStatus[] {
  return [...accounts.values()].map((a) => getAccountStatus(a.id));
}

// ---- 启动 ----

loadAllFromDisk();
migrateFromLegacy();

/** DYHUB_COOKIE 环境变量优先：更新默认账号的 cookie（覆盖磁盘值，与旧 cookieStore 行为一致） */
function applyEnvCookie(): void {
  const envCookie = process.env.DYHUB_COOKIE;
  if (!envCookie || !envCookie.trim()) return;
  let id = getDefaultAccountId();
  if (!id) id = createAccount('默认').id;
  setAccountCookie(id, envCookie, null);
  console.log('[dyhub] 已应用 DYHUB_COOKIE 环境变量到默认账号');
}
applyEnvCookie();
