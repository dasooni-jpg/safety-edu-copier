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
/* ─────────────────────────────────────────────────────────────
 *  하늘편대 100 — 게임 시뮬레이션 코어
 *
 *  이 파일은 화면(DOM/캔버스)도, 네트워크도 건드리지 않는 순수 계산기입니다.
 *  그래서 세 곳에서 똑같이 돌아갑니다.
 *    1) Cloudflare Durable Object  … 진짜 온라인 방(서버 권위)
 *    2) 브라우저(index.html)       … "혼자 연습" 모드(서버 없이)
 *    3) _test.html                 … 자동 테스트
 *
 *  좌표계는 가로 1600 × 세로 900 고정. 화면 크기는 클라이언트가 알아서 맞춥니다.
 *  아군은 왼쪽, 적은 오른쪽에서 들어옵니다.
 * ───────────────────────────────────────────────────────────── */
var SkySim = (function () {
  'use strict';

  // 서버·클라이언트가 다르면 접속 시 경고를 띄우려고 둡니다.
  const VERSION = 1;

  const FIELD = { w: 1600, h: 900 };
  const TICK_MS = 50;               // 20Hz
  const DT = TICK_MS / 1000;
  const MAX_PLAYERS = 6;
  const TOTAL_STAGES = 100;

  // ── 아군 ──
  const P_SPEED = 660;              // px/s (목표 지점까지 최대 속도)
  const P_R = 17;                   // 피격 판정 반경 (그림보다 작게 — 아이들이 잘 피하도록)
  const P_MAXHP = 100;
  const P_LIVES = 3;
  const REVIVE_R = 120;             // 이 거리 안에서 버티면 친구를 살립니다
  const REVIVE_SEC = 2.2;
  const DOWN_SEC = 14;              // 아무도 안 오면 목숨 하나 쓰고 스스로 일어남
  const SPAWN_INV = 2.6;            // 부활 직후 무적 시간
  const HIT_INV = 0.55;             // 한 번 맞으면 잠깐 무적 — 적과 몸이 겹쳐도 초당 두 번까지만 아픕니다
  const CONTACT_DMG = 12;           // 적기와 부딪혔을 때 기본 피해
  const BOMB_START = 2;
  const BOMB_MAX = 5;
  const BOMB_R = 620;

  // ── 페이즈 ──
  //  ready → play → (boss) → clear → ready(다음 스테이지)
  //  전멸하면 wipe → ready(같은 스테이지 다시)
  const READY_SEC = 3.2;
  const CLEAR_SEC = 4.6;
  const WIPE_SEC = 3.4;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const d2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
  const R1 = (v) => Math.round(v);

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ═══════════════════ 세계관: 10개 지역 × 10단계 ═══════════════════ */
  const ZONES = [
    { key: 'dawn',    name: '새벽 하늘',   sky: ['#ffd9a0', '#7fb4e8', '#3f6fae'], accent: '#ff9d47', dust: '#fff2d0' },
    { key: 'cloud',   name: '구름 바다',   sky: ['#cfe9ff', '#7fb8e8', '#3d78b8'], accent: '#38b6ff', dust: '#ffffff' },
    { key: 'sunset',  name: '노을 협곡',   sky: ['#ffb56b', '#f2687f', '#5b3d84'], accent: '#ff5f7e', dust: '#ffd0a8' },
    { key: 'night',   name: '별밤 항로',   sky: ['#1b2452', '#2b3a75', '#0d1130'], accent: '#8fb6ff', dust: '#dfe8ff' },
    { key: 'aurora',  name: '오로라 지대', sky: ['#06304a', '#0d6b6b', '#07213a'], accent: '#6bffd0', dust: '#a8ffe8' },
    { key: 'desert',  name: '모래 폭풍',   sky: ['#e8c07a', '#c98a44', '#8a5a2b'], accent: '#ffcf6b', dust: '#f7e0b0' },
    { key: 'volcano', name: '화산재 하늘', sky: ['#3a1414', '#7a2a1c', '#2a0d0d'], accent: '#ff6b3d', dust: '#ffb08a' },
    { key: 'glacier', name: '빙하 상공',   sky: ['#c3e6f8', '#6fb0d8', '#2d6b93'], accent: '#7fe0ff', dust: '#ffffff' },
    { key: 'strato',  name: '성층권',      sky: ['#0a1a3a', '#1e3f7a', '#050a1c'], accent: '#7fa8ff', dust: '#cfe0ff' },
    { key: 'space',   name: '우주 관문',   sky: ['#07040f', '#1a0a2e', '#000000'], accent: '#c07bff', dust: '#e8d0ff' },
  ];

  /* ═══════════════════ 적 도감 ═══════════════════ */
  //  hp/속도는 기준값. 스테이지가 오를수록 곱해집니다.
  const ENEMY = {
    scout:    { hp: 14, r: 22, spd: 215, score: 10, art: 'scout',   fire: { every: 2.3, k: 'aim1' } },
    wasp:     { hp: 8,  r: 15, spd: 340, score: 8,  art: 'wasp' },
    bomber:   { hp: 50, r: 34, spd: 125, score: 26, art: 'bomber',  fire: { every: 1.7, k: 'drop' } },
    sniper:   { hp: 22, r: 23, spd: 270, score: 22, art: 'sniper',  fire: { every: 2.7, k: 'burst3' }, stop: 0.62 },
    kamikaze: { hp: 16, r: 19, spd: 430, score: 18, art: 'kami',    contact: 34 },
    shieldy:  { hp: 44, r: 28, spd: 155, score: 30, art: 'shield',  fire: { every: 2.5, k: 'spread3' }, front: true },
    turret:   { hp: 58, r: 30, spd: 175, score: 34, art: 'turret',  fire: { every: 1.6, k: 'radial8' }, stop: 0.70 },
    splitter: { hp: 36, r: 31, spd: 185, score: 24, art: 'split',   split: 'splitlet' },
    splitlet: { hp: 10, r: 17, spd: 300, score: 6,  art: 'splitlet' },
    healer:   { hp: 32, r: 24, spd: 195, score: 38, art: 'healer',  heal: true },
    missiler: { hp: 46, r: 28, spd: 165, score: 34, art: 'missile', fire: { every: 3.1, k: 'homing2' }, stop: 0.66 },
    lancer:   { hp: 54, r: 30, spd: 155, score: 42, art: 'lancer',  fire: { every: 3.6, k: 'beam' },    stop: 0.72 },
    mine:     { hp: 22, r: 26, spd: 75,  score: 12, art: 'mine',    contact: 26 },
  };

  // 지역이 올라가면서 새 적이 합류합니다 (1지역부터 차례로).
  const ROSTER = [
    ['scout', 'wasp', 'bomber'],
    ['scout', 'wasp', 'bomber', 'kamikaze'],
    ['scout', 'wasp', 'bomber', 'sniper', 'kamikaze'],
    ['scout', 'wasp', 'sniper', 'kamikaze', 'mine', 'shieldy'],
    ['wasp', 'bomber', 'sniper', 'shieldy', 'mine', 'turret'],
    ['scout', 'sniper', 'kamikaze', 'shieldy', 'turret', 'splitter'],
    ['wasp', 'bomber', 'shieldy', 'turret', 'splitter', 'missiler'],
    ['sniper', 'shieldy', 'turret', 'splitter', 'missiler', 'mine', 'healer'],
    ['bomber', 'turret', 'splitter', 'missiler', 'healer', 'kamikaze', 'lancer'],
    ['sniper', 'shieldy', 'turret', 'splitter', 'missiler', 'healer', 'lancer', 'kamikaze'],
  ];

  /* ═══════════════════ 보스 10기 ═══════════════════ */
  //  공격은 몇 가지 기본기(radial/spread/aimed/rain/beam/summon/charge/spiral/wall)를
  //  조합해서 만듭니다. 값만 달라도 느낌이 확 달라지므로 10기가 각자 성격을 갖습니다.
  const BOSSES = [
    { key: 'fortress', name: '구름 요새',     art: 'fortress', hp: 8100,  r: 105,
      phases: [
        { at: 1.00, move: 'hover', atk: [{ k: 'spread', every: 1.9, n: 7, arc: 0.9, spd: 250 }, { k: 'summon', every: 7.0, type: 'wasp', n: 3 }] },
        { at: 0.50, move: 'sway',  atk: [{ k: 'radial', every: 2.2, n: 16, spd: 235 }, { k: 'aimed', every: 1.2, n: 3, spd: 330 }] },
      ] },
    { key: 'hive', name: '벌집 모함',         art: 'hive', hp: 11200, r: 112,
      phases: [
        { at: 1.00, move: 'sway',   atk: [{ k: 'summon', every: 3.4, type: 'wasp', n: 5 }, { k: 'aimed', every: 1.6, n: 2, spd: 300 }] },
        { at: 0.55, move: 'charge', atk: [{ k: 'summon', every: 4.2, type: 'kamikaze', n: 3 }, { k: 'spread', every: 1.5, n: 9, arc: 1.4, spd: 270 }] },
      ] },
    { key: 'zeppelin', name: '노을 비행선',   art: 'zeppelin', hp: 14400, r: 120,
      phases: [
        { at: 1.00, move: 'hover', atk: [{ k: 'beam', every: 4.4, warn: 1.1, w: 46 }, { k: 'spread', every: 2.0, n: 5, arc: 0.7, spd: 280 }] },
        { at: 0.60, move: 'sway',  atk: [{ k: 'beam', every: 3.2, warn: 0.9, w: 60 }, { k: 'rain', every: 1.8, n: 6, spd: 240 }] },
        { at: 0.28, move: 'sway',  atk: [{ k: 'radial', every: 1.8, n: 20, spd: 250 }, { k: 'beam', every: 2.8, warn: 0.8, w: 70 }] },
      ] },
    { key: 'batwing', name: '밤의 박쥐폭격기', art: 'batwing', hp: 18000, r: 118,
      phases: [
        { at: 1.00, move: 'sway',   atk: [{ k: 'homing', every: 2.6, n: 2 }, { k: 'rain', every: 1.5, n: 5, spd: 250 }] },
        { at: 0.55, move: 'charge', atk: [{ k: 'homing', every: 2.0, n: 3 }, { k: 'spiral', every: 0.14, n: 2, spd: 235, turn: 0.42 }] },
      ] },
    { key: 'prism', name: '오로라 수정체',    art: 'prism', hp: 22500, r: 108,
      phases: [
        { at: 1.00, move: 'orbit', atk: [{ k: 'wall', every: 2.6, n: 13, gap: 3, spd: 230 }, { k: 'aimed', every: 1.4, n: 3, spd: 340 }] },
        { at: 0.62, move: 'orbit', atk: [{ k: 'spiral', every: 0.12, n: 3, spd: 250, turn: -0.5 }] },
        { at: 0.30, move: 'sway',  atk: [{ k: 'wall', every: 2.0, n: 15, gap: 2, spd: 260 }, { k: 'radial', every: 2.4, n: 24, spd: 220 }] },
      ] },
    { key: 'sandworm', name: '모래 폭풍룡',   art: 'sandworm', hp: 27900, r: 126,
      phases: [
        { at: 1.00, move: 'charge', atk: [{ k: 'spread', every: 1.5, n: 11, arc: 1.6, spd: 280 }] },
        { at: 0.60, move: 'charge', atk: [{ k: 'spiral', every: 0.11, n: 2, spd: 265, turn: 0.6 }, { k: 'summon', every: 6.0, type: 'mine', n: 4 }] },
        { at: 0.28, move: 'sway',   atk: [{ k: 'radial', every: 1.5, n: 22, spd: 260 }, { k: 'aimed', every: 0.9, n: 4, spd: 380 }] },
      ] },
    { key: 'magma', name: '화산 거인',        art: 'magma', hp: 34200, r: 132,
      phases: [
        { at: 1.00, move: 'hover',  atk: [{ k: 'rain', every: 1.1, n: 7, spd: 270 }, { k: 'aimed', every: 1.8, n: 3, spd: 340 }] },
        { at: 0.62, move: 'sway',   atk: [{ k: 'beam', every: 3.0, warn: 0.85, w: 78 }, { k: 'rain', every: 1.0, n: 8, spd: 290 }] },
        { at: 0.30, move: 'charge', atk: [{ k: 'radial', every: 1.4, n: 26, spd: 270 }, { k: 'summon', every: 5.5, type: 'kamikaze', n: 3 }] },
      ] },
    { key: 'icequeen', name: '빙하 여왕',     art: 'icequeen', hp: 39600, r: 122,
      phases: [
        { at: 1.00, move: 'sway',  atk: [{ k: 'wall', every: 2.2, n: 15, gap: 2, spd: 250 }, { k: 'split', every: 2.8, n: 5, spd: 260, at: 0.55 }] },
        { at: 0.60, move: 'orbit', atk: [{ k: 'spiral', every: 0.10, n: 3, spd: 260, turn: 0.55 }, { k: 'homing', every: 3.0, n: 2 }] },
        { at: 0.28, move: 'sway',  atk: [{ k: 'radial', every: 1.3, n: 28, spd: 265 }, { k: 'split', every: 2.2, n: 7, spd: 280, at: 0.5 }] },
      ] },
    { key: 'interceptor', name: '성층권 요격기', art: 'interceptor', hp: 46800, r: 112,
      phases: [
        { at: 1.00, move: 'charge', atk: [{ k: 'aimed', every: 0.9, n: 3, spd: 420 }, { k: 'summon', every: 6.5, type: 'sniper', n: 2 }] },
        { at: 0.62, move: 'charge', atk: [{ k: 'clone', every: 8.0 }, { k: 'spread', every: 1.2, n: 9, arc: 1.2, spd: 320 }] },
        { at: 0.30, move: 'orbit',  atk: [{ k: 'spiral', every: 0.09, n: 4, spd: 290, turn: -0.62 }, { k: 'beam', every: 3.4, warn: 0.7, w: 66 }] },
      ] },
    { key: 'motherstar', name: '우주 모함 오리온', art: 'motherstar', hp: 63000, r: 142,
      phases: [
        { at: 1.00, move: 'hover',  atk: [{ k: 'wall', every: 2.4, n: 17, gap: 3, spd: 250 }, { k: 'summon', every: 5.0, type: 'turret', n: 2 }] },
        { at: 0.72, move: 'sway',   atk: [{ k: 'spiral', every: 0.10, n: 3, spd: 270, turn: 0.5 }, { k: 'homing', every: 2.4, n: 3 }] },
        { at: 0.46, move: 'charge', atk: [{ k: 'beam', every: 2.6, warn: 0.75, w: 84 }, { k: 'rain', every: 1.0, n: 8, spd: 300 }] },
        { at: 0.20, move: 'orbit',  atk: [{ k: 'radial', every: 1.2, n: 30, spd: 280 }, { k: 'aimed', every: 0.8, n: 5, spd: 420 }, { k: 'summon', every: 7.0, type: 'kamikaze', n: 4 }] },
      ] },
  ];

  /* ═══════════════════ 무기 ═══════════════════ */
  //  5단계까지 올라갑니다. dmg 는 한 발당 피해.
  const GUNS = [
    null,
    { cd: 0.170, shots: [{ a: 0, dy: 0, dmg: 13, big: 1 }] },
    { cd: 0.170, shots: [{ a: 0, dy: -9, dmg: 11, big: 1 }, { a: 0, dy: 9, dmg: 11, big: 1 }] },
    { cd: 0.180, shots: [{ a: 0, dy: 0, dmg: 15, big: 2 }, { a: -0.10, dy: -10, dmg: 11, big: 1 }, { a: 0.10, dy: 10, dmg: 11, big: 1 }] },
    { cd: 0.180, shots: [{ a: 0, dy: -6, dmg: 16, big: 2 }, { a: 0, dy: 6, dmg: 16, big: 2 },
                         { a: -0.16, dy: -14, dmg: 11, big: 1 }, { a: 0.16, dy: 14, dmg: 11, big: 1 }] },
    { cd: 0.190, shots: [{ a: 0, dy: 0, dmg: 26, big: 2, pierce: 1 },
                         { a: -0.09, dy: -9, dmg: 17, big: 2 }, { a: 0.09, dy: 9, dmg: 17, big: 2 },
                         { a: -0.26, dy: -18, dmg: 12, big: 1 }, { a: 0.26, dy: 18, dmg: 12, big: 1 },
                         { a: Math.PI, dy: 0, dmg: 10, big: 1 }] },
  ];
  const GUN_MAX = 5;
  const BULLET_SPD = 1500;          // 빠를수록 화면에 깔리는 총알이 줄어듭니다

  const PICKUPS = ['pow', 'heal', 'bomb', 'shield', 'star'];

  /* ═══════════════════ 단계 설계 ═══════════════════ */
  //  같은 단계는 언제나 똑같이 나옵니다(시드 고정) — 아이들이 패턴을 익힐 수 있게.
  function stagePlan(n) {
    n = clamp(n | 0, 1, TOTAL_STAGES);
    const zone = Math.min(9, Math.floor((n - 1) / 10));
    const isBoss = n % 10 === 0;
    const rng = mulberry32(0x5ca1ab1e ^ Math.imul(n, 2654435761));
    const tier = (n - 1) / (TOTAL_STAGES - 1);         // 0 … 1
    const hpMul = 1 + (n - 1) * 0.085;                 // 100단계에서 약 9.4배
    const spdMul = 1 + tier * 0.55;
    const fireMul = 1 - tier * 0.42;                   // 발사 간격이 짧아짐
    const pool = ROSTER[zone];
    const forms = ['line', 'v', 'sine', 'arc', 'rush', 'wall', 'zigzag', 'swarm', 'split', 'corner'];

    const waves = [];
    const waveN = isBoss ? 2 : 4 + Math.floor((n % 10) / 3);   // 4~7
    let lastType = null, lastForm = null;
    for (let i = 0; i < waveN; i++) {
      // 바로 앞 웨이브와는 다른 적·다른 대열이 나오게 합니다 (같은 게 이어지면 지루합니다)
      const tPool = pool.filter((t) => t !== lastType);
      const type = tPool[Math.floor(rng() * tPool.length)];
      const fPool = forms.filter((f) => f !== lastForm);
      const form = fPool[Math.floor(rng() * fPool.length)];
      lastType = type; lastForm = form;
      const base = ENEMY[type];
      let count = 6 + Math.floor(rng() * 5) + Math.floor(tier * 7);
      if (base.hp >= 40) count = Math.max(3, Math.round(count * 0.55));
      if (type === 'mine') count = Math.max(3, Math.round(count * 0.5));   // 기뢰는 느려서 화면에 쌓입니다
      if (type === 'wasp') count = Math.round(count * 1.5);
      waves.push({
        type, form, count,
        hp: Math.max(1, Math.round(base.hp * hpMul * (isBoss ? 0.7 : 1))),
        spd: base.spd * spdMul,
        fire: Math.max(0.4, (base.fire ? base.fire.every : 99) * fireMul),
        gap: Math.max(0.14, (0.34 - tier * 0.15) * (type === 'wasp' ? 0.6 : 1)),
      });
    }
    const plan = { n, zone, isBoss, waves, tier };
    if (isBoss) {
      const b = BOSSES[zone];
      plan.boss = { key: b.key, hp: Math.round(b.hp), fire: Math.max(0.5, fireMul + 0.15) };
    }
    return plan;
  }

  // 대열 만들기 — 등장 위치·경로를 정해 줍니다.
  function buildSpawns(w, rng) {
    const out = [];
    const N = w.count;
    const x0 = FIELD.w + 70;
    for (let i = 0; i < N; i++) {
      const f = N === 1 ? 0.5 : i / (N - 1);
      let x = x0, y = 140 + f * (FIELD.h - 280), delay = i * w.gap, pat = 'straight', amp = 0, per = 1, hold = 0;
      switch (w.form) {
        case 'line':   break;
        case 'v':      x = x0 + Math.abs(f - 0.5) * 260; break;
        case 'sine':   pat = 'sine'; amp = 90 + rng() * 70; per = 1.6 + rng() * 1.2; y = 200 + f * (FIELD.h - 400); break;
        case 'arc':    x = x0 + Math.sin(f * Math.PI) * 240; pat = 'sine'; amp = 50; per = 2.4; break;
        case 'rush':   y = 150 + rng() * (FIELD.h - 300); delay = i * w.gap * 0.55; pat = 'dive'; break;
        case 'wall':   delay = Math.floor(i / 2) * w.gap * 1.6; y = 120 + f * (FIELD.h - 240); break;
        case 'zigzag': pat = 'zig'; amp = 150; per = 1.1; y = 200 + f * (FIELD.h - 400); break;
        case 'swarm':  x = x0 + rng() * 320; y = 130 + rng() * (FIELD.h - 260); delay = i * w.gap * 0.7; pat = 'sine'; amp = 60 + rng() * 60; per = 1.2 + rng(); break;
        case 'split':  y = i % 2 === 0 ? 150 + (f * 0.5) * (FIELD.h - 300) : FIELD.h - 150 - (f * 0.5) * (FIELD.h - 300); break;
        case 'corner': y = i % 2 === 0 ? 130 : FIELD.h - 130; x = x0 + (i % 4) * 90; pat = 'sine'; amp = 40; per = 3; break;
      }
      const def = ENEMY[w.type];
      // 멈춰서 쏘는 적들이 전부 같은 x 에 서면 화면을 가로막는 벽이 됩니다.
      // 기체마다 서는 자리를 조금씩 다르게 해서 앞뒤로 흩어지게 합니다.
      if (def.stop) { pat = 'stop'; hold = def.stop + ((i % 4) - 1.5) * 0.055; }
      if (w.type === 'kamikaze') pat = 'home';
      if (w.type === 'mine') pat = 'drift';
      out.push({ x, y: clamp(y, 90, FIELD.h - 90), delay, pat, amp, per, hold });
    }
    return out;
  }

  /* ═══════════════════ 게임 ═══════════════════ */
  class Game {
    constructor(opts) {
      opts = opts || {};
      this.tick = 0;
      this.stage = clamp(opts.stage || 1, 1, TOTAL_STAGES);
      this.players = new Map();
      this.enemies = [];
      this.bullets = [];
      this.beams = [];
      this.pickups = [];
      this.boss = null;
      this.fx = [];
      this.newBullets = [];
      this.deadBullets = [];
      this.nid = 1;
      this.score = 0;
      this.rng = mulberry32(opts.seed || 12345);
      this.phase = 'idle';
      this.phT = 0;
      this.plan = null;
      this.dmgMul = 1;             // startStage 에서 단계에 맞게 다시 정합니다
      this.waveIdx = 0;
      this.waveT = 0;
      this.spawnQ = [];
      this.banner = '';
      this.best = opts.best || 1;   // 이 방이 밟아 본 가장 높은 단계
      this.log = [];                // 마지막 스테이지 결과 (클리어 화면용)
    }

    // ── 사람 관리 ──
    addPlayer(id, name, color) {
      if (this.players.size >= MAX_PLAYERS) return null;
      const slot = this.players.size;
      const p = {
        id, name: (name || '조종사').slice(0, 8), color: color || 0,
        x: 170 + (slot % 2) * 60, y: 180 + slot * 120, tx: 170, ty: 180 + slot * 120,
        hp: P_MAXHP, lives: P_LIVES, gun: 1, bombs: BOMB_START,
        down: false, downT: 0, revT: 0, invT: SPAWN_INV, shieldT: 0,
        fireCd: 0, score: 0, kills: 0, deaths: 0, ang: 0, alive: true, joinT: 0,
      };
      p.y = clamp(p.y, 120, FIELD.h - 120); p.ty = p.y;
      this.players.set(id, p);
      if (this.phase === 'idle') this.startStage(this.stage);
      return p;
    }
    removePlayer(id) {
      this.players.delete(id);
      if (this.players.size === 0) { this.phase = 'idle'; this.clearField(); }
    }
    setInput(id, inp) {
      const p = this.players.get(id);
      if (!p) return;
      if (typeof inp.tx === 'number' && isFinite(inp.tx)) p.tx = clamp(inp.tx, 0, FIELD.w);
      if (typeof inp.ty === 'number' && isFinite(inp.ty)) p.ty = clamp(inp.ty, 0, FIELD.h);
      if (inp.bomb) this.useBomb(p);
    }
    alivePlayers() { const a = []; for (const p of this.players.values()) if (!p.down) a.push(p); return a; }

    clearField() {
      this.enemies.length = 0; this.beams.length = 0; this.pickups.length = 0; this.boss = null;
      for (const b of this.bullets) this.deadBullets.push(b.id);
      this.bullets.length = 0;
    }

    // ── 스테이지 흐름 ──
    startStage(n) {
      this.stage = clamp(n, 1, TOTAL_STAGES);
      this.best = Math.max(this.best, this.stage);
      this.plan = stagePlan(this.stage);
      this.dmgMul = 0.55 + this.plan.tier * 0.75;
      this.rng = mulberry32(0xa53 ^ Math.imul(this.stage, 40503));
      this.waveIdx = 0; this.waveT = 0; this.spawnQ = [];
      this.clearField();
      this.phase = 'ready'; this.phT = READY_SEC;
      this.stageKills = 0; this.stageScore0 = this.score;
      for (const p of this.players.values()) {
        p.down = false; p.downT = 0; p.revT = 0;
        p.hp = P_MAXHP; p.invT = SPAWN_INV;
        p.x = 150; p.y = clamp(p.y, 120, FIELD.h - 120);
      }
      this.fx.push({ t: 'stage', n: this.stage });
    }
    nextWave() {
      if (!this.plan) return;
      if (this.waveIdx >= this.plan.waves.length) {
        if (this.plan.isBoss && !this.boss) this.spawnBoss();
        return;
      }
      const base = this.plan.waves[this.waveIdx++];
      // 사람이 많으면 적도 그만큼 더 나옵니다. 체력만 올리면 "안 죽는 적"이 되지만
      // 수를 늘리면 다섯 명이 각자 쏠 표적이 생겨 훨씬 신납니다.
      // 다만 쏘는 적은 수를 꽉 막아 둡니다 — 스무 기가 동시에 쏘면 탄막이 초등학생이
      // 피할 수 있는 수준을 넘어갑니다.
      const cap = ENEMY[base.type].fire ? 15 : 30;
      const w = Object.assign({}, base, {
        count: Math.min(cap, Math.round(base.count * (0.55 + 0.45 * Math.max(1, this.players.size)))),
      });
      const spawns = buildSpawns(w, this.rng);
      const t0 = 0;
      for (const s of spawns) this.spawnQ.push({ at: t0 + s.delay, w, s });
      this.spawnQ.sort((a, b) => a.at - b.at);
      this.waveT = 0;
      this.waveGiveGun = this.rng() < 0.8;   // 웨이브마다 파워업 하나는 확실히
    }

    spawnEnemy(w, s) {
      const def = ENEMY[w.type];
      const scale = 0.6 + 0.4 * Math.max(1, this.players.size);   // 사람이 많으면 그만큼 단단하게
      const e = {
        id: this.nid++, type: w.type, art: def.art, x: s.x, y: s.y, y0: s.y,
        vx: -w.spd, vy: 0, hp: Math.round(w.hp * scale), maxHp: Math.round(w.hp * scale),
        r: def.r, t: 0, pat: s.pat, amp: s.amp, per: s.per || 1, hold: s.hold || 0,
        fireCd: 0.6 + this.rng() * w.fire, fireEvery: w.fire, ang: Math.PI,
        score: def.score, front: !!def.front, contact: def.contact || 0,
        heal: !!def.heal, split: def.split || null, healCd: 0, burst: 0, flash: 0, boss: false,
      };
      this.enemies.push(e);
      return e;
    }

    spawnBoss() {
      const b = BOSSES[this.plan.zone];
      // 사람이 늘면 화력은 인원수만큼 커지므로 보스 체력도 거의 비례해 올려야
      // "5명이 붙으면 3초 만에 끝나는" 일이 안 생깁니다 (1명 1.0배 → 5명 3.0배)
      const scale = 0.5 + 0.5 * Math.max(1, this.players.size);
      const hp = Math.round(this.plan.boss.hp * scale);
      this.boss = {
        id: this.nid++, key: b.key, name: b.name, art: b.art, boss: true,
        x: FIELD.w + 220, y: FIELD.h / 2, vx: -180, vy: 0,
        hp, maxHp: hp, r: b.r, t: 0, ang: Math.PI, phaseIdx: 0, entering: true,
        cds: [], flash: 0, chargeT: 0, clones: [], fireMul: this.plan.boss.fire,
      };
      this.boss.cds = b.phases[0].atk.map(() => 0.9);
      this.phase = 'boss'; this.phT = 0;
      this.fx.push({ t: 'bosswarn', name: b.name });
    }

    /* ── 한 틱 ── */
    step() {
      this.tick++;
      const dt = DT;
      // 스냅샷을 가져가지 않는 곳(테스트·봇 시뮬레이션)에서 목록이 끝없이 커지지 않게 막습니다.
      // 서버는 매 틱 snapshot() 으로 비우므로 평소엔 이 줄에 걸리지 않습니다.
      if (this.fx.length > 400) this.fx.splice(0, this.fx.length - 400);
      if (this.newBullets.length > 2000) this.newBullets.splice(0, this.newBullets.length - 2000);
      if (this.deadBullets.length > 4000) this.deadBullets.splice(0, this.deadBullets.length - 4000);
      if (this.players.size === 0) { this.phase = 'idle'; return; }

      if (this.phase === 'ready') {
        this.phT -= dt;
        this.stepPlayers(dt);
        if (this.phT <= 0) { this.phase = 'play'; this.phT = 0; this.nextWave(); }
        return;
      }
      if (this.phase === 'clear') {
        this.phT -= dt;
        this.stepPlayers(dt); this.stepBullets(dt); this.stepPickups(dt);
        if (this.phT <= 0) {
          if (this.stage >= TOTAL_STAGES) { this.phase = 'allclear'; this.phT = 0; }
          else this.startStage(this.stage + 1);
        }
        return;
      }
      if (this.phase === 'wipe') {
        this.phT -= dt;
        if (this.phT <= 0) this.startStage(this.stage);
        return;
      }
      if (this.phase === 'allclear') { this.stepPlayers(dt); return; }
      if (this.phase === 'idle') return;

      // play / boss
      this.waveT += dt;
      while (this.spawnQ.length && this.spawnQ[0].at <= this.waveT) {
        const q = this.spawnQ.shift();
        this.spawnEnemy(q.w, q.s);
      }
      this.stepPlayers(dt);
      this.stepEnemies(dt);
      if (this.boss) this.stepBoss(dt);
      this.stepBullets(dt);
      this.stepBeams(dt);
      this.stepPickups(dt);
      this.collide();

      // 웨이브·스테이지 진행 판정
      if (this.phase === 'play' && this.spawnQ.length === 0 && this.enemies.length === 0) {
        if (this.waveIdx >= this.plan.waves.length) {
          if (this.plan.isBoss) { if (!this.boss) this.spawnBoss(); }
          else this.finishStage();
        } else if (this.waveT > 0.9) {
          this.nextWave();
        }
      }
      if (this.phase === 'boss' && !this.boss) this.finishStage();

      // 전멸?
      let anyUp = false;
      for (const p of this.players.values()) if (!p.down) anyUp = true;
      if (!anyUp && this.players.size > 0) {
        this.phase = 'wipe'; this.phT = WIPE_SEC;
        this.clearField();
        this.fx.push({ t: 'wipe' });
        for (const p of this.players.values()) { p.lives = P_LIVES; p.gun = Math.max(1, p.gun - 1); }
      }
    }

    finishStage() {
      this.phase = 'clear'; this.phT = CLEAR_SEC;
      const bonus = 300 + this.stage * 40;
      this.score += bonus;
      this.best = Math.max(this.best, Math.min(TOTAL_STAGES, this.stage + 1));
      this.clearField();
      this.log = { stage: this.stage, bonus, score: this.score };
      this.fx.push({ t: 'clear', stage: this.stage, bonus });
      for (const p of this.players.values()) {
        if (p.down) { p.down = false; p.hp = Math.round(P_MAXHP * 0.6); p.invT = SPAWN_INV; }
        else p.hp = Math.min(P_MAXHP, p.hp + 34);
        if (p.bombs < BOMB_MAX && this.stage % 5 === 0) p.bombs++;
      }
    }

    /* ── 아군 ── */
    stepPlayers(dt) {
      for (const p of this.players.values()) {
        p.joinT += dt;
        if (p.invT > 0) p.invT -= dt;
        if (p.shieldT > 0) p.shieldT -= dt;

        if (p.down) {
          // 낙하산 — 천천히 가라앉습니다
          p.y = clamp(p.y + 42 * dt, 80, FIELD.h - 80);
          p.x = clamp(p.x - 24 * dt, 40, FIELD.w - 40);
          p.downT -= dt;
          // 근처 친구가 있으면 구조 게이지가 찹니다
          let helper = null;
          for (const q of this.players.values()) {
            if (q === p || q.down) continue;
            if (d2(p.x, p.y, q.x, q.y) < REVIVE_R * REVIVE_R) { helper = q; break; }
          }
          if (helper) {
            p.revT += dt;
            if (p.revT >= REVIVE_SEC) { this.revive(p, false); this.fx.push({ t: 'revive', id: p.id, x: p.x, y: p.y }); }
          } else if (p.revT > 0) {
            p.revT = Math.max(0, p.revT - dt * 0.6);
          }
          // 친구가 방금 살렸으면 여기 오지 않습니다(p.down 이 이미 꺼져 있음).
          // 이 검사를 빼먹으면 구조된 순간 downT 가 0 이라 목숨까지 깎였습니다.
          if (p.down && p.downT <= 0) {
            if (p.lives > 0) { p.lives--; this.revive(p, true); }
            else { p.downT = 4; p.revT = 0; }   // 목숨이 없으면 친구만이 살릴 수 있습니다
          }
          continue;
        }

        // 목표 지점으로 이동
        const dx = p.tx - p.x, dy = p.ty - p.y;
        const d = Math.hypot(dx, dy);
        const mx = P_SPEED * dt;
        if (d > 1) {
          const k = Math.min(1, mx / d);
          p.x += dx * k; p.y += dy * k;
          p.ang = clamp(dy * k / (mx || 1), -1, 1) * 0.45;    // 기울기(그림용)
        } else p.ang *= 0.8;
        p.x = clamp(p.x, 26, FIELD.w - 26);
        p.y = clamp(p.y, 26, FIELD.h - 26);

        // 자동 발사 — 아이들이 버튼을 누를 필요가 없습니다
        if (this.phase === 'play' || this.phase === 'boss') {
          p.fireCd -= dt;
          const g = GUNS[clamp(p.gun, 1, GUN_MAX)];
          if (p.fireCd <= 0) {
            p.fireCd = g.cd;
            for (const s of g.shots) {
              const spd = BULLET_SPD;
              this.addBullet({
                x: p.x + 26, y: p.y + (s.dy || 0), vx: Math.cos(s.a) * spd, vy: Math.sin(s.a) * spd,
                r: s.big ? 9 : 6, dmg: s.dmg, own: p.id, kind: s.big === 2 ? 'p3' : s.big ? 'p2' : 'p1',
                pierce: s.pierce || 0, col: p.color,
              });
            }
          }
        }
      }
    }
    revive(p, cost) {
      p.down = false; p.revT = 0; p.downT = 0;
      p.hp = cost ? P_MAXHP * 0.7 : P_MAXHP;
      p.invT = SPAWN_INV;
    }
    hurtPlayer(p, dmg) {
      if (p.down || p.invT > 0) return;
      if (p.shieldT > 0) { p.shieldT = 0; p.invT = 1.2; this.fx.push({ t: 'shatter', x: p.x, y: p.y }); return; }
      // 앞 단계일수록 덜 아픕니다 (1단계 0.55배 → 100단계 1.3배)
      p.hp -= dmg * this.dmgMul;
      p.invT = HIT_INV;
      this.fx.push({ t: 'phit', x: p.x, y: p.y, id: p.id });
      if (p.hp <= 0) {
        p.hp = 0; p.down = true; p.downT = DOWN_SEC; p.revT = 0; p.deaths++;
        p.gun = Math.max(1, p.gun - 1);
        this.fx.push({ t: 'down', x: p.x, y: p.y, id: p.id });
      }
    }
    useBomb(p) {
      if (p.down || p.bombs <= 0) return;
      p.bombs--;
      this.fx.push({ t: 'bomb', x: p.x, y: p.y, id: p.id });
      // 적탄을 지웁니다
      for (let i = this.bullets.length - 1; i >= 0; i--) {
        const b = this.bullets[i];
        if (b.own === -1 && d2(b.x, b.y, p.x, p.y) < BOMB_R * BOMB_R) { this.killBullet(i); }
      }
      this.beams.length = 0;
      // 적에게 큰 피해
      for (let i = this.enemies.length - 1; i >= 0; i--) {
        const e = this.enemies[i];
        if (d2(e.x, e.y, p.x, p.y) < BOMB_R * BOMB_R) this.damageEnemy(i, 120, p);
      }
      if (this.boss && d2(this.boss.x, this.boss.y, p.x, p.y) < (BOMB_R + this.boss.r) * (BOMB_R + this.boss.r)) {
        this.damageBoss(200, p);
      }
    }

    /* ── 총알 ── */
    addBullet(o) {
      const b = {
        id: this.nid++, x: o.x, y: o.y, vx: o.vx, vy: o.vy, r: o.r || 7,
        dmg: o.dmg || 8, own: o.own === undefined ? -1 : o.own, kind: o.kind || 'e1',
        pierce: o.pierce || 0, hom: o.hom || 0, life: o.life || 6, born: this.tick, col: o.col || 0,
      };
      this.bullets.push(b);
      this.newBullets.push(b);
      return b;
    }
    killBullet(i) {
      const b = this.bullets[i];
      if (!b) return;          // 보스를 잡는 순간처럼 목록이 먼저 줄어든 경우
      this.deadBullets.push(b.id);
      this.bullets[i] = this.bullets[this.bullets.length - 1];
      this.bullets.pop();
    }
    stepBullets(dt) {
      for (let i = this.bullets.length - 1; i >= 0; i--) {
        const b = this.bullets[i];
        if (b.hom) {
          // 유도탄 — 가장 가까운 아군을 향해 천천히 돕니다
          const tgt = this.nearestPlayer(b.x, b.y);
          if (tgt) {
            const want = Math.atan2(tgt.y - b.y, tgt.x - b.x);
            const cur = Math.atan2(b.vy, b.vx);
            let d = want - cur;
            while (d > Math.PI) d -= Math.PI * 2;
            while (d < -Math.PI) d += Math.PI * 2;
            const turn = clamp(d, -b.hom * dt, b.hom * dt);
            const sp = Math.hypot(b.vx, b.vy);
            b.vx = Math.cos(cur + turn) * sp; b.vy = Math.sin(cur + turn) * sp;
          }
        }
        b.x += b.vx * dt; b.y += b.vy * dt;
        b.life -= dt;
        if (b.life <= 0 || b.x < -80 || b.x > FIELD.w + 120 || b.y < -80 || b.y > FIELD.h + 80) this.killBullet(i);
      }
    }
    nearestPlayer(x, y) {
      let best = null, bd = Infinity;
      for (const p of this.players.values()) {
        if (p.down) continue;
        const d = d2(x, y, p.x, p.y);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    }

    /* ── 레이저 ── */
    stepBeams(dt) {
      for (let i = this.beams.length - 1; i >= 0; i--) {
        const bm = this.beams[i];
        bm.t -= dt;
        if (bm.state === 'warn' && bm.t <= 0) { bm.state = 'fire'; bm.t = 0.75; }
        else if (bm.state === 'fire') {
          // 판정: 선분에서 일정 거리 안이면 피해
          for (const p of this.players.values()) {
            if (p.down || p.invT > 0) continue;
            const dxp = p.x - bm.x, dyp = p.y - bm.y;
            const proj = dxp * Math.cos(bm.ang) + dyp * Math.sin(bm.ang);
            if (proj < 0 || proj > 2400) continue;
            const perp = Math.abs(-dxp * Math.sin(bm.ang) + dyp * Math.cos(bm.ang));
            if (perp < bm.w / 2 + P_R) this.hurtPlayer(p, 26);   // 무적 시간 덕에 초당 두 번까지만 아픕니다
          }
          if (bm.t <= 0) this.beams.splice(i, 1);
        }
      }
    }

    /* ── 적 ── */
    stepEnemies(dt) {
      for (let i = this.enemies.length - 1; i >= 0; i--) {
        const e = this.enemies[i];
        e.t += dt;
        if (e.flash > 0) e.flash -= dt;

        switch (e.pat) {
          case 'sine':
            e.x += e.vx * dt;
            e.y = e.y0 + Math.sin(e.t * (Math.PI * 2) / e.per) * e.amp;
            break;
          case 'zig': {
            e.x += e.vx * dt;
            const ph = Math.floor(e.t / e.per) % 2;
            e.y += (ph ? 1 : -1) * e.amp * dt * 2.2;
            e.y = clamp(e.y, 70, FIELD.h - 70);
            break;
          }
          case 'dive': {
            e.x += e.vx * 1.25 * dt;
            const tgt = this.nearestPlayer(e.x, e.y);
            if (tgt) e.y += clamp(tgt.y - e.y, -150 * dt, 150 * dt);
            break;
          }
          case 'home': {
            const tgt = this.nearestPlayer(e.x, e.y);
            if (tgt) {
              const a = Math.atan2(tgt.y - e.y, tgt.x - e.x);
              const cur = Math.atan2(e.vy, e.vx);
              let d = a - cur;
              while (d > Math.PI) d -= Math.PI * 2;
              while (d < -Math.PI) d += Math.PI * 2;
              const sp = Math.hypot(e.vx, e.vy) || 300;
              const na = cur + clamp(d, -2.2 * dt, 2.2 * dt);
              e.vx = Math.cos(na) * sp; e.vy = Math.sin(na) * sp;
              e.ang = na;
            }
            e.x += e.vx * dt; e.y += e.vy * dt;
            break;
          }
          case 'drift':
            e.x += e.vx * dt;
            e.y += Math.sin(e.t * 1.3) * 26 * dt;
            break;
          case 'stop': {
            const stopX = FIELD.w * e.hold;
            if (e.x > stopX) e.x += e.vx * dt;
            else e.y += Math.sin(e.t * 1.1) * 60 * dt;
            break;
          }
          default:
            e.x += e.vx * dt;
        }
        if (e.pat !== 'home') e.ang = Math.PI;

        // 수리기 — 주변 적을 회복시킵니다 (먼저 잡아야 하는 적)
        if (e.heal) {
          e.healCd -= dt;
          if (e.healCd <= 0) {
            e.healCd = 1.4;
            for (const o of this.enemies) {
              if (o === e) continue;
              if (d2(o.x, o.y, e.x, e.y) < 300 * 300 && o.hp < o.maxHp) {
                o.hp = Math.min(o.maxHp, o.hp + o.maxHp * 0.14);
                this.fx.push({ t: 'heal', x: o.x, y: o.y });
              }
            }
          }
        }

        // 사격
        const def = ENEMY[e.type];
        if (def.fire && e.x < FIELD.w + 20) {
          e.fireCd -= dt;
          if (e.fireCd <= 0) { e.fireCd = e.fireEvery; this.enemyFire(e, def.fire.k); }
        }

        if (e.x < -120 || e.y < -160 || e.y > FIELD.h + 160) {
          this.enemies[i] = this.enemies[this.enemies.length - 1];
          this.enemies.pop();
        }
      }
    }

    enemyFire(e, kind) {
      const tgt = this.nearestPlayer(e.x, e.y);
      const aim = tgt ? Math.atan2(tgt.y - e.y, tgt.x - e.x) : Math.PI;
      const S = (a, spd, kd, dmg, hom) => this.addBullet({
        x: e.x - 10, y: e.y, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
        r: kd === 'e2' ? 12 : kd === 'em' ? 11 : 8, dmg: dmg || 12, own: -1, kind: kd || 'e1', hom: hom || 0,
      });
      switch (kind) {
        case 'aim1': S(aim, 320, 'e1', 12); break;
        case 'burst3':
          e.burst = 3;
          S(aim, 430, 'e1', 13);
          break;
        case 'drop':
          S(Math.PI * 0.75, 240, 'e2', 16); S(Math.PI * 1.25, 240, 'e2', 16);
          break;
        case 'spread3':
          for (let k = -1; k <= 1; k++) S(aim + k * 0.22, 300, 'e1', 12);
          break;
        case 'radial8': {
          const n = 8, off = e.t * 0.9;
          for (let k = 0; k < n; k++) S(off + k * (Math.PI * 2 / n), 250, 'e1', 11);
          break;
        }
        case 'homing2':
          for (let k = -1; k <= 1; k += 2) S(Math.PI + k * 0.35, 260, 'em', 18, 1.5);
          break;
        case 'beam':
          this.beams.push({ id: this.nid++, x: e.x, y: e.y, ang: aim, w: 40, state: 'warn', t: 0.95 });
          break;
      }
    }

    damageEnemy(i, dmg, byPlayer) {
      const e = this.enemies[i];
      e.hp -= dmg; e.flash = 0.08;
      if (e.hp > 0) return false;
      const gain = e.score * (1 + this.stage * 0.05) | 0;
      this.score += gain;
      if (byPlayer) { byPlayer.score += gain; byPlayer.kills++; }
      this.stageKills = (this.stageKills || 0) + 1;
      this.fx.push({ t: 'boom', x: e.x, y: e.y, s: e.r });
      // 분열기
      if (e.split) {
        for (let k = -1; k <= 1; k += 2) {
          const d = ENEMY[e.split];
          this.enemies.push({
            id: this.nid++, type: e.split, art: d.art, x: e.x, y: e.y + k * 22, y0: e.y + k * 22,
            vx: -d.spd, vy: 0, hp: Math.round(e.maxHp * 0.28), maxHp: Math.round(e.maxHp * 0.28),
            r: d.r, t: 0, pat: 'sine', amp: 55, per: 1.2, hold: 0, fireCd: 99, fireEvery: 99,
            ang: Math.PI, score: d.score, front: false, contact: 0, heal: false, split: null,
            healCd: 0, burst: 0, flash: 0, boss: false,
          });
        }
      }
      this.maybeDrop(e.x, e.y);
      this.enemies[i] = this.enemies[this.enemies.length - 1];
      this.enemies.pop();
      return true;
    }

    maybeDrop(x, y) {
      let r = this.rng();
      let type = null;
      if (this.waveGiveGun) { type = 'pow'; this.waveGiveGun = false; }
      else if (r < 0.045) type = 'pow';
      else if (r < 0.10) type = 'heal';
      else if (r < 0.125) type = 'bomb';
      else if (r < 0.15) type = 'shield';
      else if (r < 0.22) type = 'star';
      if (!type) return;
      this.pickups.push({ id: this.nid++, type, x, y, vx: -85, vy: 0, t: 0 });
    }
    stepPickups(dt) {
      for (let i = this.pickups.length - 1; i >= 0; i--) {
        const k = this.pickups[i];
        k.t += dt;
        k.x += k.vx * dt; k.y += Math.sin(k.t * 2.2) * 34 * dt;
        // 가까운 아군에게 살짝 끌려갑니다 (아이들이 놓치지 않게)
        const p = this.nearestPlayer(k.x, k.y);
        if (p && d2(k.x, k.y, p.x, p.y) < 210 * 210) {
          const a = Math.atan2(p.y - k.y, p.x - k.x);
          k.x += Math.cos(a) * 210 * dt; k.y += Math.sin(a) * 210 * dt;
        }
        if (k.x < -60 || k.t > 14) { this.pickups.splice(i, 1); continue; }
        if (p && d2(k.x, k.y, p.x, p.y) < 44 * 44) {
          this.grab(p, k.type);
          this.pickups.splice(i, 1);
        }
      }
    }
    grab(p, type) {
      switch (type) {
        case 'pow':
          if (p.gun < GUN_MAX) { p.gun++; this.fx.push({ t: 'lvup', id: p.id, x: p.x, y: p.y, lv: p.gun }); }
          else { p.score += 500; this.score += 500; }
          break;
        case 'heal': p.hp = Math.min(P_MAXHP, p.hp + 40); break;
        case 'bomb': p.bombs = Math.min(BOMB_MAX, p.bombs + 1); break;
        case 'shield': p.shieldT = 9; break;
        case 'star': p.score += 300; this.score += 300; break;
      }
      this.fx.push({ t: 'grab', x: p.x, y: p.y, k: type, id: p.id });
    }

    /* ── 보스 ── */
    stepBoss(dt) {
      const B = this.boss, def = BOSSES[this.plan.zone];
      B.t += dt;
      if (B.flash > 0) B.flash -= dt;

      if (B.entering) {
        B.x += B.vx * dt;
        if (B.x <= FIELD.w - 260) { B.x = FIELD.w - 260; B.entering = false; B.vx = 0; }
        return;
      }

      // 페이즈 전환
      const frac = B.hp / B.maxHp;
      let pi = 0;
      for (let i = 0; i < def.phases.length; i++) if (frac <= def.phases[i].at) pi = i;
      if (pi !== B.phaseIdx) {
        B.phaseIdx = pi;
        B.cds = def.phases[pi].atk.map((a, i) => 0.6 + i * 0.3);
        this.fx.push({ t: 'bossphase', n: pi + 1, x: B.x, y: B.y });
      }
      const ph = def.phases[B.phaseIdx];

      // 움직임
      switch (ph.move) {
        case 'hover':
          B.y = FIELD.h / 2 + Math.sin(B.t * 0.75) * (FIELD.h * 0.3);
          B.x = FIELD.w - 260 + Math.sin(B.t * 0.5) * 40;
          break;
        case 'sway':
          B.y = FIELD.h / 2 + Math.sin(B.t * 1.15) * (FIELD.h * 0.34);
          B.x = FIELD.w - 280 + Math.cos(B.t * 0.7) * 120;
          break;
        case 'orbit':
          B.x = FIELD.w - 330 + Math.cos(B.t * 0.85) * 190;
          B.y = FIELD.h / 2 + Math.sin(B.t * 1.7) * (FIELD.h * 0.3);
          break;
        case 'charge': {
          B.chargeT -= dt;
          if (B.chargeT <= 0) {
            const tgt = this.nearestPlayer(B.x, B.y);
            if (tgt && !B.dash) { B.dash = { x: tgt.x + 120, y: tgt.y, t: 1.5 }; }
            B.chargeT = 4.2;
          }
          if (B.dash) {
            B.dash.t -= dt;
            const a = Math.atan2(B.dash.y - B.y, B.dash.x - B.x);
            const sp = 430;
            B.x += Math.cos(a) * sp * dt; B.y += Math.sin(a) * sp * dt;
            if (B.dash.t <= 0 || d2(B.x, B.y, B.dash.x, B.dash.y) < 60 * 60) B.dash = null;
          } else {
            B.x += (FIELD.w - 280 - B.x) * 1.2 * dt;
            B.y += Math.sin(B.t * 1.0) * 90 * dt;
          }
          break;
        }
      }
      // 몸집이 큰 보스가 화면 밖으로 나가거나 위쪽 표시줄을 가리지 않게 반경만큼 여유를 둡니다
      B.x = clamp(B.x, 420, FIELD.w - B.r * 0.85);
      B.y = clamp(B.y, 110 + B.r * 0.6, FIELD.h - B.r * 0.75);

      // 공격
      for (let i = 0; i < ph.atk.length; i++) {
        B.cds[i] -= dt;
        if (B.cds[i] > 0) continue;
        const a = ph.atk[i];
        B.cds[i] = a.every * B.fireMul;
        this.bossAttack(B, a);
      }

      // 몸통 충돌
      for (const p of this.players.values()) {
        if (p.down || p.invT > 0) continue;
        const rr = B.r * 0.72 + P_R;
        if (d2(p.x, p.y, B.x, B.y) < rr * rr) this.hurtPlayer(p, 34);
      }
    }

    bossAttack(B, a) {
      const tgt = this.nearestPlayer(B.x, B.y);
      const aim = tgt ? Math.atan2(tgt.y - B.y, tgt.x - B.x) : Math.PI;
      const S = (ang, spd, kd, dmg, hom) => this.addBullet({
        x: B.x - 30, y: B.y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
        r: kd === 'e2' ? 13 : kd === 'em' ? 12 : 9, dmg: dmg || 14, own: -1, kind: kd || 'e1', hom: hom || 0, life: 9,
      });
      switch (a.k) {
        case 'radial': {
          const off = B.t * 0.7;
          for (let k = 0; k < a.n; k++) S(off + k * (Math.PI * 2 / a.n), a.spd, 'e1', 13);
          break;
        }
        case 'spread':
          for (let k = 0; k < a.n; k++) S(aim + (k / (a.n - 1) - 0.5) * a.arc, a.spd, 'e1', 13);
          break;
        case 'aimed':
          for (let k = 0; k < a.n; k++) S(aim + (k - (a.n - 1) / 2) * 0.09, a.spd, 'e1', 14);
          break;
        case 'rain':
          for (let k = 0; k < a.n; k++) {
            const y = 60 + (FIELD.h - 120) * (k + 0.5) / a.n;
            this.addBullet({ x: FIELD.w - 40, y, vx: -a.spd, vy: (this.rng() - 0.5) * 60, r: 10, dmg: 13, own: -1, kind: 'e2', life: 9 });
          }
          break;
        case 'wall': {
          const gapAt = Math.floor(this.rng() * a.n);
          for (let k = 0; k < a.n; k++) {
            if (k >= gapAt && k < gapAt + a.gap) continue;
            const y = 50 + (FIELD.h - 100) * k / (a.n - 1);
            this.addBullet({ x: FIELD.w - 30, y, vx: -a.spd, vy: 0, r: 11, dmg: 14, own: -1, kind: 'e2', life: 9 });
          }
          break;
        }
        case 'spiral': {
          B.spiralA = (B.spiralA || 0) + a.turn;
          for (let k = 0; k < a.n; k++) S(B.spiralA + k * (Math.PI * 2 / a.n), a.spd, 'e1', 12);
          break;
        }
        case 'homing':
          for (let k = 0; k < a.n; k++) S(Math.PI + (k - (a.n - 1) / 2) * 0.4, 250, 'em', 20, 1.4);
          break;
        case 'beam':
          this.beams.push({ id: this.nid++, x: B.x, y: B.y, ang: aim, w: a.w, state: 'warn', t: a.warn });
          break;
        case 'split':
          for (let k = 0; k < a.n; k++) {
            const b = S(aim + (k / Math.max(1, a.n - 1) - 0.5) * 1.0, a.spd, 'e2', 12);
            b.splitAt = a.at; b.splitT = 0.9;
          }
          break;
        case 'summon': {
          const d = ENEMY[a.type];
          for (let k = 0; k < a.n; k++) {
            const y = clamp(B.y + (k - (a.n - 1) / 2) * 90, 80, FIELD.h - 80);
            this.enemies.push({
              id: this.nid++, type: a.type, art: d.art, x: B.x - 40, y, y0: y,
              vx: -d.spd, vy: 0, hp: Math.round(d.hp * (1 + this.stage * 0.08)), maxHp: Math.round(d.hp * (1 + this.stage * 0.08)),
              r: d.r, t: 0, pat: a.type === 'kamikaze' ? 'home' : 'sine', amp: 60, per: 1.5, hold: d.stop || 0,
              fireCd: 1.5, fireEvery: 2.2, ang: Math.PI, score: d.score, front: !!d.front,
              contact: d.contact || 0, heal: !!d.heal, split: d.split || null, healCd: 0, burst: 0, flash: 0, boss: false,
            });
          }
          break;
        }
        case 'clone':
          this.fx.push({ t: 'clone', x: B.x, y: B.y });
          for (let k = -1; k <= 1; k += 2) {
            for (let j = 0; j < 6; j++) S(Math.PI + k * 0.5 + j * 0.12, 300, 'e1', 12);
          }
          break;
      }
    }

    damageBoss(dmg, byPlayer) {
      const B = this.boss;
      if (!B || B.entering) return false;
      B.hp -= dmg; B.flash = 0.1;
      if (B.hp > 0) return false;
      const gain = 2000 + this.stage * 120;
      this.score += gain;
      if (byPlayer) { byPlayer.score += gain; byPlayer.kills++; }
      this.fx.push({ t: 'bossdown', x: B.x, y: B.y, r: B.r });
      // 보상: 모두 회복 + 폭탄
      for (const p of this.players.values()) {
        p.hp = P_MAXHP; p.bombs = Math.min(BOMB_MAX, p.bombs + 1);
        if (p.gun < GUN_MAX) p.gun++;
      }
      this.boss = null;
      this.beams.length = 0;
      for (let i = this.bullets.length - 1; i >= 0; i--) if (this.bullets[i].own === -1) this.killBullet(i);
      return true;
    }

    /* ── 충돌 ── */
    collide() {
      // 아군탄 → 적
      for (let i = this.bullets.length - 1; i >= 0; i--) {
        // 보스를 잡으면 damageBoss 가 적탄을 한꺼번에 지웁니다 → 목록이 줄어든 뒤의 빈 자리를 건너뜁니다
        if (i >= this.bullets.length) continue;
        const b = this.bullets[i];
        if (b.own === -1) {
          // 분열탄
          if (b.splitAt) {
            b.splitT -= DT;
            if (b.splitT <= 0) {
              const sp = Math.hypot(b.vx, b.vy) * b.splitAt + 120;
              const base = Math.atan2(b.vy, b.vx);
              for (let k = -1; k <= 1; k++) if (k !== 0 || true) {
                this.addBullet({ x: b.x, y: b.y, vx: Math.cos(base + k * 0.5) * sp, vy: Math.sin(base + k * 0.5) * sp, r: 8, dmg: 11, own: -1, kind: 'e1', life: 5 });
              }
              this.killBullet(i);
              continue;
            }
          }
          continue;
        }
        const p = this.players.get(b.own);
        let hit = false;
        for (let j = this.enemies.length - 1; j >= 0; j--) {
          const e = this.enemies[j];
          const rr = e.r + b.r;
          if (d2(b.x, b.y, e.x, e.y) > rr * rr) continue;
          // 방패기는 앞(오른쪽에서 오는 정면)에서는 안 맞습니다
          if (e.front && b.vx > 0 && Math.abs(b.y - e.y) < e.r * 0.75) {
            this.fx.push({ t: 'guard', x: e.x - e.r, y: b.y });
            hit = true; break;
          }
          this.damageEnemy(j, b.dmg, p);
          this.fx.push({ t: 'hit', x: b.x, y: b.y });
          hit = true;
          break;
        }
        if (!hit && this.boss) {
          const B = this.boss, rr = B.r * 0.8 + b.r;
          if (!B.entering && d2(b.x, b.y, B.x, B.y) < rr * rr) {
            this.damageBoss(b.dmg, p);
            this.fx.push({ t: 'hit', x: b.x, y: b.y });
            hit = true;
          }
        }
        if (hit) {
          if (b.pierce > 0) { b.pierce--; }
          else this.killBullet(i);
        }
      }
      // 적탄 → 아군
      for (let i = this.bullets.length - 1; i >= 0; i--) {
        if (i >= this.bullets.length) continue;
        const b = this.bullets[i];
        if (b.own !== -1) continue;
        for (const p of this.players.values()) {
          if (p.down || p.invT > 0) continue;
          const rr = P_R + b.r * 0.8;
          if (d2(b.x, b.y, p.x, p.y) > rr * rr) continue;
          this.hurtPlayer(p, b.dmg);
          this.killBullet(i);
          break;
        }
      }
      // 적 몸통 → 아군
      for (let j = this.enemies.length - 1; j >= 0; j--) {
        const e = this.enemies[j];
        for (const p of this.players.values()) {
          if (p.down || p.invT > 0) continue;
          const rr = e.r * 0.8 + P_R;
          if (d2(e.x, e.y, p.x, p.y) > rr * rr) continue;
          this.hurtPlayer(p, e.contact || CONTACT_DMG);
          if (e.contact) this.damageEnemy(j, 9999, null);
          break;
        }
      }
    }

    /* ── 화면에 보낼 상태 ── */
    snapshot(full) {
      const P = [];
      for (const p of this.players.values()) {
        P.push([p.id, R1(p.x), R1(p.y), R1(p.hp), p.gun, p.invT > 0 ? 1 : 0, p.down ? 1 : 0,
                R1(p.revT / REVIVE_SEC * 100), p.bombs, p.score, p.lives, R1(p.ang * 100),
                p.shieldT > 0 ? 1 : 0, R1(p.downT)]);
      }
      const E = [];
      for (const e of this.enemies) E.push([e.id, e.art, R1(e.x), R1(e.y), R1(e.hp), R1(e.maxHp), R1(e.ang * 100), e.flash > 0 ? 1 : 0]);
      const K = [];
      for (const k of this.pickups) K.push([k.id, k.type, R1(k.x), R1(k.y)]);
      const BM = [];
      for (const b of this.beams) BM.push([b.id, R1(b.x), R1(b.y), R1(b.ang * 100), b.w, b.state === 'fire' ? 1 : 0, Math.round(b.t * 100)]);
      const HB = [];
      for (const b of this.bullets) if (b.hom || full) HB.push([b.id, R1(b.x), R1(b.y), R1(Math.atan2(b.vy, b.vx) * 100), b.kind]);

      const s = {
        t: this.tick, ph: this.phase, phT: Math.round(this.phT * 10) / 10,
        st: this.stage, zone: this.plan ? this.plan.zone : 0, sc: this.score,
        wv: this.waveIdx, wvN: this.plan ? this.plan.waves.length : 0,
        P, E, K, BM, HB,
        Bn: this.newBullets.filter((b) => !b.hom).map((b) => [b.id, R1(b.x), R1(b.y), R1(b.vx), R1(b.vy), b.kind, b.born, b.col]),
        Bd: this.deadBullets.slice(),
        X: this.fx.slice(),
        B: this.boss ? [this.boss.art, R1(this.boss.x), R1(this.boss.y), R1(this.boss.hp), R1(this.boss.maxHp),
                        this.boss.name, this.boss.flash > 0 ? 1 : 0, this.boss.phaseIdx, this.boss.entering ? 1 : 0] : null,
      };
      this.newBullets.length = 0;
      this.deadBullets.length = 0;
      this.fx.length = 0;
      return s;
    }
  }

  return {
    VERSION, FIELD, TICK_MS, DT, MAX_PLAYERS, TOTAL_STAGES,
    ZONES, ENEMY, BOSSES, GUNS, GUN_MAX, PICKUPS, ROSTER,
    P_MAXHP, P_LIVES, P_R, BOMB_MAX, REVIVE_SEC, DOWN_SEC, HIT_INV, CONTACT_DMG,
    Game, stagePlan, buildSpawns, mulberry32, clamp,
  };
})();

// CommonJS 내보내기(module.exports)는 두지 않습니다. 이 파일은 <script> 로도 읽히고
// 워커에서는 ES 모듈 안에 그대로 심기는데, 후자에서 esbuild 가 "module 은 전역이라
// 뜻대로 안 될 수 있다"고 경고합니다. 저장소에 Node 로 이 파일을 읽는 곳도 없습니다.


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

const APP_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>하늘편대 100 — 다같이 100단계</title>
<style>
  :root{
    --ink:#0b1220; --panel:rgba(12,20,38,.82); --line:rgba(255,255,255,.14);
    --gold:#ffd166; --sky:#6ec8ff; --hot:#ff6b8a; --good:#67f0a8;
  }
  *{box-sizing:border-box; -webkit-tap-highlight-color:transparent}
  html,body{height:100%;margin:0;background:#05070f;overflow:hidden;
    font-family:"Pretendard","Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif;color:#eaf2ff}
  #wrap{position:fixed;inset:0}
  canvas#game{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:none}

  /* ── 시작 화면 ── */
  #menu{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(120% 100% at 50% 0%,rgba(22,48,92,.35) 0%,rgba(7,13,28,.62) 60%,rgba(3,6,14,.82) 100%);
    overflow:auto;padding:16px}
  #menu.hide{display:none}
  .card{width:min(680px,96vw);background:var(--panel);animation:cardIn .6s cubic-bezier(.2,.9,.3,1.2);border:1px solid var(--line);border-radius:22px;
    padding:22px 22px 18px;backdrop-filter:blur(8px);box-shadow:0 24px 70px rgba(0,0,0,.6)}
  .title{display:flex;align-items:center;gap:14px;margin-bottom:6px}
  .title canvas{width:74px;height:52px;flex:0 0 auto}
  .title h1{margin:0;font-size:30px;letter-spacing:-.5px;
    background:linear-gradient(92deg,#fff 10%,#ffd166 45%,#6ec8ff 90%);-webkit-background-clip:text;background-clip:text;color:transparent}
  .sub{margin:0 0 16px;color:#9fb4d8;font-size:13.5px;line-height:1.6}
  .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
  label.lb{font-size:12.5px;color:#9fb4d8;width:100%;margin-bottom:-4px}
  input[type=text]{flex:1;min-width:120px;padding:12px 14px;border-radius:12px;border:1px solid var(--line);
    background:rgba(255,255,255,.06);color:#fff;font-size:16px;outline:none}
  input[type=text]:focus{border-color:#6ec8ff;background:rgba(110,200,255,.10)}
  .ships{display:flex;gap:8px;flex-wrap:wrap}
  .ships button{width:74px;height:52px;border-radius:12px;border:2px solid transparent;background:rgba(255,255,255,.05);
    padding:0;cursor:pointer;display:grid;place-items:center}
  .ships button.on{border-color:var(--gold);background:rgba(255,209,102,.14)}
  .ships canvas{width:64px;height:44px}
  .btns{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px}
  .btn{padding:14px 16px;border-radius:14px;border:1px solid var(--line);background:rgba(255,255,255,.07);
    color:#fff;font-size:15.5px;font-weight:700;cursor:pointer;transition:.15s}
  .btn:hover{background:rgba(255,255,255,.14);transform:translateY(-1px)}
  .btn.pri{background:linear-gradient(180deg,#3c8cff,#1f5fd8);border-color:#5aa2ff;
    box-shadow:0 8px 24px rgba(40,110,230,.35)}
  .btn.go{background:linear-gradient(180deg,#ffcf5c,#f0a318);border-color:#ffdd8a;color:#3a2500;
    box-shadow:0 8px 24px rgba(240,170,30,.3)}
  .btn.wide{grid-column:1/-1}
  .btn:disabled{opacity:.45;cursor:default;transform:none}
  .hint{font-size:12.5px;color:#8ea6cc;margin-top:10px;line-height:1.65}
  .codebox{display:flex;gap:8px}
  .codebox input{text-transform:uppercase;letter-spacing:6px;font-weight:800;text-align:center;font-size:22px}
  .msg{margin-top:10px;font-size:13.5px;min-height:19px;color:#ffb4c0}
  .msg.ok{color:#8ef0b6}
  .roomInfo{margin-top:8px;padding:10px 12px;border-radius:12px;background:rgba(110,200,255,.10);
    border:1px solid rgba(110,200,255,.25);font-size:13.5px;color:#cfe6ff;display:none}
  .stagePick{display:flex;align-items:center;gap:10px;margin-top:8px;font-size:13.5px;color:#cfe6ff;display:none}
  .stagePick input[type=range]{flex:1}
  .tabs{display:flex;gap:6px;margin-bottom:12px}
  .tabs button{flex:1;padding:9px;border-radius:11px;border:1px solid var(--line);background:transparent;
    color:#9fb4d8;font-size:13.5px;font-weight:700;cursor:pointer}
  .tabs button.on{background:rgba(255,255,255,.12);color:#fff;border-color:rgba(255,255,255,.3)}
  .pane{display:none}.pane.on{display:block}
  @keyframes cardIn{from{opacity:0;transform:translateY(24px) scale(.97)}to{opacity:1;transform:none}}
  .title h1{animation:shine 5s linear infinite;background-size:200% 100%}
  @keyframes shine{to{background-position:-200% 0}}
  .btn.go{position:relative;overflow:hidden}
  .btn.go::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.45) 50%,transparent 70%);
    transform:translateX(-120%);animation:sweep 3.2s ease-in-out infinite}
  @keyframes sweep{60%,100%{transform:translateX(120%)}}
  .ships button{transition:transform .15s}
  .ships button:hover{transform:translateY(-2px)}
  .ships button.on canvas{animation:bob 1.6s ease-in-out infinite}
  @keyframes bob{50%{transform:translateY(-3px)}}

  /* ── 게임 오버레이 ── */
  #hudDom{position:absolute;left:0;right:0;bottom:0;display:none;pointer-events:none;padding:10px}
  #hudDom.on{display:block}
  #bombBtn{position:absolute;right:14px;bottom:14px;width:78px;height:78px;border-radius:50%;
    background:radial-gradient(circle at 35% 30%,#ffe9a8,#f0a318 60%,#a76a06);border:2px solid #ffe9a8;
    color:#3a2500;font-weight:900;font-size:13px;pointer-events:auto;display:none;
    box-shadow:0 6px 20px rgba(0,0,0,.5);cursor:pointer}
  #bombBtn.on{display:block}
  /* 캔버스 안 점수판(오른쪽 위)과 겹치지 않도록 오른쪽 아래, 폭탄 버튼 위에 세로로 둡니다 */
  #topRight{position:absolute;right:14px;bottom:104px;display:grid;grid-template-columns:44px 44px;gap:7px;z-index:5}
  #topRight button.off{opacity:.45}
  #btnPause{display:none}
  #topRight.solo #btnPause{display:grid}
  #topRight button{background:rgba(8,14,28,.72);border:1px solid var(--line);color:#cfe0ff;border-radius:11px;
    width:44px;height:40px;font-size:16px;cursor:pointer;backdrop-filter:blur(6px);display:grid;place-items:center}
  #topRight button:hover{background:rgba(255,255,255,.16)}
  #topRight.hide{display:none}
  /* 태블릿을 세로로 들면 화면이 띠처럼 좁아져서 못 놉니다 */
  #rotate{position:absolute;inset:0;z-index:20;display:none;place-items:center;text-align:center;
    background:#070d1c;color:#dfe8ff;font-size:19px;font-weight:700;line-height:1.8}
  @media (orientation:portrait) and (max-width:900px){ #rotate.on{display:grid} }
  #toast{position:absolute;left:50%;top:16%;transform:translateX(-50%);z-index:6;
    display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none}
  .tst{background:rgba(8,14,28,.86);border:1px solid rgba(255,255,255,.18);border-radius:12px;
    padding:8px 16px;font-size:14px;font-weight:700;animation:tin .3s ease}
  @keyframes tin{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:none}}
</style>
</head>
<body>
<div id="wrap">
  <canvas id="game"></canvas>

  <div id="topRight" class="hide">
    <button id="btnPause" title="잠깐 멈춤 (P) — 혼자 연습에서만">⏸</button>
    <button id="btnSound" title="효과음 켜기/끄기">🔊</button>
    <button id="btnMusic" title="배경음악 켜기/끄기">🎵</button>
    <button id="btnGfx" title="그래픽 품질 (높음/낮음)">✨</button>
    <button id="btnFull" title="전체화면">⛶</button>
    <button id="btnQuit" title="나가기 (Esc)">✕</button>
  </div>
  <div id="toast"></div>
  <!-- grid 컨테이너에 글을 바로 넣으면 <br>·<b> 가 각각 한 칸을 차지해 흩어집니다 -->
  <div id="rotate"><div>📱↻<br>기기를 <b>가로로</b> 돌려 주세요</div></div>

  <div id="hudDom">
    <button id="bombBtn">💣<br><span id="bombN">2</span></button>
  </div>

  <div id="menu">
    <div class="card">
      <div class="title">
        <canvas id="logoShip" width="148" height="104"></canvas>
        <div>
          <h1>하늘편대 100</h1>
          <p class="sub" style="margin:2px 0 0">친구 5명까지 같이 날면서 <b>100단계</b>를 함께 깨는 협동 비행 슈팅</p>
        </div>
      </div>

      <div class="row"><label class="lb">이름 (별명)</label>
        <input id="nick" type="text" maxlength="8" placeholder="예: 하늘이" autocomplete="off">
      </div>
      <div class="row"><label class="lb">비행기 고르기</label>
        <div class="ships" id="ships"></div>
      </div>

      <div class="tabs">
        <button data-tab="make" class="on">방 만들기</button>
        <button data-tab="join">친구 방 들어가기</button>
        <button data-tab="solo">혼자 연습</button>
      </div>

      <div class="pane on" id="pane-make">
        <div class="btns"><button class="btn go wide" id="btnMake">방 만들고 출발 🚀</button></div>
        <div class="hint">방을 만들면 <b>4글자 코드</b>가 나옵니다. 친구들이 그 코드를 넣으면 같은 하늘로 들어옵니다.
          게임 중에도 언제든 들어올 수 있어요.<br>
          새 방은 <b>1단계부터</b> 시작합니다. 다음 시간에 이어서 하려면 <b>코드를 적어 두었다가</b>
          "친구 방 들어가기"에 같은 코드를 넣으세요 — 그 방이 깬 단계부터 이어집니다.</div>
      </div>

      <div class="pane" id="pane-join">
        <div class="codebox">
          <input id="code" type="text" maxlength="4" placeholder="ABCD" autocomplete="off">
          <button class="btn pri" id="btnJoin" style="flex:0 0 auto">들어가기</button>
        </div>
        <div class="roomInfo" id="roomInfo"></div>
        <div class="stagePick" id="stagePick">
          <span>이어서 할 단계</span>
          <input id="stageRange" type="range" min="1" max="1" value="1">
          <b id="stageVal" style="min-width:74px;text-align:right">1단계</b>
        </div>
        <div class="hint">친구가 알려 준 코드 4글자를 넣으세요. 대소문자는 상관없습니다.<br>
          비어 있던 방이면 <b>그 방이 깬 단계</b>부터 다시 시작할 수 있고, 이미 누가 날고 있으면 바로 합류합니다.</div>
      </div>

      <div class="pane" id="pane-solo">
        <div class="stagePick" style="display:flex">
          <span>시작 단계</span>
          <input id="soloRange" type="range" min="1" max="100" value="1">
          <b id="soloVal" style="min-width:74px;text-align:right">1단계</b>
        </div>
        <div class="btns"><button class="btn wide" id="btnSolo">혼자 연습 시작</button></div>
        <div class="hint">인터넷 없이 이 기기에서만 돌아갑니다. 조작과 단계를 미리 익혀 보세요.</div>
      </div>

      <div class="msg" id="msg"></div>
      <div class="hint" style="border-top:1px solid var(--line);margin-top:14px;padding-top:12px">
        <b>조작</b> — 마우스·손가락을 움직이면 비행기가 따라옵니다(총은 자동). <b>스페이스</b> 또는 오른쪽 아래 💣 버튼으로 폭탄.
        키보드 방향키/WASD 로도 움직일 수 있어요.<br>
        <b>협동</b> — 친구가 격추되면 <b>가까이 날아가 2초만 버티면</b> 살릴 수 있습니다. 다 같이 쓰러지면 그 단계를 처음부터 다시 합니다.
      </div>
    </div>
  </div>
</div>

<script src="sim.js"></script>
<script>
/* ═══════════════════════════════════════════════════════════════
 *  하늘편대 100 — 클라이언트
 *  · 그림은 전부 캔버스에 직접 그립니다(이미지 파일 없음).
 *  · 온라인은 서버가 계산한 상태를 받아 그리고, 혼자 연습은 같은
 *    sim.js 를 이 기기에서 돌립니다 — 그리는 코드는 하나뿐입니다.
 * ═══════════════════════════════════════════════════════════════ */
(function () {
'use strict';
const S = window.SkySim;
const F = S.FIELD, DT = S.DT;

/* ───────────────── 기본 도구 ───────────────── */
const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;

const SHIP_COLORS = [
  { name: '하늘', body: '#8fd4ff', deep: '#2f7fc8', trim: '#ffffff', glow: '#7fe0ff' },
  { name: '노을', body: '#ffb07a', deep: '#d1552b', trim: '#ffe9c8', glow: '#ff9a5c' },
  { name: '숲',   body: '#9be8a8', deep: '#2f9a5a', trim: '#eaffe9', glow: '#7bffb0' },
  { name: '보라', body: '#cfa8ff', deep: '#7a3fd0', trim: '#f3e8ff', glow: '#c07bff' },
  { name: '분홍', body: '#ffa8c8', deep: '#d83f78', trim: '#ffe4ef', glow: '#ff7ab0' },
  { name: '금빛', body: '#ffdf8a', deep: '#c98a10', trim: '#fff6da', glow: '#ffd166' },
];

/* ───────────────── 캔버스 ───────────────── */
const cv = $('#game'), ctx = cv.getContext('2d', { alpha: false });
let VIEW = { s: 1, ox: 0, oy: 0, w: 0, h: 0, dpr: 1 };
function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth, h = window.innerHeight;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  cv.style.width = w + 'px'; cv.style.height = h + 'px';
  const s = Math.min(w / F.w, h / F.h);
  VIEW = { s, ox: (w - F.w * s) / 2, oy: (h - F.h * s) / 2, w, h, dpr };
}
window.addEventListener('resize', resize);
resize();
const toField = (cx, cy) => ({ x: (cx - VIEW.ox) / VIEW.s, y: (cy - VIEW.oy) / VIEW.s });

/* ═══════════════════════════════════════════════════════════════
 *  그림 — 스프라이트를 한 번만 그려 두고(오프스크린) 재사용합니다.
 * ═══════════════════════════════════════════════════════════════ */
const SS = 2;                       // 선명하게 그리려고 2배로 그린 뒤 축소
const spriteCache = new Map();
function sprite(key, w, h, draw) {
  let c = spriteCache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = Math.ceil(w * SS); c.height = Math.ceil(h * SS);
  const g = c.getContext('2d');
  // 원점을 판 한가운데에 둡니다. (예전에는 w/2 로 두어 그림이 왼쪽 위로 1/4 밀리고 잘렸습니다)
  g.setTransform(SS, 0, 0, SS, w * SS / 2, h * SS / 2);
  g.lineJoin = 'round'; g.lineCap = 'round';
  draw(g);
  c._w = w; c._h = h;
  spriteCache.set(key, c);
  return c;
}
function blit(g, spr, x, y, ang, scale, alpha) {
  g.save();
  g.translate(x, y);
  if (ang) g.rotate(ang);
  const sc = scale || 1;
  if (alpha !== undefined) g.globalAlpha = alpha;
  g.drawImage(spr, -spr._w / 2 * sc, -spr._h / 2 * sc, spr._w * sc, spr._h * sc);
  g.restore();
}
// 피격 순간에 하얗게 번쩍이는 판. 원본 스프라이트를 키로 따로 보관합니다.
const whiteCache = new WeakMap();
function flashOf(spr) {
  let c = whiteCache.get(spr);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = spr.width; c.height = spr.height;
  const g = c.getContext('2d');
  g.drawImage(spr, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = 'rgba(255,255,255,.92)'; g.fillRect(0, 0, c.width, c.height);
  c._w = spr._w; c._h = spr._h;
  whiteCache.set(spr, c);
  return c;
}

/* 부드러운 빛 덩어리. 그라데이션을 매 프레임 만들면 무거워서 색마다 한 번만 그려 둡니다. */
function glow(col) {
  return sprite('glow' + col, 64, 64, (g) => {
    const [r, gg, b] = rgbOf(col), c = r + ',' + gg + ',' + b;
    const rg = g.createRadialGradient(0, 0, 0, 0, 0, 32);
    rg.addColorStop(0, 'rgba(255,255,255,1)');
    rg.addColorStop(.2, 'rgba(' + c + ',.85)');
    rg.addColorStop(.55, 'rgba(' + c + ',.25)');
    rg.addColorStop(1, 'rgba(' + c + ',0)');
    g.fillStyle = rg; g.fillRect(-32, -32, 64, 64);
  });
}
// 흰 심지 없이 색만 은은한 빛 (보스 후광처럼 넓게 까는 용도)
function haze(col) {
  return sprite('haze' + col, 64, 64, (g) => {
    const [r, gg, b] = rgbOf(col), c = r + ',' + gg + ',' + b;
    const rg = g.createRadialGradient(0, 0, 0, 0, 0, 32);
    rg.addColorStop(0, 'rgba(' + c + ',.6)'); rg.addColorStop(.5, 'rgba(' + c + ',.22)'); rg.addColorStop(1, 'rgba(' + c + ',0)');
    g.fillStyle = rg; g.fillRect(-32, -32, 64, 64);
  });
}
function glowAt(g, col, x, y, r, a) {
  g.globalAlpha = a === undefined ? 1 : a;
  g.drawImage(glow(col), x - r, y - r, r * 2, r * 2);
}
const smokeSpr = () => sprite('smoke', 64, 64, (g) => {
  const rg = g.createRadialGradient(-5, -5, 2, 0, 0, 32);
  rg.addColorStop(0, 'rgba(110,108,124,.8)'); rg.addColorStop(.6, 'rgba(76,74,90,.38)'); rg.addColorStop(1, 'rgba(60,60,76,0)');
  g.fillStyle = rg; g.fillRect(-32, -32, 64, 64);
});

/* 그래픽 품질 — 오래된 태블릿에서 버벅이면 저절로 '낮음'으로 바꿉니다(✨ 버튼으로 되돌릴 수 있음) */
const GFX = { hi: localStorage.getItem('sky.gfx') !== 'lo', autoDone: false, fps: 60, slowT: 0 };

/* ── 아군 비행기 ── */
function drawShipArt(g, C) {
  const L = 30;                       // 코 끝까지 길이
  // 그림자
  g.save(); g.globalAlpha = .28; g.filter = 'blur(3px)';
  g.fillStyle = '#000'; g.beginPath(); g.ellipse(-2, 7, L * .8, 12, 0, 0, TAU); g.fill(); g.restore();

  // 뒷날개(수평 미익)
  g.fillStyle = C.deep;
  g.beginPath();
  g.moveTo(-20, 0); g.lineTo(-30, -17); g.lineTo(-22, -18); g.lineTo(-10, -3);
  g.lineTo(-10, 3); g.lineTo(-22, 18); g.lineTo(-30, 17); g.closePath(); g.fill();

  // 주 날개 (아래위 대칭 델타익)
  const wing = g.createLinearGradient(0, -26, 0, 26);
  wing.addColorStop(0, C.body); wing.addColorStop(.5, C.deep); wing.addColorStop(1, C.body);
  g.fillStyle = wing;
  g.beginPath();
  g.moveTo(6, -4); g.lineTo(-6, -30); g.lineTo(-19, -31); g.lineTo(-13, -5);
  g.lineTo(-13, 5); g.lineTo(-19, 31); g.lineTo(-6, 30); g.lineTo(6, 4); g.closePath(); g.fill();
  // 날개 끝 미사일 포드
  g.fillStyle = C.trim;
  g.beginPath(); g.roundRect(-16, -32, 13, 5, 2.5); g.fill();
  g.beginPath(); g.roundRect(-16, 27, 13, 5, 2.5); g.fill();

  // 동체
  const body = g.createLinearGradient(0, -10, 0, 12);
  body.addColorStop(0, '#ffffff'); body.addColorStop(.28, C.body);
  body.addColorStop(.72, C.deep); body.addColorStop(1, '#12203a');
  g.fillStyle = body;
  g.beginPath();
  g.moveTo(L, 0);
  g.bezierCurveTo(L - 6, -6, 4, -11, -16, -10);
  g.lineTo(-22, -7); g.lineTo(-22, 7); g.lineTo(-16, 10);
  g.bezierCurveTo(4, 11, L - 6, 6, L, 0);
  g.closePath(); g.fill();

  // 동체 위 하이라이트
  g.globalAlpha = .55; g.fillStyle = '#fff';
  g.beginPath(); g.moveTo(L - 3, -1); g.bezierCurveTo(8, -7, -6, -8, -18, -7);
  g.lineTo(-18, -5); g.bezierCurveTo(-6, -5.5, 8, -4, L - 4, 0); g.closePath(); g.fill();
  g.globalAlpha = 1;

  // 조종석 캐노피
  const cg = g.createLinearGradient(2, -8, 8, 6);
  cg.addColorStop(0, '#ffffff'); cg.addColorStop(.35, '#bfe6ff'); cg.addColorStop(1, '#1d3f6e');
  g.fillStyle = cg;
  g.beginPath(); g.ellipse(6, -0.5, 10, 6, 0, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 1.2; g.stroke();
  g.globalAlpha = .85; g.fillStyle = '#fff';
  g.beginPath(); g.ellipse(8.5, -2.6, 4, 1.8, -.35, 0, TAU); g.fill(); g.globalAlpha = 1;

  // 기수 줄무늬
  g.fillStyle = C.trim;
  g.beginPath(); g.moveTo(L - 1, 0); g.lineTo(L - 9, -3.4); g.lineTo(L - 9, 3.4); g.closePath(); g.fill();

  // 엔진 노즐
  g.fillStyle = '#22304d';
  g.beginPath(); g.roundRect(-25, -8, 6, 6, 2); g.fill();
  g.beginPath(); g.roundRect(-25, 2, 6, 6, 2); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = .9;
  g.beginPath(); g.roundRect(-25, -8, 6, 6, 2); g.stroke();
  g.beginPath(); g.roundRect(-25, 2, 6, 6, 2); g.stroke();
}
const shipSprite = (ci) => sprite('ship' + ci, 78, 74, (g) => drawShipArt(g, SHIP_COLORS[ci % 6]));

/* ── 적 그림들 (모두 왼쪽을 향합니다) ── */
const ART = {};
ART.scout = (g) => {
  g.fillStyle = '#5b6b8a';
  g.beginPath(); g.moveTo(-2, -20); g.lineTo(10, -8); g.lineTo(10, 8); g.lineTo(-2, 20);
  g.lineTo(2, 8); g.lineTo(2, -8); g.closePath(); g.fill();
  const b = g.createLinearGradient(0, -8, 0, 8);
  b.addColorStop(0, '#cdd8ea'); b.addColorStop(.5, '#8797b4'); b.addColorStop(1, '#41506e');
  g.fillStyle = b;
  g.beginPath(); g.moveTo(-22, 0); g.bezierCurveTo(-14, -8, 6, -9, 15, -6);
  g.lineTo(15, 6); g.bezierCurveTo(6, 9, -14, 8, -22, 0); g.closePath(); g.fill();
  g.fillStyle = '#ff5a5a'; g.beginPath(); g.ellipse(-10, 0, 4.5, 3.4, 0, 0, TAU); g.fill();
  g.fillStyle = 'rgba(255,120,120,.6)'; g.beginPath(); g.ellipse(-10, 0, 8, 6, 0, 0, TAU); g.fill();
};
ART.wasp = (g) => {
  g.fillStyle = 'rgba(200,230,255,.35)';
  g.beginPath(); g.ellipse(2, -10, 10, 5, -.5, 0, TAU); g.fill();
  g.beginPath(); g.ellipse(2, 10, 10, 5, .5, 0, TAU); g.fill();
  const b = g.createLinearGradient(0, -7, 0, 7);
  b.addColorStop(0, '#ffe08a'); b.addColorStop(1, '#c07a10');
  g.fillStyle = b; g.beginPath(); g.ellipse(0, 0, 15, 7, 0, 0, TAU); g.fill();
  g.fillStyle = '#2b2416';
  for (let i = -1; i <= 1; i++) { g.beginPath(); g.ellipse(i * 6, 0, 2, 6.6, 0, 0, TAU); g.fill(); }
  g.fillStyle = '#ff4d4d'; g.beginPath(); g.arc(-13, 0, 3, 0, TAU); g.fill();
};
ART.bomber = (g) => {
  g.fillStyle = '#3d4d68';
  g.beginPath(); g.roundRect(-6, -34, 16, 68, 6); g.fill();
  const b = g.createLinearGradient(0, -14, 0, 14);
  b.addColorStop(0, '#9fb0cc'); b.addColorStop(.5, '#5d6f92'); b.addColorStop(1, '#2c3950');
  g.fillStyle = b;
  g.beginPath(); g.moveTo(-32, 0); g.bezierCurveTo(-22, -14, 12, -16, 26, -10);
  g.lineTo(26, 10); g.bezierCurveTo(12, 16, -22, 14, -32, 0); g.closePath(); g.fill();
  g.fillStyle = '#22304a';
  for (const y of [-26, -14, 14, 26]) { g.beginPath(); g.roundRect(-2, y - 4, 14, 8, 3); g.fill(); }
  g.fillStyle = '#ffb84d';
  for (const y of [-26, -14, 14, 26]) { g.beginPath(); g.arc(-3, y, 2.4, 0, TAU); g.fill(); }
  g.fillStyle = '#7fd8ff'; g.beginPath(); g.ellipse(-16, 0, 7, 4.5, 0, 0, TAU); g.fill();
  g.fillStyle = 'rgba(255,255,255,.4)'; g.beginPath(); g.ellipse(-17, -1.6, 3, 1.6, 0, 0, TAU); g.fill();
};
ART.sniper = (g) => {
  g.fillStyle = '#4a3f6b';
  g.beginPath(); g.moveTo(6, -22); g.lineTo(16, -6); g.lineTo(16, 6); g.lineTo(6, 22);
  g.lineTo(10, 6); g.lineTo(10, -6); g.closePath(); g.fill();
  const b = g.createLinearGradient(0, -8, 0, 8);
  b.addColorStop(0, '#c9b6ff'); b.addColorStop(.55, '#7a63c0'); b.addColorStop(1, '#3b2f66');
  g.fillStyle = b;
  g.beginPath(); g.moveTo(-30, 0); g.lineTo(-16, -8); g.lineTo(16, -8);
  g.lineTo(20, 0); g.lineTo(16, 8); g.lineTo(-16, 8); g.closePath(); g.fill();
  g.fillStyle = '#1d1733'; g.beginPath(); g.roundRect(-34, -3, 16, 6, 3); g.fill();
  g.fillStyle = '#ff77c8'; g.beginPath(); g.arc(-33, 0, 3.2, 0, TAU); g.fill();
  g.fillStyle = 'rgba(255,119,200,.45)'; g.beginPath(); g.arc(-33, 0, 7, 0, TAU); g.fill();
};
ART.kami = (g) => {
  g.fillStyle = '#ff5a3c';
  g.beginPath(); g.moveTo(-24, 0); g.lineTo(6, -14); g.lineTo(2, 0); g.lineTo(6, 14); g.closePath(); g.fill();
  const b = g.createRadialGradient(-6, 0, 2, -6, 0, 16);
  b.addColorStop(0, '#fff2a8'); b.addColorStop(.5, '#ff9a3c'); b.addColorStop(1, '#8a2a10');
  g.fillStyle = b; g.beginPath(); g.ellipse(-4, 0, 14, 9, 0, 0, TAU); g.fill();
  g.fillStyle = '#fff'; g.globalAlpha = .8;
  g.beginPath(); g.arc(-9, -2, 2.4, 0, TAU); g.fill(); g.globalAlpha = 1;
  g.strokeStyle = '#ffd166'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(8, -12); g.lineTo(16, -18); g.moveTo(8, 12); g.lineTo(16, 18); g.stroke();
};
ART.shield = (g) => {
  const b = g.createLinearGradient(0, -12, 0, 12);
  b.addColorStop(0, '#a8c0e0'); b.addColorStop(.5, '#566c92'); b.addColorStop(1, '#28344c');
  g.fillStyle = b; g.beginPath(); g.roundRect(-10, -18, 32, 36, 9); g.fill();
  g.fillStyle = '#33425f';
  g.beginPath(); g.moveTo(20, -20); g.lineTo(30, -8); g.lineTo(30, 8); g.lineTo(20, 20); g.closePath(); g.fill();
  // 앞쪽 방패판
  const s = g.createLinearGradient(-26, 0, -8, 0);
  s.addColorStop(0, '#ffe9a8'); s.addColorStop(.5, '#e0a83c'); s.addColorStop(1, '#8a6410');
  g.fillStyle = s;
  g.beginPath(); g.moveTo(-12, -24); g.quadraticCurveTo(-30, 0, -12, 24);
  g.lineTo(-6, 20); g.quadraticCurveTo(-21, 0, -6, -20); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 1.4; g.stroke();
  g.fillStyle = '#7fd8ff'; g.beginPath(); g.ellipse(2, 0, 6, 5, 0, 0, TAU); g.fill();
};
ART.turret = (g) => {
  g.fillStyle = '#3a4560';
  g.beginPath();
  for (let i = 0; i < 8; i++) { const a = i / 8 * TAU + .39; const r = 27; i ? g.lineTo(Math.cos(a) * r, Math.sin(a) * r) : g.moveTo(Math.cos(a) * r, Math.sin(a) * r); }
  g.closePath(); g.fill();
  g.strokeStyle = '#6d7d9e'; g.lineWidth = 2; g.stroke();
  const b = g.createRadialGradient(-4, -4, 2, 0, 0, 20);
  b.addColorStop(0, '#dfe8f8'); b.addColorStop(.6, '#8493b2'); b.addColorStop(1, '#3c4964');
  g.fillStyle = b; g.beginPath(); g.arc(0, 0, 18, 0, TAU); g.fill();
  g.fillStyle = '#20293d';
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * TAU;
    g.save(); g.rotate(a); g.beginPath(); g.roundRect(16, -3, 12, 6, 2.5); g.fill(); g.restore();
  }
  g.fillStyle = '#ff8a3c'; g.beginPath(); g.arc(0, 0, 7, 0, TAU); g.fill();
  g.fillStyle = 'rgba(255,180,80,.4)'; g.beginPath(); g.arc(0, 0, 12, 0, TAU); g.fill();
};
ART.split = (g) => {
  const b = g.createRadialGradient(-6, -6, 3, 0, 0, 30);
  b.addColorStop(0, '#d8ffe8'); b.addColorStop(.5, '#5cc98a'); b.addColorStop(1, '#1d5c3c');
  g.fillStyle = b; g.beginPath(); g.ellipse(0, 0, 28, 24, 0, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(-24, 0); g.quadraticCurveTo(0, -8, 24, 0); g.stroke();
  g.fillStyle = 'rgba(0,60,30,.5)';
  g.beginPath(); g.ellipse(-8, 6, 6, 4, .4, 0, TAU); g.fill();
  g.beginPath(); g.ellipse(9, -5, 5, 3.4, -.3, 0, TAU); g.fill();
};
ART.splitlet = (g) => {
  const b = g.createRadialGradient(-3, -3, 1, 0, 0, 16);
  b.addColorStop(0, '#e8ffe8'); b.addColorStop(.6, '#6fd8a0'); b.addColorStop(1, '#236b48');
  g.fillStyle = b; g.beginPath(); g.ellipse(0, 0, 15, 13, 0, 0, TAU); g.fill();
};
ART.healer = (g) => {
  g.fillStyle = 'rgba(120,255,190,.22)'; g.beginPath(); g.arc(0, 0, 26, 0, TAU); g.fill();
  const b = g.createLinearGradient(0, -12, 0, 12);
  b.addColorStop(0, '#dfffe8'); b.addColorStop(.5, '#63d69a'); b.addColorStop(1, '#1e6b48');
  g.fillStyle = b; g.beginPath(); g.roundRect(-18, -14, 36, 28, 12); g.fill();
  g.fillStyle = '#fff';
  g.beginPath(); g.roundRect(-4, -10, 8, 20, 3); g.fill();
  g.beginPath(); g.roundRect(-11, -3, 22, 6, 3); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1.6;
  g.beginPath(); g.roundRect(-18, -14, 36, 28, 12); g.stroke();
};
ART.missile = (g) => {
  const b = g.createLinearGradient(0, -12, 0, 12);
  b.addColorStop(0, '#c8d6ea'); b.addColorStop(.5, '#63719a'); b.addColorStop(1, '#2a3350');
  g.fillStyle = b;
  g.beginPath(); g.moveTo(-26, 0); g.lineTo(-12, -12); g.lineTo(20, -12);
  g.lineTo(26, 0); g.lineTo(20, 12); g.lineTo(-12, 12); g.closePath(); g.fill();
  g.fillStyle = '#1e2740';
  g.beginPath(); g.roundRect(-16, -24, 24, 10, 4); g.fill();
  g.beginPath(); g.roundRect(-16, 14, 24, 10, 4); g.fill();
  g.fillStyle = '#ff6b3d';
  g.beginPath(); g.arc(-14, -19, 3, 0, TAU); g.fill();
  g.beginPath(); g.arc(-14, 19, 3, 0, TAU); g.fill();
  g.fillStyle = '#7fd8ff'; g.beginPath(); g.ellipse(-8, 0, 6, 4.5, 0, 0, TAU); g.fill();
};
ART.lancer = (g) => {
  const b = g.createLinearGradient(0, -13, 0, 13);
  b.addColorStop(0, '#ffd0f0'); b.addColorStop(.5, '#b04ba8'); b.addColorStop(1, '#4a1748');
  g.fillStyle = b;
  g.beginPath(); g.moveTo(-30, 0); g.lineTo(-14, -13); g.lineTo(22, -10);
  g.lineTo(28, 0); g.lineTo(22, 10); g.lineTo(-14, 13); g.closePath(); g.fill();
  g.fillStyle = '#2b0f2c'; g.beginPath(); g.roundRect(-36, -6, 20, 12, 5); g.fill();
  const e = g.createRadialGradient(-34, 0, 1, -34, 0, 9);
  e.addColorStop(0, '#ffffff'); e.addColorStop(.5, '#ff7ae0'); e.addColorStop(1, 'rgba(255,122,224,0)');
  g.fillStyle = e; g.beginPath(); g.arc(-34, 0, 9, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(255,200,255,.6)'; g.lineWidth = 1.6;
  g.beginPath(); g.moveTo(-10, -9); g.lineTo(16, -7); g.stroke();
};
ART.mine = (g) => {
  g.strokeStyle = '#8a7a5a'; g.lineWidth = 4;
  for (let i = 0; i < 10; i++) {
    const a = i / 10 * TAU;
    g.beginPath(); g.moveTo(Math.cos(a) * 14, Math.sin(a) * 14);
    g.lineTo(Math.cos(a) * 25, Math.sin(a) * 25); g.stroke();
  }
  const b = g.createRadialGradient(-5, -5, 2, 0, 0, 18);
  b.addColorStop(0, '#8b96a8'); b.addColorStop(.6, '#4a5468'); b.addColorStop(1, '#1e2532');
  g.fillStyle = b; g.beginPath(); g.arc(0, 0, 17, 0, TAU); g.fill();
  g.fillStyle = '#ff3c3c'; g.beginPath(); g.arc(0, 0, 5, 0, TAU); g.fill();
};
const enemySprite = (art) => sprite('e_' + art, 90, 90, (g) => (ART[art] || ART.scout)(g));

/* ── 보스 그림 10기 ── */
const BOSS_ART = {};
BOSS_ART.fortress = (g, R, t) => {
  g.fillStyle = 'rgba(255,255,255,.16)';
  for (let i = 0; i < 5; i++) { const a = t * .3 + i * 1.3; g.beginPath(); g.ellipse(Math.cos(a) * R * .8, Math.sin(a * 1.3) * R * .5, R * .45, R * .3, 0, 0, TAU); g.fill(); }
  const b = g.createLinearGradient(0, -R, 0, R);
  b.addColorStop(0, '#f2f7ff'); b.addColorStop(.45, '#a8bcd8'); b.addColorStop(1, '#3d4d6b');
  g.fillStyle = b;
  g.beginPath(); g.moveTo(-R, 0); g.lineTo(-R * .5, -R * .85); g.lineTo(R * .55, -R * .8);
  g.lineTo(R, 0); g.lineTo(R * .55, R * .8); g.lineTo(-R * .5, R * .85); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 3; g.stroke();
  g.fillStyle = '#2b3650';
  for (const y of [-R * .5, 0, R * .5]) { g.beginPath(); g.roundRect(-R * 1.02, y - R * .12, R * .3, R * .24, 6); g.fill(); }
  g.fillStyle = '#ffd166';
  for (const y of [-R * .5, 0, R * .5]) { g.beginPath(); g.arc(-R * .95, y, R * .07, 0, TAU); g.fill(); }
  const core = g.createRadialGradient(0, 0, 2, 0, 0, R * .38);
  core.addColorStop(0, '#fff'); core.addColorStop(.4, '#7fd8ff'); core.addColorStop(1, 'rgba(60,140,255,0)');
  g.fillStyle = core; g.beginPath(); g.arc(0, 0, R * .38, 0, TAU); g.fill();
};
BOSS_ART.hive = (g, R, t) => {
  const b = g.createLinearGradient(0, -R, 0, R);
  b.addColorStop(0, '#ffe9a8'); b.addColorStop(.5, '#d8a020'); b.addColorStop(1, '#6b4a08');
  g.fillStyle = b;
  g.beginPath();
  for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; const x = Math.cos(a) * R, y = Math.sin(a) * R; i ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.closePath(); g.fill();
  g.strokeStyle = '#4a3208'; g.lineWidth = 4; g.stroke();
  g.fillStyle = 'rgba(60,40,4,.65)';
  for (let ring = 1; ring <= 2; ring++) for (let i = 0; i < 6 * ring; i++) {
    const a = i / (6 * ring) * TAU + ring * .3, rr = R * .3 * ring;
    g.beginPath();
    for (let k = 0; k < 6; k++) { const aa = k / 6 * TAU; const x = Math.cos(a) * rr + Math.cos(aa) * R * .13, y = Math.sin(a) * rr + Math.sin(aa) * R * .13; k ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.closePath(); g.fill();
  }
  g.fillStyle = '#ff7a3c';
  g.beginPath(); g.arc(-R * .55, 0, R * .12, 0, TAU); g.fill();
  g.fillStyle = 'rgba(255,180,60,' + (.3 + Math.sin(t * 4) * .2) + ')';
  g.beginPath(); g.arc(0, 0, R * .3, 0, TAU); g.fill();
};
BOSS_ART.zeppelin = (g, R, t) => {
  const b = g.createLinearGradient(0, -R * .7, 0, R * .7);
  b.addColorStop(0, '#ffd9b0'); b.addColorStop(.45, '#e07a5f'); b.addColorStop(1, '#6b2a3c');
  g.fillStyle = b;
  g.beginPath(); g.ellipse(0, 0, R * 1.15, R * .62, 0, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(255,220,180,.5)'; g.lineWidth = 2;
  for (let i = -2; i <= 2; i++) { g.beginPath(); g.ellipse(i * R * .35, 0, R * .1, R * .6, 0, 0, TAU); g.stroke(); }
  g.fillStyle = '#4a2436';
  g.beginPath(); g.moveTo(R * .75, -R * .5); g.lineTo(R * 1.25, -R * .95); g.lineTo(R * 1.15, -R * .35); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(R * .75, R * .5); g.lineTo(R * 1.25, R * .95); g.lineTo(R * 1.15, R * .35); g.closePath(); g.fill();
  g.fillStyle = '#33202e'; g.beginPath(); g.roundRect(-R * .5, R * .45, R * .95, R * .3, R * .12); g.fill();
  const e = g.createRadialGradient(-R * 1.1, 0, 2, -R * 1.1, 0, R * .3);
  e.addColorStop(0, '#fff'); e.addColorStop(.4, '#ff9a5c'); e.addColorStop(1, 'rgba(255,120,60,0)');
  g.fillStyle = e; g.beginPath(); g.arc(-R * 1.1, 0, R * .3, 0, TAU); g.fill();
  g.fillStyle = '#ffe08a';
  for (let i = -1; i <= 1; i++) { g.beginPath(); g.arc(-R * .2 + i * R * .3, R * .6, R * .05, 0, TAU); g.fill(); }
};
BOSS_ART.batwing = (g, R, t) => {
  const flap = Math.sin(t * 2) * .16;
  const b = g.createLinearGradient(0, -R, 0, R);
  b.addColorStop(0, '#6b5aa8'); b.addColorStop(.5, '#3a2c6b'); b.addColorStop(1, '#160f2e');
  g.fillStyle = b;
  g.save(); g.rotate(-flap);
  g.beginPath(); g.moveTo(0, -R * .2);
  g.quadraticCurveTo(R * .4, -R * .95, R * 1.15, -R * 1.0);
  g.quadraticCurveTo(R * .7, -R * .55, R * .95, -R * .35);
  g.quadraticCurveTo(R * .4, -R * .4, 0, -R * .05); g.closePath(); g.fill(); g.restore();
  g.save(); g.rotate(flap);
  g.beginPath(); g.moveTo(0, R * .2);
  g.quadraticCurveTo(R * .4, R * .95, R * 1.15, R * 1.0);
  g.quadraticCurveTo(R * .7, R * .55, R * .95, R * .35);
  g.quadraticCurveTo(R * .4, R * .4, 0, R * .05); g.closePath(); g.fill(); g.restore();
  g.fillStyle = '#241a4a';
  g.beginPath(); g.moveTo(-R, 0); g.quadraticCurveTo(-R * .3, -R * .45, R * .7, -R * .2);
  g.lineTo(R * .7, R * .2); g.quadraticCurveTo(-R * .3, R * .45, -R, 0); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(160,140,255,.55)'; g.lineWidth = 2; g.stroke();
  g.fillStyle = '#ff4d6b';
  g.beginPath(); g.ellipse(-R * .5, -R * .12, R * .1, R * .06, -.3, 0, TAU); g.fill();
  g.beginPath(); g.ellipse(-R * .5, R * .12, R * .1, R * .06, .3, 0, TAU); g.fill();
  g.fillStyle = 'rgba(255,80,110,.35)';
  g.beginPath(); g.arc(-R * .5, 0, R * .28, 0, TAU); g.fill();
};
BOSS_ART.prism = (g, R, t) => {
  g.save(); g.rotate(t * .55);
  g.fillStyle = 'rgba(120,255,220,.22)';
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * TAU;
    g.save(); g.translate(Math.cos(a) * R * 1.05, Math.sin(a) * R * 1.05); g.rotate(a);
    g.beginPath(); g.moveTo(-R * .18, 0); g.lineTo(0, -R * .28); g.lineTo(R * .18, 0); g.lineTo(0, R * .28); g.closePath(); g.fill();
    g.restore();
  }
  g.restore();
  const b = g.createLinearGradient(-R, -R, R, R);
  b.addColorStop(0, '#eafff8'); b.addColorStop(.35, '#6bffd0'); b.addColorStop(.7, '#1f8ea8'); b.addColorStop(1, '#083c52');
  g.fillStyle = b;
  g.beginPath(); g.moveTo(0, -R); g.lineTo(R * .82, -R * .3); g.lineTo(R * .55, R * .82);
  g.lineTo(-R * .55, R * .82); g.lineTo(-R * .82, -R * .3); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.65)'; g.lineWidth = 2.5; g.stroke();
  g.globalAlpha = .5; g.strokeStyle = '#fff'; g.lineWidth = 1.4;
  g.beginPath(); g.moveTo(0, -R); g.lineTo(0, R * .82);
  g.moveTo(-R * .82, -R * .3); g.lineTo(R * .82, -R * .3); g.stroke(); g.globalAlpha = 1;
  const c = g.createRadialGradient(0, 0, 2, 0, 0, R * .45);
  c.addColorStop(0, '#fff'); c.addColorStop(.45, '#a8fff0'); c.addColorStop(1, 'rgba(120,255,220,0)');
  g.fillStyle = c; g.beginPath(); g.arc(0, 0, R * .45 * (1 + Math.sin(t * 3) * .1), 0, TAU); g.fill();
};
BOSS_ART.sandworm = (g, R, t) => {
  g.fillStyle = 'rgba(220,180,110,.25)';
  for (let i = 1; i <= 4; i++) {
    g.beginPath(); g.ellipse(R * .55 * i, Math.sin(t * 2 - i * .6) * R * .3, R * (.6 - i * .1), R * (.5 - i * .08), 0, 0, TAU); g.fill();
  }
  const b = g.createRadialGradient(-R * .2, -R * .2, R * .1, 0, 0, R);
  b.addColorStop(0, '#f7e0b0'); b.addColorStop(.5, '#c98a44'); b.addColorStop(1, '#5a3a18');
  g.fillStyle = b; g.beginPath(); g.ellipse(0, 0, R, R * .92, 0, 0, TAU); g.fill();
  g.fillStyle = '#2a1a0a';
  g.beginPath(); g.ellipse(-R * .55, 0, R * .42, R * .55, 0, 0, TAU); g.fill();
  g.fillStyle = '#fff6d8';
  for (let i = 0; i < 9; i++) {
    const a = -Math.PI / 2 + i / 8 * Math.PI;
    g.save(); g.translate(-R * .55 + Math.cos(a) * R * .05, Math.sin(a) * R * .5);
    g.beginPath(); g.moveTo(0, 0); g.lineTo(-R * .16, -R * .06); g.lineTo(-R * .16, R * .06); g.closePath(); g.fill(); g.restore();
  }
  g.fillStyle = '#ffb020';
  for (const s of [-1, 1]) { g.beginPath(); g.ellipse(R * .12, s * R * .5, R * .12, R * .09, 0, 0, TAU); g.fill(); }
  g.strokeStyle = 'rgba(90,58,24,.7)'; g.lineWidth = 3;
  for (let i = 0; i < 3; i++) { g.beginPath(); g.ellipse(R * .2 + i * R * .22, 0, R * .1, R * .72, 0, 0, TAU); g.stroke(); }
};
BOSS_ART.magma = (g, R, t) => {
  const b = g.createLinearGradient(0, -R, 0, R);
  b.addColorStop(0, '#6b3a2a'); b.addColorStop(.5, '#3a1a12'); b.addColorStop(1, '#1a0808');
  g.fillStyle = b;
  g.beginPath();
  for (let i = 0; i < 11; i++) {
    const a = i / 11 * TAU, rr = R * (.82 + ((i * 37) % 11) / 40);
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr * .95;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.closePath(); g.fill();
  const pulse = .55 + Math.sin(t * 3) * .25;
  g.strokeStyle = 'rgba(255,110,40,' + pulse + ')'; g.lineWidth = 5; g.lineCap = 'round';
  const cracks = [[-.7, -.3, -.1, -.05, .5, -.4], [-.6, .4, 0, .15, .6, .5], [-.2, -.8, .05, -.3, .3, .1]];
  for (const c of cracks) {
    g.beginPath(); g.moveTo(c[0] * R, c[1] * R);
    g.quadraticCurveTo(c[2] * R, c[3] * R, c[4] * R, c[5] * R); g.stroke();
  }
  g.fillStyle = '#ffcf5c';
  for (const s of [-1, 1]) {
    g.beginPath(); g.ellipse(-R * .4, s * R * .28, R * .14, R * .1, s * .3, 0, TAU); g.fill();
  }
  const c = g.createRadialGradient(0, R * .1, 2, 0, R * .1, R * .5);
  c.addColorStop(0, '#fff2a8'); c.addColorStop(.4, 'rgba(255,110,40,.7)'); c.addColorStop(1, 'rgba(255,60,20,0)');
  g.fillStyle = c; g.beginPath(); g.arc(0, R * .1, R * .5, 0, TAU); g.fill();
};
BOSS_ART.icequeen = (g, R, t) => {
  g.save(); g.rotate(-t * .4);
  g.fillStyle = 'rgba(180,240,255,.28)';
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * TAU;
    g.save(); g.translate(Math.cos(a) * R * 1.12, Math.sin(a) * R * 1.12); g.rotate(a);
    g.beginPath(); g.moveTo(-R * .1, 0); g.lineTo(0, -R * .22); g.lineTo(R * .1, 0); g.lineTo(0, R * .22); g.closePath(); g.fill();
    g.restore();
  }
  g.restore();
  const b = g.createLinearGradient(0, -R, 0, R);
  b.addColorStop(0, '#ffffff'); b.addColorStop(.4, '#a8e6ff'); b.addColorStop(1, '#2f6b96');
  g.fillStyle = b;
  g.beginPath(); g.moveTo(0, -R * 1.02); g.lineTo(R * .5, -R * .35); g.lineTo(R * .34, R * .9);
  g.lineTo(-R * .34, R * .9); g.lineTo(-R * .5, -R * .35); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.8)'; g.lineWidth = 2.4; g.stroke();
  // 왕관
  g.fillStyle = '#dff6ff';
  g.beginPath();
  g.moveTo(-R * .5, -R * .4);
  for (let i = 0; i < 5; i++) {
    const x = -R * .5 + (i + .5) * R * .2;
    g.lineTo(x, -R * (.72 + (i % 2 ? .12 : .28)));
    g.lineTo(x + R * .1, -R * .4);
  }
  g.closePath(); g.fill();
  g.fillStyle = '#7fe0ff';
  for (const s of [-1, 1]) { g.beginPath(); g.ellipse(s * R * .17, -R * .1, R * .08, R * .11, 0, 0, TAU); g.fill(); }
  g.globalAlpha = .45 + Math.sin(t * 2.4) * .2;
  const c = g.createRadialGradient(0, R * .2, 2, 0, R * .2, R * .5);
  c.addColorStop(0, '#fff'); c.addColorStop(1, 'rgba(140,220,255,0)');
  g.fillStyle = c; g.beginPath(); g.arc(0, R * .2, R * .5, 0, TAU); g.fill(); g.globalAlpha = 1;
};
BOSS_ART.interceptor = (g, R, t) => {
  const b = g.createLinearGradient(0, -R, 0, R);
  b.addColorStop(0, '#dfe8ff'); b.addColorStop(.4, '#7f9ad8'); b.addColorStop(1, '#1c2a52');
  g.fillStyle = b;
  g.beginPath(); g.moveTo(-R * 1.15, 0);
  g.bezierCurveTo(-R * .6, -R * .3, R * .3, -R * .35, R * .85, -R * .18);
  g.lineTo(R * .85, R * .18);
  g.bezierCurveTo(R * .3, R * .35, -R * .6, R * .3, -R * 1.15, 0); g.closePath(); g.fill();
  g.fillStyle = '#2f3f6b';
  for (const s of [-1, 1]) {
    g.beginPath(); g.moveTo(R * .1, s * R * .2); g.lineTo(R * .95, s * R * 1.0);
    g.lineTo(R * .5, s * R * 1.02); g.lineTo(-R * .2, s * R * .26); g.closePath(); g.fill();
  }
  g.fillStyle = '#7fa8ff';
  for (const s of [-1, 1]) { g.beginPath(); g.roundRect(R * .55, s * R * .78 - R * .05, R * .3, R * .1, R * .05); g.fill(); }
  const cg = g.createLinearGradient(-R * .8, 0, -R * .2, 0);
  cg.addColorStop(0, '#fff'); cg.addColorStop(1, '#2a4a8a');
  g.fillStyle = cg; g.beginPath(); g.ellipse(-R * .5, 0, R * .3, R * .14, 0, 0, TAU); g.fill();
  const e = g.createRadialGradient(R * .92, 0, 2, R * .92, 0, R * .35);
  e.addColorStop(0, '#fff'); e.addColorStop(.4, '#7fc8ff'); e.addColorStop(1, 'rgba(80,160,255,0)');
  g.fillStyle = e; g.beginPath(); g.arc(R * .92, 0, R * .35 * (1 + Math.sin(t * 12) * .12), 0, TAU); g.fill();
};
BOSS_ART.motherstar = (g, R, t) => {
  g.save(); g.rotate(t * .25);
  g.strokeStyle = 'rgba(190,130,255,.4)'; g.lineWidth = R * .07;
  g.beginPath(); g.ellipse(0, 0, R * 1.25, R * .42, .35, 0, TAU); g.stroke();
  g.strokeStyle = 'rgba(120,200,255,.35)';
  g.beginPath(); g.ellipse(0, 0, R * 1.1, R * .34, -.5, 0, TAU); g.stroke();
  g.restore();
  const b = g.createLinearGradient(0, -R, 0, R);
  b.addColorStop(0, '#e8dcff'); b.addColorStop(.4, '#8a6bd8'); b.addColorStop(1, '#25123f');
  g.fillStyle = b;
  g.beginPath();
  g.moveTo(-R * 1.05, 0);
  g.lineTo(-R * .35, -R * .55); g.lineTo(R * .35, -R * .9); g.lineTo(R * .95, -R * .4);
  g.lineTo(R * .95, R * .4); g.lineTo(R * .35, R * .9); g.lineTo(-R * .35, R * .55);
  g.closePath(); g.fill();
  g.strokeStyle = 'rgba(220,190,255,.6)'; g.lineWidth = 3; g.stroke();
  g.fillStyle = '#3c2a5e';
  for (const s of [-1, 1]) { g.beginPath(); g.roundRect(-R * .1, s * R * .45 - R * .1, R * .8, R * .2, R * .08); g.fill(); }
  g.fillStyle = '#ffd166';
  for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(-R * .05 + i * R * .14, -R * .55, R * .045, 0, TAU); g.fill(); }
  for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(-R * .05 + i * R * .14, R * .55, R * .045, 0, TAU); g.fill(); }
  const c = g.createRadialGradient(-R * .35, 0, 2, -R * .35, 0, R * .55);
  const p = 1 + Math.sin(t * 2.6) * .12;
  c.addColorStop(0, '#fff'); c.addColorStop(.3, '#e0a8ff'); c.addColorStop(.65, 'rgba(160,80,255,.55)'); c.addColorStop(1, 'rgba(120,40,220,0)');
  g.fillStyle = c; g.beginPath(); g.arc(-R * .35, 0, R * .55 * p, 0, TAU); g.fill();
};

/* ═══════════════════ 배경 ═══════════════════ */
const bgLayers = { far: [], mid: [], near: [], stars: [] };
function seedBg() {
  bgLayers.far = []; bgLayers.mid = []; bgLayers.near = []; bgLayers.stars = [];
  const r = S.mulberry32(7777);
  for (let i = 0; i < 8; i++) bgLayers.far.push({ x: r() * F.w * 1.4, y: 120 + r() * (F.h - 240), s: 110 + r() * 160, o: .07 + r() * .08 });
  for (let i = 0; i < 10; i++) bgLayers.mid.push({ x: r() * F.w * 1.4, y: 60 + r() * (F.h - 120), s: 70 + r() * 120, o: .11 + r() * .12 });
  for (let i = 0; i < 9; i++) bgLayers.near.push({ x: r() * F.w * 1.4, y: 40 + r() * (F.h - 80), s: 45 + r() * 95, o: .14 + r() * .16 });
  for (let i = 0; i < 150; i++) bgLayers.stars.push({ x: r() * F.w * 1.4, y: r() * F.h, s: .6 + r() * 2.2, o: .3 + r() * .7, tw: r() * TAU });
}
seedBg();

// 지역별 배경 덩어리(구름·성운·재구름)를 부드러운 그라데이션 뭉치로 한 번만 그려 둡니다.
function rgbOf(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function bgPuff(zone) {
  return sprite('puff' + zone, 300, 190, (g) => {
    const Z = S.ZONES[zone] || S.ZONES[0];
    const space = zone === 8 || zone === 9;
    const ash = zone === 6;
    const [r, gg, b] = rgbOf(space ? Z.accent : ash ? '#2a1008' : Z.dust);
    // 겹치는 동그라미 여러 개를 가장자리가 사라지는 그라데이션으로 칠하면 솜뭉치처럼 보입니다
    const puffs = space
      ? [[0, 0, 96, 1], [-34, -12, 58, .7], [40, 10, 52, .6]]
      : [[-52, 8, 52, .85], [-16, -12, 66, 1], [26, -4, 58, .9], [62, 12, 44, .75], [4, 18, 50, .6]];
    for (const [px, py, pr, pa] of puffs) {
      const rg = g.createRadialGradient(px, py, pr * .1, px, py, pr);
      rg.addColorStop(0, 'rgba(' + r + ',' + gg + ',' + b + ',' + (pa * (space ? .55 : .9)) + ')');
      rg.addColorStop(.55, 'rgba(' + r + ',' + gg + ',' + b + ',' + (pa * (space ? .3 : .55)) + ')');
      rg.addColorStop(1, 'rgba(' + r + ',' + gg + ',' + b + ',0)');
      g.fillStyle = rg;
      g.save(); g.translate(px, py); g.scale(1, space ? 1 : .62); g.translate(-px, -py);
      g.beginPath(); g.arc(px, py, pr, 0, TAU); g.fill(); g.restore();
    }
    if (ash) {   // 화산재 속에서 붉게 달아오른 부분
      const rg = g.createRadialGradient(-10, 4, 4, -10, 4, 60);
      rg.addColorStop(0, 'rgba(255,120,50,.45)'); rg.addColorStop(1, 'rgba(255,80,30,0)');
      g.fillStyle = rg;
      g.save(); g.scale(1, .6); g.beginPath(); g.arc(-10, 7, 60, 0, TAU); g.fill(); g.restore();
    }
  });
}

/* ── 지역별 지형 실루엣 ──
 * 화면 폭만 한 긴 띠를 지역마다 한 번 그려 두고 옆으로 흘려 보냅니다.
 * 정수 주기 사인만 더해 만들어서 띠의 끝과 처음이 이음매 없이 맞물립니다. */
const TW = 1600, TH = 380;
function wave(x, parts) { let h = 0; for (const [a, k, ph] of parts) h += a * Math.sin(x / TW * TAU * k + ph); return h; }
const terrainCache = new Map();
function terrainTile(zone, layer) {
  const key = zone + ':' + layer;
  if (terrainCache.has(key)) return terrainCache.get(key);
  const Z = S.ZONES[zone] || S.ZONES[0];
  const c = document.createElement('canvas'); c.width = TW; c.height = TH;
  const g = c.getContext('2d');
  const r = S.mulberry32(911 + zone * 17 + layer * 5);
  const P = (n, amp, k0) => Array.from({ length: n }, (_, i) => [amp / (i + 1) * (.6 + r() * .6), (k0 || 1) + i * 2 + Math.floor(r() * 2), r() * TAU]);
  const grad = (top, bot, y0) => { const gr = g.createLinearGradient(0, y0 || 0, 0, TH); gr.addColorStop(0, top); gr.addColorStop(1, bot); return gr; };
  // 산등성이 한 줄. style: jag(뾰족) · mesa(계단 절벽)
  const ridge = (baseY, parts, style) => {
    const pts = [];
    for (let x = 0; x <= TW; x += 4) {
      let y = baseY - wave(x, parts);
      if (style === 'jag') y -= Math.abs(wave(x, [[16, 23, 1], [9, 41, 2], [5, 67, 4]]));
      if (style === 'mesa') y = Math.round(y / 30) * 30;
      pts.push([x, y]);
    }
    return pts;
  };
  const fillRidge = (pts, style) => {
    g.fillStyle = style; g.beginPath(); g.moveTo(0, TH);
    for (const [x, y] of pts) g.lineTo(x, y);
    g.lineTo(TW, TH); g.closePath(); g.fill();
  };
  const edge = (pts, col, w) => {
    g.strokeStyle = col; g.lineWidth = w; g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
  };
  const far = layer === 0;
  switch (Z.key) {
    case 'dawn': {
      const p = ridge(far ? 200 : 290, P(4, far ? 70 : 38), far ? 'jag' : '');
      fillRidge(p, far ? grad('#9a90c0', '#5d6498', 120) : grad('#35557a', '#172640', 220));
      edge(p, far ? 'rgba(255,220,180,.35)' : 'rgba(255,200,150,.25)', 2);
      break;
    }
    case 'cloud': {   // 발아래 구름 바다
      const p = ridge(far ? 250 : 312, [[14, 9, 1], [9, 17, 2], [6, 31, 3], [4, 53, 1]]);
      fillRidge(p, far ? grad('rgba(255,255,255,.75)', 'rgba(170,205,240,.7)', 180) : grad('rgba(255,255,255,.95)', 'rgba(190,220,250,.9)', 260));
      break;
    }
    case 'sunset': {
      const p = ridge(far ? 210 : 280, P(4, far ? 60 : 50), 'mesa');
      fillRidge(p, far ? grad('#9a4f80', '#55305f', 120) : grad('#4a2044', '#1c0a20', 200));
      edge(p, 'rgba(255,170,120,.35)', 2);
      break;
    }
    case 'night': {
      if (far) {   // 불 켜진 도시
        let x = 0;
        while (x < TW - 60) {   // 띠 끝에 건물이 걸치면 이음매가 보여서 조금 남겨 둡니다
          const w = 30 + r() * 60, h = 60 + r() * 170;
          g.fillStyle = '#141d44'; g.fillRect(x, TH - h, w - 3, h);
          for (let wy = TH - h + 10; wy < TH - 8; wy += 14) for (let wx = x + 6; wx < x + w - 10; wx += 11) {
            if (r() < .34) { g.fillStyle = r() < .8 ? 'rgba(255,214,130,.8)' : 'rgba(150,200,255,.8)'; g.fillRect(wx, wy, 4, 6); }
          }
          x += w;
        }
      } else {
        const p = ridge(320, P(3, 22));
        fillRidge(p, grad('#0b1232', '#03060f', 280));
      }
      break;
    }
    case 'aurora': {
      const p = ridge(far ? 190 : 290, P(4, far ? 70 : 34), 'jag');
      fillRidge(p, far ? grad('#2f6f82', '#0f3448', 120) : grad('#0b2f3a', '#031219', 240));
      if (far) { edge(p, 'rgba(230,255,250,.22)', 7); edge(p, 'rgba(240,255,252,.45)', 2.5); }   // 눈 덮인 능선
      break;
    }
    case 'desert': {
      const p = ridge(far ? 230 : 305, far ? P(3, 50) : P(3, 26), far ? 'mesa' : '');
      fillRidge(p, far ? grad('#b98556', '#8a5a33', 150) : grad('#e2ae68', '#9a6630', 260));
      edge(p, far ? 'rgba(255,220,170,.3)' : 'rgba(255,240,200,.55)', 3);
      break;
    }
    case 'volcano': {
      const p = ridge(far ? 200 : 300, P(4, far ? 64 : 34), 'jag');
      fillRidge(p, far ? grad('#2e110d', '#140504', 120) : grad('#120404', '#030000', 240));
      edge(p, far ? 'rgba(255,90,30,.35)' : 'rgba(255,110,40,.6)', far ? 2 : 3);
      if (far) {   // 불 뿜는 화산 두 개
        for (const vx of [380, 1180]) {
          const top = 120;
          g.fillStyle = grad('#3a1510', '#140504', top);
          g.beginPath(); g.moveTo(vx - 230, TH); g.lineTo(vx - 34, top); g.lineTo(vx + 34, top); g.lineTo(vx + 230, TH); g.closePath(); g.fill();
          const lg = g.createRadialGradient(vx, top, 4, vx, top, 90);
          lg.addColorStop(0, 'rgba(255,200,90,.95)'); lg.addColorStop(.3, 'rgba(255,90,30,.5)'); lg.addColorStop(1, 'rgba(255,60,20,0)');
          g.fillStyle = lg; g.beginPath(); g.arc(vx, top, 90, 0, TAU); g.fill();
          g.strokeStyle = 'rgba(255,120,40,.7)'; g.lineWidth = 3;
          g.beginPath(); g.moveTo(vx - 8, top + 4); g.quadraticCurveTo(vx - 30, top + 110, vx - 70, TH); g.stroke();
        }
      }
      break;
    }
    case 'glacier': {
      const p = ridge(far ? 200 : 300, P(4, far ? 64 : 30), 'jag');
      fillRidge(p, far ? grad('#f2faff', '#9cc6de', 120) : grad('#ffffff', '#86bcd8', 240));
      edge(p, far ? 'rgba(120,170,210,.5)' : 'rgba(90,150,200,.55)', 2);
      if (!far) { g.fillStyle = grad('rgba(40,110,160,.0)', 'rgba(30,90,140,.55)', 330); g.fillRect(0, 330, TW, 50); }
      break;
    }
    case 'strato': {   // 둥근 지구
      if (!far) { terrainCache.set(key, null); return null; }
      const R = 2600, cx = TW / 2, cy = TH + R - 150;
      const eg = g.createLinearGradient(0, TH - 150, 0, TH);
      eg.addColorStop(0, '#3a86d8'); eg.addColorStop(.35, '#1b4f8a'); eg.addColorStop(1, '#0a1f3c');
      g.fillStyle = eg; g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.fill();
      for (let i = 0; i < 26; i++) {   // 구름 띠
        g.fillStyle = 'rgba(255,255,255,' + (.08 + r() * .18) + ')';
        g.beginPath(); g.ellipse(r() * TW, TH - 120 + r() * 110, 60 + r() * 140, 6 + r() * 10, 0, 0, TAU); g.fill();
      }
      for (let k = 0; k < 3; k++) {   // 대기층 빛
        g.strokeStyle = ['rgba(140,210,255,.55)', 'rgba(110,170,255,.25)', 'rgba(90,140,255,.12)'][k];
        g.lineWidth = [4, 12, 26][k];
        g.beginPath(); g.arc(cx, cy, R + k * 6, Math.PI * 1.25, Math.PI * 1.75); g.stroke();
      }
      break;
    }
    default: { terrainCache.set(key, null); return null; }
  }
  terrainCache.set(key, c);
  return c;
}

/* 하늘에 떠 있는 것(해·달·행성) — 지역마다 한 번 그려 둡니다 */
function skyBody(zone) {
  const Z = S.ZONES[zone] || S.ZONES[0];
  const k = Z.key;
  if (k === 'dawn' || k === 'sunset' || k === 'desert') {
    return sprite('sun' + k, 360, 360, (g) => {
      const warm = k === 'sunset' ? ['255,200,140', '255,120,90'] : k === 'desert' ? ['255,250,220', '255,210,120'] : ['255,245,210', '255,190,120'];
      const rg = g.createRadialGradient(0, 0, 20, 0, 0, 180);
      rg.addColorStop(0, 'rgba(' + warm[0] + ',.95)'); rg.addColorStop(.18, 'rgba(' + warm[1] + ',.5)'); rg.addColorStop(1, 'rgba(' + warm[1] + ',0)');
      g.fillStyle = rg; g.fillRect(-180, -180, 360, 360);
      g.fillStyle = 'rgba(' + warm[0] + ',1)'; g.beginPath(); g.arc(0, 0, 38, 0, TAU); g.fill();
    });
  }
  if (k === 'night' || k === 'aurora' || k === 'glacier') {
    return sprite('moon' + k, 240, 240, (g) => {
      const rg = g.createRadialGradient(0, 0, 10, 0, 0, 120);
      rg.addColorStop(0, 'rgba(220,235,255,.35)'); rg.addColorStop(1, 'rgba(180,210,255,0)');
      g.fillStyle = rg; g.fillRect(-120, -120, 240, 240);
      const mg = g.createRadialGradient(-10, -10, 4, 0, 0, 34);
      mg.addColorStop(0, '#ffffff'); mg.addColorStop(1, '#c8d6f0');
      g.fillStyle = mg; g.beginPath(); g.arc(0, 0, 34, 0, TAU); g.fill();
      g.fillStyle = 'rgba(140,160,200,.35)';
      for (const [x, y, rr] of [[-10, -6, 7], [9, 8, 5], [6, -14, 4], [-6, 14, 3]]) { g.beginPath(); g.arc(x, y, rr, 0, TAU); g.fill(); }
    });
  }
  if (k === 'space') {
    return sprite('planet', 420, 300, (g) => {
      const pg = g.createRadialGradient(-40, -40, 10, 0, 0, 110);
      pg.addColorStop(0, '#f0d0ff'); pg.addColorStop(.45, '#9a5ad8'); pg.addColorStop(1, '#2a0f4a');
      g.save(); g.rotate(-.35);
      g.strokeStyle = 'rgba(220,180,255,.35)'; g.lineWidth = 10;
      g.beginPath(); g.ellipse(0, 0, 190, 42, 0, Math.PI, TAU); g.stroke();
      g.fillStyle = pg; g.beginPath(); g.arc(0, 0, 105, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(230,200,255,.55)'; g.lineWidth = 10;
      g.beginPath(); g.ellipse(0, 0, 190, 42, 0, 0, Math.PI); g.stroke();
      g.restore();
    });
  }
  if (k === 'volcano') {
    return sprite('redsun', 300, 300, (g) => {
      const rg = g.createRadialGradient(0, 0, 10, 0, 0, 150);
      rg.addColorStop(0, 'rgba(255,120,60,.7)'); rg.addColorStop(.25, 'rgba(200,50,20,.35)'); rg.addColorStop(1, 'rgba(120,20,10,0)');
      g.fillStyle = rg; g.fillRect(-150, -150, 300, 300);
      g.fillStyle = 'rgba(255,150,90,.85)'; g.beginPath(); g.arc(0, 0, 30, 0, TAU); g.fill();
    });
  }
  return null;
}
// 해·달·행성 자리. 적이 몰려오는 오른쪽 가운데는 피해서 둡니다.
const BODY_POS = { dawn: [.2, .24], sunset: [.56, .74], desert: [.8, .15], night: [.78, .16], aurora: [.25, .18], glacier: [.84, .14], space: [.42, .84], volcano: [.3, .3] };

/* 지역 날씨 — 속도선·모래바람·불씨·눈송이·별 흐름 */
const amb = [];
(function seedAmb() {
  const r = S.mulberry32(4242);
  for (let i = 0; i < 70; i++) amb.push({ x: r() * F.w, y: r() * F.h, s: r(), ph: r() * TAU });
})();
function drawWeather(g, zone, T, dt) {
  const k = (S.ZONES[zone] || S.ZONES[0]).key;
  const k2 = k === 'volcano' || k === 'glacier' || k === 'desert' ? 1 : .55;   // 속도선만 있는 곳은 줄여서 눈이 덜 피곤하게
  const n = Math.round((GFX.hi ? amb.length : 24) * k2);
  g.save();
  for (let i = 0; i < n; i++) {
    const a = amb[i];
    if (k === 'volcano') {           // 떠오르는 불씨
      a.x -= (60 + a.s * 80) * dt; a.y -= (30 + a.s * 50) * dt;
      if (a.y < -10) { a.y = F.h + 10; } if (a.x < -10) a.x += F.w + 20;
      g.globalCompositeOperation = 'lighter';
      glowAt(g, '#ff7a30', a.x + Math.sin(T * 2 + a.ph) * 8, a.y, 5 + a.s * 7, .5 + Math.sin(T * 5 + a.ph) * .3);
    } else if (k === 'glacier' || (k === 'aurora' && i % 2)) {   // 눈송이
      a.x -= (120 + a.s * 160) * dt; a.y += (26 + a.s * 30) * dt;
      if (a.y > F.h + 6) a.y = -6; if (a.x < -10) a.x += F.w + 20;
      g.globalAlpha = .45 + a.s * .45; g.fillStyle = '#fff';
      g.beginPath(); g.arc(a.x + Math.sin(T + a.ph) * 6, a.y, 1.4 + a.s * 2.2, 0, TAU); g.fill();
    } else {                         // 속도선 (모래·별도 같은 방식, 색과 빠르기만 다름)
      const sand = k === 'desert', starry = k === 'space' || k === 'strato';
      const sp = sand ? 900 + a.s * 700 : starry ? 500 + a.s * 900 : 700 + a.s * 900;
      a.x -= sp * dt;
      if (a.x < -120) { a.x = F.w + Math.random() * 200; a.y = Math.random() * F.h; }
      const len = sand ? 30 + a.s * 50 : 40 + a.s * 90;
      g.globalAlpha = sand ? .22 + a.s * .25 : starry ? .08 + a.s * .2 : .05 + a.s * .09;
      g.strokeStyle = sand ? '#ffe3b0' : starry ? '#dfe8ff' : '#ffffff';
      g.lineWidth = sand ? 1.4 : 1 + a.s * 1.4;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(a.x + len, a.y); g.stroke();
    }
  }
  g.restore();
}

let bgScroll = 0, bgZone = -1, zoneFade = 0;
function drawBackground(g, zone, T, dt) {
  if (zone !== bgZone) {
    if (bgZone >= 0 && G.mode !== 'menu') { zoneFade = 1.3; SFX.zone(); }
    bgZone = zone;
  }
  const Z = S.ZONES[zone] || S.ZONES[0];
  const sky = g.createLinearGradient(0, 0, 0, F.h);
  sky.addColorStop(0, Z.sky[0]); sky.addColorStop(.55, Z.sky[1]); sky.addColorStop(1, Z.sky[2]);
  g.fillStyle = sky; g.fillRect(0, 0, F.w, F.h);

  const night = zone === 3 || zone === 4 || zone === 8 || zone === 9;
  if (night) {
    for (const s of bgLayers.stars) {
      const x = ((s.x - bgScroll * .12) % (F.w * 1.4) + F.w * 1.4) % (F.w * 1.4) - F.w * .2;
      const tw = .55 + Math.sin(T * 2 + s.tw) * .45;
      g.globalAlpha = s.o * tw; g.fillStyle = Z.dust;
      g.beginPath(); g.arc(x, s.y, s.s, 0, TAU); g.fill();
    }
    g.globalAlpha = 1;
  }
  if (zone === 9 && GFX.hi) {   // 우주 성운
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 4; i++) {
      const x = ((i * 520 - bgScroll * .05) % (F.w + 700) + F.w + 700) % (F.w + 700) - 350;
      glowAt(g, i % 2 ? '#7a3fd0' : '#3f6fd0', x, 260 + i * 130, 330, .22);
    }
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
  }
  const body = skyBody(zone), bp = BODY_POS[Z.key];
  if (body && bp) blit(g, body, F.w * bp[0] - (bgScroll * .02) % 60, F.h * bp[1], 0, 1, zone === 9 ? .75 : 1);
  if (zone === 4) {  // 오로라 커튼
    for (let i = 0; i < 4; i++) {
      const ph = T * .35 + i * 1.5;
      const grd = g.createLinearGradient(0, 0, 0, F.h);
      grd.addColorStop(0, 'rgba(107,255,208,0)');
      grd.addColorStop(.4, 'rgba(107,255,208,' + (.12 + Math.sin(ph) * .06) + ')');
      grd.addColorStop(.75, 'rgba(120,160,255,.07)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.save(); g.translate(((i * 420 - bgScroll * .18) % (F.w + 500) + F.w + 500) % (F.w + 500) - 250, 0);
      g.beginPath(); g.moveTo(-90, 0);
      g.quadraticCurveTo(Math.sin(ph) * 120, F.h * .5, -40, F.h);
      g.lineTo(120, F.h); g.quadraticCurveTo(Math.sin(ph + .8) * 120 + 150, F.h * .5, 90, 0);
      g.closePath(); g.fill(); g.restore();
    }
  }
  if (zone === 0 || zone === 2) {   // 햇살 기둥
    if (GFX.hi) {
      const [sx, sy] = zone === 0 ? [F.w * .2, F.h * .24] : [F.w * .72, F.h * .5];
      g.save(); g.translate(sx, sy); g.rotate(Math.sin(T * .1) * .05);
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 7; i++) {
        const a = i / 7 * TAU + T * .02;
        g.globalAlpha = .03 + Math.sin(T * .7 + i) * .015;
        g.fillStyle = zone === 0 ? '#ffe6b0' : '#ffb08a';
        g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, 900, a, a + .12); g.closePath(); g.fill();
      }
      g.restore();
    }
  }

  // 먼 지형 → 구름 → 가까운 지형 순서로 겹쳐 깊이를 냅니다
  const tileLayer = (layer, spd, alpha) => {
    const t = terrainTile(zone, layer);
    if (!t) return;
    const off = zone === 8 ? 0 : ((bgScroll * spd) % TW + TW) % TW;   // 지구는 둥글어서 흘리지 않습니다
    g.globalAlpha = alpha;
    g.drawImage(t, -off, F.h - TH);
    g.drawImage(t, TW - off, F.h - TH);
    g.globalAlpha = 1;
  };
  tileLayer(0, .07, zone === 8 ? 1 : .9);

  const spr = bgPuff(zone);
  const drawLayer = (arr, spd) => {
    for (const c of arr) {
      const x = ((c.x - bgScroll * spd) % (F.w * 1.4) + F.w * 1.4) % (F.w * 1.4) - F.w * .2;
      blit(g, spr, x, c.y, 0, c.s / 100, c.o);
    }
  };
  drawLayer(bgLayers.far, .10);
  drawLayer(bgLayers.mid, .28);
  if (GFX.hi) tileLayer(1, .24, .95);
  drawLayer(bgLayers.near, .55);

  // 배경을 살짝 눌러 둡니다. 이걸 안 하면 밝은 지역(노을·빙하)에서 배경과 적이
  // 비슷한 밝기가 되어 적이 눈에 안 들어옵니다.
  g.fillStyle = 'rgba(8,12,28,.20)';
  g.fillRect(0, 0, F.w, F.h);

  drawWeather(g, zone, T, dt || 0);

  // 화면 가장자리 어둡게 (집중)
  const vg = g.createRadialGradient(F.w / 2, F.h / 2, F.h * .32, F.w / 2, F.h / 2, F.h * .95);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.5)');
  g.fillStyle = vg; g.fillRect(0, 0, F.w, F.h);

  // 새 지역에 들어설 때: 구름을 뚫고 나오듯 하얗게 걷히는 연출
  if (zoneFade > 0) {
    zoneFade -= dt || 0;
    const a = clamp(zoneFade / 1.3, 0, 1);
    g.fillStyle = 'rgba(235,245,255,' + (a * a * .85) + ')'; g.fillRect(0, 0, F.w, F.h);
  }
}

/* ═══════════════════ 파티클 ═══════════════════ */
const parts = [];
function addPart(o) { if (parts.length < (GFX.hi ? 640 : 260)) parts.push(o); }
// 폭발: 번쩍임 → 불덩이 → 불꽃 줄기 → 파편 → 연기 → 충격파
function boom(x, y, size, hue) {
  const hi = GFX.hi, c = hue || '#ffd166';
  addPart({ k: 'flash', x, y, r: size * 2.4 + 20, life: .14, t: 0, c: '#fff4d0' });
  const nf = hi ? Math.min(7, 2 + Math.round(size / 10)) : 2;
  for (let i = 0; i < nf; i++) {
    const a = Math.random() * TAU, d = Math.random() * size * .45;
    addPart({ k: 'fire', x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, vx: Math.cos(a) * 40 - 30, vy: Math.sin(a) * 40,
      r: size * (.45 + Math.random() * .35) + 8, life: .35 + Math.random() * .3, t: 0, c: hue && hue !== '#ffd166' ? hue : '#ff9a3c' });
  }
  const n = Math.min(hi ? 30 : 12, 8 + Math.round(size * .55));
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, sp = 90 + Math.random() * (140 + size * 5);
    addPart({ k: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: 1.6 + Math.random() * 2.4, life: .3 + Math.random() * .5, t: 0, c });
  }
  if (size >= 18 && hi) {
    for (let i = 0; i < Math.min(8, size / 6); i++) {
      const a = Math.random() * TAU, sp = 80 + Math.random() * 200;
      addPart({ k: 'debris', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, rot: Math.random() * TAU, vr: (Math.random() - .5) * 18,
        r: 2.5 + Math.random() * 4, life: .7 + Math.random() * .6, t: 0 });
    }
  }
  for (let i = 0; i < (hi ? 5 : 2); i++) addPart({ k: 'smoke', x: x + (Math.random() - .5) * size, y: y + (Math.random() - .5) * size, vx: -50 - Math.random() * 50, vy: (Math.random() - .5) * 40 - 12, r: size * .5 + 8, life: .8 + Math.random() * .6, t: 0 });
  addPart({ k: 'ring', x, y, r: size * .5, life: .38, t: 0, c: hue || '#ffe9a8' });
}
// 머리 위로 떠오르는 글자 (아이템 이름 등)
function floatText(x, y, text, c) { addPart({ k: 'text', x, y, vx: 0, vy: -46, life: 1.1, t: 0, text, c }); }
function stepParts(dt) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.t += dt;
    if (p.t >= p.life) { parts[i] = parts[parts.length - 1]; parts.pop(); continue; }
    if (p.vx !== undefined) { p.x += p.vx * dt; p.y += p.vy * dt; }
    if (p.k === 'spark') { p.vx *= .95; p.vy *= .95; }
    else if (p.k === 'smoke') { p.r += 46 * dt; }
    else if (p.k === 'fire') { p.vx *= .92; p.vy *= .92; }
    else if (p.k === 'debris') { p.vx -= 90 * dt; p.vy += 260 * dt; p.rot += p.vr * dt; }
    else if (p.k === 'text') { p.vy *= .94; }
  }
}
function drawParts(g) {
  // 연기는 먼저(아래에) 보통으로, 빛나는 것은 위에 더하기로 그립니다
  const sm = smokeSpr();
  for (const p of parts) {
    if (p.k === 'smoke') {
      const k = 1 - p.t / p.life;
      g.globalAlpha = k * .55;
      g.drawImage(sm, p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
    } else if (p.k === 'debris') {
      const k = 1 - p.t / p.life;
      g.save(); g.translate(p.x, p.y); g.rotate(p.rot); g.globalAlpha = Math.min(1, k * 1.6);
      g.fillStyle = '#2c3346'; g.fillRect(-p.r, -p.r * .6, p.r * 2, p.r * 1.2);
      g.fillStyle = '#ff9a3c'; g.fillRect(-p.r, -p.r * .6, p.r * .7, p.r * 1.2);
      g.restore();
    }
  }
  g.globalCompositeOperation = 'lighter';
  for (const p of parts) {
    const k = 1 - p.t / p.life;
    if (p.k === 'spark') {
      g.globalAlpha = k; g.strokeStyle = p.c; g.lineWidth = p.r * (0.5 + k);
      g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x - p.vx * .035, p.y - p.vy * .035); g.stroke();
    } else if (p.k === 'ring') {
      g.globalAlpha = k * .8; g.strokeStyle = p.c; g.lineWidth = 5 * k + 1;
      g.beginPath(); g.arc(p.x, p.y, p.r * (1 + (1 - k) * 2.6), 0, TAU); g.stroke();
    } else if (p.k === 'trail') {
      glowAt(g, p.c, p.x, p.y, p.r * 2.2 * k + 1, k * .5);
    } else if (p.k === 'flash') {
      glowAt(g, p.c, p.x, p.y, p.r * (1.2 - k * .4), k);
    } else if (p.k === 'fire') {
      const grow = p.t < .08 ? p.t / .08 : 1;
      glowAt(g, k > .5 ? '#ffd27a' : p.c, p.x, p.y, p.r * (.5 + grow * .7) * (0.6 + k * .5), k * .9);
    } else if (p.k === 'ember') {
      glowAt(g, p.c, p.x, p.y, p.r, k);
    }
  }
  g.globalCompositeOperation = 'source-over';
  for (const p of parts) {
    if (p.k !== 'text') continue;
    const k = 1 - p.t / p.life;
    g.globalAlpha = Math.min(1, k * 2.5);
    g.font = '800 18px system-ui'; g.textAlign = 'center';
    g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,.65)'; g.strokeText(p.text, p.x, p.y);
    g.fillStyle = p.c; g.fillText(p.text, p.x, p.y);
  }
  g.globalAlpha = 1;
}

/* ═══════════════════ 소리 (합성음, 파일 없음) ═══════════════════ */
let AC = null, muted = false, lastShot = 0;
function ac() { if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { } } return AC; }
function beep(type, f0, f1, dur, vol) {
  if (muted) return; const a = ac(); if (!a) return;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, a.currentTime);
  if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), a.currentTime + dur);
  g.gain.setValueAtTime(vol, a.currentTime);
  g.gain.exponentialRampToValueAtTime(.0001, a.currentTime + dur);
  o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + dur + .02);
}
function noise(dur, vol, f) {
  if (muted) return; const a = ac(); if (!a) return;
  const n = a.sampleRate * dur, buf = a.createBuffer(1, n, a.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = a.createBufferSource(); src.buffer = buf;
  const bp = a.createBiquadFilter(); bp.type = 'lowpass'; bp.frequency.value = f || 900;
  const g = a.createGain(); g.gain.value = vol;
  src.connect(bp); bp.connect(g); g.connect(a.destination); src.start();
}
const SFX = {
  shot() { const n = performance.now(); if (n - lastShot < 90) return; lastShot = n; beep('square', 900, 500, .05, .022); },
  hit() { beep('square', 320, 180, .05, .03); },
  boom() { noise(.32, .16, 700); },
  bigboom() { noise(.75, .3, 420); beep('sine', 160, 40, .6, .16); },
  pick() { beep('sine', 620, 1180, .14, .09); },
  lvup() { beep('sine', 520, 1040, .1, .09); setTimeout(() => beep('sine', 780, 1560, .12, .08), 90); },
  down() { beep('sawtooth', 420, 70, .6, .12); },
  revive() { beep('sine', 400, 900, .18, .1); setTimeout(() => beep('sine', 700, 1300, .2, .09), 130); },
  bomb() { noise(.6, .28, 300); beep('sine', 200, 50, .5, .14); },
  warn() { beep('square', 220, 220, .18, .08); setTimeout(() => beep('square', 300, 300, .22, .08), 220); },
  clear() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => beep('sine', f, f, .2, .1), i * 110)); },
  zone() { noise(1.1, .12, 1600); beep('sine', 300, 900, .9, .06); },
  shield() { beep('triangle', 500, 1400, .25, .08); },
};

/* ═══════════════════ 배경음악 (합성, 파일 없음) ═══════════════════
 *  지역마다 조(키)와 분위기(밝음/어두움)가 바뀌고, 보스전에는 빨라집니다.
 *  🎵 버튼으로 끄고 켜며, 효과음(🔊)과 따로 움직입니다. */
const MUSIC = { on: localStorage.getItem('sky.music') !== 'off', out: null, next: 0, step: 0, nbuf: null };
const PROG_MAJ = [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]];   // I  V  vi IV
const PROG_MIN = [[0, 3, 7], [8, 12, 15], [3, 7, 10], [10, 14, 17]];  // i  VI III VII
const PROG_BOSS = [[0, 3, 7], [0, 3, 8], [-2, 2, 5], [-1, 2, 7]];
const ZONE_TONE = [
  { r: 62, min: 0 }, { r: 64, min: 0 }, { r: 57, min: 1 }, { r: 55, min: 1 }, { r: 59, min: 1 },
  { r: 62, min: 1 }, { r: 52, min: 1 }, { r: 64, min: 0 }, { r: 60, min: 0 }, { r: 57, min: 1 },
];
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
function mTone(type, f, t, dur, vol, f1) {
  const a = AC, o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + .012);
  g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  o.connect(g); g.connect(MUSIC.out); o.start(t); o.stop(t + dur + .02);
}
function mHat(t, vol) {
  const a = AC;
  if (!MUSIC.nbuf) {
    const n = a.sampleRate * .05; MUSIC.nbuf = a.createBuffer(1, n, a.sampleRate);
    const d = MUSIC.nbuf.getChannelData(0); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  }
  const src = a.createBufferSource(); src.buffer = MUSIC.nbuf;
  const hp = a.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6000;
  const g = a.createGain(); g.gain.value = vol;
  src.connect(hp); hp.connect(g); g.connect(MUSIC.out); src.start(t);
}
function mStep(step, t, s16) {
  const boss = G.phase === 'boss';
  const Zt = ZONE_TONE[G.zone] || ZONE_TONE[0];
  const prog = boss ? PROG_BOSS : Zt.min ? PROG_MIN : PROG_MAJ;
  const bar = Math.floor(step / 16) % 4, i = step % 16, ch = prog[bar], root = Zt.r;
  if (i % 2 === 0) mTone('triangle', midi(root - 24 + ch[0] + (i % 8 === 6 ? 12 : 0)), t, s16 * 1.7, .12);
  const up = [0, 1, 2, 1, 0, 1, 2, 3][i % 8];
  const note = up === 3 ? ch[0] + 12 : ch[up];
  mTone(boss ? 'sawtooth' : 'triangle', midi(root + note + (i >= 8 && !boss ? 12 : 0)), t, s16 * .9, boss ? .018 : .04);
  if (i % 4 === 2) mHat(t, boss ? .05 : .03);
  if (i % (boss ? 4 : 8) === 0) mTone('sine', 150, t, .22, boss ? .2 : .13, 42);
  // 두 마디마다 긴 멜로디 한 음
  if (i === 0 && bar % 2 === 0) mTone('sine', midi(root + 12 + ch[2]), t, s16 * 14, .035);
}
setInterval(() => {
  if (!MUSIC.on || !AC || AC.state !== 'running' || G.mode === 'menu' || G.paused) return;
  if (!MUSIC.out) { MUSIC.out = AC.createGain(); MUSIC.out.gain.value = .55; MUSIC.out.connect(AC.destination); }
  const s16 = 60 / (G.phase === 'boss' ? 144 : 112) / 4;
  const now = AC.currentTime;
  if (MUSIC.next < now) MUSIC.next = now + .05;
  while (MUSIC.next < now + .3) { mStep(MUSIC.step, MUSIC.next, s16); MUSIC.next += s16; MUSIC.step++; }
}, 60);

