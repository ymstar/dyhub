/**
 * 直播间会话 —— 单房间采集单元
 *
 * 通过 CDP 监听页面 WebSocket 帧（Network.webSocketFrameReceived），
 * 解码为 RawProtoMessage 后回调给上层，由管道负责标准化。
 * 本模块不关心业务事件协议，只负责"拿到帧并解码"。
 */

import type { Page, CDPSession, BrowserContext } from 'playwright-core';
import { decodeFrame, type RawProtoMessage } from '../proto/douyin.proto.js';
import { parseRoomStatus } from './roomMeta.js';

export interface LiveSessionOptions {
  onMessage: (msg: RawProtoMessage, frame: { roomId: string }) => void;
  /** 弹幕通道建立（或断开后重新收到推送帧）时的回调 */
  onOpen?: () => void;
  /** 会话错误回调 */
  onError?: (err: Error) => void;
  /** 页面播放器最近请求的直播流地址（由 BrowserManager.openRoom 在打开页面前开始记录） */
  streamUrl?: () => string | null;
}

export type LiveSessionStatus = 'connecting' | 'live' | 'closed';

/** 直播间弹幕输入框：抖音网页端的 Slate 富文本编辑器（class 名混淆，按稳定属性定位） */
const CHAT_INPUT = '[data-e2e="live-chatting"] [data-slate-editor="true"][contenteditable="true"]';
/** 同一房间两次发送的最小间隔，避免连发触发风控 */
const CHAT_MIN_INTERVAL_MS = Number(process.env.DYHUB_CHAT_INTERVAL_MS ?? 3000);

export class LiveSession {
  readonly roomId: string;
  readonly startedAt: number = Date.now();
  status: LiveSessionStatus = 'connecting';

  private page: Page;
  private cdp: CDPSession;
  private opts: LiveSessionOptions;
  /** 独立 context（每房间 cookie 时创建，关房时需清理） */
  private ownContext?: BrowserContext;
  private wsCount = 0;
  private frameCount = 0;
  private msgCount = 0;
  private stopped = false;
  /** 收到过抖音推送帧的 WebSocket（CDP requestId），只有它们关闭才算弹幕断开 */
  private pushSockets = new Set<string>();
  /** 发送队列：同一页面一次只发一条 */
  private sendQueue: Promise<unknown> = Promise.resolve();
  private lastSentAt = 0;

  constructor(roomId: string, page: Page, cdp: CDPSession, opts: LiveSessionOptions, ownContext?: BrowserContext) {
    this.roomId = roomId;
    this.page = page;
    this.cdp = cdp;
    this.opts = opts;
    this.ownContext = ownContext;
    this.attach();
  }

  private attach(): void {
    // CDP 的 webSocketFrameReceived 事件不含 url，无法按连接过滤；
    // 直接对全部帧尝试解码，非 PushFrame / 非法帧会被 decodeFrame 安全忽略（无副作用）。
    // 页面上还有别的 WebSocket，用 requestId 记下真正推送弹幕的那条连接。
    this.cdp.on('Network.webSocketFrameReceived', (params: any) => {
      this.wsCount++;
      const payloadData: string | undefined = params?.response?.payloadData;
      if (!payloadData) return;
      let buf: Uint8Array;
      try {
        buf = Buffer.from(payloadData, 'base64');
      } catch {
        return;
      }
      let decoded;
      try {
        decoded = decodeFrame(buf);
      } catch {
        return;
      }
      this.frameCount++;
      const isPush = decoded.frame.payloadType === 'msg' || decoded.frame.payloadType === 'push';
      if (isPush && params?.requestId) this.pushSockets.add(String(params.requestId));
      // 首次建立，或弹幕通道断开后又收到推送帧（抖音重连）→ 恢复为 live
      if (isPush && this.status !== 'live' && !this.stopped) {
        this.status = 'live';
        this.opts.onOpen?.();
      }
      for (const msg of decoded.messages) {
        this.msgCount++;
        this.opts.onMessage(msg, { roomId: this.roomId });
      }
    });
    this.cdp.on('Network.webSocketClosed', (params: any) => {
      // 页面上其它 WebSocket 关闭与弹幕无关；只有推送弹幕的连接全部关闭才算断开
      if (!this.pushSockets.delete(String(params?.requestId))) return;
      if (!this.stopped && this.pushSockets.size === 0) {
        this.status = 'closed';
        this.opts.onError?.(new Error(`房间 ${this.roomId} wss 连接已关闭`));
      }
    });
    this.page.on('close', () => {
      if (!this.stopped) {
        this.stopped = true;
        this.status = 'closed';
        this.opts.onError?.(new Error(`房间 ${this.roomId} 页面已关闭`));
      }
    });
  }

