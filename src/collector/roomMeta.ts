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
  /** 主播 uid（anchor.id_str），取不到为空串 */
  uid: string;
  /** 主播 sec_uid，取不到为空串 */
  secUid: string;
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
  // 主播信息在页面内联 JSON 里是转义过的（\"anchor\":{\"id_str\":…），去掉转义再找 anchor 块
  const anchor = clean.replace(/\\"/g, '"').match(/"anchor":\{[^{}]{0,600}/)?.[0] ?? '';
  const uid = anchor.match(/"id_str":"(\d+)"/)?.[1] ?? '';
  const secUid = anchor.match(/"sec_uid":"([^"]+)"/)?.[1] ?? '';
  if (!nickname && !title && !uid) return null;
  return { nickname, avatar, title, uid, secUid };
}

/**
 * 从直播间 HTML 解析开播状态（roomStore.roomInfo.room.status）。
 *
 * 已知状态（均已实测确认）：
 *   2 = 直播中
 *   4 = 已结束
 *
 * 其它取值（1、3、5…）的含义尚未验证，可能对应预告 / 暂停 / 审核 / 回放等场景。
 * 当前调用方统一采用白名单策略：「非 2 即不可采集」
 * （见 lightweightSession.resolveRoomId 与 LiveSession.waitForLive）。
 *
 * 若未来发现某个非 2 状态实际仍可采集，应改为黑名单策略：
 * 只把明确不可采集的状态（至少 4）视为 closed，其余放行，
 * 再由 waitForLive / 弹幕帧判断是否真正连通。调整时需同步修改两处调用方。
 *
 * 该字段在初始 HTML 的 self.__pace_f 序列化数据里，以 \"status\":N 反斜杠转义形式存在，
 * 因此需要先还原 \" 与 &quot; 两种转义再匹配。取不到时返回 null（调用方放行）。
 *
 * 匹配方式与已知脆弱点：
 *   1. 严格正则假设字段顺序为 "roomStore" → "roomInfo" → "room" → "id_str" → "status"，
 *      即 status 紧跟在 id_str 之后。抖音前端若调整 JSON 字段顺序或插入新字段，
 *      严格匹配会失配。
 *   2. 兜底正则 /"room":\{"id_str":"[^"]*","status":(\d+)/ 更宽松，但页面中可能存在
 *      多个 "room" 对象（推荐流 / 关联房间等），理论上可能匹配到错误对象。
 *
 * 解析失败（返回 null）时，调用方会跳过开播校验直接继续连接，
 * 而已下播房间的 wss 仍可能建立并推送帧，因此可能重新出现
 * 「已结束房间被误报为直播中」。若该问题复现，应优先检查抖音页面结构 / 字段顺序
 * 是否变化，并同步更新本函数及两处调用方。
 */
export function parseRoomStatus(html: string): number | null {
  const clean = html.replace(/\\"/g, '"').replace(/&quot;/g, '"');
  const m =
    clean.match(/"roomStore":\{"roomInfo":\{"room":\{"id_str":"[^"]*","status":(\d+)/) ||
    clean.match(/"room":\{"id_str":"[^"]*","status":(\d+)/);
  return m ? Number(m[1]) : null;
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
