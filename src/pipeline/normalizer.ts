/**
 * 事件标准化器 —— 采集层私有协议 → 统一事件协议 的翻译层
 *
 * 核心价值：消费端永远只看到 DanmakuEvent，抖音改协议只影响本文件及解码器，
 * 消费端零改动。这是"中台基座"的根基。
 */

import type {
  DanmakuEvent,
  DanmakuUser,
  GiftEvent,
  ChatEvent,
} from '../types/events.js';
import { decodeMessageBody, longToStr, type RawProtoMessage } from '../proto/douyin.proto.js';

function toUser(body: any): DanmakuUser | undefined {
  const u = body?.user;
  if (!u) return undefined;
  const id = u.idStr || longToStr(u.id);
  if (!id) return undefined;
  return {
    id,
    nickname: u.nickName || '',
    avatar: extractAvatar(u),
    secUid: u.secUid || undefined,
  };
}

/**
 * 提取头像 URL。
 * 抖音把头像放在两处之一：
 *  1. avatarThumb.urlList（部分消息类型有）
 *  2. User field 9（signature），值为 "\nxhttps://...aweme-avatar/xxx.jpeg?from=..."（防爬编码，前面带 \nx 前缀）
 * 两处都取不到返回 undefined。
 */
function extractAvatar(u: any): string | undefined {
  const urls = u.avatarThumb?.urlList;
  if (Array.isArray(urls) && urls.length && typeof urls[0] === 'string' && urls[0].startsWith('http')) {
    return urls[0];
  }
  const coded = u.signature;
  if (typeof coded === 'string') {
    const m = coded.match(/https?:\/\/[^\s]+/);
    if (m) return m[0];
  }
  return undefined;
}

// 事件 roomId 统一采用采集会话的 roomId（用户可识别的 web_rid）：
// 房间管理（/api/rooms）、订阅过滤（WS/SSE 的 roomId 参数）、控制台切换均以此为准，
// 避免与消息体里的内部 webcast 房间号不一致导致过滤失配。
function createTime(body: any): number {
  const t = body?.common?.createTime;
  const n = typeof t === 'bigint' ? Number(t) : Number(t ?? 0);
  // createTime 是秒，转毫秒；0 / 无效时回退到当前时间
  return Number.isFinite(n) && n > 0 ? n * 1000 : Date.now();
}

/**
 * 把一条抖音原始消息标准化为统一事件。
 * @returns 标准化事件；无法识别的消息返回 unknown 事件（透传），解析失败返回 null
 */
export function normalize(msg: RawProtoMessage, meta: { roomId: string }): DanmakuEvent | null {
  const decoded = decodeMessageBody(msg);
  if (!decoded) {
    // 未声明的消息类型：透传为 unknown，保留原始载荷供调试
    return {
      id: msg.msgId || `${meta.roomId}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      roomId: meta.roomId,
      platform: 'douyin',
      type: 'unknown',
      ts: Date.now(),
      receivedAt: Date.now(),
      rawMethod: msg.method,
      data: { method: msg.method },
    } satisfies DanmakuEvent;
  }

  const body = decoded.body;
  const base = {
    id: msg.msgId || decoded.msgId,
    roomId: meta.roomId,
    platform: 'douyin' as const,
    ts: createTime(body),
    receivedAt: Date.now(),
    user: toUser(body),
    rawMethod: msg.method,
  };

  switch (decoded.method) {
    case 'WebcastChatMessage': {
      const ev: ChatEvent = {
        ...base,
        type: 'chat',
        data: { content: String(body.content ?? '') },
      };
      return ev;
    }
    case 'WebcastGiftMessage': {
      const gift = body.gift;
      const iconUrls = gift?.image?.urlList;
      const ev: GiftEvent = {
        ...base,
        type: 'gift',
        data: {
          giftId: longToStr(body.gift_id ?? gift?.id),
          giftName: gift?.name || '',
          giftIcon:
            Array.isArray(iconUrls) && iconUrls.length && typeof iconUrls[0] === 'string' && iconUrls[0].startsWith('http')
              ? iconUrls[0]
              : undefined,
          diamondCount: Number(gift?.diamond_count ?? 0),
          repeatCount: Number(body.repeat_count ?? 0),
          comboCount: Number(body.combo_count ?? 0),
          repeatEnd: Boolean(body.repeat_end),
        },
      };
      return ev;
    }
    case 'WebcastMemberMessage':
      return { ...base, type: 'member', data: { memberCount: Number(body.member_count ?? 0) } };
    case 'WebcastLikeMessage':
      return {
        ...base,
        type: 'like',
        data: { count: Number(body.count ?? 0), total: Number(body.total ?? 0) },
      };
    case 'WebcastSocialMessage':
      return { ...base, type: 'follow', data: { action: Number(body.action ?? 0) } };
    case 'WebcastRoomUserSeqMessage':
      return {
        ...base,
        type: 'room',
        data: {
          total: Number(body.total ?? 0),
          popularity: Number(body.popularity ?? 0),
          totalUser: Number(body.totalUser ?? 0),
        },
      };
    default:
      return {
        ...base,
        type: 'unknown',
        data: { method: decoded.method },
      };
  }
}