/* ═══════════════════ 게임 상태(그리기용) ═══════════════════ */
const G = {
  mode: 'menu',        // menu | online | solo
  myId: 0, room: '', roster: new Map(),
  snaps: [],           // 최근 스냅샷 (보간용)
  bullets: new Map(),  // 클라이언트가 직접 굴리는 총알
  ents: new Map(),     // 보간용 이전 위치
  shake: 0, flashT: 0, flashC: '#fff',
  banner: null, bannerT: 0,
  bossName: '', hitVig: 0,
  input: { tx: F.w * .18, ty: F.h / 2, bomb: false },
  keys: {},
  local: null, localTimer: 0,
  ws: null, ping: 0, lastRecv: 0,
  score: 0, stage: 1, zone: 0, phase: 'idle',
  paused: false, scoreShown: 0, bossLag: 1, box: 0,
  vy: new Map(),       // 비행기별 위아래 속도(기울기 연출용)
};

/* 스냅샷 받기 — 온라인·혼자 연습 공통 입구 */
function pushSnap(s) {
  G.snaps.push(s);
  if (G.snaps.length > 4) G.snaps.shift();
  G.stage = s.st; G.zone = s.zone; G.score = s.sc; G.phase = s.ph;
  // 총알: 새로 생긴 것 / 사라진 것
  const flashed = new Set();
  for (const b of s.Bn) {
    G.bullets.set(b[0], { id: b[0], x: b[1], y: b[2], vx: b[3], vy: b[4], kind: b[5], born: b[6], col: b[7] });
    if (GFX.hi && b[5][0] === 'p' && !flashed.has(b[7])) {
      flashed.add(b[7]);
      addPart({ k: 'flash', x: b[1] + 4, y: b[2], r: 16, life: .07, t: 0, c: SHIP_COLORS[(b[7] || 0) % 6].glow });
    }
  }
  for (const id of s.Bd) G.bullets.delete(id);
  // 이펙트
  for (const f of s.X) onFx(f);
}
function onFx(f) {
  switch (f.t) {
    case 'boom': boom(f.x, f.y, f.s, '#ffd166'); SFX.boom(); G.shake = Math.max(G.shake, Math.min(9, f.s * .2)); break;
    case 'hit': for (let i = 0; i < 3; i++) addPart({ k: 'spark', x: f.x, y: f.y, vx: (Math.random() - .3) * 120, vy: (Math.random() - .5) * 120, r: 2.2, life: .18, t: 0, c: '#fff2a8' }); break;
    case 'guard': for (let i = 0; i < 5; i++) addPart({ k: 'spark', x: f.x, y: f.y, vx: 60 + Math.random() * 120, vy: (Math.random() - .5) * 160, r: 2.6, life: .25, t: 0, c: '#ffd166' }); break;
    case 'phit':
      if (f.id === G.myId) { G.hitVig = 1; G.shake = Math.max(G.shake, 8); SFX.hit(); }
      boom(f.x, f.y, 14, '#ff8a8a'); break;
    case 'down':
      boom(f.x, f.y, 42, '#ff6b6b'); G.shake = Math.max(G.shake, 12); SFX.down();
      toast((nameOf(f.id) || '동료') + ' 격추! 가까이 가서 살려 주세요', '#ffb4c0'); break;
    case 'revive': boom(f.x, f.y, 26, '#8ef0b6'); SFX.revive(); toast((nameOf(f.id) || '동료') + ' 복귀!', '#8ef0b6'); break;
    case 'lvup': SFX.lvup(); if (f.id === G.myId) toast('무기 Lv.' + f.lv + ' !', '#ffd166'); boom(f.x, f.y, 18, '#ffd166'); floatText(f.x, f.y - 44, 'POWER UP', '#ffd166'); break;
    case 'grab': {
      const I = PICK_INFO[f.k] || PICK_INFO.star;
      if (f.k === 'shield') SFX.shield(); else SFX.pick();
      addPart({ k: 'ring', x: f.x, y: f.y, r: 16, life: .35, t: 0, c: I.c });
      addPart({ k: 'flash', x: f.x, y: f.y, r: 40, life: .2, t: 0, c: I.c });
      if (f.k !== 'star' || f.id === G.myId) floatText(f.x, f.y - 30, I.n, I.c);
      break;
    }
    case 'heal': addPart({ k: 'spark', x: f.x, y: f.y, vx: 0, vy: -60, r: 3, life: .5, t: 0, c: '#8ef0b6' }); break;
    case 'shatter': boom(f.x, f.y, 24, '#7fe0ff'); break;
    case 'bomb':
      G.flashT = .35; G.flashC = '#ffe9a8'; G.shake = 16; SFX.bomb();
      for (let i = 0; i < 3; i++) addPart({ k: 'ring', x: f.x, y: f.y, r: 40 + i * 30, life: .55 + i * .15, t: 0, c: i ? '#ff9a3c' : '#ffe9a8' });
      addPart({ k: 'flash', x: f.x, y: f.y, r: 260, life: .4, t: 0, c: '#ffe9a8' });
      break;
    case 'stage': G.banner = { big: f.n + ' 단계', sub: (S.ZONES[Math.floor((f.n - 1) / 10)] || {}).name || '', kind: 'stage' }; G.bannerT = 2.6; break;
    case 'clear': G.banner = { big: '단계 클리어!', sub: '보너스 +' + f.bonus, kind: 'clear' }; G.bannerT = 3.4; SFX.clear(); break;
    case 'wipe': G.banner = { big: '편대 전멸…', sub: '이 단계를 다시 도전합니다', kind: 'wipe' }; G.bannerT = 3; break;
    case 'bosswarn': G.banner = { big: '⚠ 보스 출현', sub: f.name, kind: 'boss' }; G.bannerT = 3; G.bossName = f.name; G.bossLag = 1; G.box = 1; SFX.warn(); break;
    case 'bossphase': G.shake = 14; G.flashT = .2; G.flashC = '#fff'; boom(f.x, f.y, 60, '#fff'); break;
    case 'bossdown':
      G.shake = 26; G.flashT = .6; G.flashC = '#fff'; SFX.bigboom();
      for (let i = 0; i < 16; i++) setTimeout(() => boom(f.x + (Math.random() - .5) * f.r * 2, f.y + (Math.random() - .5) * f.r * 2, 40, '#ffd166'), i * 70);
      setTimeout(() => { boom(f.x, f.y, 120, '#fff2a8'); G.flashT = .5; G.shake = 30; addPart({ k: 'ring', x: f.x, y: f.y, r: 120, life: .8, t: 0, c: '#fff' }); }, 1150);
      break;
    case 'clone': addPart({ k: 'ring', x: f.x, y: f.y, r: 60, life: .5, t: 0, c: '#7fa8ff' }); break;
  }
}
function nameOf(id) { const r = G.roster.get(id); return r ? r.name : null; }
function colorOf(id) { const r = G.roster.get(id); return r ? r.color : 0; }

