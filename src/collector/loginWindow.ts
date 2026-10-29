/**
 * 网页登录 —— 弹出真实的 Chrome 窗口打开抖音，由用户在抖音页面里完成登录
 *
 * 扫码、短信验证码、滑块等都由抖音页面自己处理，我们只轮询浏览器 cookie：
 * 出现 sessionid_ss 等登录 cookie 即存入 cookieStore 并关闭窗口。
 *
 * 浏览器资料保存在 data/login-profile/（与 data/cookie.json 一样不入库）。
 * 每次打开窗口前会清空其中的 cookie，确保总是重新登录（可切换账号）。
 * 需要图形界面：Docker / 无显示器的服务器上请改用 DYHUB_COOKIE 环境变量。
 */

import { chromium, type BrowserContext } from 'playwright-core';
import { join } from 'node:path';
import { DEFAULT_USER_AGENT, findChrome } from './browser.js';
import * as cookieStore from './cookieStore.js';

export type LoginStatus =
  | 'idle' //     未开始 / 已取消
  | 'opening' //  正在打开浏览器窗口
  | 'waiting' //  窗口已打开，等待用户登录
  | 'success' //  登录成功，cookie 已保存
  | 'expired' //  等待超时
  | 'error'; //   失败

export interface LoginState {
  status: LoginStatus;
  /** 给用户看的说明 / 错误信息 */
  message?: string;
  updatedAt: number;
}

const PROFILE_DIR = join(process.cwd(), 'data', 'login-profile');
/** 等待用户完成登录的最长时间（含短信验证） */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** 检查登录 cookie 的间隔 */
const POLL_MS = 1500;
/** 抖音写入以下任一 cookie 即视为登录成功 */
const LOGIN_COOKIES = ['sessionid_ss', 'sessionid'];

let state: LoginState = { status: 'idle', updatedAt: Date.now() };
let context: BrowserContext | null = null;
/** 每次 start 递增；旧会话的异步回调发现编号变了就不再改状态 */
let generation = 0;

function setState(status: LoginStatus, message?: string): void {
  state = { status, message, updatedAt: Date.now() };
}

export function getState(): LoginState {
  return state;
}

const isActive = () => state.status === 'opening' || state.status === 'waiting';

/** 关闭当前会话的窗口（仅当仍是同一次会话） */
async function closeWindow(gen: number): Promise<void> {
  if (gen !== generation) return;
  generation += 1;
  const ctx = context;
  context = null;
  try {
    await ctx?.close();
  } catch {
    /* 已关闭 */
  }
}

/** 取消登录并关闭窗口。不改动已保存的 cookie。 */
export async function cancel(): Promise<void> {
  if (isActive()) setState('idle');
  await closeWindow(generation);
}

/** 打开登录窗口，窗口出现后返回；之后在后台等待登录完成，用 getState() 轮询。 */
export async function start(): Promise<LoginState> {
  await cancel();
  const gen = ++generation;
  const alive = () => gen === generation;
  setState('opening', '正在打开抖音登录窗口…');

  const executablePath = process.env.DYHUB_CHROME || findChrome();
  if (!executablePath) {
    setState('error', '未找到 Chrome，可通过 DYHUB_CHROME 指定路径');
    return state;
  }

  try {
    const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      executablePath,
      headless: false,
      viewport: null,
      userAgent: DEFAULT_USER_AGENT,
      locale: 'zh-CN',
      args: ['--disable-blink-features=AutomationControlled', '--window-size=1200,860'],
    });
    if (!alive()) {
      await ctx.close();
      return state;
    }
    context = ctx;
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    // 清掉资料目录里上次的登录态，否则会直接沿用旧账号、窗口一闪而过，无法换号
    await ctx.clearCookies();

    // 用户直接关掉窗口 = 取消
    ctx.on('close', () => {
      if (gen === generation && isActive()) {
        generation += 1;
        context = null;
        setState('idle', '登录窗口已关闭');
      }
    });

    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (!alive()) return state;
    await page.bringToFront();
    setState('waiting', '请在弹出的窗口中登录抖音（扫码 / 验证码均可），完成后窗口会自动关闭');

    void waitForLogin(gen);
    return state;
  } catch (e) {
    if (alive()) {
      const msg = (e as Error).message;
      const noDisplay = /display|headed|XServer/i.test(msg);
      setState(
        'error',
        noDisplay
          ? '当前环境没有图形界面，无法弹出登录窗口，请改用粘贴 cookie'
          : `打开登录窗口失败：${msg}`,
      );
      await closeWindow(gen);
    }
    return state;
  }
}

/** 轮询浏览器 cookie，出现登录 cookie 即保存并关闭窗口；超时则标记过期 */
async function waitForLogin(gen: number): Promise<void> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (gen === generation && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const ctx = context;
    if (gen !== generation || !ctx) return;
    let cookies;
    try {
      cookies = await ctx.cookies('https://www.douyin.com');
    } catch {
      return; // 窗口已关闭
    }
    if (!cookies.some((c) => LOGIN_COOKIES.includes(c.name) && c.value)) continue;

    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    // 以登录 cookie 中最早的过期时间为准（Playwright 的 expires 单位是秒，-1 表示会话 cookie）
    const expiries = cookies
      .filter((c) => LOGIN_COOKIES.includes(c.name) && c.expires > 0)
      .map((c) => c.expires * 1000);
    cookieStore.setCookie(cookieStr, {
      expiresAt: expiries.length ? Math.min(...expiries) : null,
    });
    setState('success', '登录成功，cookie 已保存');
    console.log('[dyhub] 网页登录成功，已更新 cookie');
    await closeWindow(gen);
    return;
  }
  if (gen === generation && isActive()) {
    setState('expired', '等待登录超时，请重新打开登录窗口');
    await closeWindow(gen);
  }
}
