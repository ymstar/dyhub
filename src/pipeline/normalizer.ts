/**
 * 事件标准化器 —— 采集层私有协议 → 统一事件协议 的翻译层
 *
 * 核心价值：消费端永远只看到 DanmakuEvent，抖音改协议只影响本文件及解码器，
 * 消费端零改动。这是"中台基座"的根基。
 */

import type {
  ChatPart,
  DanmakuEvent,
  DanmakuFansClub,
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
    payLevel: u.payGrade ? Number(longToStr(u.payGrade.level) || 0) : undefined,
    fansClub: toFansClub(u.fansClub?.data),
    badges: toBadges(u.newBadgeImageList?.length ? u.newBadgeImageList : u.badgeImageList),
  };
}

/** 直播间会员勋章的 imageType；文字只是「勋章」，月 / 年会员靠图片名区分（subscribe_new / subscribe_new_yearly）。 */
const SUBSCRIBE_BADGE = 59;

/**
 * 名字旁的勋章：直播间会员记为 V 或 V年，其余用勋章文字（content.alternativeText）；
 * 没有文字的、只叫「勋章」的不输出。一个都没有时返回 undefined。
 */
function toBadges(images: any[] | undefined): string[] | undefined {
  const badges: string[] = [];
  for (const image of images ?? []) {
    const url = firstUrl(image?.urlList) ?? String(image?.uri ?? '');
    if (Number(image?.imageType) === SUBSCRIBE_BADGE || /\/subscribe_/.test(url)) {
      badges.push(/yearly/.test(url) ? 'V年' : 'V');
      continue;
    }
    const text = String(image?.content?.alternativeText ?? '').trim();
    if (text && text !== '勋章') badges.push(text);
  }
  const unique = [...new Set(badges)];
  return unique.length ? unique : undefined;
}

/** 粉丝团：名称为空且等级为 0 视为未加入，不输出。 */
function toFansClub(d: any): DanmakuFansClub | undefined {
  if (!d) return undefined;
  const name = String(d.clubName ?? '');
  const level = Number(d.level ?? 0);
  if (!name && !level) return undefined;
  return {
    name,
    level,
    status: d.userFansClubStatus ? Number(d.userFansClubStatus) : undefined,
    anchorId: longToStr(d.anchorId) || undefined,
  };
}

/** URL 列表中首个 http(s) 地址 */
function firstUrl(urls: unknown): string | undefined {
  if (!Array.isArray(urls)) return undefined;
  return urls.find((u): u is string => typeof u === 'string' && u.startsWith('http'));
}

/**
 * 富文本（webcast.data.Text）→ 分段：图片段为表情（名称取 Image.content），@用户段为 mention，
 * 其余取文字。没有可用分段时返回 undefined，消费端回退到 content。
 */
function toParts(text: any): ChatPart[] | undefined {
  const parts: ChatPart[] = [];
  for (const piece of text?.pieces ?? []) {
    const image = piece.imageValue?.image;
    const url = firstUrl(image?.urlList);
    if (url) {
      parts.push({
        type: 'emote',
        url,
        name: image.content?.name || image.content?.alternativeText || undefined,
        width: Number(longToStr(image.width) || 0) || undefined,
        height: Number(longToStr(image.height) || 0) || undefined,
      });
      continue;
    }
    const user = piece.userValue?.user;
    if (user) {
      parts.push({
        type: 'mention',
        text: `@${user.nickName || ''}`,
        userId: user.idStr || longToStr(user.id) || undefined,
      });
      continue;
    }
    if (piece.stringValue) parts.push({ type: 'text', text: String(piece.stringValue) });
  }
  return parts.length ? parts : undefined;
}

/**
 * 提取头像 URL。
 * 优先取 avatarThumb.urlList 首个（User field 9），
 * 取不到则回退到 avatarMedium / avatarLarge。
 */
function extractAvatar(u: any): string | undefined {
  for (const field of ['avatarThumb', 'avatarMedium', 'avatarLarge']) {
    const urls = u[field]?.urlList;
    if (Array.isArray(urls) && urls.length && typeof urls[0] === 'string' && urls[0].startsWith('http')) {
      return urls[0];
    }
  }
  return undefined;
}

// 事件 roomId 统一采用采集会话的 roomId（用户可识别的 web_rid）：
// 房间管理（/api/rooms）、订阅过滤（WS/SSE 的 roomId 参数）、控制台切换均以此为准，
// 避免与消息体里的内部 webcast 房间号不一致导致过滤失配。
function createTime(body: any): number {
  const t = body?.common?.createTime;
  const n = typeof t === 'bigint' ? Number(t) : Number(t ?? 0);
  // 0 / 无效时回退到当前时间
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  // 抖音的 createTime 有时是秒、有时是毫秒（同一礼物的两条消息就可能不同），统一为毫秒
  return n < 1e12 ? n * 1000 : n;
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
        data: {
          content: String(body.content ?? ''),
          parts: toParts(body.rtfContentV2) ?? toParts(body.rtfContent),
        },
      };
      return ev;
    }
    case 'WebcastEmojiChatMessage': {
      // 会员表情 / 大表情：以 chat 事件下发，parts 只有这一张图，content 为抖音给的文字替代。
      const parts = toParts(body.emojiContent);
      const name = parts?.find((p) => p.type === 'emote')?.name;
      const ev: ChatEvent = {
        ...base,
        type: 'chat',
        data: {
          content: String(body.defaultContent || name || ''),
          parts,
          sticker: true,
          emojiId: longToStr(body.emojiId) || undefined,
        },
      };
      return ev;
    }
    case 'WebcastGiftMessage': {
      const gift = body.gift;
      const iconUrls = gift?.icon?.urlList ?? gift?.image?.urlList;
      const ev: GiftEvent = {
        ...base,
        type: 'gift',
        data: {
          giftId: longToStr(body.giftId || gift?.id),
          giftName: gift?.name || '',
          giftIcon:
            Array.isArray(iconUrls) && iconUrls.length && typeof iconUrls[0] === 'string' && iconUrls[0].startsWith('http')
              ? iconUrls[0]
              : undefined,
          diamondCount: Number(gift?.diamondCount ?? 0),
          repeatCount: Number(body.repeatCount ?? 0),
          comboCount: Number(body.comboCount ?? 0),
          groupCount: Number(body.groupCount ?? 0),
          repeatEnd: Boolean(body.repeatEnd),
          groupId: longToStr(body.groupId) || undefined,
          combo: Boolean(gift?.combo),
          sendType: Number(body.sendType ?? 0),
          traceId: body.traceId || undefined,
        },
      };
      return ev;
    }
    case 'WebcastMemberMessage':
      return { ...base, type: 'member', data: { memberCount: Number(body.memberCount ?? 0) } };
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
