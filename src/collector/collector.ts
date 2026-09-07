/**
 * 采集器 —— 采集层的门面 / 管理器
 *
 * 负责直播间会话的增删查，向上层（管道 / API）提供统一接口。
 * 支持两种采集内核（由上层注入）：
 *  - 浏览器内核（browser）：真实浏览器 + CDP 帧截获，最稳，资源占用高
 *  - 轻量内核（lightweight）：纯代码 wss 直连，连接快 / 零浏览器进程
 * 两种内核产出同样的 RawProtoMessage，管道与消费端无感知。
 */

import { BrowserManager } from './browser.js';
import { LiveSession } from './liveSession.js';
import type { RawProtoMessage } from '../proto/douyin.proto.js';

/** 采集会话的统一形状（LiveSession / LightweightSession 都实现） */
export interface SessionLike {
  roomId: string;
  status: string;
  startedAt: number;
  stats(): { wsCount: number; frameCount: number; msgCount: number };
  start?(): void;
  stop(): Promise<void>;
  waitForLive(timeoutMs?: number): Promise<boolean>;
}

export interface RoomInfo {
  roomId: string;
  status: string;
  startedAt: number;
  stats: { wsCount: number; frameCount: number; msgCount: number };
  error?: string;
}

export interface CollectorOptions {
  /** 浏览器内核：BrowserManager（DYHUB_COLLECTOR=browser 时必填） */
  browser?: BrowserManager;
  /** 轻量内核：会话工厂（DYHUB_COLLECTOR=lightweight 时必填） */
  createSession?: (roomId: string) => SessionLike;
  /** 采集到原始消息的回调（交给管道标准化） */
  onMessage: (msg: RawProtoMessage, meta: { roomId: string }) => void;
}

export class Collector {
  private sessions = new Map<string, SessionLike>();
  private errors = new Map<string, string>();
  private readonly browser?: BrowserManager;
  private readonly createSession?: (roomId: string) => SessionLike;
  private readonly onMessage: CollectorOptions['onMessage'];

  constructor(opts: CollectorOptions) {
    this.browser = opts.browser;
    this.createSession = opts.createSession;
    this.onMessage = opts.onMessage;
  }

  /** 连接并开始采集一个直播间 */
  async connect(roomId: string): Promise<RoomInfo> {
    if (this.sessions.has(roomId)) {
      return this.getRoomInfo(roomId)!;
    }
    const session = this.createSession
      ? this.createSession(roomId)
      : await this.createBrowserSession(roomId);
    this.sessions.set(roomId, session);
    session.start?.();
    // 等待进入直播态（不阻塞 connect 返回，异步确认）
    session.waitForLive(30_000).then((ok) => {
      if (!ok && this.sessions.has(roomId)) {
        this.errors.set(roomId, 'wss 连接未在超时内建立（直播间可能未开播或已被风控）');
      }
    });
    return this.getRoomInfo(roomId)!;
  }

  private async createBrowserSession(roomId: string): Promise<SessionLike> {
    if (!this.browser) throw new Error('未配置浏览器内核（DYHUB_COLLECTOR=browser 时需要 DYHUB_CHROME）');
    const url = `https://live.douyin.com/${roomId}`;
    const { page, cdp } = await this.browser.openRoom(url);
    return new LiveSession(roomId, page, cdp, {
      onMessage: (msg, meta) => this.onMessage(msg, meta),
      onError: (err) => {
        this.errors.set(roomId, err.message);
      },
    });
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