/* ═══════════════════ 보간 ═══════════════════ */
function interp() {
  const n = G.snaps.length;
  if (!n) return null;
  const last = G.snaps[n - 1];
  if (n === 1) return { a: last, b: last, k: 1, t: last.t };
  const prev = G.snaps[n - 2];
  // 마지막 스냅샷보다 조금(0.9틱) 뒤를 그립니다 — 끊김 방지
  const now = performance.now();
  if (!G.snapAt) G.snapAt = now;
  const age = (now - G.snapAt) / 1000;
  const k = clamp(age / S.DT, 0, 1.6);
  return { a: prev, b: last, k: Math.min(1, k), t: prev.t + k };
}
function lerpRow(A, B, k, i) { return A === undefined ? B : A + (B - A) * k; }
function byId(rows) { const m = new Map(); for (const r of rows) m.set(r[0], r); return m; }

/* ═══════════════════ 그리기 ═══════════════════ */
let lastT = performance.now(), gameT = 0;
function frame() {
  const now = performance.now();
  let dt = (now - lastT) / 1000; lastT = now;
  dt = Math.min(.05, dt);
  gameT += dt;
  // 초당 프레임을 재서 오래 버벅이면 그래픽을 한 번 가볍게 바꿉니다
  GFX.fps = GFX.fps * .95 + (1 / Math.max(dt, .001)) * .05;
  if (G.mode !== 'menu' && GFX.hi && !GFX.autoDone && !document.hidden) {
    GFX.slowT = GFX.fps < 38 ? GFX.slowT + dt : Math.max(0, GFX.slowT - dt);
    if (GFX.slowT > 4) { GFX.autoDone = true; setGfx(false); toast('화면이 버벅여서 그래픽을 가볍게 바꿨어요 (✨ 로 되돌리기)', '#ffd166'); }
  }
  G.scoreShown += (G.score - G.scoreShown) * Math.min(1, dt * 8);
  if (Math.abs(G.score - G.scoreShown) < 1) G.scoreShown = G.score;
  if (G.box > 0 && G.phase !== 'boss' && G.bannerT <= 0) G.box = Math.max(0, G.box - dt * 2);
  if (G.mode === 'solo' && G.local && !G.paused) {
    G.localTimer += dt;
    while (G.localTimer >= S.DT) {
      G.localTimer -= S.DT;
      G.local.setInput(G.myId, { tx: G.input.tx, ty: G.input.ty, bomb: G.input.bomb });
      G.input.bomb = false;
      G.local.step();
      G.snapAt = performance.now();
      pushSnap(G.local.snapshot());
    }
  }
  if (!G.paused) stepParts(dt);
  if (G.shake > 0) G.shake = Math.max(0, G.shake - dt * 34);
  if (G.flashT > 0) G.flashT -= dt;
  if (G.bannerT > 0) G.bannerT -= dt;
  if (G.hitVig > 0) G.hitVig = Math.max(0, G.hitVig - dt * 2);
  if (!G.paused) bgScroll += dt * 130;

  render(G.paused ? 0 : dt);
  requestAnimationFrame(frame);
}

