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

export class WsDispatcher {
  private wss: WebSocketServer;
  private bus: EventBus;
  private clients = new Map<WebSocket, EventFilter>();
  private busSub: number;

  constructor(httpServer: HttpServer, bus: EventBus) {
    this.bus = bus;
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
