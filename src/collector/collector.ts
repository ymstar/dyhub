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
import * as cookieStore from './cookieStore.js';

/** 采集会话的统一形状（LiveSession / LightweightSession 都实现） */
export interface SessionLike {
  roomId: string;
  status: string;
  startedAt: number;
  stats(): { wsCount: number; frameCount: number; msgCount: number };
  start?(): void;
  stop(): Promise<void>;
  waitForLive(timeoutMs?: number): Promise<boolean>;
  /** 从页面 HTML 解析开播状态（仅浏览器内核实现；轻量内核在 resolveRoomId 内自行解析） */
  getRoomStatus?(): Promise<number | null>;
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
  /** 连接过程进度（launching → listening → live / error） */
  progress?: { step: string; detail?: string; ts: number };
  /** 是否使用了独立 cookie（而非全局共享 cookie） */
  hasOwnCookie?: boolean;
}

/** 连接进度步骤 */
export type ConnectStep = 'launching' | 'listening' | 'live' | 'error';

export interface CollectorOptions {
  /** 浏览器内核：BrowserManager（DYHUB_COLLECTOR=browser 时必填） */
  browser?: BrowserManager;
  /** 轻量内核：会话工厂（DYHUB_COLLECTOR=lightweight 时必填） */
  createSession?: (roomId: string, cookie?: string) => SessionLike;
  /** 采集到原始消息的回调（交给管道标准化） */
  onMessage: (msg: RawProtoMessage, meta: { roomId: string }) => void;
  /** 房间状态变更回调（由上层 index.ts 接线，发布 RoomStatusEvent 到 EventBus） */
  onStatusChange?: (roomId: string, status: string, error?: string) => void;
}