  /** 等待直播间进入可采集状态：先校验开播状态，再等 wss 建立（最多 timeoutMs） */
  async waitForLive(timeoutMs = 15000): Promise<boolean> {
    // 1) 先判断房间是否在开播（从页面 HTML 读 roomStore.roomInfo.room.status）
    //    已知 2=直播中、4=已结束；其它状态含义未验证，先按「不可采集」处理。
    //    详见 parseRoomStatus 的注释；若未来发现误判，改为仅拒绝明确未开播的值。
    const roomStatus = await this.getRoomStatus();
    if (roomStatus != null && roomStatus !== 2) {
      await this.stop(); // status='closed' + 关闭页面，避免 wss 帧再把状态翻成 live
      return false;
    }
    // 2) 等待 wss 建立；wss 被关闭时提前退出，不必等满超时
    const deadline = Date.now() + timeoutMs;
    while (this.status === 'connecting' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    return this.status === 'live';
  }

  /** 从页面 HTML 解析开播状态（2=直播中，4=已结束）；取不到返回 null */
  async getRoomStatus(): Promise<number | null> {
    try {
      return parseRoomStatus(await this.page.content());
    } catch {
      return null;
    }
  }

  /**
   * 以登录账号在直播间发一条弹幕：在页面输入框里输入并回车，由页面自己完成签名与请求。
   * 多次调用排队执行，两条之间至少间隔 DYHUB_CHAT_INTERVAL_MS。
   * 回车后输入框清空即视为页面已提交；是否真的发出由调用方等回显确认。
   */
  sendChat(text: string): Promise<void> {
    const run = this.sendQueue.then(() => this.doSendChat(text));
    this.sendQueue = run.catch(() => {});
    return run;
  }

  private async doSendChat(text: string): Promise<void> {
    if (this.stopped) throw new Error('会话已停止');
    const wait = this.lastSentAt + CHAT_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const input = this.page.locator(CHAT_INPUT);
    try {
      await input.waitFor({ state: 'visible', timeout: 5000 });
    } catch {
      throw new Error('找不到弹幕输入框（未登录，或抖音改版）');
    }
    await input.click();
    // 上一条没发出去时文字还留在输入框里，先删干净再输入，免得拼在一起或被页面补发
    await this.clearChatInput();
    await this.page.keyboard.insertText(text);
    await this.page.keyboard.press('Enter');
    this.lastSentAt = Date.now();
    await this.page.waitForTimeout(500);
    if (await this.chatInputText()) {
      // 没发出去：删掉，不让这段文字留在页面里
      await this.clearChatInput().catch(() => {});
      throw new Error('回车后输入框未清空，弹幕可能未发出（风控 / 需验证 / 超出字数）');
    }
  }

  /** 输入框里的文字；编辑器空时只剩零宽占位符，算作空 */
  private async chatInputText(): Promise<string> {
    const text = await this.page.locator(CHAT_INPUT).innerText();
    return text.replace(/[​\s]/g, '');
  }

  /**
   * 删光输入框里的文字。Slate 只认真实输入事件，所以用键盘而不是 fill()：先全选再退格，
   * 删不干净就把光标移到末尾逐个退格。
   */
  private async clearChatInput(): Promise<void> {
    const { keyboard } = this.page;
    for (let attempt = 0; attempt < 3; attempt++) {
      const left = await this.chatInputText();
      if (!left) return;
      if (attempt === 0) {
        await keyboard.press('ControlOrMeta+A');
        await keyboard.press('Backspace');
      } else {
        await keyboard.press('ControlOrMeta+ArrowDown');
        await keyboard.press('End');
        for (let i = 0; i < [...left].length + 5; i++) await keyboard.press('Backspace');
      }
    }
    if (await this.chatInputText()) throw new Error('输入框里有删不掉的文字，没有发送');
  }

  streamUrl(): string | null {
    return this.opts.streamUrl?.() ?? null;
  }

  /** 只截播放器画面：页面上最大的 video，没有就用最大的 canvas；都找不到时截整页 */
  async screenshot(): Promise<Buffer> {
    if (this.stopped) throw new Error('会话已停止');
    // 不在回调里定义具名函数：tsx（esbuild keepNames）会注入页面里不存在的 __name
    const clip = await this.page.evaluate(() => {
      for (const selector of ['video', 'canvas']) {
        let best: { x: number; y: number; width: number; height: number } | null = null;
        for (const el of document.querySelectorAll(selector)) {
          const r = el.getBoundingClientRect();
          const x = Math.max(r.left, 0);
          const y = Math.max(r.top, 0);
          const width = Math.min(r.right, innerWidth) - x;
          const height = Math.min(r.bottom, innerHeight) - y;
          if (width > 0 && height > 0 && (!best || width * height > best.width * best.height)) {
            best = { x, y, width, height };
          }
        }
        // 太小的不算播放器（头像、礼物动画等）
        if (best && best.width * best.height > innerWidth * innerHeight * 0.1) return best;
      }
      return null;
    });
    return this.page.screenshot({ type: 'jpeg', quality: 80, timeout: 10000, ...(clip ? { clip } : {}) });
  }
  stats() {
    return { wsCount: this.wsCount, frameCount: this.frameCount, msgCount: this.msgCount };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.status = 'closed';
    try {
      await this.page.close();
    } catch {
      /* ignore */
    }
    // 独立 context（每房间 cookie）关闭后清理
    if (this.ownContext) {
      try {
        await this.ownContext.close();
      } catch {
        /* ignore */
      }
    }
  }
}