function render(dt) {
  const g = ctx;
  g.setTransform(VIEW.dpr, 0, 0, VIEW.dpr, 0, 0);
  g.fillStyle = '#05070f'; g.fillRect(0, 0, VIEW.w, VIEW.h);
  g.save();
  const sh = G.shake;
  g.translate(VIEW.ox + (sh ? (Math.random() - .5) * sh : 0), VIEW.oy + (sh ? (Math.random() - .5) * sh : 0));
  g.scale(VIEW.s, VIEW.s);
  g.beginPath(); g.rect(0, 0, F.w, F.h); g.clip();

  drawBackground(g, G.mode === 'menu' ? menuZone() : G.zone, gameT, dt);

  const it = G.mode === 'menu' ? null : interp();
  if (it) drawWorld(g, it, dt);
  if (G.mode === 'menu') drawMenuScene(g, dt);
  drawParts(g);

  // 보스 등장 때 위아래 검은 띠(영화처럼)
  if (G.box > 0) {
    const hh = 56 * Math.sin(Math.min(1, G.box) * Math.PI / 2);
    g.fillStyle = 'rgba(0,0,0,.85)';
    g.fillRect(0, 0, F.w, hh); g.fillRect(0, F.h - hh, F.w, hh);
  }

  // 피격 붉은 테두리
  if (G.hitVig > 0) {
    const vg = g.createRadialGradient(F.w / 2, F.h / 2, F.h * .3, F.w / 2, F.h / 2, F.h * .8);
    vg.addColorStop(0, 'rgba(255,0,40,0)'); vg.addColorStop(1, 'rgba(255,0,40,' + (G.hitVig * .34) + ')');
    g.fillStyle = vg; g.fillRect(0, 0, F.w, F.h);
  }
  if (G.flashT > 0) {
    g.globalAlpha = clamp(G.flashT * 1.6, 0, .8); g.fillStyle = G.flashC;
    g.fillRect(0, 0, F.w, F.h); g.globalAlpha = 1;
  }

  if (it) drawHUD(g, it.b);
  drawBanner(g);
  if (G.paused) {
    g.fillStyle = 'rgba(4,8,20,.55)'; g.fillRect(0, 0, F.w, F.h);
    g.textAlign = 'center'; g.fillStyle = '#fff'; g.font = '900 64px system-ui';
    g.fillText('잠깐 멈춤', F.w / 2, F.h / 2);
    g.font = '600 22px system-ui'; g.fillStyle = '#cfe0ff';
    g.fillText('P 키나 ⏸ 버튼을 누르면 이어서 합니다', F.w / 2, F.h / 2 + 46);
  }
  g.restore();
}

