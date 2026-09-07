/**
 * 抖音直播 protobuf 解码器
 *
 * 负责把从 CDP 截获的 WebSocket 二进制帧解码为原始消息（RawProtoMessage）。
 * 协议字段定义来自对 webcast push 帧的逆向观察（与 dycast / DouyinLiveWebFetcher 同源）。
 *
 * 帧结构：
 *   PushFrame(payloadType=msg) → gzip(payload) → Response → Message[] → 具体消息体
 */

import protobuf from 'protobufjs';
import { ungzip } from 'pako';

const DOUYIN_PROTO = `
syntax = "proto3";
message PushFrame {
  uint64 seqId = 1;
  uint64 logId = 2;
  uint64 service = 3;
  uint64 method = 4;
  repeated HeadersList headersList = 5;
  string payloadEncoding = 6;
  string payloadType = 7;
  bytes payload = 8;
}
message HeadersList { string key = 1; string value = 2; }

message Response {
  repeated Message messagesList = 1;
  string cursor = 2;
  uint64 fetchInterval = 3;
  uint64 now = 4;
  string internalExt = 5;
  uint32 fetchType = 6;
  uint64 heartbeatDuration = 8;
  bool needAck = 9;
  string pushServer = 10;
  string liveCursor = 11;
}

message Message {
  string method = 1;
  bytes payload = 2;
  int64 msgId = 3;
  int32 msgType = 4;
}

// ---- 具体消息体（按需声明，未声明字段会被忽略）----
message ChatMessage {
  Common common = 1;
  User user = 2;
  string content = 3;
}
message GiftMessage {
  Common common = 1;
  int64 gift_id = 2;
  string repeat_count = 5;
  string combo_count = 6;
  User user = 7;
  int32 repeat_end = 9;
  GiftStruct gift = 15;
}
message GiftStruct {
  int64 id = 1;
  string name = 2;
  int32 diamond_count = 5;
  Image icon = 17;
}
message MemberMessage {
  Common common = 1;
  User user = 2;
  int64 member_count = 3;
}
message LikeMessage {
  Common common = 1;
  uint64 count = 2;
  uint64 total = 3;
  User user = 5;
}
message SocialMessage {
  Common common = 1;
  User user = 2;
  uint64 action = 4;
}
message RoomUserSeqMessage {
  Common common = 1;
  int64 total = 3;
  int64 popularity = 6;
  int64 totalUser = 7;
}
message Common {
  string method = 1;
  uint64 msgId = 2;
  uint64 roomId = 3;
  uint64 createTime = 4;
}
message User {
  uint64 id = 1;
  string nickName = 3;
  uint32 gender = 5;
  // field 9 is coded avatar url (anti-crawler prefix)
  string signature = 9;
  Image avatarThumb = 10;
  Image avatarMedium = 11;
  string secUid = 46;
  string idStr = 1029;
}
message Image {
  repeated string urlList = 1;
  string uri = 2;
}
`;

let _root: protobuf.Root | null = null;

function root(): protobuf.Root {
  if (!_root) _root = protobuf.parse(DOUYIN_PROTO).root;
  return _root;
}

function lookup(name: string): protobuf.Type {
  return root().lookupType(name);
}

/** 解码后的一帧 */
export interface DecodedFrame {
  seqId?: any; // Long
  logId?: any; // Long
  payloadType?: string;
  headers: Record<string, string>;
}

/** 解码后的原始消息（未标准化） */
export interface RawProtoMessage {
  method: string;
  msgId: string;
  payload: Uint8Array;
}

/** 解码后的消息体（具体类型由 method 决定） */
export interface DecodedMessage {
  method: string;
  msgId: string;
  body: any; // 具体消息体（ChatMessage / GiftMessage / ...）
}

export const MESSAGE_TYPES: Record<string, string> = {
  WebcastChatMessage: 'ChatMessage',
  WebcastGiftMessage: 'GiftMessage',
  WebcastMemberMessage: 'MemberMessage',
  WebcastLikeMessage: 'LikeMessage',
  WebcastSocialMessage: 'SocialMessage',
  WebcastRoomUserSeqMessage: 'RoomUserSeqMessage',
};

/** 解码一个 WebSocket 二进制帧，返回帧元信息 + 原始消息列表 */
export function decodeFrame(buf: Uint8Array): { frame: DecodedFrame; messages: RawProtoMessage[] } {
  const PushFrame = lookup('PushFrame');
  const frame = PushFrame.decode(buf) as any;
  const headers: Record<string, string> = {};
  for (const h of frame.headersList ?? []) {
    if (h.key) headers[h.key] = String(h.value ?? '');
  }

  let payload: Uint8Array = frame.payload ?? new Uint8Array(0);
  if (headers['compress_type'] === 'gzip') {
    try {
      payload = new Uint8Array(ungzip(payload));
    } catch {
      return { frame: { payloadType: frame.payloadType, headers }, messages: [] };
    }
  }

  const messages: RawProtoMessage[] = [];
  const type = String(frame.payloadType ?? '');
  if (type === 'msg' || type === 'push') {
    try {
      const Response = lookup('Response');
      const resp = Response.decode(payload) as any;
      for (const m of resp.messagesList ?? []) {
        if (!m.method) continue;
        messages.push({
          method: String(m.method),
          msgId: String(m.msgId ?? ''),
          payload: m.payload ?? new Uint8Array(0),
        });
      }
    } catch {
      // 某些帧（如 ack）无 Response 结构，忽略
    }
  }

  return {
    frame: { seqId: frame.seqId, logId: frame.logId, payloadType: type, headers },
    messages,
  };
}

/** 解码单个消息体（按 method 匹配具体类型） */
export function decodeMessageBody(msg: RawProtoMessage): DecodedMessage | null {
  const typeName = MESSAGE_TYPES[msg.method];
  if (!typeName) return null;
  try {
    const Type = lookup(typeName);
    const body = Type.decode(msg.payload);
    return { method: msg.method, msgId: msg.msgId, body };
  } catch {
    return null;
  }
}

/**
 * 从帧中提取 ack 信息（轻量内核需主动回复 ack 保持推送链路）
 * 返回 logId / needAck / internalExt，供构造 PushFrame(payload_type=ack)
 */
export function decodeAckInfo(buf: Uint8Array): { logId: string; needAck: boolean; internalExt: string } {
  const PushFrame = lookup('PushFrame');
  const frame = PushFrame.decode(buf) as any;
  const headers: Record<string, string> = {};
  for (const h of frame.headersList ?? []) {
    if (h.key) headers[h.key] = String(h.value ?? '');
  }
  let payload: Uint8Array = frame.payload ?? new Uint8Array(0);
  if (headers['compress_type'] === 'gzip') {
    try {
      payload = new Uint8Array(ungzip(payload));
    } catch {
      return { logId: String(frame.logId ?? ''), needAck: false, internalExt: '' };
    }
  }
  try {
    const Response = lookup('Response');
    const resp = Response.decode(payload) as any;
    return {
      logId: String(frame.logId ?? ''),
      needAck: !!resp.needAck,
      internalExt: String(resp.internalExt ?? ''),
    };
  } catch {
    return { logId: String(frame.logId ?? ''), needAck: false, internalExt: '' };
  }
}

/** 工具：Long → 十进制字符串（避免精度丢失） */
export function longToStr(v: any): string {
  if (v == null) return '';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object' && typeof v.toString === 'function') return v.toString();
  return String(v);
}
