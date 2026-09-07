/**
 * 标准化事件协议 —— 弹幕中台的"普通话"
 *
 * 采集层将各平台私有协议（protobuf / JSON）归一为统一事件模型，
 * 消费端（规则引擎 / AI 助理 / 弹幕游戏 / 监控）只依赖本协议，不感知平台细节。
 *
 * 事件模型核心字段：
 *  - id        稳定事件 ID（由平台 msgId 派生，用于去重 / 幂等消费）
 *  - roomId    直播间 webcast roomId（字符串，避免精度丢失）
 *  - platform  平台标识，当前仅 douyin，为多平台扩展预留
 *  - type      事件语义类型
 *  - ts        事件发生时间（毫秒）
 */

export type Platform = 'douyin' | string;

/** 事件语义类型 */
export type DanmakuEventType =
  | 'chat'      // 弹幕
  | 'gift'      // 礼物
  | 'member'    // 进场
  | 'like'      // 点赞
  | 'follow'    // 关注
  | 'room'      // 房间统计（在线人数等）
  | 'unknown';  // 尚未标准化的原始消息（透传）

/** 直播间用户（标准化） */
export interface DanmakuUser {
  id: string;        // 用户 uid（字符串，避免精度丢失）
  nickname: string;  // 昵称
  avatar?: string;   // 头像 URL（列表中的首个）
  secUid?: string;   // 安全 uid
}

/** 基础事件 */
export interface BaseDanmakuEvent {
  id: string;
  roomId: string;
  platform: Platform;
  type: DanmakuEventType;
  ts: number;          // 事件发生时间（平台 createTime，毫秒）
  receivedAt: number;  // 中台接收时间（毫秒）
  user?: DanmakuUser;
  rawMethod?: string;  // 原始平台消息方法名（调试用）
}

export interface ChatEvent extends BaseDanmakuEvent {
  type: 'chat';
  data: { content: string };
}

export interface GiftEvent extends BaseDanmakuEvent {
  type: 'gift';
  data: {
    giftId: string;
    giftName: string;
    diamondCount?: number;   // 价值（钻石）
    repeatCount?: number;    // 连击次数
    comboCount?: number;     // 连击（主播端口径）
    repeatEnd?: boolean;     // 是否连击结束
  };
}

export interface MemberEvent extends BaseDanmakuEvent {
  type: 'member';
  data: { memberCount?: number };
}

export interface LikeEvent extends BaseDanmakuEvent {
  type: 'like';
  data: { count?: number; total?: number };
}

export interface FollowEvent extends BaseDanmakuEvent {
  type: 'follow';
  data: { action?: number };
}

export interface RoomEvent extends BaseDanmakuEvent {
  type: 'room';
  data: { total?: number; popularity?: number; totalUser?: number };
}

export interface UnknownEvent extends BaseDanmakuEvent {
  type: 'unknown';
  data: { method: string; payloadBase64?: string };
}

/** 统一事件联合类型 */
export type DanmakuEvent =
  | ChatEvent
  | GiftEvent
  | MemberEvent
  | LikeEvent
  | FollowEvent
  | RoomEvent
  | UnknownEvent;

/** 事件订阅过滤器：可订阅全部，或按 roomId / type 过滤 */
export interface EventFilter {
  roomId?: string;
  type?: DanmakuEventType | DanmakuEventType[];
}

export function eventMatches(ev: DanmakuEvent, filter?: EventFilter): boolean {
  if (!filter) return true;
  if (filter.roomId && filter.roomId !== ev.roomId) return false;
  if (filter.type) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    if (!types.includes(ev.type)) return false;
  }
  return true;
}