export class Collector {
  private sessions = new Map<string, SessionLike>();
  private errors = new Map<string, string>();
  private metas = new Map<string, RoomMeta | null>();
  /** 已停止但保留的房间（不删除，随时可恢复连接） */
  private saved = new Map<string, { meta: RoomMeta | null; msgCount: number; stoppedAt: number }>();
  /** 连接过程进度 */
  private progress = new Map<string, { step: ConnectStep; detail?: string; ts: number }>();
  /** 进行中的连接 Promise，防止并发重复连接同一房间（多个订阅者同时接入时只开一次采集） */
  private connecting = new Map<string, Promise<RoomInfo>>();
  /** 每房间是否使用了独立 cookie */
  private ownCookies = new Map<string, boolean>();
  private readonly browser?: BrowserManager;
  private readonly createSession?: (roomId: string, cookie?: string) => SessionLike;
  private readonly onMessage: CollectorOptions['onMessage'];
  private readonly onStatusChange?: CollectorOptions['onStatusChange'];
  /** 每房间上次已知状态，用于轮询去重 */
  private lastStatus = new Map<string, string>();
  /** 状态轮询定时器（2s 检测会话内部状态变更，如 wss 断开 / 页面关闭） */
  private statusTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: CollectorOptions) {
    this.browser = opts.browser;
    this.createSession = opts.createSession;
    this.onMessage = opts.onMessage;
    this.onStatusChange = opts.onStatusChange;
    if (this.onStatusChange) {
      this.statusTimer = setInterval(() => this.pollStatuses(), 2000);
    }
  }

  /**
   * 连接并开始采集一个直播间（若房间处于”已停止”保留态，直接恢复）。
   * 并发调用同一 roomId 只触发一次实际连接，复用进行中的 Promise —— 多个订阅者
   * 同时接入同一房间时不会重复开浏览器页面 / 重复建 wss。
   * opts.cookie：传入时该房间使用独立 cookie（多账号多房间互不干扰）；
   *               不传时若 cookieStore 有该房间的独立 cookie 则用它，否则回退全局 cookie。
   */
  async connect(roomId: string, opts?: { cookie?: string }): Promise<RoomInfo> {
    const existing = this.sessions.get(roomId);
    // closed / error 视为「旧会话，需要重建」，只对 connecting / live 保持快速返回
    if (existing && existing.status !== 'closed' && existing.status !== 'error') {
      return this.getRoomInfo(roomId)!;
    }
    const pending = this.connecting.get(roomId);
    if (pending) return pending;
    const p = this.doConnect(roomId, opts).finally(() => this.connecting.delete(roomId));
    this.connecting.set(roomId, p);
    return p;
  }

  private async doConnect(roomId: string, opts?: { cookie?: string }): Promise<RoomInfo> {
    const stale = this.sessions.get(roomId);
    if (stale) {
      // closed / error 视为「旧会话，需要重建」，只对 connecting / live 保持快速返回
      if (stale.status !== 'closed' && stale.status !== 'error') {
        return this.getRoomInfo(roomId)!;
      }
      // 上一次连接已关闭/失败：清理旧会话与状态，允许重新连接
      this.sessions.delete(roomId);
      await stale.stop();
      this.errors.delete(roomId);
      this.progress.delete(roomId);
    }
    // 恢复保留的房间：沿用其主播信息，停止保留态
    if (this.saved.has(roomId)) {
      const s = this.saved.get(roomId)!;
      this.saved.delete(roomId);
      this.metas.set(roomId, s.meta);
    }
    const setProgress = (step: ConnectStep, detail?: string) =>
      this.progress.set(roomId, { step, detail, ts: Date.now() });

    setProgress('launching');
    // 确定本房间使用的 cookie：显式传入 > cookieStore 已有独立 cookie > 全局（undefined）
    const cookie = opts?.cookie ?? (cookieStore.hasRoomCookie(roomId) ? cookieStore.getRoomCookieStr(roomId) : undefined);
    this.ownCookies.set(roomId, !!cookie);
    const session = this.createSession
      ? this.createSession(roomId, cookie)
      : await this.createBrowserSession(roomId, cookie);
    this.sessions.set(roomId, session);
    session.start?.();
    this.fireStatusChange(roomId, 'connecting');
    setProgress('listening');
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
        const msg = (() => {
          if (session.status === 'closed') {
            return this.errors.get(roomId) || '直播间已结束或未开播';
          }
          if (session.status === 'error') {
            return this.errors.get(roomId) || '连接失败';
          }
          return 'wss 连接未在超时内建立（直播间可能未开播或已被风控）';
        })();
        this.errors.set(roomId, msg);
        setProgress('error', msg);
        this.fireStatusChange(roomId, session.status, msg);
        // 未开播时也补全主播信息，避免显示「未知主播」
        ensureMeta(0);
        return;
      }
      setProgress('live');
      this.fireStatusChange(roomId, 'live');
      ensureMeta(0);
    });
    return this.getRoomInfo(roomId)!;
  }

  /** 浏览器内核：打开直播间页面（含 Chrome 冷启动），成功后进入订阅监听阶段 */
  private async createBrowserSession(roomId: string, cookie?: string): Promise<SessionLike> {
    if (!this.browser) throw new Error('未配置浏览器内核（DYHUB_COLLECTOR=browser 时需要 DYHUB_CHROME）');
    const url = `https://live.douyin.com/${roomId}`;
    const { page, cdp, context } = await this.browser.openRoom(url, { cookie });
    const session = new LiveSession(roomId, page, cdp, {
      onMessage: (msg, meta) => this.onMessage(msg, meta),
      onError: (err) => {
        this.errors.set(roomId, err.message);
      },
    }, context);
    this.progress.set(roomId, { step: 'launching', detail: '页面已打开，等待弹幕通道', ts: Date.now() });
    return session;
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
      this.fireStatusChange(roomId, 'stopped');
    }
    this.errors.delete(roomId);
    this.progress.delete(roomId);
  }

  /** 彻底删除一个房间（含已停止保留的记录），房间从列表消失 */
  async removeRoom(roomId: string): Promise<void> {
    const s = this.sessions.get(roomId);
    if (s) {
      await s.stop();
      this.sessions.delete(roomId);
      this.fireStatusChange(roomId, 'stopped');
    }
    this.saved.delete(roomId);
    this.errors.delete(roomId);
    this.metas.delete(roomId);
    this.progress.delete(roomId);
    this.ownCookies.delete(roomId);
    this.lastStatus.delete(roomId);
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
        progress: this.progress.get(roomId),
        hasOwnCookie: this.ownCookies.get(roomId) ?? false,
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
        hasOwnCookie: this.ownCookies.get(roomId) ?? false,
      };
    }
    return null;
  }

  async disconnectAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    for (const id of ids) await this.disconnect(id);
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
  }

  /** 发射状态变更（去重：与 lastStatus 相同则跳过） */
  private fireStatusChange(roomId: string, status: string, error?: string): void {
    if (!this.onStatusChange) return;
    const prev = this.lastStatus.get(roomId);
    if (prev === status) return;
    this.lastStatus.set(roomId, status);
    this.onStatusChange(roomId, status, error);
  }

  /** 轮询所有活跃会话状态，检测会话内部状态变更（wss 断开 / 页面关闭等） */
  private pollStatuses(): void {
    for (const [roomId, session] of this.sessions) {
      const error = this.errors.get(roomId);
      this.fireStatusChange(roomId, session.status, error);
    }
  }
}
