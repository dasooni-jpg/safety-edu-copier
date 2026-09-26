/* 주의: 이 파일은 원본(template)입니다. 그대로 배포하면 맨 아래 자리표시자가
 *       치환되지 않아 오류가 납니다.
 *       build-skysquad-worker.ps1 을 돌려 나오는 skysquad-worker.js 를 배포하세요.
 *       Durable Objects 는 대시보드 붙여넣기로 배포할 수 없습니다 (wrangler 필요).
 */
/*
 * 하늘편대 100 — 온라인 협동 서버 (Cloudflare Worker + Durable Objects)
 * ──────────────────────────────────────────────────────────────
 *  방 하나 = Durable Object 하나. 같은 4글자 코드를 넣은 아이들이 같은 하늘로 모입니다.
 *
 *  게임 진행(적 등장·이동·충돌·보스)은 전부 서버가 계산합니다(server-authoritative).
 *  클라이언트는 "내 비행기가 가려는 자리"와 폭탄 여부만 보내고,
 *  서버가 20Hz로 계산해 상태를 되돌려줍니다.
 *
 *  대역폭 아끼기 — 총알은 매 틱 위치를 보내지 않고 "새로 생김 / 사라짐"만 알립니다.
 *  총알은 직선으로만 날아가므로 각 화면이 태어난 틱을 기준으로 스스로 굴립니다.
 *  (유도탄만 매 틱 위치를 보냅니다.)
 */

import { DurableObject } from "cloudflare:workers";

/* ── 게임 계산기 (skysquad-app/sim.js 를 그대로 심습니다) ── */
__SIM_JS__

const TICK_MS = SkySim.TICK_MS;
const MAX_PLAYERS = SkySim.MAX_PLAYERS;
const EMPTY_CLOSE_MS = 45000;     // 아무도 없으면 정리 (요금 방지)
const IDLE_KICK_MS = 90000;       // 신호가 끊긴 접속 정리
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 헷갈리는 0/O/1/I 제외

const validCode = (c) => /^[A-Z0-9]{4}$/.test(c);
const roomName = (c) => 'sky:' + c;

