/**
 * 直播间主播信息解析
 *
 * 直播间 HTML 的内联数据以 HTML 实体转义（&quot; / &amp;）形式嵌入，直接正则搜不到；
 * 先做实体还原，再从 anchorInfo / roomInfo 块中提取主播昵称、头像与直播标题。
 * 仅供展示，取不到时返回 null，不影响采集主链路。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';

export interface RoomMeta {
  /** 主播账号名 */
  nickname: string;
  /** 主播头像 URL */
  avatar: string;
  /** 直播标题 / 简介 */
  title: string;
}

export function parseRoomMeta(html: string): RoomMeta | null {
  const clean = html
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  const nickname = clean.match(/"nickname":"([^"]{1,80})"/)?.[1] ?? '';
  const avatar = clean.match(/"avatar":"(https:[^"]+?)"/)?.[1] ?? '';
  const title = clean.match(/"title":"([^"]{1,200})"/)?.[1] ?? '';
  if (!nickname && !title) return null;
  return { nickname, avatar, title };
}

// 无 cookie 访问 live.douyin.com 会被 503 风控，会话级缓存 cookie 链（带 TTL）
let jar: Map<string, string> | null = null;
let jarAt = 0;
const JAR_TTL_MS = 15 * 60_000;
/** cookie 获取失败时的短缓存（抖音间歇限流，短 TTL 允许快速重试） */
const JAR_FAIL_TTL_MS = 30_000;

function cookieStr(): string {
  return jar ? [...jar].map(([k, v]) => `${k}=${v}`).join('; ') : '';
}

function storeCookies(headers: Headers) {
  const all = (headers as any).getSetCookie?.() ?? [];
  for (const c of all) {
    const kv = c.split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) jar!.set(kv.slice(0, i).trim(), kv.slice(i + 1));
  }
}

async function ensureCookies(): Promise<void> {
  if (jar && Date.now() - jarAt < JAR_TTL_MS) return;
  const H = { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' };
  jar = new Map();
  jarAt = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let r = await fetch('https://www.douyin.com/', { headers: H, signal: AbortSignal.timeout(10_000) });
      storeCookies(r.headers);
      r = await fetch('https://live.douyin.com/', {
        headers: { ...H, Cookie: cookieStr() },
        signal: AbortSignal.timeout(10_000),
      });
      storeCookies(r.headers);
      if (jar.get('ttwid')) return;
    } catch {
      // 继续重试
    }
    if (attempt < 2) await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
  }
  // 全部失败：短缓存，允许后续快速重试
  jarAt = Date.now() - (JAR_TTL_MS - JAR_FAIL_TTL_MS);
}

/** 抓取直播间页并解析主播信息（失败返回 null，不抛错） */
export async function fetchRoomMeta(roomId: string): Promise<RoomMeta | null> {
  try {
    await ensureCookies();
    const r = await fetch(`https://live.douyin.com/${roomId}`, {
      headers: {
        'User-Agent': UA,
        Cookie: cookieStr(),
        Referer: `https://live.douyin.com/${roomId}`,
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) return null;
    return parseRoomMeta(await r.text());
  } catch {
    return null;
  }
}