/* 시작 화면 뒤에서 편대가 날아가는 장면. 지역은 20초마다 바뀝니다. */
function menuZone() { return Math.floor(gameT / 20) % 10; }
function drawMenuScene(g, dt) {
  for (let i = 0; i < 3; i++) {
    const x = ((gameT * 170 + i * 130) % (F.w + 700)) - 350;
    const y = F.h * .5 + (i - 1) * 120 + Math.sin(gameT * 1.1 + i * 2) * 26 + (i === 1 ? -40 : 0);
    const C = SHIP_COLORS[(i * 2) % 6];
    g.globalCompositeOperation = 'lighter';
    engineFlame(g, x, y, 0, C, 1);
    g.globalCompositeOperation = 'source-over';
    if (Math.random() < .5 && GFX.hi) addPart({ k: 'trail', x: x - 26, y: y + (Math.random() < .5 ? -5 : 5), vx: -170, vy: 0, r: 3.4, life: .4, t: 0, c: C.glow });
    blit(g, shipSprite((i * 2) % 6), x, y, Math.cos(gameT * 1.1 + i * 2) * .12, 1.15);
  }
}

function drawWorld(g, it, dt) {
  const A = it.a, B = it.b, k = it.k, rt = it.t;

  // ── 픽업 ──
  const pkA = byId(A.K);
  for (const r of B.K) {
    const p = pkA.get(r[0]);
    const x = p ? lerp(p[2], r[2], k) : r[2], y = p ? lerp(p[3], r[3], k) : r[3];
    drawPickup(g, r[1], x, y);
  }

  // ── 총알 ──
  g.globalCompositeOperation = 'lighter';
  for (const b of G.bullets.values()) {
    const dtk = (rt - b.born);
    const x = b.x + b.vx * dtk * S.DT, y = b.y + b.vy * dtk * S.DT;
    if (x < -60 || x > F.w + 60 || y < -60 || y > F.h + 60) continue;
    drawBullet(g, b.kind, x, y, Math.atan2(b.vy, b.vx), b.col);
  }
  const hbA = byId(A.HB);
  for (const r of B.HB) {
    const p = hbA.get(r[0]);
    const x = p ? lerp(p[1], r[1], k) : r[1], y = p ? lerp(p[2], r[2], k) : r[2];
    drawBullet(g, r[4], x, y, r[3] / 100, 0);
  }
  g.globalCompositeOperation = 'source-over';

  // ── 레이저 ──
  for (const r of B.BM) {
    const [id, x, y, a100, w, fire, t100] = r;
    const a = a100 / 100;
    g.save(); g.translate(x, y); g.rotate(a);
    if (!fire) {
      g.strokeStyle = 'rgba(255,80,120,' + (.35 + Math.sin(gameT * 30) * .2) + ')';
      g.lineWidth = 3; g.setLineDash([16, 12]);
      g.beginPath(); g.moveTo(0, 0); g.lineTo(2400, 0); g.stroke(); g.setLineDash([]);
    } else {
      const grd = g.createLinearGradient(0, -w / 2, 0, w / 2);
      grd.addColorStop(0, 'rgba(255,120,180,0)'); grd.addColorStop(.5, 'rgba(255,255,255,.95)');
      grd.addColorStop(1, 'rgba(255,120,180,0)');
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = grd; g.fillRect(0, -w / 2, 2400, w);
      g.fillStyle = 'rgba(255,90,160,.5)'; g.fillRect(0, -w, 2400, w * 2);
      g.globalCompositeOperation = 'source-over';
    }
    g.restore();
  }

  // ── 적 ──
  const enA = byId(A.E);
  for (const r of B.E) {
    const p = enA.get(r[0]);
    const x = p ? lerp(p[2], r[2], k) : r[2], y = p ? lerp(p[3], r[3], k) : r[3];
    const art = r[1], hp = r[4], mx = r[5], ang = r[6] / 100, fl = r[7];
    const spr = enemySprite(art);
    // 엔진 불꽃 — 날아가는 방향의 반대쪽(꼬리)에 붙입니다
    if (art !== 'mine' && art !== 'turret') {
      const bx = x - Math.cos(ang) * 24, by = y - Math.sin(ang) * 24;
      g.globalCompositeOperation = 'lighter';
      g.save(); g.translate(bx, by); g.rotate(ang);
      g.globalAlpha = .75 + Math.random() * .25;
      g.drawImage(glow('#ff8a3c'), -26 - Math.random() * 8, -7, 32, 14);
      g.restore();
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    } else if (GFX.hi) {   // 포대·기뢰는 은은하게 빛나는 심지
      g.globalCompositeOperation = 'lighter';
      glowAt(g, art === 'mine' ? '#ff3c3c' : '#ff9a3c', x, y, 20 + Math.sin(gameT * 6 + r[0]) * 5, .45);
      g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    }
    // 많이 다친 적은 연기를 뿜습니다
    if (GFX.hi && hp < mx * .45 && Math.random() < .25) {
      addPart({ k: 'smoke', x: x + (Math.random() - .5) * 12, y: y + (Math.random() - .5) * 12, vx: -90, vy: -14, r: 6, life: .6, t: 0 });
    }
    // 맞았을 때는 원래 그림 위에 흰색을 반쯤 덮습니다.
    // 통째로 하얗게 바꾸면 다섯 명이 쉬지 않고 쏘는 동안 적이 흰 덩어리로만 보입니다.
    blit(g, spr, x, y, ang - Math.PI, 1);
    if (fl) blit(g, flashOf(spr), x, y, ang - Math.PI, 1, .55);
    if (hp < mx) {
      const w = 42, h = 4;
      g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(x - w / 2, y - 34, w, h);
      g.fillStyle = hp / mx > .5 ? '#8ef0b6' : hp / mx > .25 ? '#ffd166' : '#ff7a8a';
      g.fillRect(x - w / 2, y - 34, w * (hp / mx), h);
    }
  }

  // ── 보스 ──
  if (B.B) {
    const b = B.B, ab = A.B;
    const x = ab ? lerp(ab[1], b[1], k) : b[1], y = ab ? lerp(ab[2], b[2], k) : b[2];
    const artFn = BOSS_ART[b[0]] || BOSS_ART.fortress;
    const scale = bossScale(b[0]);
    const Zc = (S.ZONES[G.zone] || S.ZONES[0]).accent;
    const frac = b[4] ? b[3] / b[4] : 1;
    g.save(); g.translate(x, y + Math.sin(gameT * 1.3) * 6);   // 둥실둥실
    // 뒤 후광 — 지역 색으로 은은하게 숨쉬기
    const hr = scale * (1.7 + Math.sin(gameT * 2) * .08);
    g.globalAlpha = .55; g.drawImage(haze(Zc), -hr, -hr, hr * 2, hr * 2); g.globalAlpha = 1;
    artFn(g, scale, gameT);
    // 맞는 동안 계속 하얗게 덮으면 밝은 보스는 흰 덩어리가 됩니다 — 짧게 깜빡이기만 합니다
    if (b[6] && Math.sin(gameT * 50) > .3) { g.globalCompositeOperation = 'lighter'; g.globalAlpha = .22; artFn(g, scale, gameT); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; }
    g.restore();
    // 체력이 줄수록 불꽃과 연기가 늘어납니다
    if (frac < .5 && !b[8]) {
      const n = frac < .2 ? 3 : 1;
      for (let i = 0; i < n; i++) if (Math.random() < .5) {
        const px = x + (Math.random() - .5) * scale * 1.4, py = y + (Math.random() - .5) * scale * 1.2;
        addPart({ k: 'smoke', x: px, y: py, vx: -110, vy: -30, r: 12, life: .9, t: 0 });
        if (Math.random() < .4) addPart({ k: 'fire', x: px, y: py, vx: -60, vy: -20, r: 16, life: .35, t: 0, c: '#ff7a30' });
      }
    }
  }

  // ── 내 비행기가 따라가는 목표점(마우스 자리) ──
  const meRow = B.P.find((q) => q[0] === G.myId);
  if (meRow && !meRow[6] && Math.hypot(G.input.tx - meRow[1], G.input.ty - meRow[2]) > 18) {
    const tx = G.input.tx, ty = G.input.ty, rr = 11 + Math.sin(gameT * 6) * 1.5;
    g.strokeStyle = 'rgba(255,209,102,.7)'; g.lineWidth = 2;
    g.beginPath(); g.arc(tx, ty, rr, 0, TAU); g.stroke();
    g.beginPath();
    g.moveTo(tx - rr - 6, ty); g.lineTo(tx - rr + 3, ty); g.moveTo(tx + rr - 3, ty); g.lineTo(tx + rr + 6, ty);
    g.moveTo(tx, ty - rr - 6); g.lineTo(tx, ty - rr + 3); g.moveTo(tx, ty + rr - 3); g.lineTo(tx, ty + rr + 6);
    g.stroke();
  }

  // ── 아군 ──
  const plA = byId(A.P);
  for (const r of B.P) {
    const p = plA.get(r[0]);
    const id = r[0];
    const x = p ? lerp(p[1], r[1], k) : r[1], y = p ? lerp(p[2], r[2], k) : r[2];
    const hp = r[3], gun = r[4], inv = r[5], down = r[6], rev = r[7], bombs = r[8],
      score = r[9], lives = r[10], ang = r[11] / 100, shield = r[12], downT = r[13];
    const ci = colorOf(id), C = SHIP_COLORS[ci % 6];
    const mine = id === G.myId;

    if (down) { drawDowned(g, x, y, C, rev, nameOf(id) || '동료', downT); continue; }

    // 위아래로 움직일 때 날개를 기울입니다(보이는 폭이 좁아짐)
    const py0 = p ? p[2] : r[2];
    const vyNow = (r[2] - py0) / S.DT;
    const vyS = (G.vy.get(id) || 0) * .85 + vyNow * .15;
    G.vy.set(id, vyS);
    const bank = clamp(Math.abs(vyS) / 700, 0, .32);
    const lean = clamp(vyS / 1400, -.18, .18);

    // 엔진 불꽃 + 비행운
    g.globalCompositeOperation = 'lighter';
    engineFlame(g, x, y, ang, C, 1 - bank * .6);
    if (mine && GFX.hi) glowAt(g, C.glow, x, y, 58, .14);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    if (Math.random() < .6) addPart({ k: 'trail', x: x - 26, y: y + (Math.random() < .5 ? -5 : 5), vx: -160, vy: 0, r: 3.4, life: .35, t: 0, c: C.glow });

    // 보호막
    if (shield) {
      g.save(); g.globalCompositeOperation = 'lighter';
      const sg = g.createRadialGradient(x, y, 20, x, y, 40);
      sg.addColorStop(0, 'rgba(120,220,255,0)'); sg.addColorStop(.7, 'rgba(120,220,255,.35)'); sg.addColorStop(1, 'rgba(200,240,255,.7)');
      g.fillStyle = sg; g.beginPath(); g.arc(x, y, 40, 0, TAU); g.fill(); g.restore();
    }
    const spr = shipSprite(ci);
    g.save(); g.translate(x, y); g.rotate(ang + lean); g.scale(1, 1 - bank);
    g.globalAlpha = inv ? (Math.sin(gameT * 26) > 0 ? .35 : .95) : 1;
    g.drawImage(spr, -spr._w / 2, -spr._h / 2, spr._w, spr._h);
    g.restore(); g.globalAlpha = 1;

    // 이름표 + 체력
    g.font = '600 15px system-ui, sans-serif'; g.textAlign = 'center';
    const nm = nameOf(id) || '조종사';
    g.fillStyle = mine ? '#ffd166' : 'rgba(255,255,255,.86)';
    g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = 3;
    g.strokeText(nm, x, y + 46); g.fillText(nm, x, y + 46);
    const bw = 46;
    g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(x - bw / 2, y + 52, bw, 5);
    g.fillStyle = hp > 55 ? '#8ef0b6' : hp > 25 ? '#ffd166' : '#ff7a8a';
    g.fillRect(x - bw / 2, y + 52, bw * clamp(hp / S.P_MAXHP, 0, 1), 5);
    if (mine) {
      g.strokeStyle = 'rgba(255,209,102,.55)'; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, 38, gameT * 2, gameT * 2 + 1.1); g.stroke();
      g.beginPath(); g.arc(x, y, 38, gameT * 2 + Math.PI, gameT * 2 + Math.PI + 1.1); g.stroke();
    }
  }
}
// 두 개의 엔진 노즐에서 나오는 불꽃. 바깥은 조종사 색, 안쪽은 하얗게 달아오른 심.
function engineFlame(g, x, y, ang, C, w) {
  const fl = 22 + Math.random() * 12;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  for (const dy of [-5 * w, 5 * w]) {
    const ex = x - ca * 22 - sa * dy, ey = y - sa * 22 + ca * dy;
    g.save(); g.translate(ex, ey); g.rotate(ang);
    g.globalAlpha = .9; g.drawImage(glow(C.glow), -fl, -6, fl + 4, 12);
    g.globalAlpha = .9; g.drawImage(glow('#ffffff'), -fl * .45, -3, fl * .45 + 2, 6);
    g.restore();
  }
}
function bossScale(key) {
  const m = { fortress: 105, hive: 112, zeppelin: 120, batwing: 118, prism: 108, sandworm: 126, magma: 132, icequeen: 122, interceptor: 112, motherstar: 142 };
  return m[key] || 110;
}
function drawDowned(g, x, y, C, rev, name, downT) {
  // 낙하산
  g.save(); g.translate(x, y);
  g.fillStyle = 'rgba(255,255,255,.9)';
  g.beginPath(); g.arc(0, -26, 26, Math.PI, 0); g.closePath(); g.fill();
  g.fillStyle = C.body;
  g.beginPath(); g.arc(0, -26, 26, Math.PI, Math.PI * 1.34); g.lineTo(0, -26); g.closePath(); g.fill();
  g.beginPath(); g.arc(0, -26, 26, Math.PI * 1.66, 0); g.lineTo(0, -26); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1.4;
  g.beginPath(); g.moveTo(-24, -26); g.lineTo(-5, 0); g.moveTo(24, -26); g.lineTo(5, 0); g.stroke();
  g.fillStyle = '#2b3650'; g.beginPath(); g.roundRect(-8, -2, 16, 14, 5); g.fill();
  g.fillStyle = '#ffd9b0'; g.beginPath(); g.arc(0, 0, 5, 0, TAU); g.fill();
  g.restore();
  // 구조 게이지
  const w = 66;
  g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(x - w / 2, y + 26, w, 7);
  g.fillStyle = '#8ef0b6'; g.fillRect(x - w / 2, y + 26, w * clamp(rev / 100, 0, 1), 7);
  g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 1; g.strokeRect(x - w / 2, y + 26, w, 7);
  g.font = '700 14px system-ui'; g.textAlign = 'center';
  g.fillStyle = '#ffd166'; g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = 3;
  const txt = name + ' 구조!';
  g.strokeText(txt, x, y + 50); g.fillText(txt, x, y + 50);
  g.globalAlpha = .5 + Math.sin(gameT * 6) * .3;
  g.strokeStyle = '#8ef0b6'; g.lineWidth = 2; g.setLineDash([8, 8]);
  g.beginPath(); g.arc(x, y, 120, 0, TAU); g.stroke();   // 이 원 안에 들어오면 구조가 시작됩니다
  g.setLineDash([]); g.globalAlpha = 1;
}
// 총알 그림도 한 번만 그려 두고 찍습니다. 총알이 수백 발이어도 가볍습니다.
function playerBulletSprite(kind, col) {
  const C = SHIP_COLORS[(col || 0) % 6];
  const big = kind === 'p3' ? 1.45 : kind === 'p2' ? 1.15 : 1;
  return sprite('pb' + kind + (col % 6), 40 * big, 10 * big, (g) => {
    // 다섯 명이 한꺼번에 쏘면 화면이 하얗게 덮여 적이 안 보입니다.
    // 그래서 꼬리는 조종사 색으로 옅게, 흰 부분은 아주 작은 점만 남깁니다.
    const tail = g.createLinearGradient(-19 * big, 0, 5 * big, 0);
    tail.addColorStop(0, 'rgba(255,255,255,0)'); tail.addColorStop(1, C.glow);
    g.globalAlpha = .62; g.fillStyle = tail;
    g.beginPath(); g.moveTo(-19 * big, 0); g.lineTo(6 * big, -1.9 * big); g.lineTo(6 * big, 1.9 * big); g.closePath(); g.fill();
    g.globalAlpha = 1; g.fillStyle = C.glow;
    g.beginPath(); g.ellipse(3 * big, 0, 5.4 * big, 2.1 * big, 0, 0, TAU); g.fill();
    g.fillStyle = '#fff';
    g.beginPath(); g.ellipse(5.4 * big, 0, 2.2 * big, 1.3 * big, 0, 0, TAU); g.fill();
  });
}
function enemyBulletSprite(kind) {
  const c = kind === 'em' ? '#ff7ae0' : kind === 'e2' ? '#ff9a3c' : '#ff5a6b';
  const r = kind === 'e2' ? 12 : kind === 'em' ? 11 : 8;
  return sprite('eb' + kind, r * 4, r * 4, (g) => {
    const grd = g.createRadialGradient(0, 0, 1, 0, 0, r * 1.9);
    grd.addColorStop(0, '#ffffff'); grd.addColorStop(.3, c); grd.addColorStop(.62, 'rgba(255,60,90,.25)'); grd.addColorStop(1, 'rgba(255,60,90,0)');
    g.fillStyle = grd; g.beginPath(); g.arc(0, 0, r * 1.9, 0, TAU); g.fill();
    // 적 총알은 테두리를 또렷하게 — 피해야 하는 것이 한눈에 보이도록
    g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 1.6;
    g.beginPath(); g.arc(0, 0, r * .62, 0, TAU); g.stroke();
    if (kind === 'em') {
      g.fillStyle = '#fff'; g.beginPath(); g.moveTo(8, 0); g.lineTo(-6, -4); g.lineTo(-6, 4); g.closePath(); g.fill();
    }
  });
}
function drawBullet(g, kind, x, y, a, col) {
  if (kind[0] === 'p') {
    const spr = playerBulletSprite(kind, col || 0);
    g.save(); g.translate(x, y); g.rotate(a);
    g.drawImage(spr, -spr._w / 2, -spr._h / 2, spr._w, spr._h);
    g.restore();
  } else {
    const spr = enemyBulletSprite(kind);
    const pulse = 1 + Math.sin(gameT * 14 + x * .05) * .08;
    const w = spr._w * pulse, h = spr._h * pulse;
    if (kind === 'em') {
      g.save(); g.translate(x, y); g.rotate(a); g.drawImage(spr, -w / 2, -h / 2, w, h); g.restore();
    } else {
      g.drawImage(spr, x - w / 2, y - h / 2, w, h);
    }
  }
}
const PICK_INFO = {
  pow: { c: '#ffd166', t: 'P', n: '무기 강화' }, heal: { c: '#8ef0b6', t: '♥', n: '수리' },
  // 글꼴에 없는 기호를 쓰면 네모(두부)로 보입니다 — 어디서나 나오는 것만 씁니다
  bomb: { c: '#ff9a3c', t: '💣', n: '폭탄' }, shield: { c: '#7fe0ff', t: '🛡', n: '보호막' },
  star: { c: '#fff2a8', t: '★', n: '점수' },
};
function drawPickup(g, type, x, y) {
  const I = PICK_INFO[type] || PICK_INFO.star;
  const bob = Math.sin(gameT * 4 + x * .05) * 3;
  g.save(); g.translate(x, y + bob);
  g.globalCompositeOperation = 'lighter';
  const gr = g.createRadialGradient(0, 0, 2, 0, 0, 26);
  gr.addColorStop(0, I.c); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.globalAlpha = .55; g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 26, 0, TAU); g.fill();
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  g.rotate(Math.sin(gameT * 2 + x * .02) * .25);
  g.fillStyle = 'rgba(10,18,34,.9)'; g.strokeStyle = I.c; g.lineWidth = 2.4;
  g.beginPath(); g.roundRect(-14, -14, 28, 28, 9); g.fill(); g.stroke();
  g.rotate(-Math.sin(gameT * 2 + x * .02) * .25);
  g.fillStyle = I.c; g.font = '800 17px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(I.t, 0, 1);
  g.textBaseline = 'alphabetic';
  g.restore();
}