/* ═══════════════ 방 하나 = Durable Object 하나 ═══════════════ */
export class SkyRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.conns = new Map();      // ws → { id, name, color, last }
    this.game = null;
    this.nextId = 1;
    this.timer = null;
    this.emptyAt = 0;
    this.best = 1;               // 이 방이 밟아 본 가장 높은 단계
    this.loaded = false;
    this.code = '';
    this.errs = 0;
    this.savedBest = 1;
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const b = await this.ctx.storage.get('best');
      if (b) { this.best = SkySim.clamp(b | 0, 1, SkySim.TOTAL_STAGES); this.savedBest = this.best; }
    } catch (e) { /* 저장소를 못 읽어도 게임은 굴러갑니다 */ }
  }

  async fetch(request) {
    await this.load();
    const url = new URL(request.url);
    this.code = url.searchParams.get('room') || this.code;

    // 방 정보 (코드를 입력할 때 미리 보여 주는 용도)
    if (url.pathname === '/info') {
      return Response.json({
        exists: this.conns.size > 0,
        players: this.conns.size,
        stage: this.game ? this.game.stage : this.best,
        best: this.best,
        names: [...this.conns.values()].map((c) => c.name),
      });
    }

    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // 실시간 게임이라 최면(hibernation)을 쓸 수 없습니다.
    // 대신 아무도 없으면 곧바로 타이머를 멈춰 과금을 끊습니다.
    server.accept();

    // 정원이 넘치면 핸드셰이크를 거절하지 않고, 연결한 뒤 이유를 말해 주고 닫습니다.
    if (this.conns.size >= MAX_PLAYERS) {
      this.send(server, { a: 'err', msg: '방이 꽉 찼어요. 정원은 ' + MAX_PLAYERS + '명이에요.' });
      try { server.close(4001, 'room full'); } catch (e) { }
      return new Response(null, { status: 101, webSocket: client });
    }

    const name = this.uniqueName((url.searchParams.get('name') || '조종사').slice(0, 8));
    const color = SkySim.clamp(parseInt(url.searchParams.get('color') || '0', 10) || 0, 0, 5);
    const wantStage = parseInt(url.searchParams.get('stage') || '0', 10) || 0;
    const id = this.nextId++;

    // 첫 사람이 들어올 때 방을 엽니다. 시작 단계는 이 방이 깬 데까지만 고를 수 있습니다.
    if (!this.game || this.conns.size === 0) {
      const start = wantStage ? SkySim.clamp(wantStage, 1, this.best) : this.best;
      this.game = new SkySim.Game({ stage: start, seed: (Date.now() & 0xffff), best: this.best });
    }

    this.conns.set(server, { id, name, color, last: Date.now() });
    this.game.addPlayer(id, name, color);
    this.emptyAt = 0;

    server.addEventListener('message', (ev) => this.onMessage(server, ev));
    server.addEventListener('close', () => this.drop(server));
    server.addEventListener('error', () => this.drop(server));

    this.send(server, {
      a: 'welcome', id, room: this.code, ver: SkySim.VERSION, tick: TICK_MS,
      stage: this.game.stage, best: this.best,
      players: this.roster(),
    });
    this.broadcast({ a: 'roster', players: this.roster() });
    this.start();

    return new Response(null, { status: 101, webSocket: client });
  }

  roster() {
    return [...this.conns.values()].map((c) => ({ id: c.id, name: c.name, color: c.color }));
  }
  uniqueName(n) {
    n = (n || '조종사').trim() || '조종사';
    const used = new Set([...this.conns.values()].map((c) => c.name));
    if (!used.has(n)) return n;
    for (let i = 2; i < 20; i++) if (!used.has(n + i)) return n + i;
    return n + Math.floor(Math.random() * 90 + 10);
  }

  onMessage(ws, ev) {
    const c = this.conns.get(ws);
    if (!c) return;
    c.last = Date.now();
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.a === 'i') {
      if (!this.game) return;
      this.game.setInput(c.id, { tx: Number(m.tx), ty: Number(m.ty), bomb: !!m.b });
    } else if (m.a === 'p') {
      this.send(ws, { a: 'p', s: m.s });
    }
  }

  drop(ws) {
    const c = this.conns.get(ws);
    if (!c) return;
    this.conns.delete(ws);
    if (this.game) this.game.removePlayer(c.id);
    try { ws.close(); } catch (e) { }
    if (this.conns.size === 0) this.emptyAt = Date.now();
    else this.broadcast({ a: 'roster', players: this.roster() });
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) { } }
  broadcast(obj) {
    const msg = JSON.stringify(obj);
    let dead = null;
    for (const ws of this.conns.keys()) {
      try { ws.send(msg); } catch (e) { (dead || (dead = [])).push(ws); }
    }
    // 보내기가 실패한 접속은 반복이 끝난 뒤에 정리합니다 (drop 이 다시 broadcast 를 부릅니다)
    if (dead) for (const ws of dead) this.drop(ws);
  }

  /* ── 20Hz 루프 ── */
  start() {
    if (this.timer) return;
    this.errs = 0;
    this.timer = setInterval(() => {
      // 한 번 튀었다고 방을 멈추면 모두가 얼어붙습니다. 연달아 실패할 때만 멈춥니다.
      try { this.tick(); this.errs = 0; }
      catch (e) { if (++this.errs > 5) this.stop(); }
    }, TICK_MS);
  }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  tick() {
    const now = Date.now();

    // 아무도 없으면 루프를 멈춥니다 (Durable Object 과금은 깨어 있는 시간 기준)
    if (this.conns.size === 0) {
      if (!this.emptyAt) this.emptyAt = now;
      if (now - this.emptyAt > EMPTY_CLOSE_MS) { this.stop(); this.game = null; }
      return;
    }
    // 신호가 끊긴 접속 정리 (클라이언트는 50ms 마다 입력을 보냅니다)
    for (const [ws, c] of this.conns) if (now - c.last > IDLE_KICK_MS) this.drop(ws);
    if (!this.game) return;

    this.game.step();

    // 이 방이 더 멀리 갔으면 기억해 둡니다 (다음 시간에 이어서 하도록)
    if (this.game.best > this.best) {
      this.best = this.game.best;
      if (this.best - this.savedBest >= 1) {
        this.savedBest = this.best;
        try { this.ctx.storage.put('best', this.best); } catch (e) { }
      }
    }

    this.broadcast({ a: 's', s: this.game.snapshot() });
  }
}

/* ═══════════════ 워커 (정적 파일 + 방 연결) ═══════════════ */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/' || path === '/index.html') {
      return new Response(APP_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    if (path === '/sim.js') {
      return new Response(SIM_TEXT, {
        headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    // 새 방 코드 — 아무도 없는 방이 나올 때까지 몇 번 뽑아 봅니다
    if (path === '/api/newroom') {
      for (let tries = 0; tries < 5; tries++) {
        let code = '';
        for (let i = 0; i < 4; i++) code += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
        const stub = env.SKY_ROOM.get(env.SKY_ROOM.idFromName(roomName(code)));
        try {
          const r = await stub.fetch(new Request('https://x/info?room=' + code));
          const j = await r.json();
          if (!j.players) return Response.json({ ok: true, room: code });
        } catch (e) {
          return Response.json({ ok: true, room: code });
        }
      }
      return Response.json({ ok: false, msg: '방 코드를 만들지 못했어요. 다시 눌러 주세요.' }, { status: 503 });
    }

    // 방 정보 미리 보기
    if (path.startsWith('/api/room/')) {
      const code = path.slice('/api/room/'.length).toUpperCase();
      if (!validCode(code)) return Response.json({ exists: false });
      const stub = env.SKY_ROOM.get(env.SKY_ROOM.idFromName(roomName(code)));
      return stub.fetch(new Request('https://x/info?room=' + code));
    }

    // 방 접속 (WebSocket)
    if (path === '/ws') {
      const code = String(url.searchParams.get('room') || '').toUpperCase();
      if (!validCode(code)) return new Response('bad room code', { status: 400 });
      const stub = env.SKY_ROOM.get(env.SKY_ROOM.idFromName(roomName(code)));
      return stub.fetch(request);
    }

    return new Response('not found', { status: 404 });
  },
};

const APP_HTML = __APP_HTML__;
const SIM_TEXT = __SIM_TEXT__;
