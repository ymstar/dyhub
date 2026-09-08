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
import { fetchRoomMeta } from './roomMeta.js';
import type { RoomMeta } from './roomMeta.js';
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
  /** 会话自带的直播间主播信息（轻量内核连接时解析；无则走 fetchRoomMeta 兜底） */
  meta?: RoomMeta | null;
}

export interface RoomInfo {
  roomId: string;
  status: string;
  startedAt: number;
  stats: { wsCount: number; frameCount: number; msgCount: number };
  error?: string;
  /** 主播信息（异步补全，可能为空） */
  meta?: RoomMeta | null;
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
  private metas = new Map<string, RoomMeta | null>();
  /** 已停止但保留的房间（不删除，随时可恢复连接） */
  private saved = new Map<string, { meta: RoomMeta | null; msgCount: number; stoppedAt: number }>();
  private readonly browser?: BrowserManager;
  private readonly createSession?: (roomId: string) => SessionLike;
  private readonly onMessage: CollectorOptions['onMessage'];

  constructor(opts: CollectorOptions) {
    this.browser = opts.browser;
    this.createSession = opts.createSession;
    this.onMessage = opts.onMessage;
  }

  /** 连接并开始采集一个直播间（若房间处于“已停止”保留态，直接恢复） */
  async connect(roomId: string): Promise<RoomInfo> {
    if (this.sessions.has(roomId)) {
      return this.getRoomInfo(roomId)!;
    }
    // 恢复保留的房间：沿用其主播信息，停止保留态
    if (this.saved.has(roomId)) {
      const s = this.saved.get(roomId)!;
      this.saved.delete(roomId);
      this.metas.set(roomId, s.meta);
    }
    const session = this.createSession
      ? this.createSession(roomId)
      : await this.createBrowserSession(roomId);
    this.sessions.set(roomId, session);
    session.start?.();
    // 异步补全主播信息（不阻塞连接，取不到不报错）
    // 轻量内核的 meta 在 resolveRoomId（异步）完成时才可用；waitForLive 可能因限流超时，
    // 但房间稍后仍可能连上，故只要最终 live 就继续取 meta，兜底失败后周期重试
    const ensureMeta = (attempt: number) => {
      const m = session.meta;
      if (m) {
        this.metas.set(roomId, m);
        return;
      }
      fetchRoomMeta(roomId).then((meta) => {
        if (!this.sessions.has(roomId)) return;
        if (meta) {
          this.metas.set(roomId, meta);
        } else if (attempt < 5) {
          setTimeout(() => ensureMeta(attempt + 1), 30_000);
        }
      });
    };
    session.waitForLive(30_000).then((ok) => {
      if (!this.sessions.has(roomId)) return;
      if (!ok && session.status !== 'live') {
        this.errors.set(roomId, 'wss 连接未在超时内建立（直播间可能未开播或已被风控）');
        return;
      }
      ensureMeta(0);
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

  /** 停止一个直播间的采集（保留房间记录与主播信息，随时可恢复连接） */
  async disconnect(roomId: string): Promise<void> {
    const s = this.sessions.get(roomId);
    if (s) {
      await s.stop();
      this.sessions.delete(roomId);
      this.saved.set(roomId, {
        meta: this.metas.get(roomId) ?? null,
        msgCount: s.stats().msgCount,
        stoppedAt: Date.now(),
      });
    }
    this.errors.delete(roomId);
  }

  /** 彻底删除一个房间（含已停止保留的记录），房间从列表消失 */
  async removeRoom(roomId: string): Promise<void> {
    const s = this.sessions.get(roomId);
    if (s) {
      await s.stop();
      this.sessions.delete(roomId);
    }
    this.saved.delete(roomId);
    this.errors.delete(roomId);
    this.metas.delete(roomId);
  }

  /** 全部已连接房间 + 已停止保留的房间 */
  getRooms(): RoomInfo[] {
    return [...this.sessions.keys()].map((id) => this.getRoomInfo(id)!)
      .concat([...this.saved.keys()].map((id) => this.getRoomInfo(id)!));
  }

  getRoomInfo(roomId: string): RoomInfo | null {
    const s = this.sessions.get(roomId);
    if (s) {
      return {
        roomId,
        status: s.status,
        startedAt: s.startedAt,
        stats: s.stats(),
        error: this.errors.get(roomId),
        meta: this.metas.has(roomId) ? this.metas.get(roomId) : undefined,
      };
    }
    const saved = this.saved.get(roomId);
    if (saved) {
      return {
        roomId,
        status: 'stopped',
        startedAt: saved.stoppedAt,
        stats: { wsCount: 0, frameCount: 0, msgCount: saved.msgCount },
        meta: saved.meta ?? undefined,
      };
    }
    return null;
  }

  async disconnectAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    for (const id of ids) await this.disconnect(id);
  }
}
