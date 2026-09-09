/**
 * 轻量采集会话（纯代码内核，无浏览器）
 *
 * 链路：cookie 三件套（ttwid / __ac_nonce / __ac_signature）→ room_id 解析
 *       → a_bogus + X-Bogus 签名 → wss 直连 → 心跳(5s) + ack → 帧解码
 *
 * 相比浏览器内核：连接秒级、内存占用极低（无 Chromium 进程），
 * 代价是依赖第三方签名脚本（third_party/douyin-sign，AGPL，见其目录声明），
 * 且抖音签名算法更新时可能失效（可随时回退 DYHUB_COLLECTOR=browser）。
 */

import { WebSocket } from 'ws';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import vm from 'vm';
import protobuf from 'protobufjs';
import { decodeFrame, decodeAckInfo } from '../proto/douyin.proto.js';
import type { RawProtoMessage } from '../proto/douyin.proto.js';
import { parseRoomMeta } from './roomMeta.js';
import type { RoomMeta } from './roomMeta.js';
import * as cookieStore from './cookieStore.js';

// PushFrame 编码器（心跳/ack，字段号与官方 proto 一致）
const PF = protobuf
  .parse('syntax = "proto3"; message PushFrame { uint64 logId = 2; string payloadType = 7; bytes payload = 8; }')
  .root.lookupType('PushFrame');
const hbFrame = Buffer.from(PF.encode({ payloadType: 'hb' }).finish());

// 与签名脚本同源的浏览器 UA（a_bogus 计算与请求头必须一致）
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';
const SIGN_DIR = fileURLToPath(new URL('../../third_party/douyin-sign/', import.meta.url));

interface SignApi {
  getAb: (paramStr: string, ua: string) => string;
  getSign: (md5: string) => string;
}

let signApiCache: SignApi | null = null;

/** 加载签名脚本（vm 沙箱，进程级缓存；抖音 SDK 反混淆产物，勿修改） */
function loadSignApi(): SignApi {
  if (signApiCache) return signApiCache;
  const abogus = readFileSync(`${SIGN_DIR}a_bogus.js`, 'utf8');
  const sign = readFileSync(`${SIGN_DIR}sign.js`, 'utf8');
  const ctx1: Record<string, unknown> = { console };
  vm.createContext(ctx1);
  vm.runInContext(abogus, ctx1);
  const ctx2: Record<string, unknown> = { console, navigator: { userAgent: UA } };
  vm.createContext(ctx2);
  vm.runInContext(sign, ctx2);
  signApiCache = {
    getAb: (p, u) => (ctx1 as any).get_ab(p, u),
    getSign: (m) => (ctx2 as any).get_sign(m),
  };
  return signApiCache;
}

/** __ac_signature 算法（移植自 DouyinLiveWebFetcher/ac_signature.py） */
function acSignature(site: string, nonce: string, ua: string, ts: number): string {
  const cal1 = (s: string, iv: number) => {
    let k = iv;
    for (const c of s) k = ((k ^ c.charCodeAt(0)) * 65599) & 0xffffffff;
    return k;
  };
  const cal2 = (s: string, iv: number) => {
    let k = iv;
    const a = s.length;
    for (let i = 0; i < 32; i++) {
      const idx = k % a;
      k = (k * 65599 + s.charCodeAt(idx)) & 0xffffffff;
    }
    return k;
  };
  const cal3 = (s: string, iv: number) => {
    let k = iv;
    for (const c of s) k = (k * 65599 + c.charCodeAt(0)) & 0xffffffff;
    return k;
  };
  const chr = (c: number) =>
    c < 26 ? String.fromCharCode(c + 65) : c < 52 ? String.fromCharCode(c + 71) : c < 62 ? String.fromCharCode(c - 4) : String.fromCharCode(c - 17);
  const enc = (n: number) => {
    let s = '';
    for (let i = 24; i >= 0; i -= 6) s += chr((n >> i) & 63);
    return s;
  };
  const s1 = cal1(site, 0);
  const s3 = cal1(site, 0);
  const s5 = cal2(site, 0);
  const s2 = cal2(ua, s1);
  const s4 = cal3(ua, s3);
  const s6 = cal3(ua, s5);
  const s7 = (s1 + s2) & 0xffffffff;
  const s8 = (s3 + s4) & 0xffffffff;
  const s9 = (s5 + s6) & 0xffffffff;
  const s10 = (s7 + s8) & 0xffffffff;
  const s11 = (s8 + s9) & 0xffffffff;
  const s12 = (s10 + s11) & 0xffffffff;
  const s13 = (s1 + s4 + s5 + s7 + s9 + s11) & 0xffffffff;
  const s14 = (s2 + s3 + s6 + s8 + s10 + s12) & 0xffffffff;
  const s15 = (s13 + s14) & 0xffffffff;
  return enc(ts & 0xffffffff) + enc(s12) + enc(s15) + enc(ts & 0xffffffff);
}

