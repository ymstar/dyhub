/**
 * 采集器 —— 采集层的门面 / 管理器
 *
 * 负责直播间会话的增删查，向上层（管道 / API）提供统一接口。
 * 单个采集器可同时采集多个直播间（一个直播间 = 一个浏览器页面 + 一个会话）。
 */

import { BrowserManager } from './browser.js';
import { LiveSession } from './liveSession.js';
import type { RawProtoMessage } from '../proto/douyin.proto.js';

export interface RoomInfo {
  roomId: string;
  status: LiveSession['status'];
  startedAt: number;
  stats: { wsCount: number; frameCount: number; msgCount: number };
  error?: string;
}

export interface CollectorOptions {
  browser: BrowserManager;
  /** 采集到原始消息的回调（交给管道标准化） */
  onMessage: (msg: RawProtoMessage, meta: { roomId: string }) => void;
}

export class Collector {
  private sessions = new Map<string, LiveSession>();
  private errors = new Map<string, string>();
  private readonly browser: BrowserManager;
  private readonly onMessage: CollectorOptions['onMessage'];

  constructor(opts: CollectorOptions) {
    this.browser = opts.browser;
    this.onMessage = opts.onMessage;
  }

  /** 连接并开始采集一个直播间 */
  async connect(roomId: string): Promise<RoomInfo> {
    if (this.sessions.has(roomId)) {
      return this.getRoomInfo(roomId)!;
    }
    const url = `https://live.douyin.com/${roomId}`;
    const { page, cdp } = await this.browser.openRoom(url);
    const session = new LiveSession(roomId, page, cdp, {
      onMessage: (msg, meta) => this.onMessage(msg, meta),
      onError: (err) => {
        this.errors.set(roomId, err.message);
      },
    });
    this.sessions.set(roomId, session);
    // 等待弹幕 wss 建立（不阻塞 connect 返回，异步确认）
    session.waitForLive().then((ok) => {
      if (!ok && this.sessions.has(roomId)) {
        this.errors.set(roomId, 'wss 连接未在超时内建立（页面可能无直播或已被风控）');
      }
    });
    return this.getRoomInfo(roomId)!;
  }

  /** 断开一个直播间采集 */
  async disconnect(roomId: string): Promise<void> {
    const s = this.sessions.get(roomId);
    if (s) {
      await s.stop();
      this.sessions.delete(roomId);
    }
    this.errors.delete(roomId);
  }

  /** 全部已连接房间 */
  getRooms(): RoomInfo[] {
    return [...this.sessions.keys()].map((id) => this.getRoomInfo(id)!);
  }

  getRoomInfo(roomId: string): RoomInfo | null {
    const s = this.sessions.get(roomId);
    if (!s) return null;
    return {
      roomId,
      status: s.status,
      startedAt: s.startedAt,
      stats: s.stats(),
      error: this.errors.get(roomId),
    };
  }

  async disconnectAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    for (const id of ids) await this.disconnect(id);
  }
}