/* ═══════════════════ HUD ═══════════════════ */
function drawHUD(g, s) {
  const Z = S.ZONES[G.zone] || S.ZONES[0];
  // 상단 좌측: 단계
  g.save();
  roundRect(g, 14, 12, 268, 58, 14, 'rgba(8,14,28,.62)', 'rgba(255,255,255,.14)');
  g.fillStyle = '#fff'; g.font = '800 27px system-ui'; g.textAlign = 'left';
  g.fillText(s.st + ' 단계', 28, 44);
  const dotX = Math.max(146, 28 + g.measureText(s.st + ' 단계').width + 14);   // 세 자리 단계에서 글자와 겹치지 않게
  g.fillStyle = Z.accent; g.font = '600 13px system-ui';
  g.fillText(Z.name, 28, 62);
  // 웨이브 점
  const wn = s.wvN || 0;
  for (let i = 0; i < wn; i++) {
    g.fillStyle = i < s.wv ? Z.accent : 'rgba(255,255,255,.2)';
    g.beginPath(); g.arc(dotX + i * 15, 40, 5, 0, TAU); g.fill();
  }
  // 100단계 진행바
  g.fillStyle = 'rgba(255,255,255,.16)'; g.fillRect(146, 56, 120, 5);
  g.fillStyle = '#ffd166'; g.fillRect(146, 56, 120 * (s.st / S.TOTAL_STAGES), 5);

  // 상단 우측: 점수 · 방 코드
  g.textAlign = 'right';
  roundRect(g, F.w - 258, 12, 244, 58, 14, 'rgba(8,14,28,.62)', 'rgba(255,255,255,.14)');
  g.fillStyle = '#ffd166'; g.font = '800 25px system-ui';
  g.fillText(Math.round(G.scoreShown).toLocaleString(), F.w - 28, 42);
  g.fillStyle = 'rgba(200,220,255,.7)'; g.font = '600 12.5px system-ui';
  g.fillText(G.mode === 'solo' ? '혼자 연습' : ('방 코드 ' + G.room + '  ·  ' + s.P.length + '명'), F.w - 28, 61);

  // 좌하단: 편대원 카드
  const rows = s.P.slice().sort((a, b) => (a[0] === G.myId ? -1 : b[0] === G.myId ? 1 : a[0] - b[0]));
  let cy = F.h - 16 - rows.length * 40;
  for (const r of rows) {
    const id = r[0], hp = r[3], gun = r[4], down = r[6], bombs = r[8], lives = r[10];
    const C = SHIP_COLORS[colorOf(id) % 6];
    const mine = id === G.myId;
    roundRect(g, 14, cy, 246, 34, 10, mine ? 'rgba(255,209,102,.16)' : 'rgba(8,14,28,.58)',
      mine ? 'rgba(255,209,102,.5)' : 'rgba(255,255,255,.10)');
    g.fillStyle = C.body; g.beginPath(); g.arc(30, cy + 17, 7, 0, TAU); g.fill();
    g.textAlign = 'left'; g.font = '700 13.5px system-ui';
    g.fillStyle = down ? '#ff9aa8' : '#fff';
    g.fillText((nameOf(id) || '조종사'), 44, cy + 15);
    // 체력바
    g.fillStyle = 'rgba(255,255,255,.15)'; g.fillRect(44, cy + 21, 118, 6);
    if (!down) {
      g.fillStyle = hp > 55 ? '#8ef0b6' : hp > 25 ? '#ffd166' : '#ff7a8a';
      g.fillRect(44, cy + 21, 118 * clamp(hp / S.P_MAXHP, 0, 1), 6);
    } else {
      g.fillStyle = '#8ef0b6'; g.fillRect(44, cy + 21, 118 * clamp(r[7] / 100, 0, 1), 6);
      g.fillStyle = '#ff9aa8'; g.font = '700 11px system-ui'; g.fillText('격추', 168, cy + 27);
    }
    g.textAlign = 'right'; g.font = '700 12.5px system-ui';
    g.fillStyle = '#ffd166'; g.fillText('Lv' + gun, 200, cy + 16);
    g.fillStyle = '#9fd4ff'; g.fillText('💣' + bombs, 232, cy + 16);
    g.fillStyle = '#ff9aa8'; g.fillText('♥' + lives, 252, cy + 27);
    cy += 40;
  }

  // 보스 체력바
  if (s.B) {
    const hp = s.B[3], mx = s.B[4], nm = s.B[5];
    const w = 760, x0 = (F.w - w) / 2, y0 = 86;
    g.textAlign = 'center'; g.font = '800 17px system-ui';
    g.fillStyle = '#fff'; g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 4;
    g.strokeText(nm, F.w / 2, y0 - 8); g.fillText(nm, F.w / 2, y0 - 8);
    roundRect(g, x0, y0, w, 18, 9, 'rgba(0,0,0,.55)', 'rgba(255,255,255,.3)');
    const frac = clamp(hp / mx, 0, 1);
    // 방금 깎인 만큼은 흰 띠로 잠깐 남겼다가 따라 줄어듭니다
    if (G.bossLag < frac) G.bossLag = frac;
    G.bossLag = Math.max(frac, G.bossLag - .0045);
    g.fillStyle = 'rgba(255,255,255,.75)';
    g.beginPath(); g.roundRect(x0 + 2, y0 + 2, (w - 4) * G.bossLag, 14, 7); g.fill();
    const bg = g.createLinearGradient(x0, 0, x0 + w, 0);
    bg.addColorStop(0, '#ff4d6b'); bg.addColorStop(.6, '#ff9a3c'); bg.addColorStop(1, '#ffd166');
    g.fillStyle = bg;
    g.beginPath(); g.roundRect(x0 + 2, y0 + 2, (w - 4) * frac, 14, 7); g.fill();
    // 반짝이는 윗면
    g.fillStyle = 'rgba(255,255,255,.28)';
    g.beginPath(); g.roundRect(x0 + 4, y0 + 3, Math.max(0, (w - 8) * frac), 5, 3); g.fill();
    // 형태가 바뀌는 지점 표시
    const BD = S.BOSSES.find((q) => q.art === s.B[0]);
    if (BD) for (const ph of BD.phases) {
      if (!(ph.at < 1)) continue;
      const px = x0 + 2 + (w - 4) * ph.at;
      g.fillStyle = frac > ph.at ? 'rgba(255,255,255,.9)' : 'rgba(255,255,255,.3)';
      g.beginPath(); g.moveTo(px, y0 - 3); g.lineTo(px + 5, y0 - 9); g.lineTo(px - 5, y0 - 9); g.closePath(); g.fill();
      g.fillRect(px - 1, y0 + 2, 2, 14);
    }
    g.fillStyle = '#fff'; g.font = '700 12px system-ui'; g.textAlign = 'right';
    g.fillText(Math.ceil(frac * 100) + '%', x0 + w - 8, y0 + 14);
    g.textAlign = 'left';
  }

  // 폭탄 안내 (내 것)
  const me = s.P.find((r) => r[0] === G.myId);
  if (me) {
    $('#bombN').textContent = me[8];
    $('#bombBtn').style.opacity = me[8] > 0 ? '1' : '.35';
  }
  g.restore();
}
function roundRect(g, x, y, w, h, r, fill, stroke) {
  g.beginPath(); g.roundRect(x, y, w, h, r);
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1.4; g.stroke(); }
}
function drawBanner(g) {
  if (!G.banner || G.bannerT <= 0) return;
  const b = G.banner;
  const t = G.bannerT;
  const a = clamp(t > 2.2 ? (3 - t) * 2.5 : t, 0, 1);
  if (!b.t0) b.t0 = t;
  const age = b.t0 - t;                       // 나타난 뒤 지난 시간
  const pop = age < .35 ? 1.35 - Math.sin(age / .35 * Math.PI / 2) * .35 : 1;
  g.save(); g.globalAlpha = a;
  g.textAlign = 'center';
  const y = F.h * .38;
  const col = b.kind === 'boss' ? '#ff6b8a' : b.kind === 'clear' ? '#8ef0b6' : b.kind === 'wipe' ? '#ff9aa8' : '#ffd166';
  // 글자 뒤 가로 띠
  const band = g.createLinearGradient(0, 0, F.w, 0);
  band.addColorStop(0, 'rgba(0,0,0,0)'); band.addColorStop(.5, 'rgba(0,0,0,.45)'); band.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = band; g.fillRect(0, y - 78, F.w, b.sub ? 138 : 100);
  g.fillStyle = col;
  const sw = Math.min(1, age * 3) * F.w * .42;
  g.fillRect(F.w / 2 - sw, y - 80, sw * 2, 2); g.fillRect(F.w / 2 - sw, y + (b.sub ? 58 : 20), sw * 2, 2);
  g.translate(F.w / 2, y - 20); g.scale(pop, pop); g.translate(-F.w / 2, -(y - 20));
  g.font = '900 76px system-ui'; g.lineWidth = 10; g.strokeStyle = 'rgba(0,0,0,.65)';
  g.strokeText(b.big, F.w / 2, y);
  const grd = g.createLinearGradient(0, y - 60, 0, y + 12);
  grd.addColorStop(0, '#fff'); grd.addColorStop(1, col);
  g.fillStyle = grd; g.fillText(b.big, F.w / 2, y);
  if (b.sub) {
    g.font = '700 26px system-ui'; g.lineWidth = 6;
    g.strokeStyle = 'rgba(0,0,0,.6)'; g.strokeText(b.sub, F.w / 2, y + 44);
    g.fillStyle = '#dfe8ff'; g.fillText(b.sub, F.w / 2, y + 44);
  }
  g.restore();
}

/* ═══════════════════ 조작 ═══════════════════ */
let pointerActive = false;
function setTargetFromClient(cx, cy, touch) {
  const p = toField(cx, cy);
  G.input.tx = clamp(p.x, 20, F.w - 20);
  G.input.ty = clamp(p.y - (touch ? 70 : 0), 20, F.h - 20);   // 손가락이 비행기를 가리지 않도록
}
cv.addEventListener('pointerdown', (e) => {
  pointerActive = true; cv.setPointerCapture(e.pointerId);
  setTargetFromClient(e.clientX, e.clientY, e.pointerType !== 'mouse');
  if (AC && AC.state === 'suspended') AC.resume();
});
cv.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse' || pointerActive) setTargetFromClient(e.clientX, e.clientY, e.pointerType !== 'mouse');
});
cv.addEventListener('pointerup', () => { pointerActive = false; });
cv.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  G.keys[e.code] = true;
  if (e.code === 'Space') { e.preventDefault(); G.input.bomb = true; }
  if (e.code === 'Escape' && G.mode !== 'menu') quit();
  if (e.code === 'KeyP') togglePause();
});
window.addEventListener('keyup', (e) => { G.keys[e.code] = false; });
$('#bombBtn').addEventListener('click', () => { G.input.bomb = true; });

// 키보드 이동 (마우스와 같이 써도 됩니다)
setInterval(() => {
  if (G.mode === 'menu') return;
  const k = G.keys, sp = 22;
  let dx = 0, dy = 0;
  if (k.ArrowLeft || k.KeyA) dx -= 1;
  if (k.ArrowRight || k.KeyD) dx += 1;
  if (k.ArrowUp || k.KeyW) dy -= 1;
  if (k.ArrowDown || k.KeyS) dy += 1;
  if (dx || dy) {
    G.input.tx = clamp(G.input.tx + dx * sp, 20, F.w - 20);
    G.input.ty = clamp(G.input.ty + dy * sp, 20, F.h - 20);
  }
}, 33);

/* ═══════════════════ 네트워크 ═══════════════════ */
function wsBase() {
  const p = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return p + location.host;
}
function connect(room, name, color, startStage, isRetry) {
  const url = wsBase() + '/ws?room=' + encodeURIComponent(room) + '&name=' + encodeURIComponent(name)
    + '&color=' + color + '&v=' + S.VERSION + (startStage ? '&stage=' + startStage : '');
  const ws = new WebSocket(url);
  G.ws = ws;
  G.leaving = false;
  if (!isRetry) { G.retry = 0; G.last = { room, name, color }; }
  ws.onopen = () => { setMsg('연결됨! 하늘로 올라갑니다…', true); };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.a === 'welcome') {
      G.myId = m.id; G.room = m.room;
      G.retry = 0;                     // 다시 붙었으니 재시도 횟수를 되돌립니다
      G.last = { room: m.room, name, color };
      G.roster.clear();
      for (const p of m.players) G.roster.set(p.id, p);
      startGame('online');
      if (m.ver !== S.VERSION) toast('서버와 게임 버전이 다릅니다. 새로고침해 주세요.', '#ffb4c0');
    } else if (m.a === 'roster') {
      const before = new Set(G.roster.keys());
      G.roster.clear();
      for (const p of m.players) G.roster.set(p.id, p);
      for (const p of m.players) if (!before.has(p.id) && p.id !== G.myId) toast(p.name + ' 님 합류!', '#8ef0b6');
    } else if (m.a === 's') {
      G.snapAt = performance.now();
      G.lastRecv = performance.now();
      pushSnap(m.s);
    } else if (m.a === 'err') {
      setMsg(m.msg || '들어갈 수 없습니다.');
      ws.close();
    }
  };
  ws.onclose = () => {
    G.ws = null;
    if (G.mode !== 'online' || G.leaving) return;
    // 태블릿 화면이 잠기거나 와이파이가 잠깐 끊기면 접속이 닫힙니다.
    // 아이들이 코드를 다시 넣지 않아도 되게 몇 번 스스로 다시 붙습니다.
    if (G.retry < 4 && G.last) {
      G.retry++;
      toast('연결이 끊겼어요. 다시 붙는 중… (' + G.retry + '/4)', '#ffd166');
      setTimeout(() => {
        if (G.mode === 'online' && !G.ws && !G.leaving) connect(G.last.room, G.last.name, G.last.color, 0, true);
      }, 900 * G.retry);
    } else {
      toast('연결이 끊어졌습니다.', '#ffb4c0');
      setTimeout(quit, 1400);
    }
  };
  ws.onerror = () => { setMsg('서버에 연결하지 못했습니다.'); };
}
setInterval(() => {
  if (G.mode !== 'online' || !G.ws || G.ws.readyState !== 1) return;
  G.ws.send(JSON.stringify({ a: 'i', tx: Math.round(G.input.tx), ty: Math.round(G.input.ty), b: G.input.bomb ? 1 : 0 }));
  G.input.bomb = false;
}, 50);

/* ═══════════════════ 화면 전환 ═══════════════════ */
function toast(text, color) {
  const d = document.createElement('div');
  d.className = 'tst'; d.textContent = text;
  if (color) d.style.color = color;
  $('#toast').appendChild(d);
  setTimeout(() => { d.style.transition = 'opacity .4s'; d.style.opacity = '0'; setTimeout(() => d.remove(), 420); }, 2200);
}
function setMsg(t, ok) { const m = $('#msg'); m.textContent = t || ''; m.className = 'msg' + (ok ? ' ok' : ''); }

function startGame(mode) {
  G.mode = mode;
  G.snaps.length = 0; G.bullets.clear(); parts.length = 0;
  $('#menu').classList.add('hide');
  $('#hudDom').classList.add('on');
  $('#bombBtn').classList.add('on');
  $('#topRight').classList.remove('hide');
  $('#topRight').classList.toggle('solo', mode === 'solo');
  G.paused = false; G.scoreShown = 0; G.box = 0; G.vy.clear();
  $('#rotate').classList.add('on');
  G.input.tx = F.w * .16; G.input.ty = F.h / 2;
  if (AC && AC.state === 'suspended') AC.resume(); else ac();
}
function quit() {
  G.leaving = true;                 // 스스로 나가는 것이니 다시 붙지 않습니다
  if (G.ws) { try { G.ws.close(); } catch (e) { } G.ws = null; }
  G.local = null;
  G.mode = 'menu';
  G.paused = false; G.box = 0; G.banner = null;
  $('#menu').classList.remove('hide');
  $('#hudDom').classList.remove('on');
  $('#bombBtn').classList.remove('on');
  $('#topRight').classList.add('hide');
  $('#rotate').classList.remove('on');
  setMsg('');
}
$('#btnQuit').addEventListener('click', quit);
$('#btnSound').addEventListener('click', () => {
  muted = !muted;
  $('#btnSound').textContent = muted ? '🔇' : '🔊';
});
// 잠깐 멈춤은 혼자 연습에서만 됩니다(온라인은 친구들이 같이 날고 있으니까요)
function togglePause() {
  if (G.mode !== 'solo') return;
  G.paused = !G.paused;
  $('#btnPause').textContent = G.paused ? '▶' : '⏸';
  if (!G.paused) { lastT = performance.now(); G.localTimer = 0; }
}
$('#btnPause').addEventListener('click', togglePause);
function setMusic(on) {
  MUSIC.on = on;
  localStorage.setItem('sky.music', on ? 'on' : 'off');
  $('#btnMusic').classList.toggle('off', !on);
  if (MUSIC.out && AC) MUSIC.out.gain.setTargetAtTime(on ? .55 : 0, AC.currentTime, .05);
  if (on && MUSIC.out && AC) MUSIC.next = 0;
}
$('#btnMusic').addEventListener('click', () => setMusic(!MUSIC.on));
setMusic(MUSIC.on);
function setGfx(hi) {
  GFX.hi = hi;
  localStorage.setItem('sky.gfx', hi ? 'hi' : 'lo');
  $('#btnGfx').classList.toggle('off', !hi);
  $('#btnGfx').title = '그래픽 품질: ' + (hi ? '높음' : '낮음 (가벼움)');
}
$('#btnGfx').addEventListener('click', () => { GFX.autoDone = true; setGfx(!GFX.hi); toast('그래픽 품질: ' + (GFX.hi ? '높음' : '낮음 (가벼움)'), '#cfe0ff'); });
setGfx(GFX.hi);
$('#btnFull').addEventListener('click', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => { });
  else document.exitFullscreen().catch(() => { });
});

/* ═══════════════════ 메뉴 ═══════════════════ */
let myColor = Math.floor(Math.random() * 6);
function buildShipPicker() {
  const box = $('#ships');
  box.innerHTML = '';
  SHIP_COLORS.forEach((C, i) => {
    const b = document.createElement('button');
    b.title = C.name;
    const c = document.createElement('canvas'); c.width = 128; c.height = 88;
    const g = c.getContext('2d');
    g.setTransform(1.5, 0, 0, 1.5, 64, 44);
    drawShipArt(g, C);
    b.appendChild(c);
    if (i === myColor) b.classList.add('on');
    b.addEventListener('click', () => {
      myColor = i;
      [...box.children].forEach((x, j) => x.classList.toggle('on', j === i));
      localStorage.setItem('sky.color', i);
    });
    box.appendChild(b);
  });
}
(function logo() {
  const c = $('#logoShip'), g = c.getContext('2d');
  g.setTransform(1.8, 0, 0, 1.8, 74, 52);
  drawShipArt(g, SHIP_COLORS[0]);
})();
buildShipPicker();