export interface LightweightSessionOptions {
  onMessage: (msg: RawProtoMessage, meta: { roomId: string }) => void;
  onError?: (err: Error) => void;
}

// 模块级共享 cookie 会话：多房间并发只跑一次 cookie 链，避免高频请求触发抖音风控
const sharedJar = new Map<string, string>();
let sharedJarAt = 0;
const JAR_TTL_MS = 15 * 60_000;
const JAR_FAIL_TTL_MS = 60_000;

function storeCookies(headers: Headers) {
  const all = (headers as any).getSetCookie
    ? (headers as any).getSetCookie()
    : (headers.get('set-cookie') || '').split(',').filter(Boolean);
  for (const c of all) {
    const kv = c.split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) sharedJar.set(kv.slice(0, i).trim(), kv.slice(i + 1));
  }
}

function sharedCookieStr(): string {
  return [...sharedJar].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function ensureSharedCookies(): Promise<void> {
  if (sharedJarAt && Date.now() - sharedJarAt < JAR_TTL_MS) return;

  // 用户通过 Dashboard 或 DYHUB_COOKIE 提供的 cookie（含登录态），绕过 cookie 链请求
  const userCookie = cookieStore.getCookieStr();
  if (userCookie && !sharedJar.size) {
    sharedJar.clear();
    for (const part of userCookie.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) sharedJar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
    // 有 ttwid 即可直接连接 wss；__ac_nonce 存在时补算 __ac_signature
    const nonce = sharedJar.get('__ac_nonce') || '';
    if (sharedJar.get('ttwid')) {
      if (nonce) {
        sharedJar.set('__ac_signature', acSignature('www.douyin.com', nonce, UA, Math.floor(Date.now() / 1000)));
      }
      sharedJarAt = Date.now();
      return;
    }
    sharedJar.clear(); // 缺 ttwid，回退 HTTP cookie 链
  }

  const H = { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' };
  sharedJar.clear();
  sharedJarAt = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let r = await fetch('https://www.douyin.com/', { headers: H, signal: AbortSignal.timeout(10_000) });
      storeCookies(r.headers);
      r = await fetch('https://live.douyin.com/', {
        headers: { ...H, Cookie: sharedCookieStr() },
        signal: AbortSignal.timeout(10_000),
      });
      storeCookies(r.headers);
      const nonce = sharedJar.get('__ac_nonce') || '';
      if (nonce && sharedJar.get('ttwid')) {
        sharedJar.set('__ac_signature', acSignature('www.douyin.com', nonce, UA, Math.floor(Date.now() / 1000)));
        return;
      }
    } catch {
      // 继续重试
    }
    if (attempt < 2) await new Promise((res) => setTimeout(res, 4000 * (attempt + 1)));
  }
  // 全部失败：短缓存，允许快速重试
  sharedJarAt = Date.now() - (JAR_TTL_MS - JAR_FAIL_TTL_MS);
  throw new Error('获取 cookie（ttwid/__ac_nonce）失败');
}

export class LightweightSession {
  readonly roomId: string;
  readonly startedAt = Date.now();
  status: 'connecting' | 'live' | 'error' = 'connecting';

  private ws: WebSocket | null = null;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private errorMsg = '';
  private frameCount = 0;
  private msgCount = 0;
  private liveResolve: ((ok: boolean) => void) | null = null;
  private liveTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** 主播信息（连接时从直播间 HTML 解析，可能为空） */
  meta: RoomMeta | null = null;

  constructor(roomId: string, private readonly opts: LightweightSessionOptions) {
    this.roomId = roomId;
  }

  stats() {
    return {
      wsCount: this.ws?.readyState === WebSocket.OPEN ? 1 : 0,
      frameCount: this.frameCount,
      msgCount: this.msgCount,
    };
  }

  /** 非阻塞启动（异步链路），通过 waitForLive 确认是否进入直播态 */
  start(): void {
    this.startInternal().catch((e) => this.fail(e as Error));
  }

  waitForLive(timeoutMs = 30_000): Promise<boolean> {
    if (this.status === 'live') return Promise.resolve(true);
    if (this.status === 'error') return Promise.resolve(false);
    return new Promise((resolve) => {
      this.liveResolve = resolve;
      this.liveTimeout = setTimeout(() => {
        this.liveResolve = null;
        resolve(false);
      }, timeoutMs);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.liveTimeout) clearTimeout(this.liveTimeout);
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch {
        /* noop */
      }
      this.ws = null;
    }
    this.status = 'connecting';
  }

  // ---------------------------------------------------------------- 内部链路

  private fail(err: Error) {
    if (this.stopped) return;
    this.status = 'error';
    this.errorMsg = err.message;
    this.opts.onError?.(err);
    this.liveResolve?.(false);
  }

  /** 连接前确保共享 cookie 会话就绪 */
  private async initCookies(): Promise<void> {
    await ensureSharedCookies();
  }

