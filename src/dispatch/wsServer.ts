/**
 * WebSocket 事件分发 —— 面向实时消费端（网页弹幕墙 / 弹幕游戏 / 数据看板）
 *
 * 客户端连接：ws://host:port/ws?roomId=xxx&types=chat,gift,member
 * 服务端将匹配的标准化事件以 JSON 推送。
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import { EventBus } from '../pipeline/eventBus.js';
import { eventMatches, type DanmakuEvent, type EventFilter } from '../types/events.js';
import type { Collector, RoomInfo } from '../collector/collector.js';

export class WsDispatcher {
  private wss: WebSocketServer;
  private bus: EventBus;
  private collector: Collector;
  private clients = new Map<WebSocket, EventFilter>();
  private busSub: number;

  constructor(httpServer: HttpServer, bus: EventBus, collector: Collector) {
    this.bus = bus;
    this.collector = collector;
    this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const roomId = url.searchParams.get('roomId') ?? undefined;
      const types = (url.searchParams.get('types') ?? '')
        .split(',')
        .filter(Boolean) as EventFilter['type'] extends any[] ? any[] : any[];
      const filter: EventFilter = { roomId, type: types.length ? types : undefined };
      this.clients.set(ws, filter);
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
      ws.send(JSON.stringify({ type: '__hello', roomId, types, ts: Date.now() }));

      // 订阅者接入即连接：房间未活跃时自动触发采集，并向客户端推送连接进度
      if (roomId) this.autoConnectRoom(ws, roomId);
    });
    // 心跳保活
    const hb = setInterval(() => {
      for (const ws of this.clients.keys()) {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }
    }, 20000);
    this.wss.on('close', () => clearInterval(hb));

    this.busSub = this.bus.subscribe(undefined, (ev) => this.broadcast(ev));
  }

  /**
   * 房间未活跃时自动触发采集，向客户端推送连接进度帧：
   *   __connecting → __connected（成功）/ __error（失败，随后关闭连接）
   * 已活跃房间直接回 __connected。自动连接的房间不会随订阅者断开而自动断开
   * （连接成本高，保留至手动 disconnect）。
   */
  private autoConnectRoom(ws: WebSocket, roomId: string): void {
    const send = (obj: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };
    const info = this.collector.getRoomInfo(roomId);
    if (info && info.status !== 'stopped') {
      send({ type: '__connected', roomId, room: info, ts: Date.now() });
      return;
    }
    send({ type: '__connecting', roomId, ts: Date.now() });
    this.collector
      .connect(roomId)
      .then((room: RoomInfo) => send({ type: '__connected', roomId, room, ts: Date.now() }))
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        send({ type: '__error', roomId, error: `房间自动连接失败: ${msg}`, ts: Date.now() });
        ws.close();
      });
  }

  private broadcast(ev: DanmakuEvent): void {
    const text = JSON.stringify(ev);
    for (const [ws, filter] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (eventMatches(ev, filter)) {
        try {
          ws.send(text);
        } catch {
          /* ignore */
        }
      }
    }
  }

  clientCount(): number {
    return this.clients.size;
  }

  close(): void {
    this.bus.unsubscribe(this.busSub);
    this.wss.close();
  }
}