$('#nick').value = localStorage.getItem('sky.nick') || '';
// 지난번에 쓰던 방 코드를 미리 넣어 둡니다 (다음 시간에 이어서 하기 편하도록)
const lastRoom = localStorage.getItem('sky.room');
if (lastRoom) {
  $('#code').value = lastRoom;
  setTimeout(() => $('#code').dispatchEvent(new Event('input')), 60);
}
const savedColor = localStorage.getItem('sky.color');
if (savedColor !== null) { myColor = +savedColor; buildShipPicker(); }

document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    document.querySelectorAll('.pane').forEach((p) => p.classList.remove('on'));
    $('#pane-' + b.dataset.tab).classList.add('on');
    setMsg('');
  });
});
function nick() {
  const v = ($('#nick').value || '').trim().slice(0, 8) || '조종사' + (Math.floor(Math.random() * 90) + 10);
  localStorage.setItem('sky.nick', v);
  return v;
}

// 혼자 연습에서 고를 수 있는 단계 = 이 기기에서 가장 멀리 간 곳
function unlocked() { return clamp(+(localStorage.getItem('sky.best') || 1), 1, S.TOTAL_STAGES); }
function setUnlocked(n) {
  if (n > unlocked()) localStorage.setItem('sky.best', String(clamp(n, 1, S.TOTAL_STAGES)));
}
function refreshRanges() {
  const u = unlocked();
  const s = $('#soloRange'); s.max = String(u); s.value = String(Math.min(+s.value || 1, u));
  $('#soloVal').textContent = s.value + '단계';
}
$('#stageRange').addEventListener('input', (e) => { $('#stageVal').textContent = e.target.value + '단계'; });
$('#soloRange').addEventListener('input', (e) => { $('#soloVal').textContent = e.target.value + '단계'; });
refreshRanges();

$('#btnMake').addEventListener('click', async () => {
  setMsg('방을 만드는 중…');
  try {
    const r = await fetch('/api/newroom', { method: 'POST' });
    const j = await r.json();
    if (!j.room) throw new Error();
    localStorage.setItem('sky.room', j.room);
    connect(j.room, nick(), myColor, 0);
  } catch (e) { setMsg('방을 만들지 못했습니다. 인터넷 연결을 확인해 주세요.'); }
});
$('#btnJoin').addEventListener('click', () => {
  const code = ($('#code').value || '').trim().toUpperCase();
  if (code.length !== 4) { setMsg('코드 4글자를 넣어 주세요.'); return; }
  localStorage.setItem('sky.room', code);
  setMsg('들어가는 중…');
  // 비어 있는 방이면 고른 단계부터, 이미 누가 날고 있으면 서버가 무시하고 바로 합류시킵니다
  const want = $('#stagePick').style.display === 'flex' ? (+$('#stageRange').value || 0) : 0;
  connect(code, nick(), myColor, want);
});
$('#code').addEventListener('input', async (e) => {
  const code = (e.target.value || '').trim().toUpperCase();
  const box = $('#roomInfo'), pick = $('#stagePick');
  if (code.length !== 4) { box.style.display = 'none'; pick.style.display = 'none'; return; }
  try {
    const r = await fetch('/api/room/' + code);
    const j = await r.json();
    box.style.display = 'block';
    box.innerHTML = j.exists
      ? ('🛩 <b>' + code + '</b> 방 — 지금 ' + j.players + '명, ' + j.stage + '단계 비행 중<br>'
         + (j.names || []).map((n) => '· ' + n).join('&nbsp;&nbsp;'))
      : (j.best > 1
        ? ('💤 <b>' + code + '</b> 방은 지금 비어 있어요. 여기까지 깼습니다 — <b>' + j.best + '단계</b>')
        : ('❔ <b>' + code + '</b> 방은 아직 없습니다. 들어가면 새로 만들어집니다.'));
    // 아무도 없고 진행 기록이 있는 방이라면 어느 단계부터 할지 고를 수 있습니다
    const canPick = !j.players && j.best > 1;
    pick.style.display = canPick ? 'flex' : 'none';
    if (canPick) {
      const rg = $('#stageRange');
      rg.max = String(j.best); rg.value = String(j.best);
      $('#stageVal').textContent = j.best + '단계';
    }
  } catch (err) { box.style.display = 'none'; pick.style.display = 'none'; }
});
$('#btnSolo').addEventListener('click', () => {
  const st = +$('#soloRange').value || 1;
  G.myId = 1;
  G.roster.clear();
  G.roster.set(1, { id: 1, name: nick(), color: myColor });
  G.local = new S.Game({ stage: st, seed: Date.now() & 0xffff });
  G.local.addPlayer(1, nick(), myColor);
  G.room = '연습';
  startGame('solo');
});

// 이 기기 최고 기록 갱신
setInterval(() => { if (G.mode !== 'menu') setUnlocked(G.stage); }, 2000);

requestAnimationFrame(frame);
window.SkyClient = { G, S, SHIP_COLORS, drawShipArt, ART, BOSS_ART };
})();
</script>
</body>
</html>
`;
const SIM_TEXT = `/* ─────────────────────────────────────────────────────────────
 *  하늘편대 100 — 게임 시뮬레이션 코어
 *
 *  이 파일은 화면(DOM/캔버스)도, 네트워크도 건드리지 않는 순수 계산기입니다.
 *  그래서 세 곳에서 똑같이 돌아갑니다.
 *    1) Cloudflare Durable Object  … 진짜 온라인 방(서버 권위)
 *    2) 브라우저(index.html)       … "혼자 연습" 모드(서버 없이)
 *    3) _test.html                 … 자동 테스트
 *
 *  좌표계는 가로 1600 × 세로 900 고정. 화면 크기는 클라이언트가 알아서 맞춥니다.
 *  아군은 왼쪽, 적은 오른쪽에서 들어옵니다.
 * ───────────────────────────────────────────────────────────── */