  /** web_rid → 内部 webcast roomId（抖音间歇限流，最多重试 3 次；成功时顺带解析主播信息） */
  private async resolveRoomId(): Promise<string> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(`https://live.douyin.com/${this.roomId}`, {
          headers: { 'User-Agent': UA, Cookie: sharedCookieStr(), Referer: `https://live.douyin.com/${this.roomId}` },
          signal: AbortSignal.timeout(12_000),
        });
        const html = (await r.text()).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        const m = html.match(/roomId\\?"\s*[:=]\s*\\?"(\d+)\\?"/) || html.match(/"roomId"\s*:\s*"?(\d+)"?/);
        if (m) {
          this.meta = parseRoomMeta(html);
          return m[1];
        }
        lastErr = new Error('room_id 解析失败（直播间不存在或未开播）');
      } catch (e) {
        lastErr = e as Error;
      }
      if (attempt < 2) await new Promise((res) => setTimeout(res, 2500 * (attempt + 1)));
    }
    throw lastErr ?? new Error('room_id 解析失败');
  }

  private buildWssUrl(roomId: string, signature: string): string {
    const now = Date.now();
    const cursor = `r-${roomId}_d-1_u-1_fh-${roomId}_t-${now}`;
    const internalExt = `internal_src:dim|wss_push_room_id:${roomId}|wss_push_did:${roomId}|first_req_ms:${now}|fetch_time:${now}|seq:1|wss_info:0-${now}-0-0|wrds_v:${roomId}`;
    const params = [
      'app_name=douyin_web',
      'version_code=180800',
      'webcast_sdk_version=1.0.14-beta.0',
      'update_version_code=1.0.14-beta.0',
      'compress=gzip',
      'device_platform=web',
      'cookie_enabled=true',
      'screen_width=1536',
      'screen_height=864',
      'browser_language=zh-CN',
      'browser_platform=Win32',
      'browser_name=Mozilla',
      `browser_version=${encodeURIComponent('5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')}`,
      'browser_online=true',
      'tz_name=Asia/Shanghai',
      `cursor=${encodeURIComponent(cursor)}`,
      `internal_ext=${encodeURIComponent(internalExt)}`,
      'host=https://live.douyin.com',
      'aid=6383',
      'live_id=1',
      'did_rule=3',
      'endpoint=live_pc',
      'support_wrds=1',
      `user_unique_id=${roomId}`,
      'im_path=/webcast/im/fetch/',
      'identity=audience',
      'need_persist_msg_count=15',
      'insert_task_id=',
      'live_reason=',
      `room_id=${roomId}`,
      'heartbeatDuration=0',
    ].join('&');
    return `wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/?${params}&signature=${signature}`;
  }

  private async startInternal(): Promise<void> {
    const { getSign } = loadSignApi();
    await this.initCookies();
    const roomId = await this.resolveRoomId();

    const sigParams =
      `live_id=1,aid=6383,version_code=180800,webcast_sdk_version=1.0.14-beta.0,room_id=${roomId},` +
      `sub_room_id=,sub_channel_id=,did_rule=3,user_unique_id=${roomId},device_platform=web,device_type=,ac=,identity=audience`;
    const signature = getSign(createHash('md5').update(sigParams).digest('hex'));

    const url = this.buildWssUrl(roomId, signature);

    await new Promise<void>((resolve, reject) => {
      // 发送完整 cookie（含登录态），使 webcast 服务端推送礼物事件
      const ws = new WebSocket(url, {
        headers: { 'User-Agent': UA, Cookie: sharedCookieStr() },
        handshakeTimeout: 15_000,
      });
      this.ws = ws;

      ws.on('open', () => {
        // 心跳 5s（与浏览器页面行为一致）
        this.hbTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(hbFrame);
        }, 5000);
        resolve();
      });
      ws.on('unexpected-response', (_q, res) => reject(new Error(`wss 握手被拒 HTTP ${res.statusCode}`)));
      ws.on('error', (e) => reject(e));
      ws.on('close', () => {
        if (this.stopped) return;
        this.fail(new Error('wss 连接断开'));
      });
      ws.on('message', (data: Buffer) => this.onFrame(new Uint8Array(data)));
    });
  }

  private onFrame(buf: Uint8Array) {
    if (this.stopped) return;
    this.frameCount++;
    try {
      const { frame, messages } = decodeFrame(buf);

      // ack：服务端需要确认时回 PushFrame(payload_type=ack)
      if (frame.payloadType !== 'hb') {
        const ack = decodeAckInfo(buf);
        if (ack.needAck && this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(PF.encode({ logId: ack.logId, payloadType: 'ack', payload: Buffer.from(ack.internalExt, 'utf8') }).finish());
        }
      }

      for (const m of messages) {
        this.msgCount++;
        this.opts.onMessage(m, { roomId: this.roomId });
        if (this.status !== 'live') {
          this.status = 'live';
          this.liveResolve?.(true);
          this.liveResolve = null;
          if (this.liveTimeout) clearTimeout(this.liveTimeout);
        }
      }
    } catch {
      // 非业务帧，忽略
    }
  }
}