var SkySim = (function () {
  'use strict';

  // 서버·클라이언트가 다르면 접속 시 경고를 띄우려고 둡니다.
  const VERSION = 1;

  const FIELD = { w: 1600, h: 900 };
  const TICK_MS = 50;               // 20Hz
  const DT = TICK_MS / 1000;
  const MAX_PLAYERS = 6;
  const TOTAL_STAGES = 100;

  // ── 아군 ──
  const P_SPEED = 660;              // px/s (목표 지점까지 최대 속도)
  const P_R = 17;                   // 피격 판정 반경 (그림보다 작게 — 아이들이 잘 피하도록)
  const P_MAXHP = 100;
  const P_LIVES = 3;
  const REVIVE_R = 120;             // 이 거리 안에서 버티면 친구를 살립니다
  const REVIVE_SEC = 2.2;
  const DOWN_SEC = 14;              // 아무도 안 오면 목숨 하나 쓰고 스스로 일어남
  const SPAWN_INV = 2.6;            // 부활 직후 무적 시간
  const HIT_INV = 0.55;             // 한 번 맞으면 잠깐 무적 — 적과 몸이 겹쳐도 초당 두 번까지만 아픕니다
  const CONTACT_DMG = 12;           // 적기와 부딪혔을 때 기본 피해
  const BOMB_START = 2;
  const BOMB_MAX = 5;
  const BOMB_R = 620;

  // ── 페이즈 ──
  //  ready → play → (boss) → clear → ready(다음 스테이지)
  //  전멸하면 wipe → ready(같은 스테이지 다시)
  const READY_SEC = 3.2;
  const CLEAR_SEC = 4.6;
  const WIPE_SEC = 3.4;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const d2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
  const R1 = (v) => Math.round(v);

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ═══════════════════ 세계관: 10개 지역 × 10단계 ═══════════════════ */
  const ZONES = [
    { key: 'dawn',    name: '새벽 하늘',   sky: ['#ffd9a0', '#7fb4e8', '#3f6fae'], accent: '#ff9d47', dust: '#fff2d0' },
    { key: 'cloud',   name: '구름 바다',   sky: ['#cfe9ff', '#7fb8e8', '#3d78b8'], accent: '#38b6ff', dust: '#ffffff' },
    { key: 'sunset',  name: '노을 협곡',   sky: ['#ffb56b', '#f2687f', '#5b3d84'], accent: '#ff5f7e', dust: '#ffd0a8' },
    { key: 'night',   name: '별밤 항로',   sky: ['#1b2452', '#2b3a75', '#0d1130'], accent: '#8fb6ff', dust: '#dfe8ff' },
    { key: 'aurora',  name: '오로라 지대', sky: ['#06304a', '#0d6b6b', '#07213a'], accent: '#6bffd0', dust: '#a8ffe8' },
    { key: 'desert',  name: '모래 폭풍',   sky: ['#e8c07a', '#c98a44', '#8a5a2b'], accent: '#ffcf6b', dust: '#f7e0b0' },
    { key: 'volcano', name: '화산재 하늘', sky: ['#3a1414', '#7a2a1c', '#2a0d0d'], accent: '#ff6b3d', dust: '#ffb08a' },
    { key: 'glacier', name: '빙하 상공',   sky: ['#c3e6f8', '#6fb0d8', '#2d6b93'], accent: '#7fe0ff', dust: '#ffffff' },
    { key: 'strato',  name: '성층권',      sky: ['#0a1a3a', '#1e3f7a', '#050a1c'], accent: '#7fa8ff', dust: '#cfe0ff' },
    { key: 'space',   name: '우주 관문',   sky: ['#07040f', '#1a0a2e', '#000000'], accent: '#c07bff', dust: '#e8d0ff' },
  ];

  /* ═══════════════════ 적 도감 ═══════════════════ */
  //  hp/속도는 기준값. 스테이지가 오를수록 곱해집니다.
  const ENEMY = {
    scout:    { hp: 14, r: 22, spd: 215, score: 10, art: 'scout',   fire: { every: 2.3, k: 'aim1' } },
    wasp:     { hp: 8,  r: 15, spd: 340, score: 8,  art: 'wasp' },
    bomber:   { hp: 50, r: 34, spd: 125, score: 26, art: 'bomber',  fire: { every: 1.7, k: 'drop' } },
    sniper:   { hp: 22, r: 23, spd: 270, score: 22, art: 'sniper',  fire: { every: 2.7, k: 'burst3' }, stop: 0.62 },
    kamikaze: { hp: 16, r: 19, spd: 430, score: 18, art: 'kami',    contact: 34 },
    shieldy:  { hp: 44, r: 28, spd: 155, score: 30, art: 'shield',  fire: { every: 2.5, k: 'spread3' }, front: true },
    turret:   { hp: 58, r: 30, spd: 175, score: 34, art: 'turret',  fire: { every: 1.6, k: 'radial8' }, stop: 0.70 },
    splitter: { hp: 36, r: 31, spd: 185, score: 24, art: 'split',   split: 'splitlet' },
    splitlet: { hp: 10, r: 17, spd: 300, score: 6,  art: 'splitlet' },
    healer:   { hp: 32, r: 24, spd: 195, score: 38, art: 'healer',  heal: true },
    missiler: { hp: 46, r: 28, spd: 165, score: 34, art: 'missile', fire: { every: 3.1, k: 'homing2' }, stop: 0.66 },
    lancer:   { hp: 54, r: 30, spd: 155, score: 42, art: 'lancer',  fire: { every: 3.6, k: 'beam' },    stop: 0.72 },
    mine:     { hp: 22, r: 26, spd: 75,  score: 12, art: 'mine',    contact: 26 },
  };

  // 지역이 올라가면서 새 적이 합류합니다 (1지역부터 차례로).
  const ROSTER = [
    ['scout', 'wasp', 'bomber'],
    ['scout', 'wasp', 'bomber', 'kamikaze'],
    ['scout', 'wasp', 'bomber', 'sniper', 'kamikaze'],
    ['scout', 'wasp', 'sniper', 'kamikaze', 'mine', 'shieldy'],
    ['wasp', 'bomber', 'sniper', 'shieldy', 'mine', 'turret'],
    ['scout', 'sniper', 'kamikaze', 'shieldy', 'turret', 'splitter'],
    ['wasp', 'bomber', 'shieldy', 'turret', 'splitter', 'missiler'],
    ['sniper', 'shieldy', 'turret', 'splitter', 'missiler', 'mine', 'healer'],
    ['bomber', 'turret', 'splitter', 'missiler', 'healer', 'kamikaze', 'lancer'],
    ['sniper', 'shieldy', 'turret', 'splitter', 'missiler', 'healer', 'lancer', 'kamikaze'],
  ];

  /* ═══════════════════ 보스 10기 ═══════════════════ */
  //  공격은 몇 가지 기본기(radial/spread/aimed/rain/beam/summon/charge/spiral/wall)를
  //  조합해서 만듭니다. 값만 달라도 느낌이 확 달라지므로 10기가 각자 성격을 갖습니다.
  const BOSSES = [
    { key: 'fortress', name: '구름 요새',     art: 'fortress', hp: 8100,  r: 105,
      phases: [
        { at: 1.00, move: 'hover', atk: [{ k: 'spread', every: 1.9, n: 7, arc: 0.9, spd: 250 }, { k: 'summon', every: 7.0, type: 'wasp', n: 3 }] },
        { at: 0.50, move: 'sway',  atk: [{ k: 'radial', every: 2.2, n: 16, spd: 235 }, { k: 'aimed', every: 1.2, n: 3, spd: 330 }] },
      ] },
    { key: 'hive', name: '벌집 모함',         art: 'hive', hp: 11200, r: 112,
      phases: [
        { at: 1.00, move: 'sway',   atk: [{ k: 'summon', every: 3.4, type: 'wasp', n: 5 }, { k: 'aimed', every: 1.6, n: 2, spd: 300 }] },
        { at: 0.55, move: 'charge', atk: [{ k: 'summon', every: 4.2, type: 'kamikaze', n: 3 }, { k: 'spread', every: 1.5, n: 9, arc: 1.4, spd: 270 }] },
      ] },
    { key: 'zeppelin', name: '노을 비행선',   art: 'zeppelin', hp: 14400, r: 120,
      phases: [
        { at: 1.00, move: 'hover', atk: [{ k: 'beam', every: 4.4, warn: 1.1, w: 46 }, { k: 'spread', every: 2.0, n: 5, arc: 0.7, spd: 280 }] },
        { at: 0.60, move: 'sway',  atk: [{ k: 'beam', every: 3.2, warn: 0.9, w: 60 }, { k: 'rain', every: 1.8, n: 6, spd: 240 }] },
        { at: 0.28, move: 'sway',  atk: [{ k: 'radial', every: 1.8, n: 20, spd: 250 }, { k: 'beam', every: 2.8, warn: 0.8, w: 70 }] },
      ] },
    { key: 'batwing', name: '밤의 박쥐폭격기', art: 'batwing', hp: 18000, r: 118,
      phases: [
        { at: 1.00, move: 'sway',   atk: [{ k: 'homing', every: 2.6, n: 2 }, { k: 'rain', every: 1.5, n: 5, spd: 250 }] },
        { at: 0.55, move: 'charge', atk: [{ k: 'homing', every: 2.0, n: 3 }, { k: 'spiral', every: 0.14, n: 2, spd: 235, turn: 0.42 }] },
      ] },
    { key: 'prism', name: '오로라 수정체',    art: 'prism', hp: 22500, r: 108,
      phases: [
        { at: 1.00, move: 'orbit', atk: [{ k: 'wall', every: 2.6, n: 13, gap: 3, spd: 230 }, { k: 'aimed', every: 1.4, n: 3, spd: 340 }] },
        { at: 0.62, move: 'orbit', atk: [{ k: 'spiral', every: 0.12, n: 3, spd: 250, turn: -0.5 }] },
        { at: 0.30, move: 'sway',  atk: [{ k: 'wall', every: 2.0, n: 15, gap: 2, spd: 260 }, { k: 'radial', every: 2.4, n: 24, spd: 220 }] },
      ] },
    { key: 'sandworm', name: '모래 폭풍룡',   art: 'sandworm', hp: 27900, r: 126,
      phases: [
        { at: 1.00, move: 'charge', atk: [{ k: 'spread', every: 1.5, n: 11, arc: 1.6, spd: 280 }] },
        { at: 0.60, move: 'charge', atk: [{ k: 'spiral', every: 0.11, n: 2, spd: 265, turn: 0.6 }, { k: 'summon', every: 6.0, type: 'mine', n: 4 }] },
        { at: 0.28, move: 'sway',   atk: [{ k: 'radial', every: 1.5, n: 22, spd: 260 }, { k: 'aimed', every: 0.9, n: 4, spd: 380 }] },
      ] },
    { key: 'magma', name: '화산 거인',        art: 'magma', hp: 34200, r: 132,
      phases: [
        { at: 1.00, move: 'hover',  atk: [{ k: 'rain', every: 1.1, n: 7, spd: 270 }, { k: 'aimed', every: 1.8, n: 3, spd: 340 }] },
        { at: 0.62, move: 'sway',   atk: [{ k: 'beam', every: 3.0, warn: 0.85, w: 78 }, { k: 'rain', every: 1.0, n: 8, spd: 290 }] },
        { at: 0.30, move: 'charge', atk: [{ k: 'radial', every: 1.4, n: 26, spd: 270 }, { k: 'summon', every: 5.5, type: 'kamikaze', n: 3 }] },
      ] },
    { key: 'icequeen', name: '빙하 여왕',     art: 'icequeen', hp: 39600, r: 122,
      phases: [
        { at: 1.00, move: 'sway',  atk: [{ k: 'wall', every: 2.2, n: 15, gap: 2, spd: 250 }, { k: 'split', every: 2.8, n: 5, spd: 260, at: 0.55 }] },
        { at: 0.60, move: 'orbit', atk: [{ k: 'spiral', every: 0.10, n: 3, spd: 260, turn: 0.55 }, { k: 'homing', every: 3.0, n: 2 }] },
        { at: 0.28, move: 'sway',  atk: [{ k: 'radial', every: 1.3, n: 28, spd: 265 }, { k: 'split', every: 2.2, n: 7, spd: 280, at: 0.5 }] },
      ] },
    { key: 'interceptor', name: '성층권 요격기', art: 'interceptor', hp: 46800, r: 112,
      phases: [
        { at: 1.00, move: 'charge', atk: [{ k: 'aimed', every: 0.9, n: 3, spd: 420 }, { k: 'summon', every: 6.5, type: 'sniper', n: 2 }] },
        { at: 0.62, move: 'charge', atk: [{ k: 'clone', every: 8.0 }, { k: 'spread', every: 1.2, n: 9, arc: 1.2, spd: 320 }] },
        { at: 0.30, move: 'orbit',  atk: [{ k: 'spiral', every: 0.09, n: 4, spd: 290, turn: -0.62 }, { k: 'beam', every: 3.4, warn: 0.7, w: 66 }] },
      ] },
    { key: 'motherstar', name: '우주 모함 오리온', art: 'motherstar', hp: 63000, r: 142,
      phases: [
        { at: 1.00, move: 'hover',  atk: [{ k: 'wall', every: 2.4, n: 17, gap: 3, spd: 250 }, { k: 'summon', every: 5.0, type: 'turret', n: 2 }] },
        { at: 0.72, move: 'sway',   atk: [{ k: 'spiral', every: 0.10, n: 3, spd: 270, turn: 0.5 }, { k: 'homing', every: 2.4, n: 3 }] },
        { at: 0.46, move: 'charge', atk: [{ k: 'beam', every: 2.6, warn: 0.75, w: 84 }, { k: 'rain', every: 1.0, n: 8, spd: 300 }] },
        { at: 0.20, move: 'orbit',  atk: [{ k: 'radial', every: 1.2, n: 30, spd: 280 }, { k: 'aimed', every: 0.8, n: 5, spd: 420 }, { k: 'summon', every: 7.0, type: 'kamikaze', n: 4 }] },
      ] },
  ];

  /* ═══════════════════ 무기 ═══════════════════ */
  //  5단계까지 올라갑니다. dmg 는 한 발당 피해.
  const GUNS = [
    null,
    { cd: 0.170, shots: [{ a: 0, dy: 0, dmg: 13, big: 1 }] },
    { cd: 0.170, shots: [{ a: 0, dy: -9, dmg: 11, big: 1 }, { a: 0, dy: 9, dmg: 11, big: 1 }] },
    { cd: 0.180, shots: [{ a: 0, dy: 0, dmg: 15, big: 2 }, { a: -0.10, dy: -10, dmg: 11, big: 1 }, { a: 0.10, dy: 10, dmg: 11, big: 1 }] },
    { cd: 0.180, shots: [{ a: 0, dy: -6, dmg: 16, big: 2 }, { a: 0, dy: 6, dmg: 16, big: 2 },
                         { a: -0.16, dy: -14, dmg: 11, big: 1 }, { a: 0.16, dy: 14, dmg: 11, big: 1 }] },
    { cd: 0.190, shots: [{ a: 0, dy: 0, dmg: 26, big: 2, pierce: 1 },
                         { a: -0.09, dy: -9, dmg: 17, big: 2 }, { a: 0.09, dy: 9, dmg: 17, big: 2 },
                         { a: -0.26, dy: -18, dmg: 12, big: 1 }, { a: 0.26, dy: 18, dmg: 12, big: 1 },
                         { a: Math.PI, dy: 0, dmg: 10, big: 1 }] },
  ];
  const GUN_MAX = 5;
  const BULLET_SPD = 1500;          // 빠를수록 화면에 깔리는 총알이 줄어듭니다

  const PICKUPS = ['pow', 'heal', 'bomb', 'shield', 'star'];

  /* ═══════════════════ 단계 설계 ═══════════════════ */
  //  같은 단계는 언제나 똑같이 나옵니다(시드 고정) — 아이들이 패턴을 익힐 수 있게.
  function stagePlan(n) {
    n = clamp(n | 0, 1, TOTAL_STAGES);
    const zone = Math.min(9, Math.floor((n - 1) / 10));
    const isBoss = n % 10 === 0;
    const rng = mulberry32(0x5ca1ab1e ^ Math.imul(n, 2654435761));
    const tier = (n - 1) / (TOTAL_STAGES - 1);         // 0 … 1
    const hpMul = 1 + (n - 1) * 0.085;                 // 100단계에서 약 9.4배
    const spdMul = 1 + tier * 0.55;
    const fireMul = 1 - tier * 0.42;                   // 발사 간격이 짧아짐
    const pool = ROSTER[zone];
    const forms = ['line', 'v', 'sine', 'arc', 'rush', 'wall', 'zigzag', 'swarm', 'split', 'corner'];

    const waves = [];
    const waveN = isBoss ? 2 : 4 + Math.floor((n % 10) / 3);   // 4~7
    let lastType = null, lastForm = null;
    for (let i = 0; i < waveN; i++) {
      // 바로 앞 웨이브와는 다른 적·다른 대열이 나오게 합니다 (같은 게 이어지면 지루합니다)
      const tPool = pool.filter((t) => t !== lastType);
      const type = tPool[Math.floor(rng() * tPool.length)];
      const fPool = forms.filter((f) => f !== lastForm);
      const form = fPool[Math.floor(rng() * fPool.length)];
      lastType = type; lastForm = form;
      const base = ENEMY[type];
      let count = 6 + Math.floor(rng() * 5) + Math.floor(tier * 7);
      if (base.hp >= 40) count = Math.max(3, Math.round(count * 0.55));
      if (type === 'mine') count = Math.max(3, Math.round(count * 0.5));   // 기뢰는 느려서 화면에 쌓입니다
      if (type === 'wasp') count = Math.round(count * 1.5);
      waves.push({
        type, form, count,
        hp: Math.max(1, Math.round(base.hp * hpMul * (isBoss ? 0.7 : 1))),
        spd: base.spd * spdMul,
        fire: Math.max(0.4, (base.fire ? base.fire.every : 99) * fireMul),
        gap: Math.max(0.14, (0.34 - tier * 0.15) * (type === 'wasp' ? 0.6 : 1)),
      });
    }
    const plan = { n, zone, isBoss, waves, tier };
    if (isBoss) {
      const b = BOSSES[zone];
      plan.boss = { key: b.key, hp: Math.round(b.hp), fire: Math.max(0.5, fireMul + 0.15) };
    }
    return plan;
  }

  // 대열 만들기 — 등장 위치·경로를 정해 줍니다.
  function buildSpawns(w, rng) {
    const out = [];
    const N = w.count;
    const x0 = FIELD.w + 70;
    for (let i = 0; i < N; i++) {
      const f = N === 1 ? 0.5 : i / (N - 1);
      let x = x0, y = 140 + f * (FIELD.h - 280), delay = i * w.gap, pat = 'straight', amp = 0, per = 1, hold = 0;
      switch (w.form) {
        case 'line':   break;
        case 'v':      x = x0 + Math.abs(f - 0.5) * 260; break;
        case 'sine':   pat = 'sine'; amp = 90 + rng() * 70; per = 1.6 + rng() * 1.2; y = 200 + f * (FIELD.h - 400); break;
        case 'arc':    x = x0 + Math.sin(f * Math.PI) * 240; pat = 'sine'; amp = 50; per = 2.4; break;
        case 'rush':   y = 150 + rng() * (FIELD.h - 300); delay = i * w.gap * 0.55; pat = 'dive'; break;
        case 'wall':   delay = Math.floor(i / 2) * w.gap * 1.6; y = 120 + f * (FIELD.h - 240); break;
        case 'zigzag': pat = 'zig'; amp = 150; per = 1.1; y = 200 + f * (FIELD.h - 400); break;
        case 'swarm':  x = x0 + rng() * 320; y = 130 + rng() * (FIELD.h - 260); delay = i * w.gap * 0.7; pat = 'sine'; amp = 60 + rng() * 60; per = 1.2 + rng(); break;
        case 'split':  y = i % 2 === 0 ? 150 + (f * 0.5) * (FIELD.h - 300) : FIELD.h - 150 - (f * 0.5) * (FIELD.h - 300); break;
        case 'corner': y = i % 2 === 0 ? 130 : FIELD.h - 130; x = x0 + (i % 4) * 90; pat = 'sine'; amp = 40; per = 3; break;
      }
      const def = ENEMY[w.type];
      // 멈춰서 쏘는 적들이 전부 같은 x 에 서면 화면을 가로막는 벽이 됩니다.
      // 기체마다 서는 자리를 조금씩 다르게 해서 앞뒤로 흩어지게 합니다.
      if (def.stop) { pat = 'stop'; hold = def.stop + ((i % 4) - 1.5) * 0.055; }
      if (w.type === 'kamikaze') pat = 'home';
      if (w.type === 'mine') pat = 'drift';
      out.push({ x, y: clamp(y, 90, FIELD.h - 90), delay, pat, amp, per, hold });
    }
    return out;
  }

  /* ═══════════════════ 게임 ═══════════════════ */
  class Game {
    constructor(opts) {
      opts = opts || {};
      this.tick = 0;
      this.stage = clamp(opts.stage || 1, 1, TOTAL_STAGES);
      this.players = new Map();
      this.enemies = [];
      this.bullets = [];
      this.beams = [];
      this.pickups = [];
      this.boss = null;
      this.fx = [];
      this.newBullets = [];
      this.deadBullets = [];
      this.nid = 1;
      this.score = 0;
      this.rng = mulberry32(opts.seed || 12345);
      this.phase = 'idle';
      this.phT = 0;
      this.plan = null;
      this.dmgMul = 1;             // startStage 에서 단계에 맞게 다시 정합니다
      this.waveIdx = 0;
      this.waveT = 0;
      this.spawnQ = [];
      this.banner = '';
      this.best = opts.best || 1;   // 이 방이 밟아 본 가장 높은 단계
      this.log = [];                // 마지막 스테이지 결과 (클리어 화면용)
    }

    // ── 사람 관리 ──
    addPlayer(id, name, color) {
      if (this.players.size >= MAX_PLAYERS) return null;
      const slot = this.players.size;
      const p = {
        id, name: (name || '조종사').slice(0, 8), color: color || 0,
        x: 170 + (slot % 2) * 60, y: 180 + slot * 120, tx: 170, ty: 180 + slot * 120,
        hp: P_MAXHP, lives: P_LIVES, gun: 1, bombs: BOMB_START,
        down: false, downT: 0, revT: 0, invT: SPAWN_INV, shieldT: 0,
        fireCd: 0, score: 0, kills: 0, deaths: 0, ang: 0, alive: true, joinT: 0,
      };
      p.y = clamp(p.y, 120, FIELD.h - 120); p.ty = p.y;
      this.players.set(id, p);
      if (this.phase === 'idle') this.startStage(this.stage);
      return p;
    }
    removePlayer(id) {
      this.players.delete(id);
      if (this.players.size === 0) { this.phase = 'idle'; this.clearField(); }
    }
    setInput(id, inp) {
      const p = this.players.get(id);
      if (!p) return;
      if (typeof inp.tx === 'number' && isFinite(inp.tx)) p.tx = clamp(inp.tx, 0, FIELD.w);
      if (typeof inp.ty === 'number' && isFinite(inp.ty)) p.ty = clamp(inp.ty, 0, FIELD.h);
      if (inp.bomb) this.useBomb(p);
    }
    alivePlayers() { const a = []; for (const p of this.players.values()) if (!p.down) a.push(p); return a; }

    clearField() {
      this.enemies.length = 0; this.beams.length = 0; this.pickups.length = 0; this.boss = null;
      for (const b of this.bullets) this.deadBullets.push(b.id);
      this.bullets.length = 0;
    }

    // ── 스테이지 흐름 ──
    startStage(n) {
      this.stage = clamp(n, 1, TOTAL_STAGES);
      this.best = Math.max(this.best, this.stage);
      this.plan = stagePlan(this.stage);
      this.dmgMul = 0.55 + this.plan.tier * 0.75;
      this.rng = mulberry32(0xa53 ^ Math.imul(this.stage, 40503));
      this.waveIdx = 0; this.waveT = 0; this.spawnQ = [];
      this.clearField();
      this.phase = 'ready'; this.phT = READY_SEC;
      this.stageKills = 0; this.stageScore0 = this.score;
      for (const p of this.players.values()) {
        p.down = false; p.downT = 0; p.revT = 0;
        p.hp = P_MAXHP; p.invT = SPAWN_INV;
        p.x = 150; p.y = clamp(p.y, 120, FIELD.h - 120);
      }
      this.fx.push({ t: 'stage', n: this.stage });
    }
    nextWave() {
      if (!this.plan) return;
      if (this.waveIdx >= this.plan.waves.length) {
        if (this.plan.isBoss && !this.boss) this.spawnBoss();
        return;
      }
      const base = this.plan.waves[this.waveIdx++];
      // 사람이 많으면 적도 그만큼 더 나옵니다. 체력만 올리면 "안 죽는 적"이 되지만
      // 수를 늘리면 다섯 명이 각자 쏠 표적이 생겨 훨씬 신납니다.
      // 다만 쏘는 적은 수를 꽉 막아 둡니다 — 스무 기가 동시에 쏘면 탄막이 초등학생이
      // 피할 수 있는 수준을 넘어갑니다.
      const cap = ENEMY[base.type].fire ? 15 : 30;
      const w = Object.assign({}, base, {
        count: Math.min(cap, Math.round(base.count * (0.55 + 0.45 * Math.max(1, this.players.size)))),
      });
      const spawns = buildSpawns(w, this.rng);
      const t0 = 0;
      for (const s of spawns) this.spawnQ.push({ at: t0 + s.delay, w, s });
      this.spawnQ.sort((a, b) => a.at - b.at);
      this.waveT = 0;
      this.waveGiveGun = this.rng() < 0.8;   // 웨이브마다 파워업 하나는 확실히
    }

    spawnEnemy(w, s) {
      const def = ENEMY[w.type];
      const scale = 0.6 + 0.4 * Math.max(1, this.players.size);   // 사람이 많으면 그만큼 단단하게
      const e = {
        id: this.nid++, type: w.type, art: def.art, x: s.x, y: s.y, y0: s.y,
        vx: -w.spd, vy: 0, hp: Math.round(w.hp * scale), maxHp: Math.round(w.hp * scale),
        r: def.r, t: 0, pat: s.pat, amp: s.amp, per: s.per || 1, hold: s.hold || 0,
        fireCd: 0.6 + this.rng() * w.fire, fireEvery: w.fire, ang: Math.PI,
        score: def.score, front: !!def.front, contact: def.contact || 0,
        heal: !!def.heal, split: def.split || null, healCd: 0, burst: 0, flash: 0, boss: false,
      };
      this.enemies.push(e);
      return e;
    }

    spawnBoss() {
      const b = BOSSES[this.plan.zone];
      // 사람이 늘면 화력은 인원수만큼 커지므로 보스 체력도 거의 비례해 올려야
      // "5명이 붙으면 3초 만에 끝나는" 일이 안 생깁니다 (1명 1.0배 → 5명 3.0배)
      const scale = 0.5 + 0.5 * Math.max(1, this.players.size);
      const hp = Math.round(this.plan.boss.hp * scale);
      this.boss = {
        id: this.nid++, key: b.key, name: b.name, art: b.art, boss: true,
        x: FIELD.w + 220, y: FIELD.h / 2, vx: -180, vy: 0,
        hp, maxHp: hp, r: b.r, t: 0, ang: Math.PI, phaseIdx: 0, entering: true,
        cds: [], flash: 0, chargeT: 0, clones: [], fireMul: this.plan.boss.fire,
      };
      this.boss.cds = b.phases[0].atk.map(() => 0.9);
      this.phase = 'boss'; this.phT = 0;
      this.fx.push({ t: 'bosswarn', name: b.name });
    }

    /* ── 한 틱 ── */
    step() {
      this.tick++;
      const dt = DT;
      // 스냅샷을 가져가지 않는 곳(테스트·봇 시뮬레이션)에서 목록이 끝없이 커지지 않게 막습니다.
      // 서버는 매 틱 snapshot() 으로 비우므로 평소엔 이 줄에 걸리지 않습니다.
      if (this.fx.length > 400) this.fx.splice(0, this.fx.length - 400);
      if (this.newBullets.length > 2000) this.newBullets.splice(0, this.newBullets.length - 2000);
      if (this.deadBullets.length > 4000) this.deadBullets.splice(0, this.deadBullets.length - 4000);
      if (this.players.size === 0) { this.phase = 'idle'; return; }

      if (this.phase === 'ready') {
        this.phT -= dt;
        this.stepPlayers(dt);
        if (this.phT <= 0) { this.phase = 'play'; this.phT = 0; this.nextWave(); }
        return;
      }
      if (this.phase === 'clear') {
        this.phT -= dt;
        this.stepPlayers(dt); this.stepBullets(dt); this.stepPickups(dt);
        if (this.phT <= 0) {
          if (this.stage >= TOTAL_STAGES) { this.phase = 'allclear'; this.phT = 0; }
          else this.startStage(this.stage + 1);
        }
        return;
      }
      if (this.phase === 'wipe') {
        this.phT -= dt;
        if (this.phT <= 0) this.startStage(this.stage);
        return;
      }
      if (this.phase === 'allclear') { this.stepPlayers(dt); return; }
      if (this.phase === 'idle') return;

      // play / boss
      this.waveT += dt;
      while (this.spawnQ.length && this.spawnQ[0].at <= this.waveT) {
        const q = this.spawnQ.shift();
        this.spawnEnemy(q.w, q.s);
      }
      this.stepPlayers(dt);
      this.stepEnemies(dt);
      if (this.boss) this.stepBoss(dt);
      this.stepBullets(dt);
      this.stepBeams(dt);
      this.stepPickups(dt);
      this.collide();

      // 웨이브·스테이지 진행 판정
      if (this.phase === 'play' && this.spawnQ.length === 0 && this.enemies.length === 0) {
        if (this.waveIdx >= this.plan.waves.length) {
          if (this.plan.isBoss) { if (!this.boss) this.spawnBoss(); }
          else this.finishStage();
        } else if (this.waveT > 0.9) {
          this.nextWave();
        }
      }
      if (this.phase === 'boss' && !this.boss) this.finishStage();

      // 전멸?
      let anyUp = false;
      for (const p of this.players.values()) if (!p.down) anyUp = true;
      if (!anyUp && this.players.size > 0) {
        this.phase = 'wipe'; this.phT = WIPE_SEC;
        this.clearField();
        this.fx.push({ t: 'wipe' });
        for (const p of this.players.values()) { p.lives = P_LIVES; p.gun = Math.max(1, p.gun - 1); }
      }
    }

    finishStage() {
      this.phase = 'clear'; this.phT = CLEAR_SEC;
      const bonus = 300 + this.stage * 40;
      this.score += bonus;
      this.best = Math.max(this.best, Math.min(TOTAL_STAGES, this.stage + 1));
      this.clearField();
      this.log = { stage: this.stage, bonus, score: this.score };
      this.fx.push({ t: 'clear', stage: this.stage, bonus });
      for (const p of this.players.values()) {
        if (p.down) { p.down = false; p.hp = Math.round(P_MAXHP * 0.6); p.invT = SPAWN_INV; }
        else p.hp = Math.min(P_MAXHP, p.hp + 34);
        if (p.bombs < BOMB_MAX && this.stage % 5 === 0) p.bombs++;
      }
    }

    /* ── 아군 ── */
    stepPlayers(dt) {
      for (const p of this.players.values()) {
        p.joinT += dt;
        if (p.invT > 0) p.invT -= dt;
        if (p.shieldT > 0) p.shieldT -= dt;

        if (p.down) {
          // 낙하산 — 천천히 가라앉습니다
          p.y = clamp(p.y + 42 * dt, 80, FIELD.h - 80);
          p.x = clamp(p.x - 24 * dt, 40, FIELD.w - 40);
          p.downT -= dt;
          // 근처 친구가 있으면 구조 게이지가 찹니다
          let helper = null;
          for (const q of this.players.values()) {
            if (q === p || q.down) continue;
            if (d2(p.x, p.y, q.x, q.y) < REVIVE_R * REVIVE_R) { helper = q; break; }
          }
          if (helper) {
            p.revT += dt;
            if (p.revT >= REVIVE_SEC) { this.revive(p, false); this.fx.push({ t: 'revive', id: p.id, x: p.x, y: p.y }); }
          } else if (p.revT > 0) {
            p.revT = Math.max(0, p.revT - dt * 0.6);
          }
          // 친구가 방금 살렸으면 여기 오지 않습니다(p.down 이 이미 꺼져 있음).
          // 이 검사를 빼먹으면 구조된 순간 downT 가 0 이라 목숨까지 깎였습니다.
          if (p.down && p.downT <= 0) {
            if (p.lives > 0) { p.lives--; this.revive(p, true); }
            else { p.downT = 4; p.revT = 0; }   // 목숨이 없으면 친구만이 살릴 수 있습니다
          }
          continue;
        }

        // 목표 지점으로 이동
        const dx = p.tx - p.x, dy = p.ty - p.y;
        const d = Math.hypot(dx, dy);
        const mx = P_SPEED * dt;
        if (d > 1) {
          const k = Math.min(1, mx / d);
          p.x += dx * k; p.y += dy * k;
          p.ang = clamp(dy * k / (mx || 1), -1, 1) * 0.45;    // 기울기(그림용)
        } else p.ang *= 0.8;
        p.x = clamp(p.x, 26, FIELD.w - 26);
        p.y = clamp(p.y, 26, FIELD.h - 26);

        // 자동 발사 — 아이들이 버튼을 누를 필요가 없습니다
        if (this.phase === 'play' || this.phase === 'boss') {
          p.fireCd -= dt;
          const g = GUNS[clamp(p.gun, 1, GUN_MAX)];
          if (p.fireCd <= 0) {
            p.fireCd = g.cd;
            for (const s of g.shots) {
              const spd = BULLET_SPD;
              this.addBullet({
                x: p.x + 26, y: p.y + (s.dy || 0), vx: Math.cos(s.a) * spd, vy: Math.sin(s.a) * spd,
                r: s.big ? 9 : 6, dmg: s.dmg, own: p.id, kind: s.big === 2 ? 'p3' : s.big ? 'p2' : 'p1',
                pierce: s.pierce || 0, col: p.color,
              });
            }
          }
        }
      }
    }
    revive(p, cost) {
      p.down = false; p.revT = 0; p.downT = 0;
      p.hp = cost ? P_MAXHP * 0.7 : P_MAXHP;
      p.invT = SPAWN_INV;
    }
    hurtPlayer(p, dmg) {
      if (p.down || p.invT > 0) return;
      if (p.shieldT > 0) { p.shieldT = 0; p.invT = 1.2; this.fx.push({ t: 'shatter', x: p.x, y: p.y }); return; }
      // 앞 단계일수록 덜 아픕니다 (1단계 0.55배 → 100단계 1.3배)
      p.hp -= dmg * this.dmgMul;
      p.invT = HIT_INV;
      this.fx.push({ t: 'phit', x: p.x, y: p.y, id: p.id });
      if (p.hp <= 0) {
        p.hp = 0; p.down = true; p.downT = DOWN_SEC; p.revT = 0; p.deaths++;
        p.gun = Math.max(1, p.gun - 1);
        this.fx.push({ t: 'down', x: p.x, y: p.y, id: p.id });
      }
    }
    useBomb(p) {
      if (p.down || p.bombs <= 0) return;
      p.bombs--;
      this.fx.push({ t: 'bomb', x: p.x, y: p.y, id: p.id });
      // 적탄을 지웁니다
      for (let i = this.bullets.length - 1; i >= 0; i--) {
        const b = this.bullets[i];
        if (b.own === -1 && d2(b.x, b.y, p.x, p.y) < BOMB_R * BOMB_R) { this.killBullet(i); }
      }
      this.beams.length = 0;
      // 적에게 큰 피해
      for (let i = this.enemies.length - 1; i >= 0; i--) {
        const e = this.enemies[i];
        if (d2(e.x, e.y, p.x, p.y) < BOMB_R * BOMB_R) this.damageEnemy(i, 120, p);
      }
      if (this.boss && d2(this.boss.x, this.boss.y, p.x, p.y) < (BOMB_R + this.boss.r) * (BOMB_R + this.boss.r)) {
        this.damageBoss(200, p);
      }
    }

    /* ── 총알 ── */
    addBullet(o) {
      const b = {
        id: this.nid++, x: o.x, y: o.y, vx: o.vx, vy: o.vy, r: o.r || 7,
        dmg: o.dmg || 8, own: o.own === undefined ? -1 : o.own, kind: o.kind || 'e1',
        pierce: o.pierce || 0, hom: o.hom || 0, life: o.life || 6, born: this.tick, col: o.col || 0,
      };
      this.bullets.push(b);
      this.newBullets.push(b);
      return b;
    }
    killBullet(i) {
      const b = this.bullets[i];
      if (!b) return;          // 보스를 잡는 순간처럼 목록이 먼저 줄어든 경우
      this.deadBullets.push(b.id);
      this.bullets[i] = this.bullets[this.bullets.length - 1];
      this.bullets.pop();
    }
    stepBullets(dt) {
      for (let i = this.bullets.length - 1; i >= 0; i--) {
        const b = this.bullets[i];
        if (b.hom) {
          // 유도탄 — 가장 가까운 아군을 향해 천천히 돕니다
          const tgt = this.nearestPlayer(b.x, b.y);
          if (tgt) {
            const want = Math.atan2(tgt.y - b.y, tgt.x - b.x);
            const cur = Math.atan2(b.vy, b.vx);
            let d = want - cur;
            while (d > Math.PI) d -= Math.PI * 2;
            while (d < -Math.PI) d += Math.PI * 2;
            const turn = clamp(d, -b.hom * dt, b.hom * dt);
            const sp = Math.hypot(b.vx, b.vy);
            b.vx = Math.cos(cur + turn) * sp; b.vy = Math.sin(cur + turn) * sp;
          }
        }
        b.x += b.vx * dt; b.y += b.vy * dt;
        b.life -= dt;
        if (b.life <= 0 || b.x < -80 || b.x > FIELD.w + 120 || b.y < -80 || b.y > FIELD.h + 80) this.killBullet(i);
      }
    }
    nearestPlayer(x, y) {
      let best = null, bd = Infinity;
      for (const p of this.players.values()) {
        if (p.down) continue;
        const d = d2(x, y, p.x, p.y);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    }

    /* ── 레이저 ── */
    stepBeams(dt) {
      for (let i = this.beams.length - 1; i >= 0; i--) {
        const bm = this.beams[i];
        bm.t -= dt;
        if (bm.state === 'warn' && bm.t <= 0) { bm.state = 'fire'; bm.t = 0.75; }
        else if (bm.state === 'fire') {
          // 판정: 선분에서 일정 거리 안이면 피해
          for (const p of this.players.values()) {
            if (p.down || p.invT > 0) continue;
            const dxp = p.x - bm.x, dyp = p.y - bm.y;
            const proj = dxp * Math.cos(bm.ang) + dyp * Math.sin(bm.ang);
            if (proj < 0 || proj > 2400) continue;
            const perp = Math.abs(-dxp * Math.sin(bm.ang) + dyp * Math.cos(bm.ang));
            if (perp < bm.w / 2 + P_R) this.hurtPlayer(p, 26);   // 무적 시간 덕에 초당 두 번까지만 아픕니다
          }
          if (bm.t <= 0) this.beams.splice(i, 1);
        }
      }
    }

    /* ── 적 ── */
    stepEnemies(dt) {
      for (let i = this.enemies.length - 1; i >= 0; i--) {
        const e = this.enemies[i];
        e.t += dt;
        if (e.flash > 0) e.flash -= dt;

        switch (e.pat) {
          case 'sine':
            e.x += e.vx * dt;
            e.y = e.y0 + Math.sin(e.t * (Math.PI * 2) / e.per) * e.amp;
            break;
          case 'zig': {
            e.x += e.vx * dt;
            const ph = Math.floor(e.t / e.per) % 2;
            e.y += (ph ? 1 : -1) * e.amp * dt * 2.2;
            e.y = clamp(e.y, 70, FIELD.h - 70);
            break;
          }
          case 'dive': {
            e.x += e.vx * 1.25 * dt;
            const tgt = this.nearestPlayer(e.x, e.y);
            if (tgt) e.y += clamp(tgt.y - e.y, -150 * dt, 150 * dt);
            break;
          }
          case 'home': {
            const tgt = this.nearestPlayer(e.x, e.y);
            if (tgt) {
              const a = Math.atan2(tgt.y - e.y, tgt.x - e.x);
              const cur = Math.atan2(e.vy, e.vx);
              let d = a - cur;
              while (d > Math.PI) d -= Math.PI * 2;
              while (d < -Math.PI) d += Math.PI * 2;
              const sp = Math.hypot(e.vx, e.vy) || 300;
              const na = cur + clamp(d, -2.2 * dt, 2.2 * dt);
              e.vx = Math.cos(na) * sp; e.vy = Math.sin(na) * sp;
              e.ang = na;
            }
            e.x += e.vx * dt; e.y += e.vy * dt;
            break;
          }
          case 'drift':
            e.x += e.vx * dt;
            e.y += Math.sin(e.t * 1.3) * 26 * dt;
            break;
          case 'stop': {
            const stopX = FIELD.w * e.hold;
            if (e.x > stopX) e.x += e.vx * dt;
            else e.y += Math.sin(e.t * 1.1) * 60 * dt;
            break;
          }
          default:
            e.x += e.vx * dt;
        }
        if (e.pat !== 'home') e.ang = Math.PI;

        // 수리기 — 주변 적을 회복시킵니다 (먼저 잡아야 하는 적)
        if (e.heal) {
          e.healCd -= dt;
          if (e.healCd <= 0) {
            e.healCd = 1.4;
            for (const o of this.enemies) {
              if (o === e) continue;
              if (d2(o.x, o.y, e.x, e.y) < 300 * 300 && o.hp < o.maxHp) {
                o.hp = Math.min(o.maxHp, o.hp + o.maxHp * 0.14);
                this.fx.push({ t: 'heal', x: o.x, y: o.y });
              }
            }
          }
        }

        // 사격
        const def = ENEMY[e.type];
        if (def.fire && e.x < FIELD.w + 20) {
          e.fireCd -= dt;
          if (e.fireCd <= 0) { e.fireCd = e.fireEvery; this.enemyFire(e, def.fire.k); }
        }

        if (e.x < -120 || e.y < -160 || e.y > FIELD.h + 160) {
          this.enemies[i] = this.enemies[this.enemies.length - 1];
          this.enemies.pop();
        }
      }
    }

    enemyFire(e, kind) {
      const tgt = this.nearestPlayer(e.x, e.y);
      const aim = tgt ? Math.atan2(tgt.y - e.y, tgt.x - e.x) : Math.PI;
      const S = (a, spd, kd, dmg, hom) => this.addBullet({
        x: e.x - 10, y: e.y, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
        r: kd === 'e2' ? 12 : kd === 'em' ? 11 : 8, dmg: dmg || 12, own: -1, kind: kd || 'e1', hom: hom || 0,
      });
      switch (kind) {
        case 'aim1': S(aim, 320, 'e1', 12); break;
        case 'burst3':
          e.burst = 3;
          S(aim, 430, 'e1', 13);
          break;
        case 'drop':
          S(Math.PI * 0.75, 240, 'e2', 16); S(Math.PI * 1.25, 240, 'e2', 16);
          break;
        case 'spread3':
          for (let k = -1; k <= 1; k++) S(aim + k * 0.22, 300, 'e1', 12);
          break;
        case 'radial8': {
          const n = 8, off = e.t * 0.9;
          for (let k = 0; k < n; k++) S(off + k * (Math.PI * 2 / n), 250, 'e1', 11);
          break;
        }
        case 'homing2':
          for (let k = -1; k <= 1; k += 2) S(Math.PI + k * 0.35, 260, 'em', 18, 1.5);
          break;
        case 'beam':
          this.beams.push({ id: this.nid++, x: e.x, y: e.y, ang: aim, w: 40, state: 'warn', t: 0.95 });
          break;
      }
    }

    damageEnemy(i, dmg, byPlayer) {
      const e = this.enemies[i];
      e.hp -= dmg; e.flash = 0.08;
      if (e.hp > 0) return false;
      const gain = e.score * (1 + this.stage * 0.05) | 0;
      this.score += gain;
      if (byPlayer) { byPlayer.score += gain; byPlayer.kills++; }
      this.stageKills = (this.stageKills || 0) + 1;
      this.fx.push({ t: 'boom', x: e.x, y: e.y, s: e.r });
      // 분열기
      if (e.split) {
        for (let k = -1; k <= 1; k += 2) {
          const d = ENEMY[e.split];
          this.enemies.push({
            id: this.nid++, type: e.split, art: d.art, x: e.x, y: e.y + k * 22, y0: e.y + k * 22,
            vx: -d.spd, vy: 0, hp: Math.round(e.maxHp * 0.28), maxHp: Math.round(e.maxHp * 0.28),
            r: d.r, t: 0, pat: 'sine', amp: 55, per: 1.2, hold: 0, fireCd: 99, fireEvery: 99,
            ang: Math.PI, score: d.score, front: false, contact: 0, heal: false, split: null,
            healCd: 0, burst: 0, flash: 0, boss: false,
          });
        }
      }
      this.maybeDrop(e.x, e.y);
      this.enemies[i] = this.enemies[this.enemies.length - 1];
      this.enemies.pop();
      return true;
    }

    maybeDrop(x, y) {
      let r = this.rng();
      let type = null;
      if (this.waveGiveGun) { type = 'pow'; this.waveGiveGun = false; }
      else if (r < 0.045) type = 'pow';
      else if (r < 0.10) type = 'heal';
      else if (r < 0.125) type = 'bomb';
      else if (r < 0.15) type = 'shield';
      else if (r < 0.22) type = 'star';
      if (!type) return;
      this.pickups.push({ id: this.nid++, type, x, y, vx: -85, vy: 0, t: 0 });
    }
    stepPickups(dt) {
      for (let i = this.pickups.length - 1; i >= 0; i--) {
        const k = this.pickups[i];
        k.t += dt;
        k.x += k.vx * dt; k.y += Math.sin(k.t * 2.2) * 34 * dt;
        // 가까운 아군에게 살짝 끌려갑니다 (아이들이 놓치지 않게)
        const p = this.nearestPlayer(k.x, k.y);
        if (p && d2(k.x, k.y, p.x, p.y) < 210 * 210) {
          const a = Math.atan2(p.y - k.y, p.x - k.x);
          k.x += Math.cos(a) * 210 * dt; k.y += Math.sin(a) * 210 * dt;
        }
        if (k.x < -60 || k.t > 14) { this.pickups.splice(i, 1); continue; }
        if (p && d2(k.x, k.y, p.x, p.y) < 44 * 44) {
          this.grab(p, k.type);
          this.pickups.splice(i, 1);
        }
      }
    }
    grab(p, type) {
      switch (type) {
        case 'pow':
          if (p.gun < GUN_MAX) { p.gun++; this.fx.push({ t: 'lvup', id: p.id, x: p.x, y: p.y, lv: p.gun }); }
          else { p.score += 500; this.score += 500; }
          break;
        case 'heal': p.hp = Math.min(P_MAXHP, p.hp + 40); break;
        case 'bomb': p.bombs = Math.min(BOMB_MAX, p.bombs + 1); break;
        case 'shield': p.shieldT = 9; break;
        case 'star': p.score += 300; this.score += 300; break;
      }
      this.fx.push({ t: 'grab', x: p.x, y: p.y, k: type, id: p.id });
    }

    /* ── 보스 ── */
    stepBoss(dt) {
      const B = this.boss, def = BOSSES[this.plan.zone];
      B.t += dt;
      if (B.flash > 0) B.flash -= dt;

      if (B.entering) {
        B.x += B.vx * dt;
        if (B.x <= FIELD.w - 260) { B.x = FIELD.w - 260; B.entering = false; B.vx = 0; }
        return;
      }

      // 페이즈 전환
      const frac = B.hp / B.maxHp;
      let pi = 0;
      for (let i = 0; i < def.phases.length; i++) if (frac <= def.phases[i].at) pi = i;
      if (pi !== B.phaseIdx) {
        B.phaseIdx = pi;
        B.cds = def.phases[pi].atk.map((a, i) => 0.6 + i * 0.3);
        this.fx.push({ t: 'bossphase', n: pi + 1, x: B.x, y: B.y });
      }
      const ph = def.phases[B.phaseIdx];

      // 움직임
      switch (ph.move) {
        case 'hover':
          B.y = FIELD.h / 2 + Math.sin(B.t * 0.75) * (FIELD.h * 0.3);
          B.x = FIELD.w - 260 + Math.sin(B.t * 0.5) * 40;
          break;
        case 'sway':
          B.y = FIELD.h / 2 + Math.sin(B.t * 1.15) * (FIELD.h * 0.34);
          B.x = FIELD.w - 280 + Math.cos(B.t * 0.7) * 120;
          break;
        case 'orbit':
          B.x = FIELD.w - 330 + Math.cos(B.t * 0.85) * 190;
          B.y = FIELD.h / 2 + Math.sin(B.t * 1.7) * (FIELD.h * 0.3);
          break;
        case 'charge': {
          B.chargeT -= dt;
          if (B.chargeT <= 0) {
            const tgt = this.nearestPlayer(B.x, B.y);
            if (tgt && !B.dash) { B.dash = { x: tgt.x + 120, y: tgt.y, t: 1.5 }; }
            B.chargeT = 4.2;
          }
          if (B.dash) {
            B.dash.t -= dt;
            const a = Math.atan2(B.dash.y - B.y, B.dash.x - B.x);
            const sp = 430;
            B.x += Math.cos(a) * sp * dt; B.y += Math.sin(a) * sp * dt;
            if (B.dash.t <= 0 || d2(B.x, B.y, B.dash.x, B.dash.y) < 60 * 60) B.dash = null;
          } else {
            B.x += (FIELD.w - 280 - B.x) * 1.2 * dt;
            B.y += Math.sin(B.t * 1.0) * 90 * dt;
          }
          break;
        }
      }
      // 몸집이 큰 보스가 화면 밖으로 나가거나 위쪽 표시줄을 가리지 않게 반경만큼 여유를 둡니다
      B.x = clamp(B.x, 420, FIELD.w - B.r * 0.85);
      B.y = clamp(B.y, 110 + B.r * 0.6, FIELD.h - B.r * 0.75);

      // 공격
      for (let i = 0; i < ph.atk.length; i++) {
        B.cds[i] -= dt;
        if (B.cds[i] > 0) continue;
        const a = ph.atk[i];
        B.cds[i] = a.every * B.fireMul;
        this.bossAttack(B, a);
      }

      // 몸통 충돌
      for (const p of this.players.values()) {
        if (p.down || p.invT > 0) continue;
        const rr = B.r * 0.72 + P_R;
        if (d2(p.x, p.y, B.x, B.y) < rr * rr) this.hurtPlayer(p, 34);
      }
    }

    bossAttack(B, a) {
      const tgt = this.nearestPlayer(B.x, B.y);
      const aim = tgt ? Math.atan2(tgt.y - B.y, tgt.x - B.x) : Math.PI;
      const S = (ang, spd, kd, dmg, hom) => this.addBullet({
        x: B.x - 30, y: B.y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
        r: kd === 'e2' ? 13 : kd === 'em' ? 12 : 9, dmg: dmg || 14, own: -1, kind: kd || 'e1', hom: hom || 0, life: 9,
      });
      switch (a.k) {
        case 'radial': {
          const off = B.t * 0.7;
          for (let k = 0; k < a.n; k++) S(off + k * (Math.PI * 2 / a.n), a.spd, 'e1', 13);
          break;
        }
        case 'spread':
          for (let k = 0; k < a.n; k++) S(aim + (k / (a.n - 1) - 0.5) * a.arc, a.spd, 'e1', 13);
          break;
        case 'aimed':
          for (let k = 0; k < a.n; k++) S(aim + (k - (a.n - 1) / 2) * 0.09, a.spd, 'e1', 14);
          break;
        case 'rain':
          for (let k = 0; k < a.n; k++) {
            const y = 60 + (FIELD.h - 120) * (k + 0.5) / a.n;
            this.addBullet({ x: FIELD.w - 40, y, vx: -a.spd, vy: (this.rng() - 0.5) * 60, r: 10, dmg: 13, own: -1, kind: 'e2', life: 9 });
          }
          break;
        case 'wall': {
          const gapAt = Math.floor(this.rng() * a.n);
          for (let k = 0; k < a.n; k++) {
            if (k >= gapAt && k < gapAt + a.gap) continue;
            const y = 50 + (FIELD.h - 100) * k / (a.n - 1);
            this.addBullet({ x: FIELD.w - 30, y, vx: -a.spd, vy: 0, r: 11, dmg: 14, own: -1, kind: 'e2', life: 9 });
          }
          break;
        }
        case 'spiral': {
          B.spiralA = (B.spiralA || 0) + a.turn;
          for (let k = 0; k < a.n; k++) S(B.spiralA + k * (Math.PI * 2 / a.n), a.spd, 'e1', 12);
          break;
        }
        case 'homing':
          for (let k = 0; k < a.n; k++) S(Math.PI + (k - (a.n - 1) / 2) * 0.4, 250, 'em', 20, 1.4);
          break;
        case 'beam':
          this.beams.push({ id: this.nid++, x: B.x, y: B.y, ang: aim, w: a.w, state: 'warn', t: a.warn });
          break;
        case 'split':
          for (let k = 0; k < a.n; k++) {
            const b = S(aim + (k / Math.max(1, a.n - 1) - 0.5) * 1.0, a.spd, 'e2', 12);
            b.splitAt = a.at; b.splitT = 0.9;
          }
          break;
        case 'summon': {
          const d = ENEMY[a.type];
          for (let k = 0; k < a.n; k++) {
            const y = clamp(B.y + (k - (a.n - 1) / 2) * 90, 80, FIELD.h - 80);
            this.enemies.push({
              id: this.nid++, type: a.type, art: d.art, x: B.x - 40, y, y0: y,
              vx: -d.spd, vy: 0, hp: Math.round(d.hp * (1 + this.stage * 0.08)), maxHp: Math.round(d.hp * (1 + this.stage * 0.08)),
              r: d.r, t: 0, pat: a.type === 'kamikaze' ? 'home' : 'sine', amp: 60, per: 1.5, hold: d.stop || 0,
              fireCd: 1.5, fireEvery: 2.2, ang: Math.PI, score: d.score, front: !!d.front,
              contact: d.contact || 0, heal: !!d.heal, split: d.split || null, healCd: 0, burst: 0, flash: 0, boss: false,
            });
          }
          break;
        }
        case 'clone':
          this.fx.push({ t: 'clone', x: B.x, y: B.y });
          for (let k = -1; k <= 1; k += 2) {
            for (let j = 0; j < 6; j++) S(Math.PI + k * 0.5 + j * 0.12, 300, 'e1', 12);
          }
          break;
      }
    }

    damageBoss(dmg, byPlayer) {
      const B = this.boss;
      if (!B || B.entering) return false;
      B.hp -= dmg; B.flash = 0.1;
      if (B.hp > 0) return false;
      const gain = 2000 + this.stage * 120;
      this.score += gain;
      if (byPlayer) { byPlayer.score += gain; byPlayer.kills++; }
      this.fx.push({ t: 'bossdown', x: B.x, y: B.y, r: B.r });
      // 보상: 모두 회복 + 폭탄
      for (const p of this.players.values()) {
        p.hp = P_MAXHP; p.bombs = Math.min(BOMB_MAX, p.bombs + 1);
        if (p.gun < GUN_MAX) p.gun++;
      }
      this.boss = null;
      this.beams.length = 0;
      for (let i = this.bullets.length - 1; i >= 0; i--) if (this.bullets[i].own === -1) this.killBullet(i);
      return true;
    }

    /* ── 충돌 ── */
    collide() {
      // 아군탄 → 적
      for (let i = this.bullets.length - 1; i >= 0; i--) {
        // 보스를 잡으면 damageBoss 가 적탄을 한꺼번에 지웁니다 → 목록이 줄어든 뒤의 빈 자리를 건너뜁니다
        if (i >= this.bullets.length) continue;
        const b = this.bullets[i];
        if (b.own === -1) {
          // 분열탄
          if (b.splitAt) {
            b.splitT -= DT;
            if (b.splitT <= 0) {
              const sp = Math.hypot(b.vx, b.vy) * b.splitAt + 120;
              const base = Math.atan2(b.vy, b.vx);
              for (let k = -1; k <= 1; k++) if (k !== 0 || true) {
                this.addBullet({ x: b.x, y: b.y, vx: Math.cos(base + k * 0.5) * sp, vy: Math.sin(base + k * 0.5) * sp, r: 8, dmg: 11, own: -1, kind: 'e1', life: 5 });
              }
              this.killBullet(i);
              continue;
            }
          }
          continue;
        }
        const p = this.players.get(b.own);
        let hit = false;
        for (let j = this.enemies.length - 1; j >= 0; j--) {
          const e = this.enemies[j];
          const rr = e.r + b.r;
          if (d2(b.x, b.y, e.x, e.y) > rr * rr) continue;
          // 방패기는 앞(오른쪽에서 오는 정면)에서는 안 맞습니다
          if (e.front && b.vx > 0 && Math.abs(b.y - e.y) < e.r * 0.75) {
            this.fx.push({ t: 'guard', x: e.x - e.r, y: b.y });
            hit = true; break;
          }
          this.damageEnemy(j, b.dmg, p);
          this.fx.push({ t: 'hit', x: b.x, y: b.y });
          hit = true;
          break;
        }
        if (!hit && this.boss) {
          const B = this.boss, rr = B.r * 0.8 + b.r;
          if (!B.entering && d2(b.x, b.y, B.x, B.y) < rr * rr) {
            this.damageBoss(b.dmg, p);
            this.fx.push({ t: 'hit', x: b.x, y: b.y });
            hit = true;
          }
        }
        if (hit) {
          if (b.pierce > 0) { b.pierce--; }
          else this.killBullet(i);
        }
      }
      // 적탄 → 아군
      for (let i = this.bullets.length - 1; i >= 0; i--) {
        if (i >= this.bullets.length) continue;
        const b = this.bullets[i];
        if (b.own !== -1) continue;
        for (const p of this.players.values()) {
          if (p.down || p.invT > 0) continue;
          const rr = P_R + b.r * 0.8;
          if (d2(b.x, b.y, p.x, p.y) > rr * rr) continue;
          this.hurtPlayer(p, b.dmg);
          this.killBullet(i);
          break;
        }
      }
      // 적 몸통 → 아군
      for (let j = this.enemies.length - 1; j >= 0; j--) {
        const e = this.enemies[j];
        for (const p of this.players.values()) {
          if (p.down || p.invT > 0) continue;
          const rr = e.r * 0.8 + P_R;
          if (d2(e.x, e.y, p.x, p.y) > rr * rr) continue;
          this.hurtPlayer(p, e.contact || CONTACT_DMG);
          if (e.contact) this.damageEnemy(j, 9999, null);
          break;
        }
      }
    }

    /* ── 화면에 보낼 상태 ── */
    snapshot(full) {
      const P = [];
      for (const p of this.players.values()) {
        P.push([p.id, R1(p.x), R1(p.y), R1(p.hp), p.gun, p.invT > 0 ? 1 : 0, p.down ? 1 : 0,
                R1(p.revT / REVIVE_SEC * 100), p.bombs, p.score, p.lives, R1(p.ang * 100),
                p.shieldT > 0 ? 1 : 0, R1(p.downT)]);
      }
      const E = [];
      for (const e of this.enemies) E.push([e.id, e.art, R1(e.x), R1(e.y), R1(e.hp), R1(e.maxHp), R1(e.ang * 100), e.flash > 0 ? 1 : 0]);
      const K = [];
      for (const k of this.pickups) K.push([k.id, k.type, R1(k.x), R1(k.y)]);
      const BM = [];
      for (const b of this.beams) BM.push([b.id, R1(b.x), R1(b.y), R1(b.ang * 100), b.w, b.state === 'fire' ? 1 : 0, Math.round(b.t * 100)]);
      const HB = [];
      for (const b of this.bullets) if (b.hom || full) HB.push([b.id, R1(b.x), R1(b.y), R1(Math.atan2(b.vy, b.vx) * 100), b.kind]);

      const s = {
        t: this.tick, ph: this.phase, phT: Math.round(this.phT * 10) / 10,
        st: this.stage, zone: this.plan ? this.plan.zone : 0, sc: this.score,
        wv: this.waveIdx, wvN: this.plan ? this.plan.waves.length : 0,
        P, E, K, BM, HB,
        Bn: this.newBullets.filter((b) => !b.hom).map((b) => [b.id, R1(b.x), R1(b.y), R1(b.vx), R1(b.vy), b.kind, b.born, b.col]),
        Bd: this.deadBullets.slice(),
        X: this.fx.slice(),
        B: this.boss ? [this.boss.art, R1(this.boss.x), R1(this.boss.y), R1(this.boss.hp), R1(this.boss.maxHp),
                        this.boss.name, this.boss.flash > 0 ? 1 : 0, this.boss.phaseIdx, this.boss.entering ? 1 : 0] : null,
      };
      this.newBullets.length = 0;
      this.deadBullets.length = 0;
      this.fx.length = 0;
      return s;
    }
  }

  return {
    VERSION, FIELD, TICK_MS, DT, MAX_PLAYERS, TOTAL_STAGES,
    ZONES, ENEMY, BOSSES, GUNS, GUN_MAX, PICKUPS, ROSTER,
    P_MAXHP, P_LIVES, P_R, BOMB_MAX, REVIVE_SEC, DOWN_SEC, HIT_INV, CONTACT_DMG,
    Game, stagePlan, buildSpawns, mulberry32, clamp,
  };
})();

// CommonJS 내보내기(module.exports)는 두지 않습니다. 이 파일은 <script> 로도 읽히고
// 워커에서는 ES 모듈 안에 그대로 심기는데, 후자에서 esbuild 가 "module 은 전역이라
// 뜻대로 안 될 수 있다"고 경고합니다. 저장소에 Node 로 이 파일을 읽는 곳도 없습니다.
`;
