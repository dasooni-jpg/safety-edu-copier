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
  const VERSION = 3;               // 2: 보조기·차지샷·메달 / 3: 기체 6종·지상 목표물·부품 보스·결과 화면

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
  const CLEAR_SEC = 6.5;            // 결과 화면을 읽을 시간
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

  // ── 보조기(윙맨) — 무기 Lv2부터 한 대씩, 최대 4대가 뒤에서 따라 쏩니다 ──
  const WING = [[-30, -52], [-30, 52], [-60, -96], [-60, 96]];
  const WING_CD = 0.26;
  const WING_DMG = 8;
  const wingCount = (gun) => clamp(gun - 1, 0, 4);

  // ── 차지샷 — 게이지가 저절로 차고, 버튼을 누르면 한 번에 뚫고 나가는 큰 포탄 ──
  const CHARGE_SEC = 2.2;           // 한 칸 차는 시간
  const CHARGE_MAX = 3;
  const CHARGE_DMG = [0, 90, 190, 330];

  // ── 기체 6종 — 비행기 색(0~5)마다 무기 성격과 차지샷이 다릅니다 ──
  //  spread: 퍼짐 배율, dmg: 피해 배율, cd: 발사 간격 배율, pierce: 관통 추가, life: 사거리(초), bombs: 폭탄 추가
  const SHIP_TYPES = [
    { key: 'balance', name: '하늘매',     desc: '균형형 · 차지: 거대 포탄',       spread: 1,    dmg: 1,    cd: 1,    pierce: 0, life: 6,   bombs: 0, charge: 'orb' },
    { key: 'spread',  name: '노을부채',   desc: '넓게 퍼짐 · 차지: 부채꼴 포탄', spread: 1.9,  dmg: 0.82, cd: 1,    pierce: 0, life: 6,   bombs: 0, charge: 'fan' },
    { key: 'lance',   name: '숲창',       desc: '곧게 관통 · 차지: 관통 창',      spread: 0.35, dmg: 0.95, cd: 1,    pierce: 1, life: 6,   bombs: 0, charge: 'lance' },
    { key: 'rapid',   name: '보라벌',     desc: '빠른 연사 · 차지: 유도 미사일',  spread: 1,    dmg: 0.72, cd: 0.7,  pierce: 0, life: 6,   bombs: 0, charge: 'missile' },
    { key: 'heavy',   name: '분홍망치',   desc: '짧고 강함 · 차지: 사방 충격파',  spread: 1.2,  dmg: 1.55, cd: 1,    pierce: 0, life: 0.5, bombs: 0, charge: 'nova' },
    { key: 'bomber',  name: '금빛독수리', desc: '폭탄 +1 · 차지: 융단 폭격',     spread: 1,    dmg: 0.9,  cd: 1,    pierce: 0, life: 6,   bombs: 1, charge: 'carpet' },
  ];
  const shipType = (color) => SHIP_TYPES[((color | 0) % 6 + 6) % 6];

  // ── 지형 — 화면과 서버가 똑같은 땅을 보도록 여기서 계산합니다 ──
  //  땅은 초당 GROUND_SPEED 만큼 왼쪽으로 흐르고, 가로로 FIELD.w 마다 되풀이됩니다.
  const TERRAIN_W = 800, TERRAIN_H = 450;      // 지형 격자(화면의 절반 해상도)
  const GROUND_SPEED = 130;
  const TERRAIN = {
    dawn: { sea: 0.555, shift: -0.03 }, cloud: { sea: 0.555, shift: -0.06 }, sunset: {}, night: { sea: 0.43 },
    aurora: { lake: 0.36 }, desert: { lake: 0.24 }, volcano: {}, glacier: { sea: 0.5 }, strato: null, space: null,
  };
  function periodicNoise(seed) {
    const r = mulberry32(seed), T = new Float32Array(8192);
    for (let i = 0; i < T.length; i++) T[i] = r();
    const hsh = (i, j, P, o) => T[(((((i % P) + P) % P) * 92821) ^ ((j + o * 977) * 68917)) & 8191];
    const one = (x, y, P, o) => {
      const cs = TERRAIN_W / P, fx = x / cs, fy = y / cs, ix = Math.floor(fx), iy = Math.floor(fy);
      let tx = fx - ix, ty = fy - iy; tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
      const a = hsh(ix, iy, P, o), b = hsh(ix + 1, iy, P, o), c = hsh(ix, iy + 1, P, o), d = hsh(ix + 1, iy + 1, P, o);
      return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    };
    return (x, y) => one(x, y, 5, 0) * 0.5 + one(x, y, 10, 1) * 0.25 + one(x, y, 20, 2) * 0.15 + one(x, y, 40, 3) * 0.1;
  }
  const noiseByZone = [];
  const terrainNoise = (zone) => noiseByZone[zone] || (noiseByZone[zone] = periodicNoise(1000 + zone * 31));
  // 지형 격자 한 칸의 높이 (0~1)
  function terrainHeight(zone, tx, ty) {
    const T = TERRAIN[(ZONES[zone] || ZONES[0]).key] || {};
    const n = (terrainNoise(zone)(((tx % TERRAIN_W) + TERRAIN_W) % TERRAIN_W, ty) - 0.5) * 1.9 + 0.5 + (T.shift || 0);
    return clamp(n, 0, 1);
  }
  const groundOffset = (tick) => ((tick * DT * GROUND_SPEED) % FIELD.w + FIELD.w) % FIELD.w;
  // 필드의 한 점이 지금 무엇 위에 있는지: 'sea' · 'lake' · 'land' · null(하늘 높이라 땅이 없음)
  function terrainAt(zone, x, y, tick) {
    const T = TERRAIN[(ZONES[zone] || ZONES[0]).key];
    if (!T) return null;
    const n = terrainHeight(zone, (x + groundOffset(tick)) / 2, clamp(y, 0, FIELD.h - 1) / 2);
    if (T.sea !== undefined && n < T.sea) return 'sea';
    if (T.lake !== undefined && n < T.lake) return 'lake';
    return 'land';
  }

  // ── 지상 목표물 — 땅과 함께 흘러가며 쏘고, 부수면 금괴를 떨어뜨립니다 ──
  const GROUND_UNITS = {
    tank:   { hp: 26, r: 20, score: 30, on: 'land', every: 2.9, k: 'aim1' },
    aa:     { hp: 20, r: 18, score: 26, on: 'land', every: 3.3, k: 'twin' },
    bunker: { hp: 60, r: 26, score: 50, on: 'land', every: 3.6, k: 'radial6' },
    ship:   { hp: 85, r: 34, score: 60, on: 'sea',  every: 2.8, k: 'spread3' },
  };
  const ZONE_GROUND = [['ship', 'tank', 'aa'], ['ship', 'aa'], ['tank', 'aa', 'bunker'], ['aa', 'tank', 'ship'],
    ['tank', 'aa'], ['tank', 'bunker'], ['bunker', 'aa'], ['ship', 'aa'], [], []];
  const GOLD = 250;
  // 보스 포탑 자리 (보스 반경 배수) — 앞쪽 위아래, 뒤쪽 위아래
  const BOSS_PART_POS = [[-0.3, -0.72], [-0.3, 0.72], [0.35, -0.95], [0.35, 0.95]];
  const ARMOR_MUL = 0.35;          // 포탑이 남아 있으면 본체는 35%만 맞습니다

  // ── 메달 — 6초 안에 이어서 먹으면 값이 올라갑니다 ──
  const MEDAL = [100, 200, 300, 500, 800, 1000, 1500, 2000];
  const CHAIN_SEC = 6;

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
    const plan = { n, zone, isBoss, waves, tier, hpMul, fireMul };
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
      this.grounds = [];            // 지상 목표물 (전차·대공포·토치카·군함)
      this.groundT = 2;
      this.stageT = 0;              // 이번 단계에 걸린 시간 (시간 보너스)
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
        hp: P_MAXHP, lives: P_LIVES, gun: 1, bombs: BOMB_START + shipType(color).bombs,
        down: false, downT: 0, revT: 0, invT: SPAWN_INV, shieldT: 0,
        fireCd: 0, score: 0, kills: 0, deaths: 0, ang: 0, alive: true, joinT: 0,
        wingCd: WING_CD, charge: 0, chain: 0, chainT: 0,
        sk: 0, sm: 0, sg: 0, score0: 0,     // 이번 단계 격추·메달·금괴·시작 점수 (결과 화면용)
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
      if (inp.charge) this.fireCharge(p);
    }
    fireCharge(p) {
      if (p.down || p.charge < 1 || (this.phase !== 'play' && this.phase !== 'boss')) return;
      const lv = Math.floor(clamp(p.charge, 0, CHARGE_MAX));
      p.charge = 0;
      const D = CHARGE_DMG[lv] * (1 + (this.stage - 1) * 0.06);
      const T = shipType(p.color);
      const C = (o) => this.addBullet(Object.assign({ x: p.x + 40, y: p.y, own: p.id, col: p.color, life: 3, cg: 1, kind: 'pk' }, o));
      switch (T.charge) {
        case 'fan':       // 부채꼴로 퍼지는 포탄
          for (let k = 0; k < 3 + lv * 2; k++) {
            const a = (k / (2 + lv * 2) - 0.5) * 1.1;
            C({ vx: Math.cos(a) * 950, vy: Math.sin(a) * 950, r: 16 + lv * 3, dmg: Math.round(D * 0.45) });
          }
          break;
        case 'lance':     // 한 줄로 길게 뚫고 가는 창
          for (let k = 0; k < 4 + lv * 2; k++) C({ x: p.x + 40 - k * 46, vx: 1700, vy: 0, r: 12 + lv * 4, dmg: Math.round(D * 0.32) });
          break;
        case 'missile':   // 적을 따라가는 미사일
          for (let k = 0; k < 2 + lv * 2; k++) {
            const a = (k % 2 ? -1 : 1) * (0.5 + (k >> 1) * 0.25);
            C({ vx: Math.cos(a) * 520, vy: Math.sin(a) * 520, r: 12, dmg: Math.round(D * 0.42), hom: 4.2, kind: 'pm', life: 3.5 });
          }
          break;
        case 'nova':      // 사방으로 퍼지는 충격파
          for (let k = 0; k < 8 + lv * 4; k++) {
            const a = k / (8 + lv * 4) * Math.PI * 2;
            C({ x: p.x, vx: Math.cos(a) * 760, vy: Math.sin(a) * 760, r: 16 + lv * 3, dmg: Math.round(D * 0.42), life: 0.9 });
          }
          break;
        case 'carpet':    // 앞쪽 세로 한 줄 전체를 폭격
          for (let k = 0; k < 5 + lv * 2; k++) {
            const y = clamp(p.y + (k / (4 + lv * 2) - 0.5) * (260 + lv * 120), 30, FIELD.h - 30);
            C({ y, vx: 900, vy: 0, r: 18 + lv * 3, dmg: Math.round(D * 0.4) });
          }
          break;
        default:          // 거대 포탄
          C({ vx: 1050, vy: 0, r: 20 + lv * 9, dmg: Math.round(D), kind: 'pc' });
      }
      this.fx.push({ t: 'charge', id: p.id, x: p.x, y: p.y, lv, k: T.charge });
    }
    alivePlayers() { const a = []; for (const p of this.players.values()) if (!p.down) a.push(p); return a; }

    clearField() {
      this.enemies.length = 0; this.beams.length = 0; this.pickups.length = 0; this.boss = null;
      this.grounds.length = 0; this.groundT = 2;
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
      this.stageKills = 0; this.stageScore0 = this.score; this.stageT = 0;
      for (const p of this.players.values()) {
        p.sk = 0; p.sm = 0; p.sg = 0; p.score0 = p.score;
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
        cds: [], flash: 0, chargeT: 0, clones: [], fireMul: this.plan.boss.fire, parts: [],
      };
      // 1945 식 부품 — 포탑을 먼저 부숴야 본체가 제대로 맞습니다. 지역이 오를수록 포탑이 늘어납니다.
      const nParts = 2 + (this.plan.zone >= 3 ? 1 : 0) + (this.plan.zone >= 6 ? 1 : 0);
      for (let i = 0; i < nParts; i++) {
        const [ox, oy] = BOSS_PART_POS[i];
        const php = Math.round(hp * 0.07);
        this.boss.parts.push({ dx: ox * b.r, dy: oy * b.r, hp: php, maxHp: php, r: Math.max(22, b.r * 0.2),
          alive: true, cd: 1.5 + i * 0.4, ang: Math.PI, flash: 0 });
      }
      this.boss.armored = true;
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
      this.stageT += dt;
      this.stepPlayers(dt);
      this.stepEnemies(dt);
      this.stepGrounds(dt);
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
      const base = 300 + this.stage * 40;
      // 시간 보너스: 목표 시간보다 빨리 깰수록 커집니다 (1945 의 '시간 메달')
      const target = this.plan.waves.length * 11 + (this.plan.isBoss ? 70 : 0);
      const timeBonus = Math.max(0, Math.round((target - this.stageT) * 25 * (1 + this.stage * 0.04)));
      const bonus = base + timeBonus;
      this.score += bonus;
      this.best = Math.max(this.best, Math.min(TOTAL_STAGES, this.stage + 1));
      this.clearField();
      const P = [];
      for (const p of this.players.values()) P.push([p.id, p.sk, p.sm, p.sg, p.score - p.score0]);
      this.log = { stage: this.stage, bonus, score: this.score };
      this.fx.push({ t: 'clear', stage: this.stage, bonus, base, timeBonus, time: Math.round(this.stageT * 10) / 10, target, P });
      for (const p of this.players.values()) {
        if (p.down) { p.down = false; p.hp = Math.round(P_MAXHP * 0.6); p.invT = SPAWN_INV; }
        else p.hp = Math.min(P_MAXHP, p.hp + 34);
        if (p.bombs < BOMB_MAX + shipType(p.color).bombs && this.stage % 5 === 0) p.bombs++;
      }
    }

    /* ── 아군 ── */
    stepPlayers(dt) {
      for (const p of this.players.values()) {
        p.joinT += dt;
        if (p.invT > 0) p.invT -= dt;
        if (p.chainT > 0) { p.chainT -= dt; if (p.chainT <= 0) p.chain = 0; }
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
          const T = shipType(p.color);
          if (p.fireCd <= 0) {
            p.fireCd = g.cd * T.cd;
            for (const s of g.shots) {
              const spd = BULLET_SPD;
              const a = s.a === Math.PI ? s.a : s.a * T.spread;
              this.addBullet({
                x: p.x + 26, y: p.y + (s.dy || 0) * (T.spread < 1 ? 0.6 : 1), vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
                r: s.big ? 9 : 6, dmg: s.dmg * T.dmg, own: p.id, kind: s.big === 2 ? 'p3' : s.big ? 'p2' : 'p1',
                pierce: Math.max(s.pierce || 0, T.pierce), col: p.color, life: T.life,
              });
            }
          }
          // 보조기 사격
          const nw = wingCount(p.gun);
          if (nw > 0) {
            p.wingCd -= dt;
            if (p.wingCd <= 0) {
              p.wingCd = WING_CD;
              for (let w = 0; w < nw; w++) {
                const x = clamp(p.x + WING[w][0], 10, FIELD.w - 10), y = clamp(p.y + WING[w][1], 10, FIELD.h - 10);
                this.addBullet({ x: x + 16, y, vx: BULLET_SPD, vy: 0, r: 6, dmg: WING_DMG, own: p.id, kind: 'pw', col: p.color });
              }
            }
          }
          if (p.charge < CHARGE_MAX) p.charge = Math.min(CHARGE_MAX, p.charge + dt / CHARGE_SEC);
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
      for (let i = this.grounds.length - 1; i >= 0; i--) {
        const g = this.grounds[i];
        if (d2(g.x, g.y, p.x, p.y) < BOMB_R * BOMB_R) this.damageGround(i, 120, p);
      }
      if (this.boss && d2(this.boss.x, this.boss.y, p.x, p.y) < (BOMB_R + this.boss.r) * (BOMB_R + this.boss.r)) {
        const B = this.boss;
        for (let i = 0; i < B.parts.length; i++) if (B.parts[i].alive) this.damagePart(i, 150, p);
        if (this.boss) this.damageBoss(200, p);
      }
    }

    /* ── 총알 ── */
    addBullet(o) {
      const b = {
        id: this.nid++, x: o.x, y: o.y, vx: o.vx, vy: o.vy, r: o.r || 7,
        dmg: o.dmg || 8, own: o.own === undefined ? -1 : o.own, kind: o.kind || 'e1',
        pierce: o.pierce || 0, hom: o.hom || 0, life: o.life || 6, born: this.tick, col: o.col || 0,
        cg: o.cg || 0,
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
          // 유도탄 — 적탄은 가장 가까운 아군을, 아군 미사일은 가장 가까운 적을 향해 돕니다
          const tgt = b.own === -1 ? this.nearestPlayer(b.x, b.y) : this.nearestTarget(b.x, b.y);
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
    nearestTarget(x, y) {
      let best = null, bd = Infinity;
      const see = (o) => { const d = d2(x, y, o.x, o.y); if (d < bd) { bd = d; best = o; } };
      for (const e of this.enemies) see(e);
      for (const g of this.grounds) see(g);
      if (this.boss && !this.boss.entering) see(this.boss);
      return best;
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

    /* ── 지상 목표물 ── */
    stepGrounds(dt) {
      const zone = this.plan ? this.plan.zone : 0;
      const kinds = ZONE_GROUND[zone] || [];
      if (kinds.length && (this.phase === 'play' || this.phase === 'boss')) {
        this.groundT -= dt;
        if (this.groundT <= 0) {
          this.groundT = 2.4 + this.rng() * 2.4;
          if (this.grounds.length < 5) {
            // 오른쪽 끝에서 땅 모양에 맞는 자리를 찾습니다 (군함은 바다, 전차는 땅)
            for (let tries = 0; tries < 8; tries++) {
              const x = FIELD.w + 40, y = 80 + this.rng() * (FIELD.h - 160);
              const t = terrainAt(zone, x, y, this.tick);
              const fit = kinds.filter((k) => (GROUND_UNITS[k].on === 'sea') === (t === 'sea' || t === 'lake'));
              if (!fit.length) continue;
              // 배는 몸집이 커서 앞뒤도 바다여야 합니다
              const type = fit[Math.floor(this.rng() * fit.length)];
              if (type === 'ship' && (terrainAt(zone, x - 40, y, this.tick) === 'land' || terrainAt(zone, x + 40, y, this.tick) === 'land')) continue;
              const d = GROUND_UNITS[type];
              const hp = Math.round(d.hp * this.plan.hpMul * (0.6 + 0.4 * Math.max(1, this.players.size)));
              this.grounds.push({ id: this.nid++, type, x, y, hp, maxHp: hp, r: d.r, ang: Math.PI,
                fireCd: 1 + this.rng() * d.every, flash: 0 });
              break;
            }
          }
        }
      }
      for (let i = this.grounds.length - 1; i >= 0; i--) {
        const g = this.grounds[i];
        g.x -= GROUND_SPEED * dt;
        if (g.flash > 0) g.flash -= dt;
        const tgt = this.nearestPlayer(g.x, g.y);
        if (tgt) {
          const want = Math.atan2(tgt.y - g.y, tgt.x - g.x);
          let d = want - g.ang;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          g.ang += clamp(d, -2.5 * dt, 2.5 * dt);
        }
        const d = GROUND_UNITS[g.type];
        g.fireCd -= dt;
        if (g.fireCd <= 0 && g.x < FIELD.w - 40 && g.x > 160 && tgt) {
          g.fireCd = d.every * (this.plan ? this.plan.fireMul : 1) * 1.15;
          this.groundFire(g, d.k);
        }
        if (g.x < -60) { this.grounds[i] = this.grounds[this.grounds.length - 1]; this.grounds.pop(); }
      }
    }
    groundFire(g, kind) {
      const S = (a, spd, kd) => this.addBullet({ x: g.x + Math.cos(g.ang) * g.r, y: g.y + Math.sin(g.ang) * g.r,
        vx: Math.cos(a) * spd, vy: Math.sin(a) * spd, r: 8, dmg: 11, own: -1, kind: kd || 'e1' });
      switch (kind) {
        case 'twin': S(g.ang - 0.12, 360); S(g.ang + 0.12, 360); break;
        case 'spread3': for (let k = -1; k <= 1; k++) S(g.ang + k * 0.28, 300, 'e2'); break;
        case 'radial6': for (let k = 0; k < 6; k++) S(g.ang + k * Math.PI / 3, 250); break;
        default: S(g.ang, 330);
      }
    }
    damageGround(i, dmg, byPlayer) {
      const g = this.grounds[i];
      g.hp -= dmg; g.flash = 0.08;
      if (g.hp > 0) return false;
      const gain = GROUND_UNITS[g.type].score * (1 + this.stage * 0.05) | 0;
      this.score += gain;
      if (byPlayer) { byPlayer.score += gain; byPlayer.kills++; byPlayer.sk++; }
      this.fx.push({ t: 'boom', x: g.x, y: g.y, s: g.r, gnd: 1 });
      this.addPickup('gold', g.x, g.y, -GROUND_SPEED);
      this.grounds[i] = this.grounds[this.grounds.length - 1];
      this.grounds.pop();
      return true;
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
      if (byPlayer) { byPlayer.score += gain; byPlayer.kills++; byPlayer.sk++; }
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
      else if (r < 0.30) type = 'star';
      if (!type) return;
      this.addPickup(type, x, y);
    }
    addPickup(type, x, y, vx) {
      const k = { id: this.nid++, type, x, y, vx: vx === undefined ? -85 : vx, vy: 0, t: 0 };
      // P 아이템은 화면 위아래를 튕겨 다닙니다 (1945 처럼 쫓아가서 먹는 재미)
      if (type === 'pow') { k.vx = -55; k.vy = (this.rng() < 0.5 ? -1 : 1) * 150; k.bounce = 1; }
      this.pickups.push(k);
      return k;
    }
    stepPickups(dt) {
      for (let i = this.pickups.length - 1; i >= 0; i--) {
        const k = this.pickups[i];
        k.t += dt;
        k.x += k.vx * dt;
        if (k.bounce) {
          k.y += k.vy * dt;
          if (k.y < 70) { k.y = 70; k.vy = Math.abs(k.vy); }
          if (k.y > FIELD.h - 70) { k.y = FIELD.h - 70; k.vy = -Math.abs(k.vy); }
          if (k.x < 80 && k.t < 12) k.vx = Math.abs(k.vx);     // 왼쪽 끝에서도 한 번 되돌아옵니다
          if (k.x > FIELD.w - 80) k.vx = -Math.abs(k.vx);
        } else k.y += Math.sin(k.t * 2.2) * 34 * dt;
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
        case 'bomb': p.bombs = Math.min(BOMB_MAX + shipType(p.color).bombs, p.bombs + 1); break;
        case 'gold': {
          const v = Math.round(GOLD * (1 + this.stage * 0.03));
          p.score += v; this.score += v; p.sg++;
          this.fx.push({ t: 'grab', x: p.x, y: p.y, k: type, id: p.id, v });
          return;
        }
        case 'shield': p.shieldT = 9; break;
        case 'star': {
          p.chain = p.chainT > 0 ? p.chain + 1 : 1;
          p.chainT = CHAIN_SEC;
          const v = MEDAL[Math.min(p.chain, MEDAL.length) - 1];
          p.score += v; this.score += v; p.sm++;
          this.fx.push({ t: 'grab', x: p.x, y: p.y, k: type, id: p.id, v, n: p.chain });
          return;
        }
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

      // 포탑: 가장 가까운 아군을 겨눠 두 발씩
      for (const pt of B.parts) {
        if (!pt.alive) continue;
        if (pt.flash > 0) pt.flash -= dt;
        const px = B.x + pt.dx, py = B.y + pt.dy;
        const tgt = this.nearestPlayer(px, py);
        if (tgt) pt.ang = Math.atan2(tgt.y - py, tgt.x - px);
        pt.cd -= dt;
        if (pt.cd <= 0 && tgt) {
          pt.cd = 2.3 * B.fireMul;
          for (const k of [-0.1, 0.1]) this.addBullet({ x: px, y: py, vx: Math.cos(pt.ang + k) * 330, vy: Math.sin(pt.ang + k) * 330, r: 8, dmg: 12, own: -1, kind: 'e1' });
        }
      }

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

    damagePart(i, dmg, byPlayer) {
      const B = this.boss;
      if (!B || B.entering) return false;
      const pt = B.parts[i];
      if (!pt || !pt.alive) return false;
      pt.hp -= dmg; pt.flash = 0.08;
      if (pt.hp > 0) return false;
      pt.alive = false;
      const gain = 300 + this.stage * 20;
      this.score += gain;
      if (byPlayer) { byPlayer.score += gain; byPlayer.sk++; }
      this.fx.push({ t: 'partdown', x: B.x + pt.dx, y: B.y + pt.dy });
      this.addPickup('gold', B.x + pt.dx, B.y + pt.dy, -90);
      if (B.armored && B.parts.every((q) => !q.alive)) {
        B.armored = false;              // 장갑이 벗겨지며 본체가 드러납니다
        this.fx.push({ t: 'armorbreak', x: B.x, y: B.y, r: B.r });
      }
      return true;
    }
    damageBoss(dmg, byPlayer) {
      const B = this.boss;
      if (!B || B.entering) return false;
      if (B.armored) dmg *= ARMOR_MUL;
      B.hp -= dmg; B.flash = 0.1;
      if (B.hp > 0) return false;
      const gain = 2000 + this.stage * 120;
      this.score += gain;
      if (byPlayer) { byPlayer.score += gain; byPlayer.kills++; }
      this.fx.push({ t: 'bossdown', x: B.x, y: B.y, r: B.r });
      for (let i = 0; i < 10; i++) {
        const k = this.addPickup('star', B.x + (this.rng() - 0.5) * B.r, B.y + (this.rng() - 0.5) * B.r * 1.4, -60 - this.rng() * 160);
        k.t = -2;   // 보통 메달보다 2초 더 남아 있습니다
      }
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
        if (b.cg) {
          if (!b.hits) b.hits = new Set();
          for (let j = this.grounds.length - 1; j >= 0; j--) {
            const g = this.grounds[j];
            if (b.hits.has(g.id)) continue;
            const rr = g.r + b.r;
            if (d2(b.x, b.y, g.x, g.y) > rr * rr) continue;
            b.hits.add(g.id);
            this.damageGround(j, b.dmg, p);
          }
          if (this.boss) {
            const B = this.boss;
            for (let j = 0; j < B.parts.length; j++) {
              const pt = B.parts[j];
              if (!pt.alive || b.hits.has('p' + j)) continue;
              const rr = pt.r + b.r;
              if (d2(b.x, b.y, B.x + pt.dx, B.y + pt.dy) > rr * rr) continue;
              b.hits.add('p' + j);
              this.damagePart(j, b.dmg, p);
            }
          }
          for (let j = this.enemies.length - 1; j >= 0; j--) {
            const e = this.enemies[j];
            if (b.hits.has(e.id)) continue;
            const rr = e.r + b.r;
            if (d2(b.x, b.y, e.x, e.y) > rr * rr) continue;
            b.hits.add(e.id);
            this.fx.push({ t: 'hit', x: e.x, y: e.y });
            this.damageEnemy(j, b.dmg, p);             // 방패도 뚫습니다
          }
          if (this.boss && !b.hits.has('boss')) {
            const B = this.boss, rr = B.r * 0.8 + b.r;
            if (!B.entering && d2(b.x, b.y, B.x, B.y) < rr * rr) {
              b.hits.add('boss');
              this.fx.push({ t: 'hit', x: b.x, y: b.y });
              this.damageBoss(b.dmg * 2, p);             // 보스에게는 두 배
            }
          }
          continue;
        }
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
        if (!hit) {
          for (let j = this.grounds.length - 1; j >= 0; j--) {
            const g = this.grounds[j], rr = g.r + b.r;
            if (d2(b.x, b.y, g.x, g.y) > rr * rr) continue;
            this.damageGround(j, b.dmg, p);
            this.fx.push({ t: 'hit', x: b.x, y: b.y });
            hit = true; break;
          }
        }
        if (!hit && this.boss && !this.boss.entering) {
          const B = this.boss;
          for (let j = 0; j < B.parts.length; j++) {
            const pt = B.parts[j];
            if (!pt.alive) continue;
            const rr = pt.r + b.r;
            if (d2(b.x, b.y, B.x + pt.dx, B.y + pt.dy) > rr * rr) continue;
            this.damagePart(j, b.dmg, p);
            this.fx.push({ t: 'hit', x: b.x, y: b.y });
            hit = true; break;
          }
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
                p.shieldT > 0 ? 1 : 0, R1(p.downT),
                R1(p.charge * 10), p.chain, R1(p.chainT * 10)]);
      }
      const E = [];
      for (const e of this.enemies) E.push([e.id, e.art, R1(e.x), R1(e.y), R1(e.hp), R1(e.maxHp), R1(e.ang * 100), e.flash > 0 ? 1 : 0]);
      const K = [];
      for (const k of this.pickups) K.push([k.id, k.type, R1(k.x), R1(k.y)]);
      const BM = [];
      for (const b of this.beams) BM.push([b.id, R1(b.x), R1(b.y), R1(b.ang * 100), b.w, b.state === 'fire' ? 1 : 0, Math.round(b.t * 100)]);
      const HB = [];
      for (const b of this.bullets) if (b.hom || full) HB.push([b.id, R1(b.x), R1(b.y), R1(Math.atan2(b.vy, b.vx) * 100), b.kind, b.col]);
      const GT = [];
      for (const g of this.grounds) GT.push([g.id, g.type, R1(g.x), R1(g.y), R1(g.hp), R1(g.maxHp), R1(g.ang * 100), g.flash > 0 ? 1 : 0]);

      const s = {
        t: this.tick, ph: this.phase, phT: Math.round(this.phT * 10) / 10,
        st: this.stage, zone: this.plan ? this.plan.zone : 0, sc: this.score,
        wv: this.waveIdx, wvN: this.plan ? this.plan.waves.length : 0,
        P, E, K, BM, HB, GT,
        Bn: this.newBullets.filter((b) => !b.hom).map((b) => [b.id, R1(b.x), R1(b.y), R1(b.vx), R1(b.vy), b.kind, b.born, b.col]),
        Bd: this.deadBullets.slice(),
        X: this.fx.slice(),
        B: this.boss ? [this.boss.art, R1(this.boss.x), R1(this.boss.y), R1(this.boss.hp), R1(this.boss.maxHp),
                        this.boss.name, this.boss.flash > 0 ? 1 : 0, this.boss.phaseIdx, this.boss.entering ? 1 : 0,
                        this.boss.parts.map((q) => [R1(q.dx), R1(q.dy), q.alive ? Math.max(1, R1(q.hp / q.maxHp * 100)) : 0, R1(q.ang * 100), q.flash > 0 ? 1 : 0]),
                        this.boss.armored ? 1 : 0] : null,
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
    WING, wingCount, CHARGE_MAX, CHARGE_SEC, MEDAL, CHAIN_SEC,
    SHIP_TYPES, shipType, TERRAIN, TERRAIN_W, TERRAIN_H, GROUND_SPEED, terrainHeight, terrainAt, groundOffset,
    GROUND_UNITS, ZONE_GROUND, GOLD, ARMOR_MUL,
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
      this.game.setInput(c.id, { tx: Number(m.tx), ty: Number(m.ty), bomb: !!m.b, charge: !!m.c });
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
  /* 카드가 화면보다 길면 가운데 정렬 때문에 위쪽이 잘려 스크롤로도 못 보던 문제 → margin:auto 로 가운데 둠 */
  #menu{position:absolute;inset:0;display:flex;align-items:flex-start;justify-content:center;
    background:radial-gradient(120% 100% at 50% 0%,rgba(22,48,92,.35) 0%,rgba(7,13,28,.62) 60%,rgba(3,6,14,.82) 100%);
    overflow:auto;padding:16px}
  #menu.hide{display:none}
  /* Canva 배경 그림이 있으면 그 위에 살짝 어둡게 덮습니다 */
  #menu.canva{background:linear-gradient(180deg,rgba(4,10,24,.25),rgba(4,10,24,.55)),var(--menuBg) center/cover no-repeat}
  .card{margin:auto;width:min(680px,96vw);background:var(--panel);animation:cardIn .6s cubic-bezier(.2,.9,.3,1.2);border:1px solid var(--line);border-radius:22px;
    padding:22px 22px 18px;backdrop-filter:blur(8px);box-shadow:0 24px 70px rgba(0,0,0,.6)}
  .title{display:flex;align-items:center;gap:14px;margin-bottom:6px}
  .title canvas{width:74px;height:52px;flex:0 0 auto}
  .title canvas.emblem{width:70px;height:70px}
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
  .shipInfo{width:100%;font-size:13px;color:#cfe0ff;min-height:18px}
  .shipInfo b{color:#ffd166}
  .orient{display:flex;gap:8px}
  .orient button{padding:8px 14px;border-radius:11px;border:1px solid var(--line);background:transparent;color:#9fb4d8;font-weight:700;cursor:pointer}
  .orient button.on{background:rgba(255,255,255,.12);color:#fff;border-color:rgba(255,209,102,.6)}
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
  .ships button{position:relative}
  .ships button.locked canvas{filter:grayscale(1) brightness(.45)}
  .ships button.locked::after{content:"🔒";position:absolute;right:4px;bottom:2px;font-size:14px}
  .orient{flex-wrap:wrap}
  #sizeNow{color:#8ea6cc;font-size:12px}
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
  /* 차지샷 버튼 — 폭탄 버튼 왼쪽 */
  #chargeBtn{position:absolute;right:102px;bottom:18px;width:66px;height:66px;border-radius:50%;
    background:radial-gradient(circle at 35% 30%,#d8f4ff,#3c8cff 60%,#1a3f8a);border:2px solid #bfe6ff;
    color:#fff;font-weight:900;font-size:13px;pointer-events:auto;display:none;
    box-shadow:0 6px 20px rgba(0,0,0,.5);cursor:pointer;text-shadow:0 1px 2px rgba(0,0,0,.6)}
  #chargeBtn.on{display:block}
  #chargeBtn.full{animation:pulse .5s ease-in-out infinite alternate}
  /* 작은 휴대폰: 버튼을 줄여 게임 판을 덜 가리게 */
  @media (max-width:520px){
    #bombBtn{width:60px;height:60px;right:10px;bottom:10px;font-size:11px}
    #chargeBtn{width:52px;height:52px;right:78px;bottom:14px;font-size:11px}
    #topRight{right:10px;bottom:80px;grid-template-columns:36px 36px;gap:5px}
    #topRight button{width:36px;height:34px;font-size:13px}
  }
  @keyframes pulse{to{box-shadow:0 0 26px #7fe0ff,0 6px 20px rgba(0,0,0,.5);transform:scale(1.07)}}
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
  @media (orientation:portrait) and (max-width:900px){ body:not(.vert) #rotate.on{display:grid} }
  /* 세로(1945식)는 휴대폰을 세워서 — 눕힌 휴대폰에서는 판이 너무 작아집니다 */
  @media (orientation:landscape) and (max-height:500px){ body.vert #rotate.on{display:grid} }
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
  <div id="rotate"><div>📱↻<br>기기를 <b id="rotDir">가로로</b> 돌려 주세요<br><small id="rotAlt"></small></div></div>

  <div id="hudDom">
    <button id="bombBtn">💣<br><span id="bombN">2</span></button>
    <button id="chargeBtn">⚡<br><span id="chargeN"></span></button>
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
      <div class="row"><label class="lb">비행기 고르기 — 비행기마다 무기와 ⚡차지샷이 다릅니다</label>
        <div class="ships" id="ships"></div>
        <div class="shipInfo" id="shipInfo"></div>
      </div>
      <div class="row"><label class="lb">화면 방향</label>
        <div class="orient"><button data-o="v">📱 세로 (1945식)</button><button data-o="h">🖥 가로 (넓게)</button></div>
      </div>
      <div class="row"><label class="lb">그림 스타일</label>
        <div class="orient arts"><button data-a="canva">🎨 Canva 그림</button><button data-a="draw">✏️ 직접 그린 그림</button></div>
      </div>
      <div class="row"><label class="lb">비행기·총알 크기 <span id="sizeNow"></span></label>
        <div class="orient sizes"><button data-z="auto">자동(추천)</button><button data-z="1">보통</button><button data-z="1.25">크게</button><button data-z="1.5">아주 크게</button></div>
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
        <b>⚡ 차지샷</b> — 비행기 둘레 게이지가 저절로 찹니다. <b>X 키</b>나 ⚡ 버튼으로 모든 적을 뚫는 큰 포탄 발사.<br>
        <b>🔒 비행기 해금</b> — 처음에는 하늘매만 탈 수 있어요. 3·6·11·16·21단계에 도착할 때마다 새 비행기가 하나씩 열립니다.<br>
        <b>보조기·메달</b> — P 를 먹을수록 작은 보조기가 붙어 같이 쏩니다(최대 4대). 금메달은 이어서 먹을수록 점수가 커집니다(최대 2000).<br>
        <b>협동</b> — 친구가 격추되면 <b>가까이 날아가 2초만 버티면</b> 살릴 수 있습니다. 다 같이 쓰러지면 그 단계를 처음부터 다시 합니다.
      </div>
    </div>
  </div>
</div>

<script>
/* Canva 로 만든 그림 31장 (원본: skysquad-app/art/*.png). 용량을 줄이려고 WebP 로 바꿔 글자(base64)로 넣었습니다.
 * WebP 를 못 읽는 오래된 기기는 코드로 그린 그림으로 저절로 대신합니다. */
window.SKY_ART = {"b_batwing":"data:image/webp;base64,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","b_fortress":"data:image/webp;base64,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","b_hive":"data:image/webp;base64,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","b_icequeen":"data:image/webp;base64,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","b_interceptor":"data:image/webp;base64,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","b_magma":"data:image/webp;base64,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","b_motherstar":"data:image/webp;base64,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","b_prism":"data:image/webp;base64,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","b_sandworm":"data:image/webp;base64,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","b_zeppelin":"data:image/webp;base64,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","e_bomber":"data:image/webp;base64,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","e_kami":"data:image/webp;base64,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","e_missile":"data:image/webp;base64,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","e_scout":"data:image/webp;base64,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","e_sniper":"data:image/webp;base64,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","e_wasp":"data:image/webp;base64,UklGRqQeAABXRUJQVlA4WAoAAAAwAAAAxwAAxwAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZBTFBIvwoAAAHwRm3bsTnWtm37fpzBHasRsxFMG23bSvqeatu2bdu2zSRt27aq4qSO/di3H5Wqvq7rvM5j/pwRMQH4HzallnkloiEURRDUUrQoQlAVyRsRDYWik0X3ngMWHzx40XFjFhsyeJE+3bsIOqlFUMkS0RAE7YsB41ecvOcJF976+CvvfPxda2try7y5LTNaf/z83dem33vF6Qdtvd5fRvdTtJciaF5oCACgg347+egbX/yqjfX2uZ89de1Rk3/THwAkBMkECQqg2/j/P+eJb5wLdbMYzVJK3tmUklmM0RIXnj6//5g1hgiAoBmgCmDophe+Np8k3WK05O6sq7sni9GcJH98/Ijl+gIIUm2igkH/uP0HOmnRkjsb2VOMiaR/dPGq3SBaZSoYc9pXdJqZs6TJLJH++l4DoVJZAYNObaWbJZbbzZLzkx26QStKscL7TNGcTdDNnFPHQytJsdUCxsSmmSK/Ww5aQQEbejI21TZ+szS0cgRdX2Jkk23jpRWk+L25N5vET/tAqud3xib0Se/qEXR5hrHZtPFcKCo3YNU2WnOJ/Hx0FUGx5RzG1Dws8qu/Q1HFit89z2TWFNzM+cg4KKpZ0WPvr+kpJi+XW3Tne/8uoKhqVSy2/7t0pmhelpSik+n5rXtDBdUtKuix9mVfkKRFS95YniwaSf/grGUKiAoqXRRAv7VOfn42SbqZJff6eTIzc5JsnXbUCj0ABEH1BwUQlpp81lPfOhvavnjs+PVHCgBVZKIERfvFl9v21PvemuX1S9+9cOuxW/5xANprQF5KCFho97FPM9XHeGbfgPYSgiBLJYSgwIv1OwtBQ1BB1gp6f1m/+xCQv4qRM+j1egk5rPhtrFfip/0h+ROwEr1OzpZR0BzamIn1sl/mUIGtGOvExGUQ8idgv/oZN8yjExthqwwSjPyQqV6JD3eH5E7Anoyse+JaCJmjWPUTev2cr0+CZo2g2+tMbMDImzNHMexbeiMYnwQkZwQ6jakxjkNA1gbsQGsA5/zfQrNGoNOYGoDGixCyRjHqJ3ojJL7UFZIzgkFfMDWC8UnkDRSHNYSzbR0EZM4u9IZYsAI0awQDP2NqABrvh0jOKEb9RG+ExOcCsgaCuxgbIfJYBGROnztp9Us8TyBZIqEDBExmqptz3m+gWLiErFi4aAihwMO0ehkvQLcQVACIICMF/dfoD0V7wbgPmeqV+GAPCNoHjFmjG6TiRDQUQQWCa3glBP3G/WWDHc/4ms66O18/aqs1fjOsKzDgDR6MAAlFEVSkSkRUQ1GooGPtulwLW6+8/7XPZiaS7mzA5CTbvn/v6avvJt8YG9BJDUURVESalIiohqIIik5K98G/Wf0/h5x376ufzXVPbO8WY2JDWozG9p48zXj/qZtP33fKipMW7YrOaihCUBWRpiGForNd+45ZZsMdjrrojuc/bWljh06PlpI7G9k9JTMjnR3O/+HDqdeeus8/1v7dkJ6KzoYgTUEF0D6Lj//7RtsfetZ1j7zxxezEjj3GaJbcWWpPySxGc3bc1vLJc/deftLeW67+hzGL9hRAtAkoev/j6mc/m9nGzqYYo1lydzZV95QsxmiJnfQFLR88eeG6XaGlUyz3Dp3tk8UYLbk7m757MosxmrO9c/p4aMkUf5lFi5bcnVXs7p6sLfLj0dBSCcJUtjEDF/CakgWszMQcdM5ZElqmAifQsoCJ/0BRJsU9uRB5bKkExYtMuXAltFR9P8oF472QEikW/56eC9MBKdOIWbmQ+IKWa8y8fHgtlGx+PrxelGvUnHx4JZRraGs+PCdlEiz6TS4YH0eZBX0/ZMqFuyCl6v5aLkReCS0VptJy4QyEEkFxRz4chqJMBS7KBeMO5Qo4PBec6yGU69+Z4PTfQ8u1LD0TZg6GlEkxqpWeA4mvdi2XILzAlAORVyCg1AHHM+aAcbOyKZZsYaq+yNd7QcoFxZ40qziPbFsNirILDncm8+pKljhzMyjKr1j5GdLNqsnMGe+cBEUzVHRd5555ZIqpalJ0Z+vVfwEUzVEVmHD4G06mmLwqPEUn7dm9RgGqaJpBgO4rXvQVnRa9ClJMJN855c9dAFU0VQ0CDJx8y490WvTm5jHR+cWlq/UAJAiargQFsPiUW3+i06I3qxSN5FdXr98PQFBBc5agAIZsdfsM0qN580lmdP5w7UYDAGgQNHMJCmDkjg/NIT2aNxOPkc7W2/6xGAANguYvQQAstefjc0k38+bgZiRb795mJAQaBFUpQQCZuM+0uaSbedmSmZOzHthxFAQSBNWqQQCduOfUeaSbeXnczJ0zH95pLAAJgirWIIBO3G/qPNItpjKkaCRnP7TzWAASFNWtQQCdsM+Tc+m06I2VotE5476dxgkgQVH1EgTQpXa9dwadFpM3hqeY6Pzh5m1HApAgyEMNAsiwf9/ZSqdFr5/HROdX105ZDIAERU5qUAAjtr71JzKlepmTn168Xn8AWijyUwsBMHjL+5N7fRJnXbt2LwAaBLkqQSDY6Cd6PRKfnQCBBkHeSghYZT69dokfDUUIghwucCVj7Yx7owsyucAOtJo5uQxCLin+Tnrtvl0EkkuCwS21Mz6JfBYULzDVKvIshGxCwFWMtTJujyKfCuxDq5GTf0PIp4AV6TX7fhAknxTDWui1SXwWOSUIz9JqE3kBAjI64PJaGXdAkVc71sjJP0NzSvEneo2+7AfJKcHAT5lqYbwfgqwWPEirReQJKPIq4JTaJE5ByK0pNXHGidC8Ukxqo/+8xHd6QPJK0P0tpp9nvA4Bma24kVaLvVHkVsC+tXAuA80rCV1wWG1WRVfNJwkKxR++pf+8xOcXhSCoZJAEhaDHKue30llD5weH/C4A0CBZo4VAMGDDCz50psSaJmfbC8et1AOABskT0UIADP3HdV/SmaKzxik66e+ft25/ABJUMkNCAKBjt7+rlWSKyVlHt+gkv7p68jABJATJB1UAPf582JNz6LSYnHX3FBOdMx7c55ddAKjkgSjQf63z3nOSFp2N6ikmkm0vHLtMT0DzAH+99HM6PUZngyczJ/3dk5eCVp+g+1mJnqI5S+kW3TlnP+TAJYwxsdQWjYdAKy5gPcbE0htnjYdWm+BmRjbByD0QKk3wfx8xNQPjNRWnGNFCbw6PQytuiVnN4hlIxY2e0SyeqjjB0B+bxaPQiuv9OVNzuBWh0gA82yzOrLqAsxjr4t6Re522qL7VaF4XdiJ5HRK/GgypNgEe4gJzr9msBR3Nn8dau1sbD0BAxSvGvMpEjzGaWUrunUrc+T5aO+MFh9E65Z6SWYzRyMRLBNUv6HfQ6zOdHSdrn1JyJn6IIzvaotvXdNKTLdTZsf347FYBOSiCYuzyW+x1/OV3P/fh9/PZybSAe2JdJpLO2eNxJheYs+O53773zF0XHLrt2n8aKlDJAYii4x5Df7H8pjsfc9m9L3zcYokv9cHIGXQy8bmApVvoPuPjF+654JDtNvjb+CHd0aEoslFDCEEVndR+o3+3xuTREEyjkZGnoMCft9/gz+P6KzoW1RBCEGSoiIb2ioWKBBzTzrkOgmDhGtqrCrJYVEMQBCxLp/PrQRBoCEEFeS7o9S6T8RYIMj/gUppxexT5txmNc5aE5p5i6DfOqYDkHhTnk7shIPsFw5+6tQck/wAExX+HIiL/HfyvgwBWUDgg7hEAAPBNAJ0BKsgAyAA+PRyMRKIhoRJp7TggA8Syt34+TG7gAZn6gMC+w3j363mvOmpEr1jlf/T/0D8T/aS9uPmC/pR+C3aD/Cv2AftD+3fu1egD0AP1T9U7/heyF6AH7VemX+3PwS/tP+5vwCfxb+4//POPP6f54PEP8z9OnrL5L/kn7rxP+ou40+/9bP9n3+/IjUR9qf5fxWdwfa70Dvbz7P/zPRI+68z/r77AH5U+vX+48U/6//w/YK/k/91/5f3VfK1/2ebP6p/8n+o/x3yG/zP+z/7n87P8h85fsD/cX2Of1qJtarY7VWtSl2t7VHd0EpGOcABMH7kzNj5wQEUsEYzVSKj+TtpxDY1c8ApP7kfjbO8GVGDd9MhVsX3bwjTw0UkQU+qTL30C+ZQ7idMx4zBmtcKRT3FG9Od0l4u5m5yl6aDxNDY52077lm/dTBQ9DmRX+P9R+GTucfjfEylu4wuS6aF1ZlIhlHOWCPmsbAyBOHsi1uQZEJLo5VfZaxN9BZsMq2XVhAe1vFH3mF9Km+X/q5bYuX+lfC/SG2do0VZDOp3AwAIQTdjpfYMkw5NsTsalnnz4Uv3qCyjfuNUFF/ao0wtUgg+226Oc/znHwxXYCrxvvQszqw2hsU3TszXrYZnmg8U+Z9EGhIemGXRfMeXAl1metOjTHJ857urxPISygQCn3oPe1dfU+GH+KlF/zfD/8Yz4HKXprcF2jGsJ4KmvI7px4obOUvTR0rhknbp/SX5gn8Yo1654UPTs+0xChZxLBbvmIBlSrVrwOiaAHEDFLzBbjVUJ5ti6jvGzV8ZRn/NAQHOUNwuZ1XwTKWnUNxhatVsdqrCAAP77phAGz/4J6BPGOpnKs3jJlb//JPBDLPU5eGhwfkLayPqIlGEHzUtXOlLj6HYDyZ1nKjOiz0Q4fTWIrVxKL81OW6Kc4/x0OOB76v+FZ7xFv7rWWr/NL/016BbtnDyPPVPt6vONz83RiQhBC2+71dgddziR5KLXwFhFyKivQ8rdNf7dypOFj9kxCMDbJl+LL1JPVHWRjt6J9cgqmzO8+kt48uFhog/Jafg5HGXLcxO+qovY+FwG3s97NU6DlmfnWyRZq/xcB+XPvzvbFdAZX5m4mhhy1tttQ0JwcW6yevdRFgrVvEK7qROV1Hsuceuz1OBP6vYO4/zXOUPP/JroSZRpE8ZfToRZ4et43YLfFHAzADoiDeVUnqiL7Pv5WJ2pxP/f7w4TcAbfGf2uUBXTFyN+jTlO+ZbiaMXicyQIx/JhaM8Kbtq527QDc6uXmlCzUitHtvtuvk1ndn7XI7KS/ayd+LEK6STP+un9UsuuUCeI8qIVjeiRE6wdaAR3ybiBMrv5H/oeN6gvCQAVhnRRBgYh+1Ohz19D/wnub5lgTjR+ZD51RwiH+rwjf26gv6ySzryN6rMyhjDwemqtDXJNhWLi77EIiu0zXFotjWU8Fkt0yNmOkpWxN83T+1csqIZVMp9OZyWAk2GHQQOaNlsYU87QxwY/h5ribKpk7g7x5IJJ+nTanZo3E+WmF7o0My3P6puIxZNMpayFjeru7dk4gT3r7QtXp95pGsXPpu5/yNhNIdos3J1PbouRjJ4vrSWUAHZJSGYg0g615NSCtUgACQo/F+Yqh94p/IjGAJ/293zfuSV3gfvTx0r9NVa54oE6h3aslQZech6IhCl5b3+St++SFK39OQshufAVNazlU47r6bmy+k8TpP3YITEu4bmwyr4de/Q7I+rYbcCm/XURDls1MmMgH3BVARxs/P4bH2NV0r+SnY3l/H42+YkPCY/bWTMWHWt+cV98SO+Wxo2lktOp+bRZfn93MZD+sMMuAKlQL24ix3ccyKYoP/CD5NXnLAa/PKKlg/0P5Ibf1/P5kSJJUR3+gzGdhCyUEV/Ej6XoZHe+hKThmonrU99zEPoWv0AUHBC6vKaGJGYkbIIvQY0ElWA0WTdy+6oht4HOcgaLlraN/y8lsgQQpxqUyPYQl5JZ4ii+TIIYHScaEg4Zn8qtetfhEhg24xjFSD7uDuWuUewkz9vHfuP757kfZp0r/YiGmHrrLPm8DHL/O5x/S/kpBcj29OsOprVQjvuYsLfSwboS07+LZOrrGektpU+B/4ks/P9iXh/yh+vg8PQnupa4seu9EOEQJi4jRMqv9723ULBVfaEP7fDqpKXopx6JIbcX357dJ+GKy/b/ogZFMSNoDFY8CPtPgAR35kaAJZVe3MTb1Xb1ZrmJ4+HWtuuLsap28f3yetMNFghWoJH2EKAyU+L2Tct834WmIND/8tQvk6V/FwkRXxl2VvJVdwkdYUNvMV5mo41r+0DnVX8W4+h1ucs4Amd00w3QDbQkzTsGFUggXR84dKwodlihlRfbIPzFleGfvw65ZrtW3sHPPK8kbymJvsAaoT+I6QohLGR12QqZtn3p0kKUY4IVGkydgM63rIrxDlkjEafIrg3ihg6XRcWR7MOnrUqR9hangPxy7doAxYNFNp68UZv6RaUGc2CD+OL6qbr0zBHscacQd23WuOQ6wy+y2/rcNQdQqBcm5dNsFVqlc3kc+jnnmKvJozscr2IdVHn2CNi4vV0+/qpHBWwOc4/HOY669gYhcHL+pzMra8oBIVEilw0QOnz2JJf8F9z+mDm9vGVzyuufpAqutNR7HESa7PiXaMwf3UD2Schoi1QmeI0wcqR9CpcIe79ktA3sJsER6vTKSVpjpSGB0y5+CoNFNesz6+19uM1HXNGy7Y10pREbz0FE854jL2clZ3HwB18uw5zMQmOymh4Mn5PqRXCCSk2a97JcuVdYMJIO5eaHgBgLz/BzCPiTU5kBZOa/+G7sR81GBVE9LnMopWu51ZK9EZu+uH40qq5MC9KDlr/i4HlhJSkT13TNwuNEiRR5B/Y8wUTPBNp72iYplT6hSxXT7wwJgRTLdkNdRwzIb6ZgWuFwBxRppZbpg5Wcu/Sl3elP7xR/us9gTh9s08z4gMlMHLw2G9p/whjDqkNZ5OU5RH08hKp4PEFEvwBRMfAzSCOvUMQptMSRuP7zB4QnIwNLutE30E67azyfFIrtSanYKJXmYCU2ZufIGv5aaap6I9gCdNqrFRF5VJ1q9f6gwUK6eaVqEiA8tczm3T7kscYRnv9unhl++SXehDdI/HuR7JJ5pFh3secSJxIkrsc2oZEy5p/tAerxCvo9awUHEizZrlut9Jdbbjf/y8LxsW7Bfnh5Og4PekrAUsFZAiZQ7uwpgPlhrc0uBg+OvFLdhfGyD7uhp2JsInhRGkeQ0dZ8r5jQMtMm/Aq2EwazDEcWK+j/pyLoFRMtoJRa6iveqiOHWr0mcHR+peu6azJidTs+gIEY0E2lMbMygdYK3tXFIZ+6Ib7asXHU729IuURmBc2n3i6+1BafqM/G2uSijZt3++2Ex9ryr6vTlYDiIqBBucC3JSdu7bn3lMe0BPM2FGS3p/N8st941b3uJX1DleIqnNQPNkSRikqevlEQCSSBvSItPC95wBaBLAMd/Y7/DwWZnXYTyLk/5eiWE20A++1rQeSh5hEaxmiZmK+HbyEAfiUi0HKdF/qxlHxqRZB9JlvGQsizBDxXsjscGyR6sxv4dK0TfmxarDfHTLbuNrZT6j3fIAmXWi+QwI/JL2nfqScCcGB3dQj+WXeTG2R+lCpoTiNoY2rrWVyxrCXQL3i3CIWsmsMmoHa7vLdeNNgNDClUt/eMGQP5C6Mz3FbqadeQK79Z5kTJc7nNcZ2J+dlZnrmUJnTI8KGH8Rlbx6frwEWVyzXyvsKrSQDmpV7lfsa7xRx38vJAhSfl+Um6gYLcThKNPRhKHl9TuTcPZGtrKrQXQqo361eZJobX9mJTAFo74clJUK2AnKOtOeg0v6tvAMQeMI43BU7qgIsZyJGpQDD+V/472PsAD3uC10In8PBTi3zHcIUoB0keO1bEUCtmUlK8X9NMm5Q9G13b2aJKosQAhLVMyTD6NHaDB5EvsENU4C55VLd7elfY3a4td9UkJ86bew0wMZu0VpABVz+Bt/pPb3NzsU45vP6rEI56WzXElkkt9fW8yZIIyASeJLU4pBAKkDwr/2tz68D1ggM5jdVIsDrN63zGS66yOpbJE8Wya1io791HZOqYYp9O/KPLiCF8EACfT2Tp/uV1AAaPtFufVvHFrpa80B+MfjvSBJxhRYP/7qnNxOM3yRwK2d6Ftx1wf1mv8sL7cQypBVM2m9RM170eo+fzrTfmKHglkN4kK7Qm1YCVKW/KxUx6Sg3iyMWARIWG9DQRpaGvWdaIeOb6/Rmi0gQMyMuDAPSvBAJwb7UvnyV7Eomaf7hkp45IQh0pr+6J2eGLEFKjBvDj4ytVX59IPIW+dOYuaARtSrPkqXctcusGmA4tOfymXWKp4t1tgG+RStyCZ2+wfIVGa6Xn4AOx5+Y10LZfrWl2ZVyLh3RNUnz69kTM+vpvbfjan1FUAXdTaxOPj/+IsvTrUnQTFau7ZbEtXQT7bQn2GFzB0YZY5Ps0LCjkyY88ODbnFt0x0xmlu+IpghjOP+7oPq+sMFaZXXvUyB5y5PGyGebO7jisXzBDt7hplFXRY9ynlqn/BQoQl8q9LQUPLxIcz/6SRZ0OhQuNQ6sdUu1QC7//gMPtlEZ3WCyE3cOxXqHQdCSYj8ePrfSuOkGOmcznpE2IjjD1PtWICf7CE4GrOAEc3ehVNAIvzII4CZE+zO1qTnOyxWCLD5ddiUEPom/HDmjQGChtsT6DC0FEZ0hB9CrA5wThTG9q9RV83K7jLv9vYdmhyiiRAU5O6OiRus+adukCtxr3+xDGK1sHiEKTg5meuSsWijKLa7IoDjQIysZpRoM2NsTqnC759dfJ4duFthuZKrCsdp1l6SXsd0C/85LRhU/ttjVH3xU+IUoSmfnl5SZ0NWdytRfRc9HkNtvGPyuVsYNN9XEmDZjRHKM27PLBmTwflbsI7itMcawoGK6fpS0ZvMhahl0gtNvcfS417kegUXLQoUsj+KuIRvsshA1pHVDgLtFAlb+AKNh3deoKYGOLWdOdVu28OFdEjAZoLUunMwDMB8sC7dAVUNe+dpEb5XynConorXaPbliBbmI8iuyN0gvtUMyteJW42UmSBQdRcox8fGKWMX+/PE28112wEOwFB08eVm7Gjb4dgd6i29qzxH8hCxEEWjwUF/ZGrittT2WV40G+WX/ONJLoIpuw7FEE56qKony/XakMgDLNyqZ2UPZrl/GNfiKEBYIkkg3zLKunSF6OIJNw+Gq5mI6RNXKxVAQdgB9UAAk9R+igAcS2EUOPIJJLiUTkOe4lGKvIYCy6YI/JN/xmUzxxLvmitt0VNu4kSxR1RiBwhe7H0r4W6XB+nPWLR69U5rAcZskwKPLFnToY3dZU4HELBZEmBAjWtiaz8+Hd0anEvtNDuCGvq3ZOd74RQSwxOU2Bn+EpYX2b1iOjaee51Z9SFDOZCkiKkBnxjGM6z6j3bKvL/3ut58LjDlyuNoPQ9H1aKBRaxnnM5sEC/4rmUXjNE7pcxsZ6+lDfRJdVNFyoTHoLX8UdpxSedPRTL9z9Y4FozxUBftuRIFSrrJVczd8dqZMu+VPeZV3mGLVwY54QjO8Zh60gOXSAE7FnegDjp91u0Up2oshsZGrXk97BnGZRWQsS+ewOeGHH+r5dwm3jIOoJBkBUMO/smKA3xa5wvHXhk1HkqV+Dw3hMSamwJl+86T1HUeEBAaC3jHqyoe8KOT7P9LYXIyju55vzWZMzpYpRgO7omTMmOUn6HUn71X4a9hR5gNBKMy8XgRs8t9IAtuoR/FJG36SnXNuxYqV7MOzX5j5Y+iP9yt/hVdugoHf/JuGzjVUtuARsvdP7DttYP7JwpWd7zlJ1nqw1BgqHBf5pwk2nygr/8tIO3rcUNtxM4KXfm9gVL1iAAaAwSNljgZe2GadZ1Pq8OybNC/Ios2SdJowJwZYoeINO4bz16KhXDvHPqAXmVgRb0NP9+njlhU9/qpy6p2/8QQ+6yHLcUe5iduQQ6Yb9hCDqc6W2Ej6nMZ+x+dzhC3csdjMXrMgcRA7DvlerJxNHO/tuzAVTZg8EkAVkShrv4WppIfwR+MMjNjQC9t9A+nrl+4FQigAAAAAAAA==","g_aa":"data:image/webp;base64,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","g_bunker":"data:image/webp;base64,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","g_ship":"data:image/webp;base64,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","g_tank":"data:image/webp;base64,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","i_gold":"data:image/webp;base64,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","i_pow":"data:image/webp;base64,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","i_star":"data:image/webp;base64,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","logo":"data:image/webp;base64,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","ship0":"data:image/webp;base64,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","ship1":"data:image/webp;base64,UklGRnwqAABXRUJQVlA4WAoAAAAwAAAAxwAAxwAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZBTFBIGA0AAAHwh223aUnS9t1jjBVplJ1l27aN7GyWbdtulJ5i2yrb7S5XVpZtJYvpzIg55rj/2BEbEbHn4+OIiAnA/+4VUVU1VVUpNrHKBPWrmZaWmKJbGzlqlXU22Gj9NVdYfKigVkyLSUwA6JI7HnX1fS9/8tWsTo80d8bnHz53y8XfW3cYAJiWkBqAhfa8ftzUYDO7PrzzhNUNECsdNWCe79z2GUlGSp5z9Jize3KSnPvMuasAYiUjKljhyo8ZzClHsJmRUwpy9r07VVAtFlEsfdMMMqfMloYnkk/tJqKFoqhO/JyRcrD1kTLjjqVhRaJY/GHmlNlLw51TvgOV8jCs+y5TZi8OD14CkdJQbDqFKdi7s/NnCikLxeoTmdjro4tXQYtCMM84JvbBcB4GKwnFtUzsk5lfrAgtB8U6cxh9g4m/KwnD9XT20eCs1aClIBj5HnNfofMsVKWg2JR92Hk/pBQMBzL3ncy3hkCK4Rh63wlOnL8g9mXuO5kfjCiILRh9x/kPFINgvg+Z+9DFqFCKhp/Q+0pwzlrQYlCsP5fRRxJ/B0U5Kq5j6huZk5YrCsG8LzH1hcj8HgwlqVhrClPvi8TzoShLxRafM0Uvc+flEJSmYd13mbw3RWI6EVoeUCx6JyPl3hLJOX4XGEpUIQdNYCSP1kVOmbxjCRjKVBSL/OgLRqTcmkiZjMd2E1EUqwoWP/OFxNZ//NOtDCooWFGgY5OL32c0L5hu23MEIIrCFYNhN0Y0LfNtA9RQwh3YrjXvDhBFGRu+wcwWTBgKKaQKR9CbF5y2DLSQBA+2gs7TYGUkGDae0ZK7oKW0yNQW/R1SSsMntOhvxWEm3YlpA4t81qK/1yeq0p2qtqumG7ZlSzLfNJSkYPhPfjICAijWv/9wSB2K9b1F71SQHgTz/OHmhSCAYo/H9oO0IcMB5L6wmts4fhFIPRvmFr3dUYfhW+RhqADBs/xgOKT9VDiNPLVG8BCnrQztqcL3mNnC4OSF6zqBPLoGGMcvF2pPZ5And3c/p69U36H01kxdFlrHSeRxNYLn+MUC7eli8sQaxT2cukJ9xzG1ZvZqdZ1KnlMDvMCvF2lPPyBPqBE8xGkNnNKqWas2cmF3r3LmqPZ0LXkcDILBb3DmSvWd16q8EayO08nrUEFgr7NzLWg7uqanYe9x5sr1GK5oUXC7Rm7opnqDvkF7urauWQ38oEXMG9V1NnltN4PeZt64PV1HHtVNNZZfLlPfzmS0IPO1IZA6jid/hAoAXmRatz39iNy3G/k3p4yCQkTVzCrF4/QWJJ6GAWZmqiIVjiAvr1E81p4US75PPmhiA3ASE6+AoUfBwm8wt8B5FQTdCxZ4l5y8PDo6sJtn/h7SPkRUzaqBOJGJc1aCKu5iJ58GZMSiK22yy3eOP/9PHzPY0nj5prMOHr3tuisvtiDWCTr3RWW4iV0cPxxWVWaqIv2RiKiaVZWpoEfDjUzkLkusv/nod5k57S/PvPHxlBmZtRFsEWuja8ZnE158NZj56IG7b7vi3XTOXQOKOtWqykxFRPqQiIiqVVWlgrpl8LwrrrvdmGMuuuJtZnLajK5g3ZFTSp7ZKk8peWadQbLTyeDTP73qzKNH77zuCiOHCOoWrSozVRHpLSKqVlUmqLcatuDya+8w5ojzrvvDw+M+/XxWYoMeJMM95xwR7L0RkXP2Gk852G2w2zTr8/HP/e0P15918D5brjNqweGGesUqM1WRFqhVgp5t2ELLbzL68LOvufmRFz+eOjux7vCUUq6JWvaHERE1nlJKOVhv+Mzpn7zw0G+vOX2/HdYdNd8QRY9ips1RAYCBC6+w+X5nXP3HB8d+8FVnsN7InlJyz1HL/j1qs3tKyXOw3jx30jtP3v+rS47de90lhqLWGhOFrnrUjQ+/+nlmnZE9JfecIyLYriMisntKyYP1znjrH786eZPBEG1AFNs+OpdBkuGeUvIcEcGyjIicPaXkmd3Ga8cMhtYlGHgDGZ6S5wiWcEROySM4djVoHYKO25k8WN6eOGktaE+KS9gVLPMujh0C6U6x4jQGSz3xKFh3hrPoLHbno5Ce7i254CfzQboRPFF2U5eA9vBY2X29eA+Gu8tu/PyQHq4sucxntI7vlpzzNzB0q1hpJqPgjugJwOP0UgvOXgXag+GkcnM+CkGPgiWnMIptP1hPMFzFVGaZrwyF1KFY7gtGkTkPhKFew9lMJZb4V0X9ggH/ZCqvzK/XhNYHxUqT6KUVzsNhaNSwy2ymssqJl0DRuGGP6Uy5nCIFL4CimYb1X2ZOHiUUOWV+dQAUzTWMuHQqI5JHlExkT5lMf14WhmarYsmL3sokI6UcJRLuyUly8k/XgyiaLwoM3OyyJz4PknT3HAWR3T1I8utxN+w1L6CKlooBwEJbn3r7e3NJMrvnaH+R3TNJdn340MW7LykAVNF6NdQOXmvfG576nCTDk+f2FZ48k+TU53520HrDUasm6KVipgAgi297xp1vdZJk9pSj3UROyYNkfPrIZXssWwGAmCl6u5qhdshq373hia9IMjx5jjYROXmQ5OwXf3fcJvMBgJipoK+KmQKALbr9OXe+6ySZk+fo3yJyctZO/uvVY5YbAABipujzomYCAEPWOuxnz8wkyUgpR/RLkT1lkux69/bTN59fAMBMBf2nWqUAYEvsceH9k4IkPXlEvxI5pSDJGeN+ctAaQwBAKlP0w6KVoXbkZqf8+a25JBnJc/QHkT05SfqEhy/Za0kFAK1U0J+LVQIAA9c48MZnvwqSkVLOfSmyp0ySs9+8+ZQtRqDWKhW0Q9FKULvYjuc98HEiSXfPfSHcPUjyi6ev++6qHQAgZiJoq1opaodveOTvX55Jktk9Ry/K7k6S/vGDZ++wGGqlMkF7FjMBgGrFMdf8ezJJhiePXpCTB0nOevHXR2w4ErVqinavpqhdeKvTbn+zk8GcokXuJGPiX68YvWIHAIiZoBTVTABg8Cr7/+K1YM6tCA9++uejN1gAtWYqKE0xUwAYtMPdHrkFzjePmA8CiJmiWEXNINjuPebmxY+GAmaqKF4xw1JvMzcp8yyoCUq5A/s2K/PNIRCUs2I9Ntl5PwRFNWoqoymJP4eVlGD4O8xNuhBVWenT9KZkHlZWUDzQpOAOsKKq8DumZgTzatDCuozenFmLF5bhsOZkfjISUlg7MjfnWSssxZpkNMF5LxSFNerrpiT+HFVZCYa/w9wE5zmlBcFj9CZk7gcrLMPNTQluVWBXNCPYuTy0uI5vRuan80GKa89mOMdWBbY+I5pwHxSFrRj1JRtL/Amq0hIMeYu5IedZ5QXBv+gNZX4PVlyGPzQhuHGRXdBYcMZS0ALbr7HMd4ZDCmwb5kac/4aguBWrzmE09CdYeQkWGM/c0KUlBuDFJhxUZIp76Q1kblVkhmsbCc5ZCVpkpzPVlzl+IUh5yQB8h97IawOhpaUKwc8bCc7eAipWUibAiDFPMNhg8OsrVoTAtIzUAKx9zSeMzIYjc+atew4G1IpHTIGhYx7tJN3ZxEhBvnXesgBMS0ZNgNUue5cRKQebGymTM27baQCgViqmwOA975tD5hRspacgXz5zFCAm5SEmwFJnvcGI5Gx5pBz86hdbdACmZaEGdGxz8zQyp2CvDE9kjD16IUBMisEEWPCIsZmRnL04pxyccsM6AqiUgBiAda+dROYU7OXhHuz854EjAdV2JyoYPPqRToZ7sC/mFOT7Fy8PqLY1FSx06ptkeGafDc/B6b9cG1BpW6KY//zJDE/Bvu0p2Hn7OlBpUyI4YDwjebDv55TZ9ZP5oG1JMPDXjJTZT0ZyvrYqtB0Bv2GXsx+NLr6zJKT9GA5jCvavnby5DQmGvMbMfjaic31ouzHswGC/m3geqnZT4UR6/+O8C9J+LmPqfzKfQtutcFH/9GQ7Opi5/3HeBWk3io3I6HcSL4O1G8HIj/uhzF3aDww3sau/cb4wENJ2FEt+wK7oTyJl7gFD+1Vs+Cmze45+ITxlpqOhaMeKJf8wl8GcUs7RrJx6yt6siJySk8z/2ByK9iyCVc//90wGyfDkOUdEXZFTsF73qCsicvbkwdq5467dTKFo16KALbnbeXe8PJPdR/aUUnL3lFIEv/r1dAbJzMf+xghPyd1TSskze5zzzoM/GLNcByCKNq4mANCxxDZHXnHn81NmB+ufcNPyA95hJuk8HPs/1sm6febksbdddewOSw9GrSnavVil6NZGLLf5Nw4/99rf3PzIX+/77bXHbTsCivvpZJDbQXW1Q6/41e333/enX/7HaQfuseGSwxTdSmUqKEMRqypBE20AbmSqmbUMOgSNi1WmIihNEVWrKlMFRK0yQYWT6WTme4Mh0MpURFStqkxFBOVs2IlBOu+HoOgVS0xlMPFHqMpO0DGOzsxDSg+Ku5kYsSG08AxH0p0vDYQUnkB/xTx9OyiKX/AgR8NQ/obvPT4C8p8AQBT/SRT5z8L/lwpWUDggbhsAAHBhAJ0BKsgAyAA+PRyLRCIhoRTqLSAgA8SyN3C3hwAM02MX8d2il4e/fkn7ItYfrX9c/rf+O/uP7L8jXU3lZ8vf7z+8/u7/c/mt/pPUN+Tf9//cvgH/Ur++f1v8he5l+5HqD/kf9T/6/99/f/5Y/9B+2nuX/s/+l9gD+o/2T/w+1J/z/Yq/xX+99gX+Wf4H00/3G+ED+w/7z9s/gS/YD/z+wB/9PUA4Tz+W/iJ7n/Cj8v+PXnX5IfVn7d+43rxY9+sH/R8lP3a/feujs7+MOoR7C/2PfXdx9uP+y9Aj2P+tf6/7gPTu1PvA3sB/qR/uPV3/X+H39f/0n/K9wf+Xf1n/df3r+8fs78kP/F/p/RP9Qf+D/O/AV/MP6l/t/8F+9P+O/////+7z2D/uh7Gf66GuAQjwKVtPdGTQdG1H+IleiNNxogQEniakxbIUCMaBcQCb0Jx9fhYDAtGTw3dt8R8U7umQlwcjJ7n0a7+OiR7TdFM6BcP5xfNoS1D8IEKqRWpGUwrm9kqhhYpIH/xq1ylEZdkcPkKSlwr6csIMEdXES+VBu5vz6PCsmSURoIfBmjTw2faZwbYw1OBfqN7rLVBn/kwVRIH+E/QiRIVQQ8FA+/SCaTBqHvFcyrELol+vYzTCJyQ1Ka5DAa3H9DgER0LmTBj1bXDOeMDE1CTF/kmRZgv6cp7302QFA4R2V4eQY01M+NP8rtNP41axbR97Wfek8bnNcMMiGQjKeNrXHRRrZIJLD8KeuO7etk0bCbdj3ZmEoZFYqU7pqFKLFdm6XSaYgmRB9xqsY7PDp0zackUiuzCbFR6M8FH1w8yXDMho5O+zEtIdbP4Qms8ItPaXkLR/+uaCdByI2dKxqCgHrRAPCCVhelkyadlFvYgE52wBoYmY0kGH9zRQJL77pmbyvsX/+Typa5oRef1LR1VOWy3umKu5ZVK6bClbBOdvyyVs8a7Lefipn2l/nxrm1DHWnOXdYC2sJJiOXlbvXZfUpmcYUb+7YjntRW/bUVoMpK0ctuv5xNn41nzbpSX4hm62ewtm61yAAP77UHOf/OnD0He8TvGS+9eI1vTFg0VkFlC2cNRwBvMGk8Wcjf+DSbe3pgKDhlRUIZ/6g6U6QpNfIJoZSajE4OG4aQa/U0TuMgzIncmaf0/80VvZef4cH6nIULMFOgWvr51ZrHZOwsSVK/I9ZChYuDnizKQiXOUY+X5+ivlT+bksUZMBcUk9F029PnAEcL/gsdJ8MX+EHQ4+NgyX/NZEVtdjdches3yXwXqfuQAslVImkEzSyXWIClifApgsL0XEHqRG6qkxTzJAzJ6m9u7UXT5V7NjKL4jn/2DoBAEZZ1fIY1KGp8+bVyR9grtuYq+3XOSARdrb7MNwhfKlq/lNk/dniDXrIAPoMrKHkiYaJYBmW78llKQkHLqdd+X3W5Ki7b6hmwkYiPnKa8NsGtE96B0JucPm2SNeqpVSPS6/FuZUbbsEOUX+Hciv9Z0szOczzKAwFJFDIuAR9RPq/wM00Jh3ask+V2Y0G9zdDeD18U6tn+w/8+anNDIbBftnOgQmtF33CnHiL2ec6yvPItK34wYpdvDc7hRwblW6mVytc5pkmkYXiqWx74xbXT8fLu1oeKa44vyIHG13BgrCwtprOqkjiajhX2izi5ESulwaTcoM4TIlRlrHZojM7BQGDLztqDsTYmW38aQh/Ei6bTCpuOZqc+bqEBmiFQGLBMW0fcBXnyJ6bCyU+I2kgG5CH77vHugG5gQi1aeBBmunndSswiP6VAvIMrGBSRz9kxnT6EyxaxpIyMTdjosY6y/OdEahoYXhmhl8Qg2PM2bhKvsaao+IkUfUIi+p/ogA1Kj8w5Ih461wrQcH9hg1AeKuBDEABwYyKzDRb0OPM9dLTLeSGwJQg0EfazhhPoEw3uY74do8yw4qzSahDhbRtYDtfvrHtlsomxxvr3FhwUTjIHAanfFhdWCSglyvQ03uXzwHzgT+HPJSTm8nOWKtlLk8Zb3K5/rlmKPGd3m1QzE3NaLQUVlD4bMtpfFu3yp9YPd/TDWUs4UpuOzaA9JFFj/pbDxD8pMRgQaX5illEqAQKcN0kmWB984qFBIPobkCTRGEbYjc6aHS9SJ3odHgLky/kFnfwkbtVgNWRyaU98nG7vEtWYHeX+hAFJ7yQe7qlt0XwwkP9kDlfMrV02VxBrV45qlYLQiULTqn/lTvnhXCv7Ptn8BavHXm2818V+XVQVLei34TdmDEJapvHT5oayrXboUbmlBrnQO0peLATPCO4WdfJzy5zz8IuHiP+1yQAAAe3NmVmgOG/nk6YJy542d8csYGCwidTW/SwpcPSz14nKqXRGjupRBHVWWen6KiV31jV2eQpyrRGU3Hmxva5VdAef/JoPCwC2eG9Frhm6mSN4C/qAAsf4AvcKOkNhi54KwJhQulZeZZXfcwXayIo5nvJFGkO4zMmNV58WsOpFr1e/DEC9zG1cpFAmci9By85XI8/1+KNSjsVfna9yZ+ZstXHxPPNYMyQ44Yn4l3Bqd3udb2k8/CbWZC9fZh4Fij1y1xUysZ4mer9+qH7lhTTQDUpnFO/Lrcr+2qpUNi2VcX2Ez6JsrVIEVrQnsqzP2DsaWQbbEV6OOFhBnGvUhnL1Ln6lpatq3Hm1zpEgHIrezl1/CosA2Ji+/QeYpUmj0ro1Syo0GEWIKoSN6MmnIfjwBMmDc97PRCa6ac1U6LuFzpGIXAAhjQweh0lo5/TYHHKgPn8qIEEftjwcwjZke3DWMAxfH3fRyaJkkErhP1PkwZn29ElDc687hm/dftQOpK7809nq7icMhS05oQGwbWiyPvLiaDfSbHRxuoRhpjjXuCOlcF7GDcQr8qT66APDjiDWqs0COXe9o3f4X+Vh5nAW43GsE6ZaqwniFvIxlALEp/0fitq0NRf0ulHixvUMoGlS1aH9EEdfx7UG9dpse++2LBI5QDonA+0aLODTwAHog0j9A13i+8Qk8BBHBc2FOHKnu7UuZiUBD8JpmnXAiduRNXDuE5K1TazHVw2/oGzvRQJQbCRF+G5wFVkWW3rTIKNaLW9sJtggGJxJLKZCpCYfom65deqFojK9jVN1GxdX/aYLKAOMnwtoQgek2wUbLWI4tW79WnUD6r4YKM8fnaZNkNE8S2SNT96ki6jIo3age4HbH63sEyCgETfaGA4Hx+scnIV+P/9dNwC2hU6KqAlUaC4KoDq0G7F3JO1FH8qQRI5mr0KBkqeG8/1pBoHA7gdnVGNNitfiK/4nGhz9+UFvozxAUrPf0tdhjvGRCCKfucKBhJMA3gmTDuHwVwgP7x2cCa1O/evxWFUbPEkXIxjv4Pp4bLdWc2pZv285dAPdaer669P+YpE0IJuzsDInTruYyw9K8CcoKhwsb7N7DP3/+91dsZS2RxACZVcJNtA9o2usdQviI/aydcm7NovdjBY9laLfPQ3uwBeDbgzFW+fLgwv7YuGdX4v4k++LuGXRxib0Of3lr02aWnrZMJexWJgP1vWXSk0fv3+MQRfzUf33fHiknZ9rTekftvXG4KdodMSEn+avpn4n3pEjTHTYipLDKi//7d1V7SKeVPRd1/rM6I+se2F0XfJ8M31c9l3UtcnU4Vin+V1b2mbKhCfBO8yTsWFX4imPF7wL37EfgBmuXy1c6JJuZpd5XpSZiEWhTjgpXqaHnMH3HZLQUjLgV1ksnn0lheCNITEKERfp4nMOgIyaZAANe5S79mpl2bKLPTRYT1SxtMjj42zcWgLyZeZ2jyI+jGVuZt86dFomMIZqcuxOZghdKPW9r3O4JcxQy98wqeahVvKrzb8ErSohmJ3LGQmMzs0EQGWZ8o7aBzxBIHbTBrVNfmmyhbJFz2DgKP8UOM9V4zeoU29NKgQi5ajb4+x3PUupfATgTh72l25EfCkgngYG2an1Esg1Wc6nF/KxsvomA0wXsJ39NUMYKA7ds9lkTbRh/v60IqdOU64f+SHp2uhG6KtfctFki8z5WS/AiIfkFXYGrdZMYgoUwDJmKhyZxuZlLPzjTB42SSt5dAjtz8ynB/iDH+TPV50bLubKQwZ0Qm5h3tNX2Rm6TLT0f5NvuwwdSN44ZRJ9eWZyrSWW481miE11SfkFSOaKGlS1UX8Py2kF1qyqbkNVAMIGVwc+YQ+Yvm9uqWODFwl0It7Gcx/tS/Du+yJj3wz62gedLoi5Hb8nXuM4e7am18eyya2D5wDD0c2v94e8PpxIp74CtVL/R1m8gV1thYnEMCYjItfrvrx4uPa6fl7b/qI/7bKQLgpF897wn3NyJ/yjVvzNZ3A85ydmDnQDVNyqrt+gtYyhOw9SCBnZmIo2N7I7O3nne192gxiKQoxRveyl2cDpNAdXMr5wvdmY+yrgYOdwLJP0ewMG1k/de/gzM5AoHHf0LDfovg7kf/6Ny+f8s6Xrt1b3YfUTqUoQaTRqQL4Yd1OiY40xiN6pWpVPL9vb76MvOBcl5T+WhK1i7cAFb4FXqWDNhrEsEoriiZUnyhIH7oa9fHnBPKynCdt+PneFBLUStRkbPtORe5iRLxqbnuptbv++uWO3Awealepi9z2nlnTE95fOXz8SEPwmhLLt1GBk6xP2wd1WU9kOPTC3Uk6mEK4H+Pfhi4Khd5356w6jIPYcEDSN86iprtBxtK/59+kn2tGY3kHlcl9P8JcQb5fq4Y7yeuITLQC3AEvKoczcV7ANL8DsnCYhBEj46KFPDMMGYEBVW1cFCMqoqHSKH9M6/52ZHQo3T0cHaDpccqEIt/GLUo9K7dTkabkd7SzQbvODGz7DvKEOKG5cLrSjHvXlQod5QJP2+r9Vr6g2UIAco9Txoi5a5yj5B6AL4u/IqaNfMqWcQbMTycY/bVBvDk1LyY4YCWTxXb+aIl5VQcftR6KjJr75SKAl/VYMe8tp++eWxcgKhRQS0cL6111vGYKHQSJS2nqW6FlzbvtoElYWivlEFS5EwpnZMt0MwmsQ39VQT523XheqyajoLXh5ntwv8RV72d90nIXpWy8k5uXkNxcBESu3fUCoiPUDQQkj4JcyV2jg46GkJjz48id7lv71yrTOxyyfIbhNJEw54bjQERT5GGwb8iGjT/rDgIHvZQxb5JuRigkFKfv+wCTRMGIqXTTNibMHSSBSLWAPVUYbfJToVLmgVAI5NmAShCYDYr9ThLEJ0CXLtjn0kWs1pb5BAx/enEVO7Wv3vk3Wr+4jkH6UnWpEkQl1zIqNv6f5qDkRJf4i9uquPXHNPvrFBSyLyJPcKbrHsyf16SDc7R5uo8qRvqmkYEXiye7cTZUfGxtEj6lzOB6qxX3ZwyeuQFW8OXPS+AWovbfYHIh+4UpHfwKIrPQ+1P3qDp9ffHuAP0qZHlQa8VsIQA4MHhqYD1MgVjmtboe9BooZF0zhl8P/vhbCHQ6QNbSvslK+xIW1phbslt/B3A7bzQ8YTeQSO2m7BXA1khyyO13n6kK+hqASnt4++7RfpfahU0Uk7TNZ0IHumcBNlFekGIoamA4MR0Gz1BNy9JQwPtBHLP5MaA2EfHCQLxflpLydPYbQz0Bk8WcIeltyT1af7eInSbRfA5xpcNLadBnht4H0xqA2/BaiWE8cmYl+X8RF/2gLPVxYEiCb0HoYFLLpWc0MM/iGzdhJkL2T0qU+4jhkScFcI9Sd2o9DBj7tiJgrHV57vw+YA1tKWR4IBtmMzjaILGGNGheuUvAIIDwffTab+HLAwkKPYcg3R6J/lbxbj3ay2Sd8dj1DoL2bT+Hrqs3OpgPjiZlE9Uhq23meNLYXgnXTx8iXJGCjF0tR0PDUM+HAm9rBFZVYe+bt5AJFXuNvWzhPppwqWp0tczRYd93jtwtrgrD3unv7/mMzD6W6k2fduNPBW3PnNXhQtDJ21XJ27N/nw9l4Msuslg2WiFS1vqmt4DIkDKRYnULoMmLVIfB80WU6LN3tMiap/twNk0NfrxmGznIJKZ9yoQktf10Lj8aDZs8S6upPXON7C3O97TpKNYgZ7sv205bXtZkZqHdXKA24C0+44XHXnGC6nTVfZQLrccAUyOsv0b2LyPWoTPMitAkZJejY7NDkaTt3t53PrKdKcAFw/vHQPL84Hfb6cdGQX9GSubxZPIan58k9yXJkguziWec157G5UjyBRdGRWF2qRcIAcWmWDb9zpNzotl8f6GbmWs/rOO68YlnMn2FeZkf8el8OSw/xWWQ8dKP4tp1Fo9pDjHaOqCFdHMEd5zr0EXZUbNGWxmCffKNZF4qORk9cLrBzJWKI0J/pLQ1QSUpKBTh6oioyt0o93BAjFA3d5WAqwTWOZA4NXT2Ay8jTJE4yKY/Z5umGeAJeWZlNJ7tDa78fv2Tiu2MkN3zsZPR2VRpvy7tq9V2uuy2dsOVyujYTXuCHNoQbeW/WXTFnuA2/B8NwBMHF9vUDFSAo6sU+8tnReQu6F8SN8XkHb1nQT15sAru1l16B+vGop735KwqoyjOlI5upVptEitmHzxANSG6arVd2RviZF+7uEoSWIRG/JNt1V9T+uZJVGlRaOhQVw3pM4mgFjFiJqTq+y1toTAzTbnjl33t+/QdzqfpA5XO3mHav3v6IV3r4Wuys04dYwo6/IXZHN6psYcSlVSNZGu8q+48ZSj6IB+tf2u4fCakH+OdXJyexApr8PwI7gAF3c/VYJQKGalt+bvo/v0s8kXKEKn7vBz0D2rFCp6ACTTz8hrYnbpFPbMD0HIeFvqtBCl5ax60I904ksbwwc7Rc9Jaxn0I/Vk39dqtwQe7dI1C3AgaIe+8kAbBvrNpjRXVj2B18/txtUJNQmuAehqyag8c/JfoxmJ1MGNofWnam49qTzEMcywkua8GUkEQShHjE7sTME65txkZMDgbjEFVTI/F6IfIZmyn4e/FkT2dWLQLnvh+cITqmfsf8dHBx9otskuidN1su4B/GPneV6wO0XNAAc6k/bL89LyHPmcvNFrLM8ls/bpBl+W3FocQUQlnyIi+k4TcqiKP+maD0yulVDem6bMADXMJfQz6dJ2BCKU7f3wWb3ZKtVG/TfNyBRgItwLofPGtF3CvTIXvJzwkuH9fDFKzph1d+dDev//NrNWBzeU3zhCkB1CA3ANWz5Pn2pdKneAACtVqkAAKRvnrY6LjsS8qGNKPEA+JtOKTsx64abmJZdr03f+wIhbTCMBM9fwRvB++hnjxWrxaAGUmlqE3Du9/DOK8m1Cu0SNc40aY83SvQM8FwQrX03w8nZuocbOKmj2Y3vhSi/oAcMgR3axkxQmcBjO1NjEAw0HAV7ajp6taLHd3D8zCWPLPDIY8XKB1OA0QJZMj+Htb7RofU53/6gtcIeiByeeM07c9x8DdFH/SD7Efmj6ydYRz2rIEIf7rLAfA9YSo35zB3eTIRSKgPryyRyHBV/8AAAADwrGNGi+h8fzJ2OncSHNuYKd+Cs2TQt63jVYk+hbJQCC4vv9/H5dj5du6uCfKzFTZlftVXzujxUii4zj/JpPMuaJiR7o9+mKwpdAT5ZnWAYZR6UWw+CKsuZWM+f9Ef6OaBb5IcV/p+Q0RuWP14r696So3wG0ycEjDo8Ra/gz72fQ4H88sbixAO6TviafJ1ZiDnijIoC/eY8x3LWchddQFEEXpVgEMLzoPGjjrh7PKv7CpJcPs8Co9wGnv8qZ3z+w1O9dz+AYc3NubBrAGiTkMs9rPnKFeGIp93y2Fbqr9NDogIt8FhbDZICh3ps7BW8AmYIj+HhWHuEFml4ILf8Gb0XsJIO1sinIEGVl9E/CrtC8w0FMbkRXwlMAohoHgLaWxXMDH071U0WwnPcsXZdVfzImX+AglKkUkwtI2hE/qOUVFZ72nlhCqZ1a/ANYV2SK8SeNPywfiLrvA/X7PaUS9vDpKmIv1AmDa1rbVvKAzdg08AHPddD77BUqsO2wMVmPgr/3pyITRjbN2y+OVDp1aBRSOpUoRtuzd4yyDdyCIpfw35/fuV7oyyHDT7FVOhU5pBs3giNlkPenG8/BUV+0hgV/QVrzsQrx+2mv0LXguf59G7m4vLjQ8jrT9IF7C5J1vmbJzKV1qlcVh0OQ/S93rtqruNZk73XOxIpZ0u8QT8MGP4dISTJLKX1RYTzCIKaf1HfensWq5j+uYEqpjedbsMNsSv+TZ4RoL+lDgOVWsKscVykO+zGqxxwKo6gfduM4dxDuro8b4jZcW+cmbH6waiITJpr62Kgeh0nhJ64MVAu/kcx8s/fvkAHcKoy/9mUJqlMRvx8/YFxPV98P1VJf7X1e+kyn7rBuWU+zwD5p7zn7StNj2jhMEqr7IAtE6yJ9OBdd8dAqgAA+vigx3BVJmhIyQ0FQg4PVH52cC12btRc1hfyu8fl63Z228FaumLbiVLao6xX4hIIeGkMC3g+qCqGB4bS94jKTAyHvTiYPDiFDnjSMr4vZ5+7hdG0XHeNs0HvOZU0fzfJcaY55MZ7YTAPTbGleruI3+Nci0RtRMrv7x7NQoXme5BgkdbkpD3ngIBKK4dE4c9pdY4fnpqRcy+1dqX2IW/F+O6dm1ZaJYWjHWtqqrYBDxht02ytNuJUF3z8Ad5A3cqBqYVUDBO5RcFsWklnF0KQaoRdO339mFpLKszr6yDibNHrev3wKp2aZR6y13M0iA1U3RS+QLxBcO6L5XnQCSHvP5/4xWc7OwP7pZMMSxZM2TlpGSAp8R0JNE1QFfgcHWIqNW6UTv/Uwschn90pqfQESKMRJooVQOVFLVCpF4stPQtGXoLAb5HXtW1shrjhDXK7YKM1rKFKWXi7oS76GWiqO34pS1+UNGBPHDDJYEXVsrMmTCAS9kFw7JF51zr8pfPRG9QcrcBA9EVdUEjsyu929Fc9eYxLrNQE6e7dGRzuAYmjbhomfUxvRvG0sALpCd8PVV74gvbJPGyJc84as9UA8K6oaMYoROkv/luK57HRoqXyL7b+4RxLNXacsmqIVly91K0VZ9SKG97aul86LmW2mAtP2W2X6eojFKjZePZYe90bwY7ZZRtXEVZ04MN+tt8/bq7QHk+sF/uZAVbr3BxrqmUBK9taL7essmjfCGck/dbspjO9hmE1U5Y7TceEwZDd+c8zHh6pQ2RxaKr8AxYb8P/Yy5Vgl4PhMi2IIWIjqyp1foM4HutLc6JiajdqSMxBUbSdEnRrnfK0cdKEpq3Mwx7lMRBarxxhd97vpvTx1QlSPiDOlnEakKyvqoFU2kuozc4exJfeXQyKxwFpc873W0BD5muZ080UGpoGi3S1yBVaf6jjcmTOuv+zqNIppiyC1nksv7BJPPovkw9jTjqw3Ed0MJxI0i+2hM9Udkq1R8SlaNi3ALj5J6sFNKUcqHzNzEDUqaAAAAAAA","ship2":"data:image/webp;base64,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","ship3":"data:image/webp;base64,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","ship4":"data:image/webp;base64,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","ship5":"data:image/webp;base64,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","title_bg":"data:image/webp;base64,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"};
</script>
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
/* 화면 방향 — 세로(1945식)는 게임 판을 90° 돌려 그립니다.
 * 게임 규칙·서버는 그대로이고 그리는 방향만 바뀌므로, 한 방 안에서도 사람마다 달리 볼 수 있습니다.
 * 세로일 때: 게임 판의 앞(+x)이 화면 위, 게임 판의 위(-y)가 화면 왼쪽입니다. */
let VERT = localStorage.getItem('sky.vert') !== 'h';
let VW = F.w, VH = F.h;              // 화면에 보이는 판의 가로·세로(논리 단위)
const UP = () => (VERT ? Math.PI / 2 : 0);   // 글자를 화면에 똑바로 세우려면 이만큼 돌립니다
/* 비행기·총알 그림 크기 배율 — 맞는 판정(히트박스)은 그대로이고 그림만 커집니다.
 * 'auto' 는 세로 판이 작게 보이는 기기(가로로 긴 태블릿·모니터)에서 저절로 키웁니다. */
let SIZE_PICK = localStorage.getItem('sky.size') || 'auto';
let ZS = 1;
function calcZS() {
  ZS = SIZE_PICK === 'auto' ? (VIEW.s < .5 ? 1.4 : VIEW.s < .62 ? 1.25 : 1) : (+SIZE_PICK || 1);
}
function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth, h = window.innerHeight;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  cv.style.width = w + 'px'; cv.style.height = h + 'px';
  VW = VERT ? F.h : F.w; VH = VERT ? F.w : F.h;
  const s = Math.min(w / VW, h / VH);
  VIEW = { s, ox: (w - VW * s) / 2, oy: (h - VH * s) / 2, w, h, dpr };
  document.body.classList.toggle('vert', VERT);
  calcZS();
}
window.addEventListener('resize', resize);
resize();
// 화면 좌표 → 게임 판 좌표
function toField(cx, cy) {
  const lx = (cx - VIEW.ox) / VIEW.s, ly = (cy - VIEW.oy) / VIEW.s;
  return VERT ? { x: F.w - ly, y: lx } : { x: lx, y: ly };
}
// 세계를 화면 방향에 맞게 돌립니다 (그리기 직전에 한 번)
function worldTransform(g) { if (VERT) { g.translate(0, F.w); g.rotate(-Math.PI / 2); } }

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
/* ── Canva 그림 불러오기 ──
 * 그림 스타일 'canva'(기본) 이면 Canva 로 만든 그림을, 'draw' 면 코드로 그린 그림을 씁니다.
 * 그림이 다 읽히기 전이나 읽기에 실패하면 코드로 그린 그림으로 저절로 대신합니다. */
const ART_IMG = {};
let ART_ON = localStorage.getItem('sky.art') !== 'draw';
let artReady = false;
(function loadArt() {
  const src = window.SKY_ART || {};
  const keys = Object.keys(src);
  let left = keys.length;
  const done = () => { if (--left <= 0) { artReady = true; spriteCache.clear(); if (window.__artChanged) window.__artChanged(); } };
  for (const k of keys) {
    const im = new Image();
    im.onload = () => { ART_IMG[k] = im; done(); };
    im.onerror = done;
    im.src = src[k];
  }
})();
const artOf = (k) => (ART_ON && artReady && ART_IMG[k]) || null;
// 그림(위쪽이 기수)을 판에 옮깁니다. rot: 돌릴 각도, size: 긴 쪽 길이
function drawArt(g, im, rot, size) {
  const k = size / Math.max(im.width, im.height);
  g.save(); g.rotate(rot || 0);
  g.drawImage(im, -im.width * k / 2, -im.height * k / 2, im.width * k, im.height * k);
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

// 땅에 떨어지는 그림자판 — 그림 모양 그대로 까맣게 칠한 판을 한 번만 만들어 둡니다
const shadowCache = new WeakMap();
function shadowOf(spr) {
  let c = shadowCache.get(spr);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = spr.width; c.height = spr.height;
  const g = c.getContext('2d');
  g.drawImage(spr, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
  c._w = spr._w; c._h = spr._h;
  shadowCache.set(spr, c);
  return c;
}
function dropShadow(g, spr, x, y, ang, sc) {
  if (!GFX.hi && spr._w < 100) return;
  const k = bgZone === 9 ? 0 : bgZone === 8 ? .12 : .3;
  if (!k) return;
  const sh = shadowOf(spr), s2 = (sc || 1) * .8;
  g.save(); g.translate(x + SHADOW.x, y + SHADOW.y); if (ang) g.rotate(ang);
  g.globalAlpha = k;
  g.drawImage(sh, -sh._w / 2 * s2, -sh._h / 2 * s2, sh._w * s2, sh._h * s2);
  g.restore();
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
// 기체 6종의 생김새. 색 번호 = 기체 번호 (sim.js 의 SHIP_TYPES 와 같은 순서)
const SHIP_FORM = [
  { wing: 'ellipse', span: 36, chord: 1,   nose: 26, guns: [-17, 17],            props: [[36, 0]] },           // 하늘매: 균형형
  { wing: 'straight', span: 40, chord: 1.1, nose: 24, guns: [-26, -14, 14, 26],   props: [[34, 0]] },           // 노을부채: 넓은 날개·기관총 4정
  { wing: 'swept', span: 32, chord: .9,   nose: 34, guns: [-8, 8],              props: [[44, 0]] },           // 숲창: 긴 기수
  { wing: 'ellipse', span: 28, chord: .8, nose: 22, guns: [-12, 12],            props: [[32, 0]], small: 1 }, // 보라벌: 작고 날렵
  { wing: 'straight', span: 38, chord: 1.2, nose: 22, guns: [-5, 5], nacelles: [-18, 18], props: [[30, -18], [30, 18]] }, // 분홍망치: 쌍발
  { wing: 'straight', span: 38, chord: 1.1, nose: 26, guns: [-17, 17], bombs: [-26, -9, 9, 26], props: [[36, 0]] }, // 금빛독수리: 폭탄 달린 전폭기
];
function drawShipArt(g, C, ti) {
  if (ti === undefined) ti = Math.max(0, SHIP_COLORS.indexOf(C));
  const Fm = SHIP_FORM[ti % 6], W = Fm.span, ch = Fm.chord, N = Fm.nose;
  // 위에서 내려다본 2차대전식 프로펠러기. 오른쪽(+x)이 기수입니다.
  const wingG = g.createLinearGradient(0, -W, 0, W);
  wingG.addColorStop(0, C.body); wingG.addColorStop(.45, C.deep); wingG.addColorStop(.55, C.deep); wingG.addColorStop(1, C.body);
  g.fillStyle = wingG;
  g.beginPath();
  if (Fm.wing === 'ellipse') {
    g.moveTo(10 * ch, -5);
    g.bezierCurveTo(12 * ch, -W * .6, 6 * ch, -W, -2, -W);
    g.bezierCurveTo(-8 * ch, -W, -10 * ch, -W * .66, -9 * ch, -5);
    g.lineTo(-9 * ch, 5);
    g.bezierCurveTo(-10 * ch, W * .66, -8 * ch, W, -2, W);
    g.bezierCurveTo(6 * ch, W, 12 * ch, W * .6, 10 * ch, 5);
  } else if (Fm.wing === 'swept') {
    g.moveTo(12, -5); g.lineTo(-8, -W); g.lineTo(-16, -W); g.lineTo(-8, -5);
    g.lineTo(-8, 5); g.lineTo(-16, W); g.lineTo(-8, W); g.lineTo(12, 5);
  } else {
    g.moveTo(10 * ch, -5); g.lineTo(6 * ch, -W); g.lineTo(-6 * ch, -W); g.lineTo(-9 * ch, -5);
    g.lineTo(-9 * ch, 5); g.lineTo(-6 * ch, W); g.lineTo(6 * ch, W); g.lineTo(10 * ch, 5);
  }
  g.closePath(); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 1; g.stroke();
  // 날개 기관총
  g.fillStyle = '#2a2f3a';
  for (const y of Fm.guns) g.fillRect(8 * ch, y - 1, 8, 2);
  // 날개 밑 폭탄
  for (const y of Fm.bombs || []) { g.fillStyle = '#3a3f2a'; g.beginPath(); g.ellipse(0, y, 8, 3, 0, 0, TAU); g.fill(); g.fillStyle = '#c8b040'; g.fillRect(-9, y - 3, 2, 6); }
  // 날개 표식
  for (const y of [-W * .66, W * .66]) {
    g.fillStyle = C.trim; g.beginPath(); g.arc(1, y, 5, 0, TAU); g.fill();
    g.fillStyle = C.deep; g.beginPath(); g.arc(1, y, 3.1, 0, TAU); g.fill();
    g.fillStyle = C.trim; g.beginPath(); g.arc(1, y, 1.3, 0, TAU); g.fill();
  }
  // 쌍발 엔진 덮개
  for (const y of Fm.nacelles || []) {
    g.fillStyle = '#2b3242'; g.beginPath(); g.roundRect(-14, y - 5, 42, 10, 4); g.fill();
    g.fillStyle = C.trim; g.beginPath(); g.moveTo(28, y - 3.5); g.quadraticCurveTo(33, y, 28, y + 3.5); g.closePath(); g.fill();
    g.fillStyle = 'rgba(220,230,240,.22)'; g.beginPath(); g.ellipse(30, y, 2, 13, 0, 0, TAU); g.fill();
  }
  // 꼬리 날개
  const tl = Fm.small ? 26 : 30;
  g.fillStyle = C.deep;
  g.beginPath();
  g.moveTo(-tl + 8, -2); g.bezierCurveTo(-tl + 6, -9, -tl + 2, -14, -tl - 1, -14); g.lineTo(-tl - 3, -12); g.lineTo(-tl, -2);
  g.lineTo(-tl, 2); g.lineTo(-tl - 3, 12); g.lineTo(-tl - 1, 14); g.bezierCurveTo(-tl + 2, 14, -tl + 6, 9, -tl + 8, 2);
  g.closePath(); g.fill();
  // 동체
  const fw = Fm.small ? 5.5 : 6.5;
  const body = g.createLinearGradient(0, -8, 0, 8);
  body.addColorStop(0, '#ffffff'); body.addColorStop(.3, C.body); body.addColorStop(.75, C.deep); body.addColorStop(1, '#1a2238');
  g.fillStyle = body;
  g.beginPath();
  g.moveTo(N, -fw);
  g.bezierCurveTo(10, -fw - 1.5, -16, -fw + .5, -tl - 4, -2.2);
  g.lineTo(-tl - 4, 2.2);
  g.bezierCurveTo(-16, fw - .5, 10, fw + 1.5, N, fw);
  g.closePath(); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 1; g.stroke();
  if (!Fm.nacelles) {
    // 엔진 덮개·배기구·스피너
    g.fillStyle = '#2b3242';
    g.beginPath(); g.roundRect(N - 6, -fw - .3, 7, fw * 2 + .6, 2); g.fill();
    g.fillStyle = '#555c6c';
    for (const y of [-fw - .7, fw - .5]) for (let k = 0; k < 3; k++) g.fillRect(N - 14 + k * 3, y, 2, 1.4);
    g.fillStyle = C.trim;
    g.beginPath(); g.moveTo(N + 1, -4.5); g.quadraticCurveTo(N + 8, -2, N + 9, 0); g.quadraticCurveTo(N + 8, 2, N + 1, 4.5); g.closePath(); g.fill();
    g.fillStyle = 'rgba(220,230,240,.22)';
    g.beginPath(); g.ellipse(N + 10, 0, 2.2, 17, 0, 0, TAU); g.fill();
  } else {
    g.fillStyle = '#9fd8ff'; g.beginPath(); g.ellipse(N - 2, 0, 5, 4, 0, 0, TAU); g.fill();   // 유리 기수
  }
  // 조종석 유리
  const cg = g.createLinearGradient(-6, -4, 2, 4);
  cg.addColorStop(0, '#ffffff'); cg.addColorStop(.4, '#a8dcff'); cg.addColorStop(1, '#1d3f6e');
  g.fillStyle = cg;
  g.beginPath(); g.ellipse(-3, 0, 8, 4.2, 0, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(30,40,60,.6)'; g.lineWidth = .8;
  g.beginPath(); g.moveTo(-3, -4); g.lineTo(-3, 4); g.stroke();
  g.fillStyle = 'rgba(255,255,255,.8)'; g.beginPath(); g.ellipse(-1, -1.8, 3, 1.1, 0, 0, TAU); g.fill();
  g.fillStyle = C.trim; g.fillRect(-tl + 6, -3.4, 3, 6.8);
}
// 도는 프로펠러 (위에서 보면 기수 앞의 세로 막대가 깜빡이며 길이가 변합니다)
function drawProp(g, x, y, ang, sc, t, ti) {
  if (ti !== undefined && artOf('ship' + (ti % 6))) return;   // Canva 그림에는 프로펠러가 그려져 있음
  const props = ti === undefined ? [[36, 0]] : SHIP_FORM[ti % 6].props;
  g.save(); g.translate(x, y); g.rotate(ang); g.scale(sc, sc);
  g.strokeStyle = 'rgba(30,30,36,.7)'; g.lineWidth = 2.2;
  for (const [px, py] of props) for (let k = 0; k < 3; k++) {
    const l = Math.cos(t * 40 + k * 2.09 + py) * (py ? 13 : 17);
    g.beginPath(); g.moveTo(px, py); g.lineTo(px, py + l); g.stroke();
  }
  g.restore();
}
const shipSprite = (ci) => {
  const im = artOf('ship' + (ci % 6));
  if (im) return sprite('shipC' + (ci % 6), 92, 92, (g) => drawArt(g, im, Math.PI / 2, 86));   // 위쪽 기수 → 오른쪽
  return sprite('ship' + ci, 92, 92, (g) => drawShipArt(g, SHIP_COLORS[ci % 6], ci % 6));
};

/* ── 적 그림들 (모두 왼쪽을 향합니다) ── */
const ART = {};
// 적 비행기 공통 부품 (오른쪽을 보고 그린 뒤 좌우를 뒤집어 왼쪽을 보게 합니다)
function emblem(g, x, y, r) {   // 적 표식: 주황 테두리 안의 검은 마름모 (실제 나라 표식은 쓰지 않습니다)
  g.fillStyle = '#ff8a2a'; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  g.fillStyle = '#1b1b22'; g.beginPath(); g.moveTo(x + r * .62, y); g.lineTo(x, y - r * .62); g.lineTo(x - r * .62, y); g.lineTo(x, y + r * .62); g.closePath(); g.fill();
}
function propDisc(g, x, y, r) { g.fillStyle = 'rgba(210,215,225,.28)'; g.beginPath(); g.ellipse(x, y, 1.8, r, 0, 0, TAU); g.fill(); }
function enemyPlane(g, o) {
  g.save(); g.scale(-1, 1);
  const L = o.len, W = o.span;
  const wg = g.createLinearGradient(0, -W, 0, W);
  wg.addColorStop(0, o.light); wg.addColorStop(.5, o.body); wg.addColorStop(1, o.light);
  // 주 날개 (곧은 날개, 끝이 살짝 좁음)
  g.fillStyle = wg;
  g.beginPath();
  g.moveTo(o.wx + o.chord, -3); g.lineTo(o.wx + o.chord * .7, -W); g.lineTo(o.wx - o.chord * .15, -W);
  g.lineTo(o.wx - o.chord * .3, -3); g.lineTo(o.wx - o.chord * .3, 3); g.lineTo(o.wx - o.chord * .15, W);
  g.lineTo(o.wx + o.chord * .7, W); g.lineTo(o.wx + o.chord, 3); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = 1; g.stroke();
  // 엔진(날개 위)
  for (const y of o.engines || []) {
    g.fillStyle = o.dark; g.beginPath(); g.roundRect(o.wx - 4, y - 3.6, o.chord + 10, 7.2, 3); g.fill();
    propDisc(g, o.wx + o.chord + 8, y, 10);
  }
  // 꼬리
  g.fillStyle = o.body;
  g.beginPath(); g.moveTo(-L * .5 + 6, -2); g.lineTo(-L * .5 - 1, -o.tail); g.lineTo(-L * .5 - 6, -o.tail); g.lineTo(-L * .5 - 3, 0);
  g.lineTo(-L * .5 - 6, o.tail); g.lineTo(-L * .5 - 1, o.tail); g.lineTo(-L * .5 + 6, 2); g.closePath(); g.fill();
  // 동체
  const bg = g.createLinearGradient(0, -o.fw, 0, o.fw);
  bg.addColorStop(0, o.light); bg.addColorStop(.5, o.body); bg.addColorStop(1, o.dark);
  g.fillStyle = bg;
  g.beginPath(); g.moveTo(L * .5, -o.fw * .7); g.quadraticCurveTo(L * .5 + 5, 0, L * .5, o.fw * .7);
  g.lineTo(-L * .5, o.fw * .3); g.lineTo(-L * .5, -o.fw * .3); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.4)'; g.stroke();
  if (o.glassNose) { g.fillStyle = '#9fd8ff'; g.beginPath(); g.ellipse(L * .5 - 3, 0, 6, o.fw * .55, 0, 0, TAU); g.fill(); }
  else { propDisc(g, L * .5 + 5, 0, o.prop || 13); g.fillStyle = o.nose || '#c8b040'; g.beginPath(); g.arc(L * .5 + 1, 0, 3, 0, TAU); g.fill(); }
  // 조종석
  g.fillStyle = '#2d4a6a'; g.beginPath(); g.ellipse(o.cx, 0, o.fw * .9, o.fw * .45, 0, 0, TAU); g.fill();
  g.fillStyle = 'rgba(255,255,255,.55)'; g.beginPath(); g.ellipse(o.cx + 1, -1, o.fw * .4, o.fw * .15, 0, 0, TAU); g.fill();
  for (const y of o.emblems || []) emblem(g, o.wx + o.chord * .25, y, o.er || 4);
  g.restore();
}
ART.scout = (g) => enemyPlane(g, { len: 44, span: 22, chord: 12, wx: 2, fw: 5, tail: 8, cx: -2,
  body: '#5f6e45', light: '#8a9a66', dark: '#343c26', emblems: [-14, 14] });
ART.wasp = (g) => enemyPlane(g, { len: 34, span: 16, chord: 9, wx: 1, fw: 4.5, tail: 6, cx: -3, prop: 10,
  body: '#4a5262', light: '#7a8496', dark: '#262b36', nose: '#ffd166', emblems: [-10, 10], er: 3 });
ART.bomber = (g) => enemyPlane(g, { len: 66, span: 40, chord: 14, wx: 2, fw: 7, tail: 14, cx: 14, glassNose: true,
  body: '#6a7058', light: '#9aa084', dark: '#3a3e30', engines: [-15, 15], emblems: [-30, 30], er: 5 });
ART.sniper = (g) => {   // 쌍동체 전투기
  g.save(); g.scale(-1, 1);
  const bg = g.createLinearGradient(0, -22, 0, 22);
  bg.addColorStop(0, '#9a86c8'); bg.addColorStop(.5, '#4e3f7a'); bg.addColorStop(1, '#9a86c8');
  g.fillStyle = bg;
  g.beginPath(); g.roundRect(-4, -30, 16, 60, 4); g.fill();                   // 날개
  g.fillStyle = '#4e3f7a';
  for (const y of [-12, 12]) { g.beginPath(); g.roundRect(-30, y - 3.5, 50, 7, 3.5); g.fill(); propDisc(g, 22, y, 11); }
  g.fillStyle = '#3b2f60'; g.fillRect(-32, -16, 6, 32);                         // 꼬리 연결
  g.fillStyle = '#7a63c0'; g.beginPath(); g.ellipse(6, 0, 14, 5, 0, 0, TAU); g.fill();   // 가운데 조종실
  g.fillStyle = '#9fd8ff'; g.beginPath(); g.ellipse(10, 0, 6, 3, 0, 0, TAU); g.fill();
  emblem(g, 4, -24, 4); emblem(g, 4, 24, 4);
  g.restore();
};
ART.kami = (g) => {   // 급강하 폭격기 — 빨갛게 달아오른 기수
  enemyPlane(g, { len: 40, span: 18, chord: 11, wx: 0, fw: 5, tail: 7, cx: 0,
    body: '#a8402a', light: '#e07a50', dark: '#5a1a10', nose: '#ffd166', emblems: [-12, 12], er: 3.4 });
  const b = g.createRadialGradient(-22, 0, 1, -22, 0, 12);
  b.addColorStop(0, 'rgba(255,240,160,.9)'); b.addColorStop(1, 'rgba(255,120,40,0)');
  g.fillStyle = b; g.beginPath(); g.arc(-22, 0, 12, 0, TAU); g.fill();
};
ART.missile = (g) => enemyPlane(g, { len: 76, span: 44, chord: 15, wx: 4, fw: 8, tail: 16, cx: 18, glassNose: true,
  body: '#5a6474', light: '#8e98aa', dark: '#2c3240', engines: [-13, -28, 13, 28], emblems: [-38, 38], er: 4.5 });
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
// Canva 그림이 있는 적과 그 크기 (판정 반경보다 조금 크게)
const ENEMY_IMG = { scout: 56, wasp: 44, bomber: 88, missile: 100, sniper: 76, kami: 52 };
const enemySprite = (art) => {
  const im = ENEMY_IMG[art] && artOf('e_' + art);
  if (im) return sprite('eC_' + art, ENEMY_IMG[art] + 6, ENEMY_IMG[art] + 6, (g) => drawArt(g, im, -Math.PI / 2, ENEMY_IMG[art]));   // 기수 → 왼쪽
  return sprite('e_' + art, 90, 90, (g) => (ART[art] || ART.scout)(g));
};

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

/* ═══════════ 위에서 내려다본 땅 (1945 스타일) ═══════════
 * 지역마다 바다·섬·협곡·도시·설원·사막·용암·빙하·구름바다를 한 장 그려 두고
 * 오른쪽에서 왼쪽으로 흘려 보냅니다. 가로로 주기가 딱 맞는 잡음만 써서 이음매가 없습니다.
 * 반 해상도(800×450)로 만들어 2배로 늘려 찍습니다 — 만드는 시간이 1/4 입니다. */
const GW = 800, GH = 450, GS = F.w / GW;
function periodicNoise(seed) {
  const r = S.mulberry32(seed), T = new Float32Array(8192);
  for (let i = 0; i < T.length; i++) T[i] = r();
  const hsh = (i, j, P, o) => T[(((((i % P) + P) % P) * 92821) ^ ((j + o * 977) * 68917)) & 8191];
  const one = (x, y, P, o) => {
    const cs = GW / P, fx = x / cs, fy = y / cs, ix = Math.floor(fx), iy = Math.floor(fy);
    let tx = fx - ix, ty = fy - iy; tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
    const a = hsh(ix, iy, P, o), b = hsh(ix + 1, iy, P, o), c = hsh(ix, iy + 1, P, o), d = hsh(ix + 1, iy + 1, P, o);
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
  return (x, y) => one(x, y, 5, 0) * .5 + one(x, y, 10, 1) * .25 + one(x, y, 20, 2) * .15 + one(x, y, 40, 3) * .1;
}
const hex3 = (h) => rgbOf(h);
function ramp(stops) {   // [[위치, '#색'], …] → n 에 맞는 색
  const S2 = stops.map(([p, c]) => [p, hex3(c)]);
  return (n) => {
    if (n <= S2[0][0]) return S2[0][1];
    for (let i = 1; i < S2.length; i++) if (n <= S2[i][0]) {
      const [p0, c0] = S2[i - 1], [p1, c1] = S2[i], k = (n - p0) / (p1 - p0);
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k];
    }
    return S2[S2.length - 1][1];
  };
}
const ISLAND = ramp([[0, '#0a3560'], [.44, '#12609a'], [.52, '#2a9cc2'], [.545, '#6fd0d8'], [.56, '#e6d49a'], [.585, '#6ca848'], [.7, '#3b7a32'], [.82, '#5f6a4a'], [.92, '#9a9480'], [1, '#e8e8e2']]);
const GROUND = {
  dawn:    { sea: .555, col: ISLAND, shift: -.03, tint: [255, 200, 150, .10] },
  cloud:   { sea: .555, col: ISLAND, shift: -.06 },
  sunset:  { col: ramp([[0, '#3a1616'], [.3, '#6b2c20'], [.45, '#a24e2e'], [.55, '#c9763f'], [.66, '#a4512f'], [.8, '#e0a060'], [1, '#f2cc94']]), river: '#2e6e8e' },
  night:   { sea: .43, col: ramp([[0, '#040c20'], [.43, '#0a1e3e'], [.44, '#1a2030'], [1, '#1e2536']]), city: true },
  aurora:  { lake: .36, col: ramp([[0, '#4f86a8'], [.36, '#8cc0d8'], [.38, '#f2f6fa'], [.6, '#dfe8f0'], [.64, '#2d4a3e'], [1, '#1f3830']]), speckle: .64 },
  desert:  { col: ramp([[0, '#2e8a9e'], [.22, '#3fa0a8'], [.24, '#4f8a3a'], [.28, '#c9a060'], [.5, '#e0bc78'], [.7, '#d2a864'], [.74, '#8a5a33'], [1, '#6a4428']]), dunes: true },
  volcano: { col: ramp([[0, '#120c0c'], [.5, '#2a1e1c'], [.8, '#3e2c28'], [1, '#54403a']]), lava: true },
  glacier: { sea: .5, col: ramp([[0, '#08243e'], [.5, '#15466a'], [.505, '#8ec4dc'], [.53, '#dcecf6'], [1, '#ffffff']]) },
  strato:  { col: ramp([[0, '#10254a'], [.36, '#1d3f6e'], [.4, '#9fb8d8'], [.48, '#dfe8f4'], [1, '#ffffff']]), cloudy: true },
};
const groundCache = new Map();
function groundTile(zone) {
  const Z = S.ZONES[zone] || S.ZONES[0];
  const D = GROUND[Z.key];
  if (!D) return null;
  if (groundCache.has(zone)) return groundCache.get(zone);
  if (groundCache.size > 2) groundCache.delete(groundCache.keys().next().value);   // 메모리 아끼기
  const c = document.createElement('canvas'); c.width = GW; c.height = GH;
  const g = c.getContext('2d');
  const img = g.createImageData(GW, GH), px = img.data;
  const nz2 = periodicNoise(77 + zone * 13);   // 강·용암 줄기 (모양만, 규칙과 무관)
  const r = S.mulberry32(5 + zone);
  const H = new Float32Array((GW + 1) * (GH + 1));
  for (let y = 0; y <= GH; y++) for (let x = 0; x <= GW; x++) {
    H[y * (GW + 1) + x] = S.terrainHeight(zone, x, y);   // sim.js 와 똑같은 땅 — 군함이 바다에 뜨도록
  }
  const sea = new Uint8Array(GW * GH);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    const i = y * (GW + 1) + x, n = H[i];
    let [R, G2, B] = D.col(n);
    // 빛이 왼쪽 위에서 비친다고 보고 기울기로 그늘을 넣어 입체감을 냅니다
    // 3칸 떨어진 두 점의 높이 차로 부드럽게 그늘을 계산합니다(1칸이면 얼룩무늬가 됩니다)
    const ya = y < 3 ? 0 : y - 3, yb = y > GH - 3 ? GH : y + 3;
    const xa = (x + GW - 3) % GW, xb = (x + 3) % GW;
    const slope = H[yb * (GW + 1) + xb] - H[ya * (GW + 1) + xa];
    const isSea = D.sea !== undefined && n < D.sea;
    let sh = isSea ? 1 - clamp(slope * 2, -.15, .15) : 1 - clamp(slope * 5, -.32, .32);
    if (D.river || D.lava) {
      const rv = Math.abs(nz2(x, y) - .5);
      if (D.river && rv < .009) { [R, G2, B] = rgbOf(D.river); sh = 1 - rv * 12; }
      else if (D.river && rv < .016) { R *= .75; G2 *= .8; B *= .65; }
      if (D.lava && rv < .018) { const k = 1 - rv / .018; R = 255; G2 = 90 + 150 * k; B = 20 + 60 * k; sh = 1; }
      else if (D.lava && rv < .05) { const k = 1 - (rv - .018) / .032; R += 150 * k * k; G2 += 40 * k * k; }
    }
    if (D.dunes && n > .28 && n < .72) sh *= .86 + Math.sin(x * .09 + y * .03 + n * 30) * .14;
    if (D.speckle && n > D.speckle && r() < .45) { R *= .6; G2 *= .7; B *= .6; }   // 침엽수림
    if (D.city && n >= D.sea) {   // 도시: 길 사이 블록, 불 켜진 창
      const bx = x % 22, by = y % 18;
      if (bx < 3 || by < 3) { R = 16; G2 = 18; B = 26; if ((bx === 1 || by === 1) && r() < .08) { R = 255; G2 = 210; B = 130; } }
      else { const lit = r() < .035 + (n - .44) * .12; if (lit) { R = 255; G2 = 205 + r() * 40; B = 120 + r() * 60; } else { const v = 30 + r() * 20; R = v; G2 = v + 4; B = v + 16; } }
      sh = 1;
    }
    if (isSea) sea[y * GW + x] = 1;
    const grain = (r() - .5) * 10;
    const o = (y * GW + x) * 4;
    px[o] = clamp(R * sh + grain, 0, 255); px[o + 1] = clamp(G2 * sh + grain, 0, 255); px[o + 2] = clamp(B * sh + grain, 0, 255); px[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  if (D.tint) { g.fillStyle = 'rgba(' + D.tint.join(',') + ')'; g.fillRect(0, 0, GW, GH); }
  // 바다에 배 몇 척 (흰 물살을 끌고 갑니다)
  if (false) {   // (장식용 배는 진짜 군함과 헷갈려서 뺐습니다)
    for (let k = 0, tries = 0; k < 5 && tries < 400; tries++) {
      const x = 40 + r() * (GW - 80), y = 30 + r() * (GH - 60);
      if (!sea[(y | 0) * GW + (x | 0)] || !sea[(y | 0) * GW + ((x + 30) | 0)] || !sea[(y | 0) * GW + ((x - 30) | 0)]) continue;
      k++;
      g.fillStyle = 'rgba(255,255,255,.5)';
      g.beginPath(); g.moveTo(x + 8, y); g.lineTo(x + 40, y - 7); g.lineTo(x + 40, y + 7); g.closePath(); g.fill();
      g.fillStyle = '#5a6272'; g.beginPath(); g.ellipse(x, y, 12, 3.2, 0, 0, TAU); g.fill();
      g.fillStyle = '#8a92a2'; g.fillRect(x - 4, y - 1.5, 6, 3);
    }
  }
  const out = { c, sea };
  groundCache.set(zone, out);
  return out;
}

/* 지역 날씨 — 불씨·눈송이·모래바람·우주 별 흐름 (위에서 본 화면이라 속도선은 뺐습니다) */
const amb = [];
(function seedAmb() {
  const r = S.mulberry32(4242);
  for (let i = 0; i < 70; i++) amb.push({ x: r() * F.w, y: r() * F.h, s: r(), ph: r() * TAU });
})();
function drawWeather(g, zone, T, dt) {
  const k = (S.ZONES[zone] || S.ZONES[0]).key;
  if (k !== 'volcano' && k !== 'glacier' && k !== 'aurora' && k !== 'desert' && k !== 'space') return;
  const n = GFX.hi ? (k === 'space' ? 40 : amb.length) : 20;
  g.save();
  for (let i = 0; i < n; i++) {
    const a = amb[i];
    if (k === 'volcano') {
      a.x -= (100 + a.s * 80) * dt; a.y -= (20 + a.s * 40) * dt;
      if (a.y < -10) a.y = F.h + 10; if (a.x < -10) a.x += F.w + 20;
      g.globalCompositeOperation = 'lighter';
      glowAt(g, '#ff7a30', a.x + Math.sin(T * 2 + a.ph) * 8, a.y, 4 + a.s * 6, .45 + Math.sin(T * 5 + a.ph) * .3);
    } else if (k === 'glacier' || k === 'aurora') {
      a.x -= (170 + a.s * 160) * dt; a.y += (20 + a.s * 26) * dt;
      if (a.y > F.h + 6) a.y = -6; if (a.x < -10) a.x += F.w + 20;
      g.globalAlpha = .4 + a.s * .45; g.fillStyle = '#fff';
      g.beginPath(); g.arc(a.x + Math.sin(T + a.ph) * 6, a.y, 1.4 + a.s * 2.2, 0, TAU); g.fill();
    } else {
      const sand = k === 'desert';
      a.x -= (sand ? 700 + a.s * 600 : 400 + a.s * 700) * dt;
      if (a.x < -120) { a.x = F.w + Math.random() * 200; a.y = Math.random() * F.h; }
      g.globalAlpha = sand ? .16 + a.s * .2 : .08 + a.s * .2;
      g.strokeStyle = sand ? '#ffe3b0' : '#dfe8ff'; g.lineWidth = sand ? 1.4 : 1 + a.s;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(a.x + 30 + a.s * 60, a.y); g.stroke();
    }
  }
  g.restore();
}

let bgScroll = 0, bgZone = -1, zoneFade = 0;
const GROUND_SPD = 1;       // 땅이 흐르는 빠르기 (bgScroll 배수)
const SHADOW = { x: 20, y: 30 };   // 비행기 그림자가 땅에 떨어지는 방향
function groundOff() {
  // 게임 중에는 서버 시간(틱)으로 땅 위치를 정합니다 — 지상 목표물과 땅이 딱 맞게
  if (G.mode !== 'menu' && G.rt !== undefined) return S.groundOffset(G.rt);
  return ((bgScroll * GROUND_SPD) % F.w + F.w) % F.w;
}
function drawBackground(g, zone, T, dt) {
  if (zone !== bgZone) {
    if (bgZone >= 0 && G.mode !== 'menu') { zoneFade = 1.3; SFX.zone(); }
    bgZone = zone;
  }
  const Z = S.ZONES[zone] || S.ZONES[0];
  const tile = groundTile(zone);
  if (tile) {
    const off = groundOff();
    g.imageSmoothingEnabled = true;
    g.drawImage(tile.c, -off, 0, F.w, F.h);
    g.drawImage(tile.c, F.w - off, 0, F.w, F.h);
    // 바다 반짝임
    if (GFX.hi && GROUND[Z.key].sea !== undefined) {
      const r = S.mulberry32(99);
      g.fillStyle = '#ffffff';
      for (let i = 0; i < 90; i++) {
        const tx = r() * GW, ty = r() * GH, ph = r() * TAU;
        if (!tile.sea[(ty | 0) * GW + (tx | 0)]) continue;
        const a = Math.sin(T * 2.4 + ph);
        if (a < .2) continue;
        let x = tx * GS - off; if (x < -10) x += F.w;
        g.globalAlpha = a * .45;
        g.fillRect(x, ty * GS, 7, 1.6);
      }
      g.globalAlpha = 1;
    }
  } else {   // 우주: 별과 성운
    const sky = g.createLinearGradient(0, 0, 0, F.h);
    sky.addColorStop(0, Z.sky[0]); sky.addColorStop(.55, Z.sky[1]); sky.addColorStop(1, Z.sky[2]);
    g.fillStyle = sky; g.fillRect(0, 0, F.w, F.h);
    for (const s of bgLayers.stars) {
      const x = ((s.x - bgScroll * .12) % (F.w * 1.4) + F.w * 1.4) % (F.w * 1.4) - F.w * .2;
      g.globalAlpha = s.o * (.55 + Math.sin(T * 2 + s.tw) * .45); g.fillStyle = Z.dust;
      g.beginPath(); g.arc(x, s.y, s.s, 0, TAU); g.fill();
    }
    if (GFX.hi) {
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 4; i++) {
        const x = ((i * 520 - bgScroll * .05) % (F.w + 700) + F.w + 700) % (F.w + 700) - 350;
        glowAt(g, i % 2 ? '#7a3fd0' : '#3f6fd0', x, 260 + i * 130, 330, .22);
      }
      g.globalCompositeOperation = 'source-over';
    }
    g.globalAlpha = 1;
  }
  if (zone === 4) {  // 오로라는 위에서 봐도 하늘에 걸린 빛 띠
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i++) {
      const ph = T * .35 + i * 1.7;
      const x = ((i * 600 - bgScroll * .3) % (F.w + 600) + F.w + 600) % (F.w + 600) - 300;
      g.globalAlpha = .12 + Math.sin(ph) * .05;
      g.save(); g.translate(x, F.h / 2); g.rotate(.5 + Math.sin(ph) * .2); g.scale(1, 5);
      g.drawImage(haze('#6bffd0'), -160, -90, 320, 180); g.restore();
    }
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
  }
  // 구름 그림자 (구름은 비행기 위에 따로 그립니다)
  if (tile && GFX.hi) {
    const spr = bgPuff(1);
    for (const c of bgLayers.mid) {
      const x = ((c.x - bgScroll * 1.6) % (F.w * 1.4) + F.w * 1.4) % (F.w * 1.4) - F.w * .2;
      const sh = shadowOf(spr), w = sh._w * c.s / 100 * 1.3, h = sh._h * c.s / 100 * 1.3;
      g.globalAlpha = .16;
      g.drawImage(sh, x + 60 - w / 2, c.y + 90 - h / 2, w, h);
    }
    g.globalAlpha = 1;
  }
  // 땅을 살짝 눌러 적과 총알이 또렷하게 보이게 합니다
  g.fillStyle = 'rgba(6,10,24,.26)';
  g.fillRect(0, 0, F.w, F.h);
  drawWeather(g, zone, T, dt || 0);
  const vg = g.createRadialGradient(F.w / 2, F.h / 2, F.h * .32, F.w / 2, F.h / 2, F.h * .95);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.5)');
  g.fillStyle = vg; g.fillRect(0, 0, F.w, F.h);
}
// 비행기보다 위를 지나가는 구름 — 가끔 시야를 살짝 가려 높이감을 줍니다
function drawCloudsAbove(g, zone) {
  if (!groundTile(zone)) return;
  const Z = S.ZONES[zone] || S.ZONES[0];
  const spr = bgPuff(Z.key === 'volcano' ? 6 : 1);
  const heavy = Z.key === 'cloud' || Z.key === 'strato';
  for (const c of heavy ? bgLayers.mid.concat(bgLayers.near) : bgLayers.mid) {
    const x = ((c.x - bgScroll * 1.6) % (F.w * 1.4) + F.w * 1.4) % (F.w * 1.4) - F.w * .2;
    blit(g, spr, x, c.y, 0, c.s / 100 * 1.3, (heavy ? .34 : .22) * (GFX.hi ? 1 : .8));
  }
  if (zoneFade > 0) {   // 새 지역: 구름을 뚫고 나오듯 하얗게 걷힘
    const a = clamp(zoneFade / 1.3, 0, 1);
    g.fillStyle = 'rgba(235,245,255,' + (a * a * .85) + ')'; g.fillRect(0, 0, F.w, F.h);
  }
}
function tickZoneFade(dt) { if (zoneFade > 0) zoneFade -= dt; }

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
function floatText(x, y, text, c) { addPart({ k: 'text', x, y, vx: 0, vy: 0, life: 1.1, t: 0, text, c }); }
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
    g.save(); g.translate(p.x, p.y); g.rotate(UP());
    const rise = -46 * p.t * (1 - p.t * .3);
    g.font = '800 18px system-ui'; g.textAlign = 'center';
    g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,.65)'; g.strokeText(p.text, 0, rise);
    g.fillStyle = p.c; g.fillText(p.text, 0, rise);
    g.restore();
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
  charge(lv) { beep('sawtooth', 160, 900 + lv * 200, .35, .09); noise(.3, .12 + lv * .04, 2500); },
  medal(n) { const f = 880 * Math.pow(1.06, Math.min(n, 10)); beep('square', f, f * 1.5, .08, .045); },
  raid() { beep('sawtooth', 90, 70, 1.2, .07); },
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
  input: { tx: F.w * .18, ty: F.h / 2, bomb: false, charge: false },
  keys: {},
  local: null, localTimer: 0,
  ws: null, ping: 0, lastRecv: 0,
  score: 0, stage: 1, zone: 0, phase: 'idle',
  paused: false, scoreShown: 0, bossLag: 1, box: 0, wing: new Map(), raid: null,
  result: null, craters: [],
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
    case 'boom':
      if (f.gnd) G.craters.push({ x: f.x, y: f.y, r: f.s * 1.3, t: 0 });   // 땅에 불탄 자국
      boom(f.x, f.y, f.s, '#ffd166'); SFX.boom(); G.shake = Math.max(G.shake, Math.min(9, f.s * .2)); break;
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
    case 'charge': {
      const C = SHIP_COLORS[colorOf(f.id) % 6];
      addPart({ k: 'flash', x: f.x + 40, y: f.y, r: 70 + f.lv * 30, life: .2, t: 0, c: C.glow });
      addPart({ k: 'ring', x: f.x + 30, y: f.y, r: 30 + f.lv * 10, life: .35, t: 0, c: C.glow });
      if (f.id === G.myId) { G.shake = Math.max(G.shake, 4 + f.lv * 2); floatText(f.x, f.y - 52, '차지 ' + ['', 'Ⅰ', 'Ⅱ', 'Ⅲ'][f.lv] + '!', C.glow); }
      SFX.charge(f.lv);
      break;
    }
    case 'grab': {
      const I = PICK_INFO[f.k] || PICK_INFO.star;
      if (f.k === 'gold') {
        SFX.pick(); addPart({ k: 'flash', x: f.x, y: f.y, r: 36, life: .2, t: 0, c: '#ffd166' });
        if (f.id === G.myId || GFX.hi) floatText(f.x, f.y - 30, '금괴 ' + (f.v || 250), '#ffe08a');
        break;
      }
      if (f.k === 'star') {
        SFX.medal(f.n || 1);
        addPart({ k: 'ring', x: f.x, y: f.y, r: 14, life: .3, t: 0, c: '#ffd166' });
        if (f.id === G.myId || GFX.hi) floatText(f.x, f.y - 30, (f.v || 100) + (f.n > 1 ? '  ×' + f.n : ''), f.v >= 1000 ? '#ffffff' : '#ffd166');
        break;
      }
      if (f.k === 'shield') SFX.shield(); else SFX.pick();
      addPart({ k: 'ring', x: f.x, y: f.y, r: 16, life: .35, t: 0, c: I.c });
      addPart({ k: 'flash', x: f.x, y: f.y, r: 40, life: .2, t: 0, c: I.c });
      if (f.k !== 'star' || f.id === G.myId) floatText(f.x, f.y - 30, I.n, I.c);
      break;
    }
    case 'heal': addPart({ k: 'spark', x: f.x, y: f.y, vx: 0, vy: -60, r: 3, life: .5, t: 0, c: '#8ef0b6' }); break;
    case 'shatter': boom(f.x, f.y, 24, '#7fe0ff'); break;
    case 'bomb':
      // 1945 처럼 지원 폭격기 편대가 화면을 가로지르며 폭탄을 쏟습니다(피해는 이미 들어갔고 연출만)
      G.raid = { t: 0, y: f.y, c: colorOf(f.id) };
      G.flashT = .35; G.flashC = '#ffe9a8'; G.shake = 16; SFX.bomb();
      for (let i = 0; i < 3; i++) addPart({ k: 'ring', x: f.x, y: f.y, r: 40 + i * 30, life: .55 + i * .15, t: 0, c: i ? '#ff9a3c' : '#ffe9a8' });
      addPart({ k: 'flash', x: f.x, y: f.y, r: 260, life: .4, t: 0, c: '#ffe9a8' });
      break;
    case 'stage': G.banner = { big: f.n + ' 단계', sub: (S.ZONES[Math.floor((f.n - 1) / 10)] || {}).name || '', kind: 'stage' }; G.bannerT = 2.6; break;
    case 'clear':
      G.result = Object.assign({ t: 0, t0: gameT, P: [], base: f.bonus, timeBonus: 0, time: 0, target: 0 }, f);
      SFX.clear(); break;
    case 'partdown':   // 보스 포탑 파괴
      boom(f.x, f.y, 40, '#ffb347'); G.shake = Math.max(G.shake, 8); SFX.boom();
      floatText(f.x, f.y - 40, '포탑 파괴!', '#ffd166');
      break;
    case 'armorbreak':   // 장갑이 벗겨지며 본체가 드러남
      G.shake = 18; G.flashT = .3; G.flashC = '#fff'; SFX.bigboom();
      for (let i = 0; i < 26; i++) {
        const a = Math.random() * TAU, sp = 180 + Math.random() * 300;
        addPart({ k: 'debris', x: f.x + Math.cos(a) * f.r * .6, y: f.y + Math.sin(a) * f.r * .6, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, rot: a, vr: (Math.random() - .5) * 14, r: 7 + Math.random() * 9, life: 1.4, t: 0 });
      }
      G.banner = { big: '장갑 파괴!', sub: '이제 본체가 제대로 맞습니다', kind: 'clear' }; G.bannerT = 2.4;
      break;
    case 'wipe': G.banner = { big: '편대 전멸…', sub: '이 단계를 다시 도전합니다', kind: 'wipe' }; G.bannerT = 3; break;
    case 'bosswarn': G.banner = { big: '⚠ 보스 출현', sub: f.name, kind: 'boss' }; G.bannerT = 3; G.bossName = f.name; G.bossLag = 1; G.box = 1; SFX.warn(); break;
    case 'bossphase':   // 장갑이 떨어져 나가며 모습이 바뀝니다
      G.shake = 14; G.flashT = .2; G.flashC = '#fff'; boom(f.x, f.y, 60, '#fff');
      for (let i = 0; i < 18; i++) {
        const a = Math.random() * TAU, sp = 150 + Math.random() * 260;
        addPart({ k: 'debris', x: f.x + Math.cos(a) * 60, y: f.y + Math.sin(a) * 60, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60, rot: a, vr: (Math.random() - .5) * 14, r: 6 + Math.random() * 8, life: 1.2, t: 0 });
      }
      floatText(f.x, f.y - 140, '형태 변화!', '#ff9aa8');
      break;
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
      G.local.setInput(G.myId, { tx: G.input.tx, ty: G.input.ty, bomb: G.input.bomb, charge: G.input.charge });
      G.input.bomb = false; G.input.charge = false;
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
  if (!G.paused) { bgScroll += dt * 130; tickZoneFade(dt); }

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
  g.beginPath(); g.rect(0, 0, VW, VH); g.clip();
  g.save();
  worldTransform(g);

  const it = G.mode === 'menu' ? null : interp();
  G.rt = it ? it.t : undefined;            // 땅의 흐름을 서버 시간에 맞춥니다(지상 목표물이 땅 위에 서 있도록)
  drawBackground(g, G.mode === 'menu' ? menuZone() : G.zone, gameT, dt);
  if (it) drawWorld(g, it, dt);
  if (G.mode === 'menu') drawMenuScene(g, dt);
  drawParts(g);
  if (G.mode !== 'menu' && !G.paused) drawRaid(g, dt); else if (G.raid) drawRaid(g, 0);
  drawCloudsAbove(g, bgZone);
  g.restore();   // ↑ 여기까지 세계(돌아감), ↓ 여기부터 화면 그대로

  // 보스 등장 때 위아래 검은 띠(영화처럼)
  if (G.box > 0) {
    const hh = 56 * Math.sin(Math.min(1, G.box) * Math.PI / 2);
    g.fillStyle = 'rgba(0,0,0,.85)';
    g.fillRect(0, 0, VW, hh); g.fillRect(0, VH - hh, VW, hh);
  }
  // 피격 붉은 테두리
  if (G.hitVig > 0) {
    const m = Math.min(VW, VH);
    const vg = g.createRadialGradient(VW / 2, VH / 2, m * .3, VW / 2, VH / 2, Math.max(VW, VH) * .6);
    vg.addColorStop(0, 'rgba(255,0,40,0)'); vg.addColorStop(1, 'rgba(255,0,40,' + (G.hitVig * .34) + ')');
    g.fillStyle = vg; g.fillRect(0, 0, VW, VH);
  }
  if (G.flashT > 0) {
    g.globalAlpha = clamp(G.flashT * 1.6, 0, .8); g.fillStyle = G.flashC;
    g.fillRect(0, 0, VW, VH); g.globalAlpha = 1;
  }
  drawBanner(g);
  drawResult(g);
  if (G.paused) {
    g.fillStyle = 'rgba(4,8,20,.55)'; g.fillRect(0, 0, VW, VH);
    g.textAlign = 'center'; g.fillStyle = '#fff'; g.font = '900 64px system-ui';
    g.fillText('잠깐 멈춤', VW / 2, VH / 2);
    g.font = '600 22px system-ui'; g.fillStyle = '#cfe0ff';
    g.fillText('P 키나 ⏸ 버튼을 누르면 이어서', VW / 2, VH / 2 + 46);
  }
  g.restore();
  // 점수판 등은 화면 픽셀 기준으로 그립니다 (세로 화면에서도 글자가 너무 작아지지 않게)
  if (VERT && VIEW.ox > 4) drawSideDecor(g);
  if (it) { g.setTransform(VIEW.dpr, 0, 0, VIEW.dpr, 0, 0); drawHUD(g, it.b); }
}
// 가로로 긴 기기에서 세로 판을 쓸 때 양옆 빈자리 꾸미기
function drawSideDecor(g) {
  g.setTransform(VIEW.dpr, 0, 0, VIEW.dpr, 0, 0);
  const x1 = VIEW.ox + VW * VIEW.s;
  for (const [x, w] of [[0, VIEW.ox], [x1, VIEW.w - x1]]) {
    const gr = g.createLinearGradient(x, 0, x + w, 0);
    gr.addColorStop(0, x ? '#0b1428' : '#050910'); gr.addColorStop(1, x ? '#050910' : '#0b1428');
    g.fillStyle = gr; g.fillRect(x, 0, w, VIEW.h);
  }
  g.strokeStyle = 'rgba(255,209,102,.35)'; g.lineWidth = 2;
  g.strokeRect(VIEW.ox - 1, VIEW.oy - 1, VW * VIEW.s + 2, VH * VIEW.s + 2);
}

/* 시작 화면 뒤에서 편대가 날아가는 장면. 지역은 20초마다 바뀝니다. */
function menuZone() { return Math.floor(gameT / 20) % 10; }
function drawMenuScene(g, dt) {
  for (let i = 0; i < 3; i++) {
    const x = ((gameT * 170 + i * 130) % (F.w + 700)) - 350;
    const y = F.h * .5 + (i - 1) * 120 + Math.sin(gameT * 1.1 + i * 2) * 26 + (i === 1 ? -40 : 0);
    const C = SHIP_COLORS[(i * 2) % 6];
    g.globalCompositeOperation = 'lighter';
    g.globalCompositeOperation = 'source-over';
    const sp = shipSprite((i * 2) % 6), a = Math.cos(gameT * 1.1 + i * 2) * .12;
    dropShadow(g, sp, x, y, a, 1.15);
    blit(g, sp, x, y, a, 1.15);
    drawProp(g, x, y, a, 1.15, gameT + i, (i * 2) % 6);
  }
}

// 보조기 자리 — 서버와 같은 자리를 목표로, 화면에서는 살짝 늦게 따라와 편대 느낌을 냅니다
function wingPos(id, x, y, n) {
  let arr = G.wing.get(id);
  if (!arr) { arr = []; G.wing.set(id, arr); }
  for (let i = 0; i < n; i++) {
    const tx = clamp(x + S.WING[i][0], 10, F.w - 10), ty = clamp(y + S.WING[i][1], 10, F.h - 10);
    if (!arr[i]) arr[i] = { x: tx, y: ty };
    arr[i].x += (tx - arr[i].x) * .25; arr[i].y += (ty - arr[i].y) * .25;
  }
  arr.length = n;
  return arr;
}
const PROP_ART = new Set(['scout', 'wasp', 'bomber', 'sniper', 'kami', 'missile']);
/* ── 지상 목표물 그림 ── 몸체는 한 번 그려 두고, 포탑만 매번 겨누는 방향으로 돌립니다 */
const GROUND_ART = {
  tank: (g) => {
    g.fillStyle = '#2a2e22'; g.fillRect(-20, -15, 40, 7); g.fillRect(-20, 8, 40, 7);   // 무한궤도
    g.fillStyle = '#4a4f36'; for (let i = -18; i < 20; i += 5) { g.fillRect(i, -15, 2, 7); g.fillRect(i, 8, 2, 7); }
    const b = g.createLinearGradient(0, -10, 0, 10); b.addColorStop(0, '#8a8f62'); b.addColorStop(1, '#4f5436');
    g.fillStyle = b; g.beginPath(); g.roundRect(-17, -10, 34, 20, 4); g.fill();
    g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 1; g.stroke();
  },
  aa: (g) => {
    g.fillStyle = '#6a6a62'; g.beginPath(); g.roundRect(-18, -18, 36, 36, 5); g.fill();
    g.fillStyle = '#4e4e48'; g.beginPath(); g.roundRect(-14, -14, 28, 28, 4); g.fill();
    g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = 1; g.strokeRect(-18, -18, 36, 36);
  },
  bunker: (g) => {
    const b = g.createRadialGradient(-6, -6, 3, 0, 0, 26); b.addColorStop(0, '#b8b4a4'); b.addColorStop(1, '#5a574c');
    g.fillStyle = b; g.beginPath(); g.arc(0, 0, 25, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = 2; g.stroke();
    g.fillStyle = '#3d3b33'; g.beginPath(); g.arc(0, 0, 12, 0, TAU); g.fill();
  },
  ship: (g) => {
    g.fillStyle = 'rgba(255,255,255,.35)';   // 뱃머리 물살
    g.beginPath(); g.moveTo(-44, 0); g.lineTo(-58, -12); g.lineTo(-52, 0); g.lineTo(-58, 12); g.closePath(); g.fill();
    const b = g.createLinearGradient(0, -13, 0, 13); b.addColorStop(0, '#9aa2ae'); b.addColorStop(1, '#4f5663');
    g.fillStyle = b;
    g.beginPath(); g.moveTo(-46, 0); g.quadraticCurveTo(-30, -13, 0, -13); g.lineTo(40, -11); g.lineTo(44, 0); g.lineTo(40, 11); g.lineTo(0, 13); g.quadraticCurveTo(-30, 13, -46, 0); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 1.2; g.stroke();
    g.fillStyle = '#b8a07a'; g.fillRect(-26, -7, 56, 14);                    // 갑판
    g.fillStyle = '#6a717c'; g.beginPath(); g.roundRect(-4, -8, 16, 16, 3); g.fill();   // 함교
    g.fillStyle = '#3a3f48'; g.beginPath(); g.arc(18, 0, 3.5, 0, TAU); g.fill();        // 굴뚝
  },
};
const GROUND_IMG = { tank: 52, aa: 46, bunker: 58, ship: 112 };
const groundSprite = (type) => {
  const im = artOf('g_' + type);
  if (im) return sprite('gC_' + type, GROUND_IMG[type] + 6, GROUND_IMG[type] + 6,
    (g) => drawArt(g, im, type === 'ship' ? -Math.PI / 2 : Math.PI / 2, GROUND_IMG[type]));   // 배는 흐르는 쪽(왼쪽), 나머지는 오른쪽을 봄
  return sprite('g_' + type, 130, 60, (g) => GROUND_ART[type](g));
};
function drawTurret(g, x, y, ang, len, w, twin, col, sc) {
  g.save(); g.translate(x, y); if (sc) g.scale(sc, sc); g.rotate(ang);
  g.fillStyle = '#2b2f26';
  if (twin) { g.fillRect(4, -5, len, 3); g.fillRect(4, 2, len, 3); } else g.fillRect(4, -w / 2, len, w);
  g.fillStyle = col || '#6c7250'; g.beginPath(); g.arc(0, 0, w + 4, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 1; g.stroke();
  g.restore();
}
function drawGroundUnits(g, A, B, k, dt) {
  // 불탄 자국은 땅과 함께 흘러가다 사라집니다
  for (let i = G.craters.length - 1; i >= 0; i--) {
    const c = G.craters[i];
    c.t += dt; c.x -= S.GROUND_SPEED * dt;
    if (c.t > 9 || c.x < -80) { G.craters.splice(i, 1); continue; }
    g.globalAlpha = .55 * (1 - c.t / 9);
    g.drawImage(shadowOf(smokeSpr()), c.x - c.r, c.y - c.r, c.r * 2, c.r * 2);
    if (c.t < 3 && GFX.hi && Math.random() < .08) addPart({ k: 'smoke', x: c.x, y: c.y, vx: -S.GROUND_SPEED - 20, vy: 0, r: 8, life: 1, t: 0 });
  }
  g.globalAlpha = 1;
  if (!B.GT) return;
  const gA = byId(A.GT || []);
  for (const r of B.GT) {
    const p = gA.get(r[0]);
    const x = p ? lerp(p[2], r[2], k) : r[2], y = p ? lerp(p[3], r[3], k) : r[3];
    const type = r[1], ang = r[6] / 100, fl = r[7];
    const spr = groundSprite(type);
    const img = !!artOf('g_' + type);
    g.save(); g.translate(x, y); g.scale(ZS, ZS);
    if (img && type !== 'ship') g.rotate(ang);   // Canva 그림은 몸 전체가 조종사 쪽으로 돕니다
    g.drawImage(spr, -spr._w / 2, -spr._h / 2, spr._w, spr._h);
    if (fl) { g.globalAlpha = .5; g.drawImage(flashOf(spr), -spr._w / 2, -spr._h / 2, spr._w, spr._h); g.globalAlpha = 1; }
    g.restore();
    if (img) { if (r[4] < r[5]) hpBar(g, x, y, 34 * ZS, r[4] / r[5]); continue; }
    if (type === 'tank') drawTurret(g, x, y, ang, 20, 5, false, '#7a8054', ZS);
    else if (type === 'aa') drawTurret(g, x, y, ang, 18, 4, true, '#8a8a80', ZS);
    else if (type === 'bunker') { g.save(); g.translate(x, y); g.scale(ZS, ZS); g.rotate(ang); g.fillStyle = '#1a1a16'; g.fillRect(8, -2.5, 12, 5); g.restore(); }
    else if (type === 'ship') { drawTurret(g, x - 18 * ZS, y, ang, 16, 4, true, '#7a808c', ZS); drawTurret(g, x + 30 * ZS, y, ang, 14, 4, false, '#7a808c', ZS); }
    if (r[4] < r[5]) hpBar(g, x, y, 30 * ZS, r[4] / r[5]);
  }
}
function drawShadows(g, A, B, k) {
  if (bgZone === 9) return;
  const enA = byId(A.E);
  for (const r of B.E) {
    const p = enA.get(r[0]);
    dropShadow(g, enemySprite(r[1]), p ? lerp(p[2], r[2], k) : r[2], p ? lerp(p[3], r[3], k) : r[3], r[6] / 100 - Math.PI, ZS);
  }
  if (B.B && artOf('b_' + B.B[0])) {   // 보스 그림자
    const b = B.B, ab = A.B;
    dropShadow(g, bossSprite(b[0], bossScale(b[0])), ab ? lerp(ab[1], b[1], k) : b[1], ab ? lerp(ab[2], b[2], k) : b[2], 0, 1.1);
  }
  const plA = byId(A.P);
  for (const r of B.P) {
    if (r[6]) continue;
    const p = plA.get(r[0]);
    const x = p ? lerp(p[1], r[1], k) : r[1], y = p ? lerp(p[2], r[2], k) : r[2];
    const spr = shipSprite(colorOf(r[0]));
    dropShadow(g, spr, x, y, r[11] / 100, ZS);
    for (const w of G.wing.get(r[0]) || []) dropShadow(g, spr, w.x, w.y, 0, .62 * ZS);
  }
}

function drawWorld(g, it, dt) {
  const A = it.a, B = it.b, k = it.k, rt = it.t;
  drawGroundUnits(g, A, B, k, dt);
  drawShadows(g, A, B, k);

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
    drawBullet(g, r[4], x, y, r[3] / 100, r[5] || 0);
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
    // 프로펠러기는 배기 연기만, 기계 병기는 분사 불꽃
    if (PROP_ART.has(art)) {
      if (GFX.hi && Math.random() < .12) addPart({ k: 'smoke', x: x - Math.cos(ang) * 20, y: y - Math.sin(ang) * 20, vx: -60, vy: 0, r: 3, life: .4, t: 0 });
    } else if (art !== 'mine' && art !== 'turret') {
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
    blit(g, spr, x, y, ang - Math.PI, ZS);
    if (fl) blit(g, flashOf(spr), x, y, ang - Math.PI, ZS, .55);
    if (hp < mx) hpBar(g, x, y, 34 * ZS, hp / mx);
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
    const bImg = artOf('b_' + b[0]);
    if (bImg) {
      // Canva 보스 그림: 기수가 왼쪽(적 쪽 방향)을 보게 돌리고, 숨쉬듯 살짝 흔들어 살아 있는 느낌을 냅니다
      const bs = bossSprite(b[0], scale);
      g.save(); g.rotate(Math.sin(gameT * .9) * .035); const pz = 1 + Math.sin(gameT * 2.2) * .012; g.scale(pz, pz);
      g.drawImage(bs, -bs._w / 2, -bs._h / 2, bs._w, bs._h);
      if (b[7] >= 1) {   // 형태가 바뀐 뒤: 속이 달아오르며 붉게 맥박침
        g.globalCompositeOperation = 'lighter'; g.globalAlpha = .18 + Math.sin(gameT * 6) * .08;
        g.drawImage(haze('#ff5a3c'), -scale, -scale, scale * 2, scale * 2);
        g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
      }
      if (b[6] && Math.sin(gameT * 50) > .3) { g.globalAlpha = .35; g.drawImage(flashOf(bs), -bs._w / 2, -bs._h / 2, bs._w, bs._h); g.globalAlpha = 1; }
      g.restore();
    } else artFn(g, scale, gameT);
    // 맞는 동안 계속 하얗게 덮으면 밝은 보스는 흰 덩어리가 됩니다 — 짧게 깜빡이기만 합니다
    if (!bImg && b[6] && Math.sin(gameT * 50) > .3) { g.globalCompositeOperation = 'lighter'; g.globalAlpha = .22; artFn(g, scale, gameT); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; }
    g.restore();
    // 1945 식 부품: 장갑판과 포탑. 포탑이 다 부서지면 장갑이 떨어져 본체가 드러납니다.
    const parts = b[9] || [];
    if (b[10]) {
      g.save(); g.translate(x, y);
      g.strokeStyle = 'rgba(190,205,225,.8)'; g.lineWidth = 7;
      g.setLineDash([22, 10]); g.lineDashOffset = -gameT * 20;
      g.beginPath(); g.ellipse(0, 0, scale * 1.02, scale * .92, 0, 0, TAU); g.stroke();
      g.setLineDash([]); g.restore();
    }
    for (const pt of parts) {
      const px = x + pt[0], py = y + pt[1];
      if (pt[2] > 0) {
        g.fillStyle = '#39404e'; g.beginPath(); g.arc(px, py, 26, 0, TAU); g.fill();
        g.strokeStyle = '#9aa6b8'; g.lineWidth = 3; g.stroke();
        drawTurret(g, px, py, pt[3] / 100, 26, 6, true, pt[4] ? '#ffffff' : '#7d8aa0');
        g.globalCompositeOperation = 'lighter'; glowAt(g, '#ff5a3c', px, py, 10 + Math.sin(gameT * 8) * 2, .7); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
        hpBar(g, px, py, 38, pt[2] / 100);
      } else {   // 부서진 포탑: 검게 탄 구멍에서 연기
        g.fillStyle = 'rgba(20,16,14,.85)'; g.beginPath(); g.arc(px, py, 20, 0, TAU); g.fill();
        g.globalCompositeOperation = 'lighter'; glowAt(g, '#ff7a30', px, py, 14 + Math.random() * 6, .5); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
        if (GFX.hi && Math.random() < .2) addPart({ k: 'smoke', x: px, y: py, vx: -80, vy: -20, r: 8, life: .8, t: 0 });
      }
    }
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

    if (down) { g.save(); g.translate(x, y); g.rotate(UP()); drawDowned(g, 0, 0, C, rev, nameOf(id) || '동료', downT); g.restore(); continue; }

    // 위아래로 움직일 때 날개를 기울입니다(보이는 폭이 좁아짐)
    const py0 = p ? p[2] : r[2];
    const vyNow = (r[2] - py0) / S.DT;
    const vyS = (G.vy.get(id) || 0) * .85 + vyNow * .15;
    G.vy.set(id, vyS);
    const bank = clamp(Math.abs(vyS) / 700, 0, .32);
    const lean = clamp(vyS / 1400, -.18, .18);

    // 보조기 편대 (무기 Lv2부터 한 대씩)
    const spr = shipSprite(ci);
    const wings = wingPos(id, x, y, S.wingCount(gun));
    for (const w of wings) {
      g.save(); g.translate(w.x, w.y); g.rotate(lean * .6); g.scale(.62 * ZS, .62 * ZS * (1 - bank * .7));
      g.drawImage(spr, -spr._w / 2, -spr._h / 2, spr._w, spr._h); g.restore();
      drawProp(g, w.x, w.y, 0, .62 * ZS, gameT + w.y, ci);
    }
    // 날개 끝 비행운 + 내 비행기 은은한 빛
    if (mine && GFX.hi) { g.globalCompositeOperation = 'lighter'; glowAt(g, C.glow, x, y, 58, .12); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; }
    if (Math.random() < .5) {
      const s2 = Math.random() < .5 ? -1 : 1;
      addPart({ k: 'trail', x: x - 4, y: y + s2 * 34 * (1 - bank), vx: -200, vy: 0, r: 2, life: .3, t: 0, c: '#ffffff' });
    }
    // 차지 게이지: 비행기 둘레 세 칸
    const chg = (r[14] || 0) / 10;
    if (chg > 0 || mine) {
      const full = chg >= S.CHARGE_MAX - .01;
      for (let i = 0; i < S.CHARGE_MAX; i++) {
        const a0 = -Math.PI / 2 + i * TAU / 3 + .12, span = TAU / 3 - .24;
        const f = clamp(chg - i, 0, 1);
        g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 5;
        g.beginPath(); g.arc(x, y, 46 * ZS, a0, a0 + span); g.stroke();
        if (f > 0) {
          g.strokeStyle = full ? (Math.sin(gameT * 12) > 0 ? '#ffffff' : C.glow) : f >= 1 ? C.glow : 'rgba(255,255,255,.55)';
          g.lineWidth = 3.4;
          g.beginPath(); g.arc(x, y, 46 * ZS, a0, a0 + span * f); g.stroke();
        }
      }
    }

    // 보호막
    if (shield) {
      g.save(); g.globalCompositeOperation = 'lighter';
      const sg = g.createRadialGradient(x, y, 20, x, y, 40);
      sg.addColorStop(0, 'rgba(120,220,255,0)'); sg.addColorStop(.7, 'rgba(120,220,255,.35)'); sg.addColorStop(1, 'rgba(200,240,255,.7)');
      g.fillStyle = sg; g.beginPath(); g.arc(x, y, 40, 0, TAU); g.fill(); g.restore();
    }
    g.save(); g.translate(x, y); g.rotate(ang + lean); g.scale(ZS, ZS * (1 - bank));
    g.globalAlpha = inv ? (Math.sin(gameT * 26) > 0 ? .35 : .95) : 1;
    g.drawImage(spr, -spr._w / 2, -spr._h / 2, spr._w, spr._h);
    g.restore(); g.globalAlpha = 1;
    drawProp(g, x, y, ang + lean, ZS, gameT + id, ci);

    // 이름표 + 체력 (화면 기준으로 비행기 아래)
    g.save(); g.translate(x, y); g.rotate(UP());
    g.font = '600 15px system-ui, sans-serif'; g.textAlign = 'center';
    const nm = nameOf(id) || '조종사';
    g.fillStyle = mine ? '#ffd166' : 'rgba(255,255,255,.86)';
    g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = 3;
    const ny = 60 * ZS;
    g.strokeText(nm, 0, ny); g.fillText(nm, 0, ny);
    const bw = 46;
    g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(-bw / 2, ny + 6, bw, 5);
    g.fillStyle = hp > 55 ? '#8ef0b6' : hp > 25 ? '#ffd166' : '#ff7a8a';
    g.fillRect(-bw / 2, ny + 6, bw * clamp(hp / S.P_MAXHP, 0, 1), 5);
    g.restore();
  }
}
// 작은 체력바 — 화면 방향과 상관없이 항상 대상 '위'에 가로로 그립니다
function hpBar(g, x, y, up, f) {
  const w = 42, h = 4;
  g.save(); g.translate(x, y); g.rotate(UP());
  g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(-w / 2, -up, w, h);
  g.fillStyle = f > .5 ? '#8ef0b6' : f > .25 ? '#ffd166' : '#ff7a8a';
  g.fillRect(-w / 2, -up, w * clamp(f, 0, 1), h);
  g.restore();
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
// 지원 폭격기 그림 (조종사 색) — 적 폭격기 틀을 빌려 오른쪽을 보게 그립니다
function raidSprite(ci) {
  const C = SHIP_COLORS[ci % 6];
  return sprite('raid' + ci, 110, 110, (g) => {
    g.rotate(Math.PI);
    enemyPlane(g, { len: 84, span: 50, chord: 17, wx: 4, fw: 9, tail: 18, cx: 22, glassNose: true,
      body: C.deep, light: C.body, dark: '#1a2238', engines: [-15, -32, 15, 32] });
  });
}
function drawRaid(g, dt) {
  const R = G.raid;
  if (!R) return;
  R.t += dt;
  const DUR = 1.7;
  if (R.t > DUR) { G.raid = null; return; }
  if (!R.sound) { R.sound = 1; SFX.raid(); }
  const spr = raidSprite(R.c);
  const lanes = [.18, .36, .5, .64, .82];
  R.drop = (R.drop || 0) - dt;
  for (let i = 0; i < lanes.length; i++) {
    const x = -220 + (F.w + 440) * ((R.t - Math.abs(i - 2) * .08) / DUR);
    const y = F.h * lanes[i];
    dropShadow(g, spr, x, y, 0, 1);
    blit(g, spr, x, y, 0, 1);
    drawProp(g, x - 4, y - 15, 0, .7, gameT + i); drawProp(g, x - 4, y + 15, 0, .7, gameT + i + 1);
    if (R.drop <= 0 && x > 40 && x < F.w - 40) boom(x - 30 + Math.random() * 20, y + (Math.random() - .5) * 90, 20 + Math.random() * 16, '#ffb347');
  }
  if (R.drop <= 0) R.drop = GFX.hi ? .07 : .14;
}
// Canva 보스 그림 판 (보스 반경의 2.5배 크기, 기수 → 왼쪽)
function bossSprite(key, R) {
  const im = artOf('b_' + key), S2 = Math.round(R * 2.5);
  return sprite('bC_' + key, S2, S2, (g) => drawArt(g, im, -Math.PI / 2, S2));
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
  if (ZS === 1) return drawBulletRaw(g, kind, x, y, a, col);
  g.save(); g.translate(x, y); g.scale(ZS, ZS);
  drawBulletRaw(g, kind, 0, 0, a, col);
  g.restore();
}
function drawBulletRaw(g, kind, x, y, a, col) {
  if (kind === 'pc') {   // 차지샷: 조종사 색의 거대한 빛 포탄
    const C = SHIP_COLORS[(col || 0) % 6];
    const wob = 1 + Math.sin(gameT * 30) * .08;
    g.save(); g.translate(x, y);
    g.globalAlpha = .5; g.drawImage(glow(C.glow), -190, -70 * wob, 240, 140 * wob);
    g.globalAlpha = .9; g.drawImage(glow(C.glow), -90, -44 * wob, 140, 88 * wob);
    g.globalAlpha = 1; g.drawImage(glow('#ffffff'), -36, -24, 76, 48);
    g.strokeStyle = 'rgba(255,255,255,.6)'; g.lineWidth = 2;
    for (let i = 0; i < 3; i++) { const rr = 18 + ((gameT * 90 + i * 14) % 40); g.globalAlpha = 1 - rr / 58; g.beginPath(); g.ellipse(-rr * .6, 0, rr * .35, rr, 0, 0, TAU); g.stroke(); }
    g.restore(); g.globalAlpha = 1;
    return;
  }
  if (kind === 'pk') {   // 차지샷 조각 (부채꼴·창·충격파·융단 폭격)
    const C = SHIP_COLORS[(col || 0) % 6];
    g.save(); g.translate(x, y); g.rotate(a);
    g.globalAlpha = .7; g.drawImage(glow(C.glow), -70, -26, 100, 52);
    g.globalAlpha = 1; g.drawImage(glow('#ffffff'), -22, -12, 40, 24);
    g.restore(); g.globalAlpha = 1;
    return;
  }
  if (kind === 'pm') {   // 유도 미사일
    const C = SHIP_COLORS[(col || 0) % 6];
    g.save(); g.translate(x, y); g.rotate(a);
    g.globalAlpha = .8; g.drawImage(glow(C.glow), -44, -9, 40, 18);
    g.globalAlpha = 1; g.fillStyle = '#e8eef8'; g.beginPath(); g.roundRect(-8, -3, 18, 6, 3); g.fill();
    g.fillStyle = C.deep; g.fillRect(-8, -4.5, 4, 9);
    g.restore(); g.globalAlpha = 1;
    return;
  }
  if (kind === 'pw') {   // 보조기 기관총: 가늘고 노란 예광탄
    g.fillStyle = 'rgba(255,230,140,.9)'; g.fillRect(x - 12, y - 1.2, 16, 2.4);
    g.fillStyle = '#fff'; g.fillRect(x, y - 1, 5, 2);
    return;
  }
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
  star: { c: '#ffd166', t: '★', n: '메달' }, gold: { c: '#ffd166', t: '▰', n: '금괴' },
};
function drawPickup(g, type, x, y) {
  if (ZS === 1) return drawPickupRaw(g, type, x, y);
  g.save(); g.translate(x, y); g.scale(ZS, ZS);
  drawPickupRaw(g, type, 0, 0);
  g.restore();
}
function drawPickupRaw(g, type, x, y) {
  const im = artOf('i_' + type);
  if (im) {
    g.save(); g.translate(x, y + Math.sin(gameT * 4 + x * .05) * 2); g.rotate(UP());
    const c = type === 'pow' ? '#ff4d5e' : '#ffd166';
    g.globalCompositeOperation = 'lighter'; glowAt(g, c, 0, 0, 26 + Math.sin(gameT * 6) * 3, .45); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    if (type === 'star') g.scale(Math.max(.18, Math.abs(Math.cos(gameT * 5 + x * .03))), 1);   // 메달은 빙글빙글
    const sz = type === 'gold' ? 34 : 30;
    g.drawImage(im, -sz / 2, -sz / 2, sz, sz);
    g.restore();
    if (Math.sin(gameT * 3 + x) > .95) { g.globalCompositeOperation = 'lighter'; glowAt(g, '#ffffff', x - 5, y - 6, 10, .9); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; }
    return;
  }
  const I = PICK_INFO[type] || PICK_INFO.star;
  if (type === 'star') {   // 금메달: 빙글빙글 돌며 반짝임
    const sx = Math.cos(gameT * 5 + x * .03);
    g.save(); g.translate(x, y);
    g.globalCompositeOperation = 'lighter'; glowAt(g, '#ffd166', 0, 0, 24, .4); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    g.scale(Math.max(.15, Math.abs(sx)), 1);
    g.fillStyle = sx > 0 ? '#f0b020' : '#c88a10';
    g.beginPath(); g.arc(0, 0, 13, 0, TAU); g.fill();
    g.strokeStyle = '#fff2b0'; g.lineWidth = 2.2; g.stroke();
    if (sx > 0) {
      g.fillStyle = '#fff6c8';
      g.beginPath();
      for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? 3.4 : 8; g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
      g.closePath(); g.fill();
    }
    g.restore();
    if (Math.sin(gameT * 3 + x) > .95) { g.globalCompositeOperation = 'lighter'; glowAt(g, '#ffffff', x - 5, y - 6, 10, .9); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; }
    return;
  }
  // 1945 식 캡슐 아이템 — P 는 빨강·파랑으로 깜빡입니다
  if (type === 'gold') {   // 금괴: 사다리꼴 금덩이
    g.save(); g.translate(x, y); g.rotate(UP());
    g.globalCompositeOperation = 'lighter'; glowAt(g, '#ffd166', 0, 0, 22, .35); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    const gg = g.createLinearGradient(0, -9, 0, 9);
    gg.addColorStop(0, '#fff2b0'); gg.addColorStop(.5, '#f0b020'); gg.addColorStop(1, '#8a5a08');
    g.fillStyle = gg; g.strokeStyle = '#fff6c8'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(-10, -8); g.lineTo(10, -8); g.lineTo(15, 8); g.lineTo(-15, 8); g.closePath(); g.fill(); g.stroke();
    if (Math.sin(gameT * 4 + x) > .8) { g.globalCompositeOperation = 'lighter'; glowAt(g, '#ffffff', 6, -6, 9, .9); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; }
    g.restore();
    return;
  }
  const blink = type === 'pow' && Math.sin(gameT * 8) > 0;
  const c = type === 'pow' ? (blink ? '#ff4d5e' : '#4d8bff') : I.c;
  g.save(); g.translate(x, y + Math.sin(gameT * 4 + x * .05) * 2); g.rotate(UP());
  g.globalCompositeOperation = 'lighter'; glowAt(g, c, 0, 0, 28, .45); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
  const grd = g.createLinearGradient(0, -13, 0, 13);
  grd.addColorStop(0, '#ffffff'); grd.addColorStop(.35, c); grd.addColorStop(1, 'rgba(0,0,0,.6)');
  g.fillStyle = grd; g.strokeStyle = '#ffffff'; g.lineWidth = 2;
  g.beginPath(); g.roundRect(-17, -13, 34, 26, 13); g.fill(); g.stroke();
  g.fillStyle = '#fff'; g.font = '900 17px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.45)';
  const t = type === 'pow' ? 'P' : type === 'bomb' ? 'B' : I.t;
  g.strokeText(t, 0, 1); g.fillText(t, 0, 1);
  g.textBaseline = 'alphabetic';
  g.restore();
}

/* ═══════════════════ HUD ═══════════════════ */
function hudLayout() {
  const fx = VIEW.ox, fy = VIEW.oy, fw = VW * VIEW.s, fh = VH * VIEW.s;
  const hs = clamp(VIEW.s * (VERT ? 1.45 : 1), .55, 1.15);
  const side = VERT && VIEW.ox >= 268 * hs + 24;          // 옆 여백이 넉넉하면 점수판을 여백으로
  return {
    hs, side, fx, fy, fw, fh,
    stage: side ? [fx - 14 - 268 * hs, fy + 12] : [fx + 12 * hs, fy + 12 * hs],
    score: side ? [fx + fw + 14, fy + 12] : [fx + fw - 12 * hs - 244 * hs, fy + 12 * hs],
    cards: side ? [fx - 14 - 246 * hs, fy + fh - 16] : [fx + 12 * hs, fy + fh - 16 * hs],
    boss: side ? [fx + 16, fy + 34, fw - 32] : [fx + fw * .5 - Math.min(760 * hs, fw - 300 * hs) / 2, fy + 86 * hs, Math.min(760 * hs, fw - 300 * hs)],
  };
}
function drawHUD(g, s) {
  const Z = S.ZONES[G.zone] || S.ZONES[0];
  const L = hudLayout(), hs = L.hs;
  const at = (xy) => { g.save(); g.translate(xy[0], xy[1]); g.scale(hs, hs); };

  // 단계
  at(L.stage);
  roundRect(g, 0, 0, 268, 58, 14, 'rgba(8,14,28,.62)', 'rgba(255,255,255,.14)');
  g.fillStyle = '#fff'; g.font = '800 27px system-ui'; g.textAlign = 'left';
  g.fillText(s.st + ' 단계', 14, 32);
  const dotX = Math.max(132, 14 + g.measureText(s.st + ' 단계').width + 14);   // 세 자리 단계에서 글자와 겹치지 않게
  g.fillStyle = Z.accent; g.font = '600 13px system-ui';
  g.fillText(Z.name, 14, 50);
  const wn = s.wvN || 0;
  for (let i = 0; i < wn; i++) {
    g.fillStyle = i < s.wv ? Z.accent : 'rgba(255,255,255,.2)';
    g.beginPath(); g.arc(dotX + i * 15, 28, 5, 0, TAU); g.fill();
  }
  g.fillStyle = 'rgba(255,255,255,.16)'; g.fillRect(132, 44, 120, 5);
  g.fillStyle = '#ffd166'; g.fillRect(132, 44, 120 * (s.st / S.TOTAL_STAGES), 5);
  g.restore();

  // 점수 · 방 코드
  at(L.score);
  roundRect(g, 0, 0, 244, 58, 14, 'rgba(8,14,28,.62)', 'rgba(255,255,255,.14)');
  g.textAlign = 'right'; g.fillStyle = '#ffd166'; g.font = '800 25px system-ui';
  g.fillText(Math.round(G.scoreShown).toLocaleString(), 230, 30);
  g.fillStyle = 'rgba(200,220,255,.7)'; g.font = '600 12.5px system-ui';
  g.fillText(G.mode === 'solo' ? '혼자 연습' : ('방 코드 ' + G.room + '  ·  ' + s.P.length + '명'), 230, 49);
  // 메달 연쇄 (내 것)
  const me = s.P.find((r) => r[0] === G.myId);
  if (me && me[15] > 0 && me[16] > 0) {
    const n = me[15], left = me[16] / 10 / S.CHAIN_SEC;
    const next = S.MEDAL[Math.min(n + 1, S.MEDAL.length) - 1];
    roundRect(g, 0, 64, 244, 34, 10, 'rgba(8,14,28,.62)', 'rgba(255,209,102,.45)');
    g.textAlign = 'left'; g.font = '800 15px system-ui'; g.fillStyle = '#ffd166';
    g.fillText('🏅 메달 연쇄 ×' + n, 12, 86);
    g.textAlign = 'right'; g.font = '700 12.5px system-ui'; g.fillStyle = '#fff2c0';
    g.fillText('다음 ' + next, 232, 86);
    g.fillStyle = 'rgba(255,255,255,.15)'; g.fillRect(12, 91, 220, 3);
    g.fillStyle = '#ffd166'; g.fillRect(12, 91, 220 * clamp(left, 0, 1), 3);
  }
  g.restore();

  // 편대원 카드 (아래에서 위로 쌓음)
  const rows = s.P.slice().sort((a, b) => (a[0] === G.myId ? -1 : b[0] === G.myId ? 1 : a[0] - b[0]));
  at(L.cards);
  let cy = -rows.length * 40;
  for (const r of rows) {
    const id = r[0], hp = r[3], gun = r[4], down = r[6], bombs = r[8], lives = r[10];
    const C = SHIP_COLORS[colorOf(id) % 6];
    const mine = id === G.myId;
    roundRect(g, 0, cy, 246, 34, 10, mine ? 'rgba(255,209,102,.16)' : 'rgba(8,14,28,.58)',
      mine ? 'rgba(255,209,102,.5)' : 'rgba(255,255,255,.10)');
    g.fillStyle = C.body; g.beginPath(); g.arc(16, cy + 17, 7, 0, TAU); g.fill();
    g.textAlign = 'left'; g.font = '700 13.5px system-ui';
    g.fillStyle = down ? '#ff9aa8' : '#fff';
    g.fillText((nameOf(id) || '조종사'), 30, cy + 15);
    g.fillStyle = 'rgba(255,255,255,.15)'; g.fillRect(30, cy + 21, 118, 6);
    if (!down) {
      g.fillStyle = hp > 55 ? '#8ef0b6' : hp > 25 ? '#ffd166' : '#ff7a8a';
      g.fillRect(30, cy + 21, 118 * clamp(hp / S.P_MAXHP, 0, 1), 6);
    } else {
      g.fillStyle = '#8ef0b6'; g.fillRect(30, cy + 21, 118 * clamp(r[7] / 100, 0, 1), 6);
      g.fillStyle = '#ff9aa8'; g.font = '700 11px system-ui'; g.fillText('격추', 154, cy + 27);
    }
    g.textAlign = 'right'; g.font = '700 12.5px system-ui';
    g.fillStyle = '#ffd166'; g.fillText('Lv' + gun, 186, cy + 16);
    g.fillStyle = '#9fd4ff'; g.fillText('💣' + bombs, 218, cy + 16);
    g.fillStyle = '#ff9aa8'; g.fillText('♥' + lives, 238, cy + 27);
    cy += 40;
  }
  g.restore();

  // 보스 체력바
  if (s.B) {
    const hp = s.B[3], mx = s.B[4], nm = s.B[5];
    const [bx, by, bw] = L.boss;
    g.save(); g.translate(bx, by); g.scale(hs, hs);
    const w = bw / hs, x0 = 0, y0 = 0;
    g.textAlign = 'center'; g.font = '800 17px system-ui';
    g.fillStyle = '#fff'; g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 4;
    const armored = s.B[10];
    const label = nm + (armored ? '  🛡 포탑을 먼저 부수세요' : '');
    g.strokeText(label, w / 2, -8); g.fillText(label, w / 2, -8);
    roundRect(g, x0, y0, w, 18, 9, 'rgba(0,0,0,.55)', 'rgba(255,255,255,.3)');
    const frac = clamp(hp / mx, 0, 1);
    if (G.bossLag < frac) G.bossLag = frac;
    G.bossLag = Math.max(frac, G.bossLag - .0045);
    g.fillStyle = 'rgba(255,255,255,.75)';
    g.beginPath(); g.roundRect(x0 + 2, y0 + 2, (w - 4) * G.bossLag, 14, 7); g.fill();
    const bg = g.createLinearGradient(x0, 0, x0 + w, 0);
    if (armored) { bg.addColorStop(0, '#6f8aa8'); bg.addColorStop(1, '#b8cce0'); }
    else { bg.addColorStop(0, '#ff4d6b'); bg.addColorStop(.6, '#ff9a3c'); bg.addColorStop(1, '#ffd166'); }
    g.fillStyle = bg;
    g.beginPath(); g.roundRect(x0 + 2, y0 + 2, (w - 4) * frac, 14, 7); g.fill();
    g.fillStyle = 'rgba(255,255,255,.28)';
    g.beginPath(); g.roundRect(x0 + 4, y0 + 3, Math.max(0, (w - 8) * frac), 5, 3); g.fill();
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
    g.restore();
  }

  if (me) {
    const cl = Math.floor((me[14] || 0) / 10);
    $('#chargeN').textContent = cl ? '×' + cl : '';
    $('#chargeBtn').style.opacity = cl ? '1' : '.4';
    $('#chargeBtn').classList.toggle('full', cl >= S.CHARGE_MAX);
    $('#bombN').textContent = me[8];
    $('#bombBtn').style.opacity = me[8] > 0 ? '1' : '.35';
  }
}

/* 단계 결과 화면 (1945 의 결과표처럼) — 클리어 뒤 몇 초 동안 보여 줍니다 */
function drawResult(g) {
  const R = G.result;
  if (!R || G.phase !== 'clear') return;
  R.t = gameT - R.t0;
  const a = clamp(R.t * 3, 0, 1);
  // 세로 화면에서는 판 폭에 맞춰 조금 키워 읽기 쉽게 합니다
  const zk = Math.max(1, (VW - 30) / 760);
  const w = Math.min(760, VW - 40), h = 150 + R.P.length * 38 + 150;
  const x0 = (VW - w) / 2, y0 = Math.max(20, (VH / zk - h) / 2);
  g.save(); g.globalAlpha = a;
  g.translate(VW / 2, 0); g.scale(zk, zk); g.translate(-VW / 2, 0);
  g.translate(0, (1 - a) * 30);
  roundRect(g, x0, y0, w, h, 22, 'rgba(6,12,28,.88)', 'rgba(255,209,102,.6)');
  g.textAlign = 'center'; g.fillStyle = '#ffd166'; g.font = '900 40px system-ui';
  g.fillText(R.stage + ' 단계 클리어!', VW / 2, y0 + 56);
  g.fillStyle = '#cfe0ff'; g.font = '600 17px system-ui';
  g.fillText('걸린 시간 ' + R.time.toFixed(1) + '초  ·  목표 ' + R.target + '초', VW / 2, y0 + 88);
  // 표: 이름 / 격추 / 메달 / 금괴 / 점수
  const cols = [x0 + 34, x0 + w * .46, x0 + w * .6, x0 + w * .74, x0 + w - 34];
  let y = y0 + 128;
  g.font = '700 14px system-ui'; g.fillStyle = 'rgba(200,220,255,.7)';
  g.textAlign = 'left'; g.fillText('조종사', cols[0], y);
  g.textAlign = 'center'; g.fillText('격추', cols[1], y); g.fillText('🏅메달', cols[2], y); g.fillText('🟨금괴', cols[3], y);
  g.textAlign = 'right'; g.fillText('얻은 점수', cols[4], y);
  const shown = (v, i) => Math.round(v * clamp((R.t - .3 - i * .15) * 2, 0, 1));
  R.P.forEach((r, i) => {
    y += 38;
    const mine = r[0] === G.myId, C = SHIP_COLORS[colorOf(r[0]) % 6];
    if (mine) { g.fillStyle = 'rgba(255,209,102,.12)'; g.fillRect(x0 + 16, y - 26, w - 32, 36); }
    g.fillStyle = C.body; g.beginPath(); g.arc(cols[0] + 6, y - 7, 7, 0, TAU); g.fill();
    g.textAlign = 'left'; g.font = '800 18px system-ui'; g.fillStyle = mine ? '#ffd166' : '#fff';
    g.fillText(nameOf(r[0]) || '조종사', cols[0] + 20, y);
    g.textAlign = 'center'; g.fillStyle = '#fff';
    g.fillText(shown(r[1], i), cols[1], y); g.fillText(shown(r[2], i), cols[2], y); g.fillText(shown(r[3], i), cols[3], y);
    g.textAlign = 'right'; g.fillStyle = '#ffd166'; g.fillText(shown(r[4], i).toLocaleString(), cols[4], y);
  });
  y += 50;
  g.strokeStyle = 'rgba(255,255,255,.15)'; g.beginPath(); g.moveTo(x0 + 24, y - 30); g.lineTo(x0 + w - 24, y - 30); g.stroke();
  g.font = '700 19px system-ui';
  const line = (label, v, c, k) => {
    g.textAlign = 'left'; g.fillStyle = '#dfe8ff'; g.fillText(label, cols[0], y);
    g.textAlign = 'right'; g.fillStyle = c; g.fillText('+' + Math.round(v * clamp((R.t - k) * 2, 0, 1)).toLocaleString(), cols[4], y);
    y += 32;
  };
  line('단계 보너스', R.base, '#8ef0b6', 1.0);
  line('⏱ 시간 보너스' + (R.timeBonus > 0 ? '' : ' (다음엔 더 빨리!)'), R.timeBonus, '#7fe0ff', 1.3);
  g.textAlign = 'center'; g.font = '600 15px system-ui'; g.fillStyle = 'rgba(200,220,255,.75)';
  g.fillText('곧 다음 단계로 이어집니다…', VW / 2, y + 8);
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
  const y = VH * .38;
  const col = b.kind === 'boss' ? '#ff6b8a' : b.kind === 'clear' ? '#8ef0b6' : b.kind === 'wipe' ? '#ff9aa8' : '#ffd166';
  // 글자 뒤 가로 띠
  const band = g.createLinearGradient(0, 0, VW, 0);
  band.addColorStop(0, 'rgba(0,0,0,0)'); band.addColorStop(.5, 'rgba(0,0,0,.45)'); band.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = band; g.fillRect(0, y - 78, VW, b.sub ? 138 : 100);
  g.fillStyle = col;
  const sw = Math.min(1, age * 3) * VW * .42;
  g.fillRect(VW / 2 - sw, y - 80, sw * 2, 2); g.fillRect(VW / 2 - sw, y + (b.sub ? 58 : 20), sw * 2, 2);
  g.translate(VW / 2, y - 20); g.scale(pop, pop); g.translate(-VW / 2, -(y - 20));
  g.font = '900 76px system-ui'; g.lineWidth = 10; g.strokeStyle = 'rgba(0,0,0,.65)';
  g.strokeText(b.big, VW / 2, y);
  const grd = g.createLinearGradient(0, y - 60, 0, y + 12);
  grd.addColorStop(0, '#fff'); grd.addColorStop(1, col);
  g.fillStyle = grd; g.fillText(b.big, VW / 2, y);
  if (b.sub) {
    g.font = '700 26px system-ui'; g.lineWidth = 6;
    g.strokeStyle = 'rgba(0,0,0,.6)'; g.strokeText(b.sub, VW / 2, y + 44);
    g.fillStyle = '#dfe8ff'; g.fillText(b.sub, VW / 2, y + 44);
  }
  g.restore();
}

/* ═══════════════════ 조작 ═══════════════════ */
let pointerActive = false;
function setTargetFromClient(cx, cy, touch) {
  const p = toField(cx, cy);
  // 손가락이 비행기를 가리지 않도록 화면 위쪽으로 70 만큼 띄웁니다 (세로면 판의 앞쪽)
  G.input.tx = clamp(p.x + (touch && VERT ? 70 : 0), 20, F.w - 20);
  G.input.ty = clamp(p.y - (touch && !VERT ? 70 : 0), 20, F.h - 20);
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
  if (e.code === 'KeyX' || e.code === 'KeyZ' || e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'Enter') { e.preventDefault(); G.input.charge = true; }
  if (e.code === 'Escape' && G.mode !== 'menu') quit();
  if (e.code === 'KeyP') togglePause();
});
window.addEventListener('keyup', (e) => { G.keys[e.code] = false; });
$('#bombBtn').addEventListener('click', () => { G.input.bomb = true; });
$('#chargeBtn').addEventListener('click', () => { G.input.charge = true; });

// 키보드 이동 (마우스와 같이 써도 됩니다)
setInterval(() => {
  if (G.mode === 'menu') return;
  const k = G.keys, sp = 22;
  let dx = 0, dy = 0;
  let sx = 0, sy = 0;   // 화면 기준 방향
  if (k.ArrowLeft || k.KeyA) sx -= 1;
  if (k.ArrowRight || k.KeyD) sx += 1;
  if (k.ArrowUp || k.KeyW) sy -= 1;
  if (k.ArrowDown || k.KeyS) sy += 1;
  if (VERT) { dx = -sy; dy = sx; } else { dx = sx; dy = sy; }
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
  G.ws.send(JSON.stringify({ a: 'i', tx: Math.round(G.input.tx), ty: Math.round(G.input.ty), b: G.input.bomb ? 1 : 0, c: G.input.charge ? 1 : 0 }));
  G.input.bomb = false; G.input.charge = false;
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
  $('#bombBtn').classList.add('on'); $('#chargeBtn').classList.add('on');
  G.wing.clear(); G.raid = null;
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
  $('#bombBtn').classList.remove('on'); $('#chargeBtn').classList.remove('on');
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
/* ── 기체 해금 (선생님 설정값) ──
 *  이 기기에서 도달한 가장 높은 단계가 아래 값 이상이면 그 비행기가 열립니다.
 *  순서: 하늘매 · 노을부채 · 숲창 · 보라벌 · 분홍망치 · 금빛독수리
 *  모두 열기: 주소 끝에 ?unlockall=1 (되돌리기: ?unlockall=0) — 기기마다 한 번만 하면 기억됩니다. */
const UNLOCK_STAGE = [1, 3, 6, 11, 16, 21];
(function unlockParam() {
  const q = new URLSearchParams(location.search).get('unlockall');
  if (q === '1') localStorage.setItem('sky.unlockall', '1');
  if (q === '0') localStorage.removeItem('sky.unlockall');
})();
const allOpen = () => localStorage.getItem('sky.unlockall') === '1';
const shipOpen = (i) => allOpen() || unlocked() >= UNLOCK_STAGE[i % 6];
const openCount = () => [0, 1, 2, 3, 4, 5].filter(shipOpen).length;
let myColor = 0;
function buildShipPicker() {
  const box = $('#ships');
  box.innerHTML = '';
  SHIP_COLORS.forEach((C, i) => {
    const b = document.createElement('button');
    b.title = C.name;
    const c = document.createElement('canvas'); c.width = 128; c.height = 88;
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 60, 44);   // 날개 폭(최대 ±40)이 칸 안에 들어오게
    const im = artOf('ship' + i);
    if (im) drawArt(g, im, Math.PI / 2, 84); else drawShipArt(g, C, i);
    b.appendChild(c);
    if (i === myColor) b.classList.add('on');
    const open = shipOpen(i);
    if (!open) { b.classList.add('locked'); b.title = '🔒 ' + UNLOCK_STAGE[i] + '단계에 도착하면 열려요'; }
    b.addEventListener('click', () => {
      if (!open) {
        const T = S.SHIP_TYPES[i];
        $('#shipInfo').innerHTML = '🔒 <b>' + T.name + '</b> — <b>' + UNLOCK_STAGE[i] + '단계</b>에 도착하면 열려요 (지금 최고 ' + unlocked() + '단계) · ' + T.desc;
        return;
      }
      myColor = i;
      [...box.children].forEach((x, j) => x.classList.toggle('on', j === i));
      localStorage.setItem('sky.color', i);
      showShipInfo();
    });
    box.appendChild(b);
  });
}
function showShipInfo() {
  const T = S.SHIP_TYPES[myColor % 6];
  $('#shipInfo').innerHTML = '<b>' + T.name + '</b> — ' + T.desc;
}
function logo() {
  const c = $('#logoShip'), g = c.getContext('2d');
  const emb = artOf('logo');
  c.classList.toggle('emblem', !!emb);
  c.width = emb ? 140 : 148; c.height = emb ? 140 : 104;
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height);
  if (emb) { g.drawImage(emb, 0, 0, 140, 140); }
  else { g.setTransform(1.3, 0, 0, 1.3, 74, 52); drawShipArt(g, SHIP_COLORS[0]); }
  // 시작 화면 배경 그림
  const bg = ART_ON && artReady && window.SKY_ART && window.SKY_ART.title_bg;
  $('#menu').classList.toggle('canva', !!bg);
  if (bg) $('#menu').style.setProperty('--menuBg', 'url(' + bg + ')');
}
logo();
// Canva 그림이 다 읽히면(또는 스타일을 바꾸면) 메뉴 그림을 다시 그립니다
window.__artChanged = () => { logo(); buildShipPicker(); };
buildShipPicker();
showShipInfo();
function setOrient(v) {
  VERT = v;
  localStorage.setItem('sky.vert', v ? 'v' : 'h');
  document.querySelectorAll('.orient:not(.sizes):not(.arts) button').forEach((b) => b.classList.toggle('on', (b.dataset.o === 'v') === v));
  $('#rotDir').textContent = v ? '세로로' : '가로로';
  $('#rotAlt').textContent = v ? '(또는 나가서 화면 방향을 "가로"로 바꾸세요)' : '(또는 나가서 화면 방향을 "세로"로 바꾸세요)';
  G.wing.clear();
  resize();
  setSize(SIZE_PICK);   // 방향이 바뀌면 '자동' 크기도 다시 계산
}
document.querySelectorAll('.orient:not(.sizes):not(.arts) button').forEach((b) => b.addEventListener('click', () => setOrient(b.dataset.o === 'v')));
function setArt(on) {
  ART_ON = on;
  localStorage.setItem('sky.art', on ? 'canva' : 'draw');
  document.querySelectorAll('.arts button').forEach((b) => b.classList.toggle('on', (b.dataset.a === 'canva') === on));
  spriteCache.clear();
  window.__artChanged();
}
document.querySelectorAll('.arts button').forEach((b) => b.addEventListener('click', () => setArt(b.dataset.a === 'canva')));
setOrient(VERT);
function setSize(z) {
  SIZE_PICK = z;
  localStorage.setItem('sky.size', z);
  document.querySelectorAll('.sizes button').forEach((b) => b.classList.toggle('on', b.dataset.z === z));
  calcZS();
  $('#sizeNow').textContent = '— 지금 ' + Math.round(ZS * 100) + '% (맞는 판정은 그대로)';
}
document.querySelectorAll('.sizes button').forEach((b) => b.addEventListener('click', () => setSize(b.dataset.z)));
setSize(SIZE_PICK);
window.addEventListener('resize', () => setSize(SIZE_PICK));
setArt(ART_ON);

$('#nick').value = localStorage.getItem('sky.nick') || '';
// 지난번에 쓰던 방 코드를 미리 넣어 둡니다 (다음 시간에 이어서 하기 편하도록)
const lastRoom = localStorage.getItem('sky.room');
if (lastRoom) {
  $('#code').value = lastRoom;
  setTimeout(() => $('#code').dispatchEvent(new Event('input')), 60);
}
const savedColor = localStorage.getItem('sky.color');
if (savedColor !== null && shipOpen(+savedColor)) { myColor = +savedColor; buildShipPicker(); showShipInfo(); }

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
// 최고 기록 갱신 + 새 비행기가 열렸으면 알림
setInterval(() => {
  if (G.mode === 'menu') return;
  const before = openCount();
  setUnlocked(G.stage);
  if (openCount() > before) {
    const names = [0, 1, 2, 3, 4, 5].filter((i) => shipOpen(i) && UNLOCK_STAGE[i] > 1 && unlocked() - UNLOCK_STAGE[i] < 3).map((i) => S.SHIP_TYPES[i].name);
    const nm = names[names.length - 1] || '새 비행기';
    G.banner = { big: '✈ 새 비행기 해금!', sub: nm + ' — 다음 출격 때 고를 수 있어요', kind: 'clear' }; G.bannerT = 3.2;
    toast('🔓 ' + nm + ' 열림!', '#ffd166');
    SFX.lvup();
    buildShipPicker();
  }
}, 2000);

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
  const VERSION = 3;               // 2: 보조기·차지샷·메달 / 3: 기체 6종·지상 목표물·부품 보스·결과 화면

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
  const CLEAR_SEC = 6.5;            // 결과 화면을 읽을 시간
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

  // ── 보조기(윙맨) — 무기 Lv2부터 한 대씩, 최대 4대가 뒤에서 따라 쏩니다 ──
  const WING = [[-30, -52], [-30, 52], [-60, -96], [-60, 96]];
  const WING_CD = 0.26;
  const WING_DMG = 8;
  const wingCount = (gun) => clamp(gun - 1, 0, 4);

  // ── 차지샷 — 게이지가 저절로 차고, 버튼을 누르면 한 번에 뚫고 나가는 큰 포탄 ──
  const CHARGE_SEC = 2.2;           // 한 칸 차는 시간
  const CHARGE_MAX = 3;
  const CHARGE_DMG = [0, 90, 190, 330];

  // ── 기체 6종 — 비행기 색(0~5)마다 무기 성격과 차지샷이 다릅니다 ──
  //  spread: 퍼짐 배율, dmg: 피해 배율, cd: 발사 간격 배율, pierce: 관통 추가, life: 사거리(초), bombs: 폭탄 추가
  const SHIP_TYPES = [
    { key: 'balance', name: '하늘매',     desc: '균형형 · 차지: 거대 포탄',       spread: 1,    dmg: 1,    cd: 1,    pierce: 0, life: 6,   bombs: 0, charge: 'orb' },
    { key: 'spread',  name: '노을부채',   desc: '넓게 퍼짐 · 차지: 부채꼴 포탄', spread: 1.9,  dmg: 0.82, cd: 1,    pierce: 0, life: 6,   bombs: 0, charge: 'fan' },
    { key: 'lance',   name: '숲창',       desc: '곧게 관통 · 차지: 관통 창',      spread: 0.35, dmg: 0.95, cd: 1,    pierce: 1, life: 6,   bombs: 0, charge: 'lance' },
    { key: 'rapid',   name: '보라벌',     desc: '빠른 연사 · 차지: 유도 미사일',  spread: 1,    dmg: 0.72, cd: 0.7,  pierce: 0, life: 6,   bombs: 0, charge: 'missile' },
    { key: 'heavy',   name: '분홍망치',   desc: '짧고 강함 · 차지: 사방 충격파',  spread: 1.2,  dmg: 1.55, cd: 1,    pierce: 0, life: 0.5, bombs: 0, charge: 'nova' },
    { key: 'bomber',  name: '금빛독수리', desc: '폭탄 +1 · 차지: 융단 폭격',     spread: 1,    dmg: 0.9,  cd: 1,    pierce: 0, life: 6,   bombs: 1, charge: 'carpet' },
  ];
  const shipType = (color) => SHIP_TYPES[((color | 0) % 6 + 6) % 6];

  // ── 지형 — 화면과 서버가 똑같은 땅을 보도록 여기서 계산합니다 ──
  //  땅은 초당 GROUND_SPEED 만큼 왼쪽으로 흐르고, 가로로 FIELD.w 마다 되풀이됩니다.
  const TERRAIN_W = 800, TERRAIN_H = 450;      // 지형 격자(화면의 절반 해상도)
  const GROUND_SPEED = 130;
  const TERRAIN = {
    dawn: { sea: 0.555, shift: -0.03 }, cloud: { sea: 0.555, shift: -0.06 }, sunset: {}, night: { sea: 0.43 },
    aurora: { lake: 0.36 }, desert: { lake: 0.24 }, volcano: {}, glacier: { sea: 0.5 }, strato: null, space: null,
  };
  function periodicNoise(seed) {
    const r = mulberry32(seed), T = new Float32Array(8192);
    for (let i = 0; i < T.length; i++) T[i] = r();
    const hsh = (i, j, P, o) => T[(((((i % P) + P) % P) * 92821) ^ ((j + o * 977) * 68917)) & 8191];
    const one = (x, y, P, o) => {
      const cs = TERRAIN_W / P, fx = x / cs, fy = y / cs, ix = Math.floor(fx), iy = Math.floor(fy);
      let tx = fx - ix, ty = fy - iy; tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
      const a = hsh(ix, iy, P, o), b = hsh(ix + 1, iy, P, o), c = hsh(ix, iy + 1, P, o), d = hsh(ix + 1, iy + 1, P, o);
      return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    };
    return (x, y) => one(x, y, 5, 0) * 0.5 + one(x, y, 10, 1) * 0.25 + one(x, y, 20, 2) * 0.15 + one(x, y, 40, 3) * 0.1;
  }
  const noiseByZone = [];
  const terrainNoise = (zone) => noiseByZone[zone] || (noiseByZone[zone] = periodicNoise(1000 + zone * 31));
  // 지형 격자 한 칸의 높이 (0~1)
  function terrainHeight(zone, tx, ty) {
    const T = TERRAIN[(ZONES[zone] || ZONES[0]).key] || {};
    const n = (terrainNoise(zone)(((tx % TERRAIN_W) + TERRAIN_W) % TERRAIN_W, ty) - 0.5) * 1.9 + 0.5 + (T.shift || 0);
    return clamp(n, 0, 1);
  }
  const groundOffset = (tick) => ((tick * DT * GROUND_SPEED) % FIELD.w + FIELD.w) % FIELD.w;
  // 필드의 한 점이 지금 무엇 위에 있는지: 'sea' · 'lake' · 'land' · null(하늘 높이라 땅이 없음)
  function terrainAt(zone, x, y, tick) {
    const T = TERRAIN[(ZONES[zone] || ZONES[0]).key];
    if (!T) return null;
    const n = terrainHeight(zone, (x + groundOffset(tick)) / 2, clamp(y, 0, FIELD.h - 1) / 2);
    if (T.sea !== undefined && n < T.sea) return 'sea';
    if (T.lake !== undefined && n < T.lake) return 'lake';
    return 'land';
  }

  // ── 지상 목표물 — 땅과 함께 흘러가며 쏘고, 부수면 금괴를 떨어뜨립니다 ──
  const GROUND_UNITS = {
    tank:   { hp: 26, r: 20, score: 30, on: 'land', every: 2.9, k: 'aim1' },
    aa:     { hp: 20, r: 18, score: 26, on: 'land', every: 3.3, k: 'twin' },
    bunker: { hp: 60, r: 26, score: 50, on: 'land', every: 3.6, k: 'radial6' },
    ship:   { hp: 85, r: 34, score: 60, on: 'sea',  every: 2.8, k: 'spread3' },
  };
  const ZONE_GROUND = [['ship', 'tank', 'aa'], ['ship', 'aa'], ['tank', 'aa', 'bunker'], ['aa', 'tank', 'ship'],
    ['tank', 'aa'], ['tank', 'bunker'], ['bunker', 'aa'], ['ship', 'aa'], [], []];
  const GOLD = 250;
  // 보스 포탑 자리 (보스 반경 배수) — 앞쪽 위아래, 뒤쪽 위아래
  const BOSS_PART_POS = [[-0.3, -0.72], [-0.3, 0.72], [0.35, -0.95], [0.35, 0.95]];
  const ARMOR_MUL = 0.35;          // 포탑이 남아 있으면 본체는 35%만 맞습니다

  // ── 메달 — 6초 안에 이어서 먹으면 값이 올라갑니다 ──
  const MEDAL = [100, 200, 300, 500, 800, 1000, 1500, 2000];
  const CHAIN_SEC = 6;

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
    const plan = { n, zone, isBoss, waves, tier, hpMul, fireMul };
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
      this.grounds = [];            // 지상 목표물 (전차·대공포·토치카·군함)
      this.groundT = 2;
      this.stageT = 0;              // 이번 단계에 걸린 시간 (시간 보너스)
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
        hp: P_MAXHP, lives: P_LIVES, gun: 1, bombs: BOMB_START + shipType(color).bombs,
        down: false, downT: 0, revT: 0, invT: SPAWN_INV, shieldT: 0,
        fireCd: 0, score: 0, kills: 0, deaths: 0, ang: 0, alive: true, joinT: 0,
        wingCd: WING_CD, charge: 0, chain: 0, chainT: 0,
        sk: 0, sm: 0, sg: 0, score0: 0,     // 이번 단계 격추·메달·금괴·시작 점수 (결과 화면용)
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
      if (inp.charge) this.fireCharge(p);
    }
    fireCharge(p) {
      if (p.down || p.charge < 1 || (this.phase !== 'play' && this.phase !== 'boss')) return;
      const lv = Math.floor(clamp(p.charge, 0, CHARGE_MAX));
      p.charge = 0;
      const D = CHARGE_DMG[lv] * (1 + (this.stage - 1) * 0.06);
      const T = shipType(p.color);
      const C = (o) => this.addBullet(Object.assign({ x: p.x + 40, y: p.y, own: p.id, col: p.color, life: 3, cg: 1, kind: 'pk' }, o));
      switch (T.charge) {
        case 'fan':       // 부채꼴로 퍼지는 포탄
          for (let k = 0; k < 3 + lv * 2; k++) {
            const a = (k / (2 + lv * 2) - 0.5) * 1.1;
            C({ vx: Math.cos(a) * 950, vy: Math.sin(a) * 950, r: 16 + lv * 3, dmg: Math.round(D * 0.45) });
          }
          break;
        case 'lance':     // 한 줄로 길게 뚫고 가는 창
          for (let k = 0; k < 4 + lv * 2; k++) C({ x: p.x + 40 - k * 46, vx: 1700, vy: 0, r: 12 + lv * 4, dmg: Math.round(D * 0.32) });
          break;
        case 'missile':   // 적을 따라가는 미사일
          for (let k = 0; k < 2 + lv * 2; k++) {
            const a = (k % 2 ? -1 : 1) * (0.5 + (k >> 1) * 0.25);
            C({ vx: Math.cos(a) * 520, vy: Math.sin(a) * 520, r: 12, dmg: Math.round(D * 0.42), hom: 4.2, kind: 'pm', life: 3.5 });
          }
          break;
        case 'nova':      // 사방으로 퍼지는 충격파
          for (let k = 0; k < 8 + lv * 4; k++) {
            const a = k / (8 + lv * 4) * Math.PI * 2;
            C({ x: p.x, vx: Math.cos(a) * 760, vy: Math.sin(a) * 760, r: 16 + lv * 3, dmg: Math.round(D * 0.42), life: 0.9 });
          }
          break;
        case 'carpet':    // 앞쪽 세로 한 줄 전체를 폭격
          for (let k = 0; k < 5 + lv * 2; k++) {
            const y = clamp(p.y + (k / (4 + lv * 2) - 0.5) * (260 + lv * 120), 30, FIELD.h - 30);
            C({ y, vx: 900, vy: 0, r: 18 + lv * 3, dmg: Math.round(D * 0.4) });
          }
          break;
        default:          // 거대 포탄
          C({ vx: 1050, vy: 0, r: 20 + lv * 9, dmg: Math.round(D), kind: 'pc' });
      }
      this.fx.push({ t: 'charge', id: p.id, x: p.x, y: p.y, lv, k: T.charge });
    }
    alivePlayers() { const a = []; for (const p of this.players.values()) if (!p.down) a.push(p); return a; }

    clearField() {
      this.enemies.length = 0; this.beams.length = 0; this.pickups.length = 0; this.boss = null;
      this.grounds.length = 0; this.groundT = 2;
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
      this.stageKills = 0; this.stageScore0 = this.score; this.stageT = 0;
      for (const p of this.players.values()) {
        p.sk = 0; p.sm = 0; p.sg = 0; p.score0 = p.score;
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
        cds: [], flash: 0, chargeT: 0, clones: [], fireMul: this.plan.boss.fire, parts: [],
      };
      // 1945 식 부품 — 포탑을 먼저 부숴야 본체가 제대로 맞습니다. 지역이 오를수록 포탑이 늘어납니다.
      const nParts = 2 + (this.plan.zone >= 3 ? 1 : 0) + (this.plan.zone >= 6 ? 1 : 0);
      for (let i = 0; i < nParts; i++) {
        const [ox, oy] = BOSS_PART_POS[i];
        const php = Math.round(hp * 0.07);
        this.boss.parts.push({ dx: ox * b.r, dy: oy * b.r, hp: php, maxHp: php, r: Math.max(22, b.r * 0.2),
          alive: true, cd: 1.5 + i * 0.4, ang: Math.PI, flash: 0 });
      }
      this.boss.armored = true;
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
      this.stageT += dt;
      this.stepPlayers(dt);
      this.stepEnemies(dt);
      this.stepGrounds(dt);
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
      const base = 300 + this.stage * 40;
      // 시간 보너스: 목표 시간보다 빨리 깰수록 커집니다 (1945 의 '시간 메달')
      const target = this.plan.waves.length * 11 + (this.plan.isBoss ? 70 : 0);
      const timeBonus = Math.max(0, Math.round((target - this.stageT) * 25 * (1 + this.stage * 0.04)));
      const bonus = base + timeBonus;
      this.score += bonus;
      this.best = Math.max(this.best, Math.min(TOTAL_STAGES, this.stage + 1));
      this.clearField();
      const P = [];
      for (const p of this.players.values()) P.push([p.id, p.sk, p.sm, p.sg, p.score - p.score0]);
      this.log = { stage: this.stage, bonus, score: this.score };
      this.fx.push({ t: 'clear', stage: this.stage, bonus, base, timeBonus, time: Math.round(this.stageT * 10) / 10, target, P });
      for (const p of this.players.values()) {
        if (p.down) { p.down = false; p.hp = Math.round(P_MAXHP * 0.6); p.invT = SPAWN_INV; }
        else p.hp = Math.min(P_MAXHP, p.hp + 34);
        if (p.bombs < BOMB_MAX + shipType(p.color).bombs && this.stage % 5 === 0) p.bombs++;
      }
    }

    /* ── 아군 ── */
    stepPlayers(dt) {
      for (const p of this.players.values()) {
        p.joinT += dt;
        if (p.invT > 0) p.invT -= dt;
        if (p.chainT > 0) { p.chainT -= dt; if (p.chainT <= 0) p.chain = 0; }
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
          const T = shipType(p.color);
          if (p.fireCd <= 0) {
            p.fireCd = g.cd * T.cd;
            for (const s of g.shots) {
              const spd = BULLET_SPD;
              const a = s.a === Math.PI ? s.a : s.a * T.spread;
              this.addBullet({
                x: p.x + 26, y: p.y + (s.dy || 0) * (T.spread < 1 ? 0.6 : 1), vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
                r: s.big ? 9 : 6, dmg: s.dmg * T.dmg, own: p.id, kind: s.big === 2 ? 'p3' : s.big ? 'p2' : 'p1',
                pierce: Math.max(s.pierce || 0, T.pierce), col: p.color, life: T.life,
              });
            }
          }
          // 보조기 사격
          const nw = wingCount(p.gun);
          if (nw > 0) {
            p.wingCd -= dt;
            if (p.wingCd <= 0) {
              p.wingCd = WING_CD;
              for (let w = 0; w < nw; w++) {
                const x = clamp(p.x + WING[w][0], 10, FIELD.w - 10), y = clamp(p.y + WING[w][1], 10, FIELD.h - 10);
                this.addBullet({ x: x + 16, y, vx: BULLET_SPD, vy: 0, r: 6, dmg: WING_DMG, own: p.id, kind: 'pw', col: p.color });
              }
            }
          }
          if (p.charge < CHARGE_MAX) p.charge = Math.min(CHARGE_MAX, p.charge + dt / CHARGE_SEC);
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
      for (let i = this.grounds.length - 1; i >= 0; i--) {
        const g = this.grounds[i];
        if (d2(g.x, g.y, p.x, p.y) < BOMB_R * BOMB_R) this.damageGround(i, 120, p);
      }
      if (this.boss && d2(this.boss.x, this.boss.y, p.x, p.y) < (BOMB_R + this.boss.r) * (BOMB_R + this.boss.r)) {
        const B = this.boss;
        for (let i = 0; i < B.parts.length; i++) if (B.parts[i].alive) this.damagePart(i, 150, p);
        if (this.boss) this.damageBoss(200, p);
      }
    }

    /* ── 총알 ── */
    addBullet(o) {
      const b = {
        id: this.nid++, x: o.x, y: o.y, vx: o.vx, vy: o.vy, r: o.r || 7,
        dmg: o.dmg || 8, own: o.own === undefined ? -1 : o.own, kind: o.kind || 'e1',
        pierce: o.pierce || 0, hom: o.hom || 0, life: o.life || 6, born: this.tick, col: o.col || 0,
        cg: o.cg || 0,
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
          // 유도탄 — 적탄은 가장 가까운 아군을, 아군 미사일은 가장 가까운 적을 향해 돕니다
          const tgt = b.own === -1 ? this.nearestPlayer(b.x, b.y) : this.nearestTarget(b.x, b.y);
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
    nearestTarget(x, y) {
      let best = null, bd = Infinity;
      const see = (o) => { const d = d2(x, y, o.x, o.y); if (d < bd) { bd = d; best = o; } };
      for (const e of this.enemies) see(e);
      for (const g of this.grounds) see(g);
      if (this.boss && !this.boss.entering) see(this.boss);
      return best;
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

    /* ── 지상 목표물 ── */
    stepGrounds(dt) {
      const zone = this.plan ? this.plan.zone : 0;
      const kinds = ZONE_GROUND[zone] || [];
      if (kinds.length && (this.phase === 'play' || this.phase === 'boss')) {
        this.groundT -= dt;
        if (this.groundT <= 0) {
          this.groundT = 2.4 + this.rng() * 2.4;
          if (this.grounds.length < 5) {
            // 오른쪽 끝에서 땅 모양에 맞는 자리를 찾습니다 (군함은 바다, 전차는 땅)
            for (let tries = 0; tries < 8; tries++) {
              const x = FIELD.w + 40, y = 80 + this.rng() * (FIELD.h - 160);
              const t = terrainAt(zone, x, y, this.tick);
              const fit = kinds.filter((k) => (GROUND_UNITS[k].on === 'sea') === (t === 'sea' || t === 'lake'));
              if (!fit.length) continue;
              // 배는 몸집이 커서 앞뒤도 바다여야 합니다
              const type = fit[Math.floor(this.rng() * fit.length)];
              if (type === 'ship' && (terrainAt(zone, x - 40, y, this.tick) === 'land' || terrainAt(zone, x + 40, y, this.tick) === 'land')) continue;
              const d = GROUND_UNITS[type];
              const hp = Math.round(d.hp * this.plan.hpMul * (0.6 + 0.4 * Math.max(1, this.players.size)));
              this.grounds.push({ id: this.nid++, type, x, y, hp, maxHp: hp, r: d.r, ang: Math.PI,
                fireCd: 1 + this.rng() * d.every, flash: 0 });
              break;
            }
          }
        }
      }
      for (let i = this.grounds.length - 1; i >= 0; i--) {
        const g = this.grounds[i];
        g.x -= GROUND_SPEED * dt;
        if (g.flash > 0) g.flash -= dt;
        const tgt = this.nearestPlayer(g.x, g.y);
        if (tgt) {
          const want = Math.atan2(tgt.y - g.y, tgt.x - g.x);
          let d = want - g.ang;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          g.ang += clamp(d, -2.5 * dt, 2.5 * dt);
        }
        const d = GROUND_UNITS[g.type];
        g.fireCd -= dt;
        if (g.fireCd <= 0 && g.x < FIELD.w - 40 && g.x > 160 && tgt) {
          g.fireCd = d.every * (this.plan ? this.plan.fireMul : 1) * 1.15;
          this.groundFire(g, d.k);
        }
        if (g.x < -60) { this.grounds[i] = this.grounds[this.grounds.length - 1]; this.grounds.pop(); }
      }
    }
    groundFire(g, kind) {
      const S = (a, spd, kd) => this.addBullet({ x: g.x + Math.cos(g.ang) * g.r, y: g.y + Math.sin(g.ang) * g.r,
        vx: Math.cos(a) * spd, vy: Math.sin(a) * spd, r: 8, dmg: 11, own: -1, kind: kd || 'e1' });
      switch (kind) {
        case 'twin': S(g.ang - 0.12, 360); S(g.ang + 0.12, 360); break;
        case 'spread3': for (let k = -1; k <= 1; k++) S(g.ang + k * 0.28, 300, 'e2'); break;
        case 'radial6': for (let k = 0; k < 6; k++) S(g.ang + k * Math.PI / 3, 250); break;
        default: S(g.ang, 330);
      }
    }
    damageGround(i, dmg, byPlayer) {
      const g = this.grounds[i];
      g.hp -= dmg; g.flash = 0.08;
      if (g.hp > 0) return false;
      const gain = GROUND_UNITS[g.type].score * (1 + this.stage * 0.05) | 0;
      this.score += gain;
      if (byPlayer) { byPlayer.score += gain; byPlayer.kills++; byPlayer.sk++; }
      this.fx.push({ t: 'boom', x: g.x, y: g.y, s: g.r, gnd: 1 });
      this.addPickup('gold', g.x, g.y, -GROUND_SPEED);
      this.grounds[i] = this.grounds[this.grounds.length - 1];
      this.grounds.pop();
      return true;
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
      if (byPlayer) { byPlayer.score += gain; byPlayer.kills++; byPlayer.sk++; }
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
      else if (r < 0.30) type = 'star';
      if (!type) return;
      this.addPickup(type, x, y);
    }
    addPickup(type, x, y, vx) {
      const k = { id: this.nid++, type, x, y, vx: vx === undefined ? -85 : vx, vy: 0, t: 0 };
      // P 아이템은 화면 위아래를 튕겨 다닙니다 (1945 처럼 쫓아가서 먹는 재미)
      if (type === 'pow') { k.vx = -55; k.vy = (this.rng() < 0.5 ? -1 : 1) * 150; k.bounce = 1; }
      this.pickups.push(k);
      return k;
    }
    stepPickups(dt) {
      for (let i = this.pickups.length - 1; i >= 0; i--) {
        const k = this.pickups[i];
        k.t += dt;
        k.x += k.vx * dt;
        if (k.bounce) {
          k.y += k.vy * dt;
          if (k.y < 70) { k.y = 70; k.vy = Math.abs(k.vy); }
          if (k.y > FIELD.h - 70) { k.y = FIELD.h - 70; k.vy = -Math.abs(k.vy); }
          if (k.x < 80 && k.t < 12) k.vx = Math.abs(k.vx);     // 왼쪽 끝에서도 한 번 되돌아옵니다
          if (k.x > FIELD.w - 80) k.vx = -Math.abs(k.vx);
        } else k.y += Math.sin(k.t * 2.2) * 34 * dt;
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
        case 'bomb': p.bombs = Math.min(BOMB_MAX + shipType(p.color).bombs, p.bombs + 1); break;
        case 'gold': {
          const v = Math.round(GOLD * (1 + this.stage * 0.03));
          p.score += v; this.score += v; p.sg++;
          this.fx.push({ t: 'grab', x: p.x, y: p.y, k: type, id: p.id, v });
          return;
        }
        case 'shield': p.shieldT = 9; break;
        case 'star': {
          p.chain = p.chainT > 0 ? p.chain + 1 : 1;
          p.chainT = CHAIN_SEC;
          const v = MEDAL[Math.min(p.chain, MEDAL.length) - 1];
          p.score += v; this.score += v; p.sm++;
          this.fx.push({ t: 'grab', x: p.x, y: p.y, k: type, id: p.id, v, n: p.chain });
          return;
        }
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

      // 포탑: 가장 가까운 아군을 겨눠 두 발씩
      for (const pt of B.parts) {
        if (!pt.alive) continue;
        if (pt.flash > 0) pt.flash -= dt;
        const px = B.x + pt.dx, py = B.y + pt.dy;
        const tgt = this.nearestPlayer(px, py);
        if (tgt) pt.ang = Math.atan2(tgt.y - py, tgt.x - px);
        pt.cd -= dt;
        if (pt.cd <= 0 && tgt) {
          pt.cd = 2.3 * B.fireMul;
          for (const k of [-0.1, 0.1]) this.addBullet({ x: px, y: py, vx: Math.cos(pt.ang + k) * 330, vy: Math.sin(pt.ang + k) * 330, r: 8, dmg: 12, own: -1, kind: 'e1' });
        }
      }

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

    damagePart(i, dmg, byPlayer) {
      const B = this.boss;
      if (!B || B.entering) return false;
      const pt = B.parts[i];
      if (!pt || !pt.alive) return false;
      pt.hp -= dmg; pt.flash = 0.08;
      if (pt.hp > 0) return false;
      pt.alive = false;
      const gain = 300 + this.stage * 20;
      this.score += gain;
      if (byPlayer) { byPlayer.score += gain; byPlayer.sk++; }
      this.fx.push({ t: 'partdown', x: B.x + pt.dx, y: B.y + pt.dy });
      this.addPickup('gold', B.x + pt.dx, B.y + pt.dy, -90);
      if (B.armored && B.parts.every((q) => !q.alive)) {
        B.armored = false;              // 장갑이 벗겨지며 본체가 드러납니다
        this.fx.push({ t: 'armorbreak', x: B.x, y: B.y, r: B.r });
      }
      return true;
    }
    damageBoss(dmg, byPlayer) {
      const B = this.boss;
      if (!B || B.entering) return false;
      if (B.armored) dmg *= ARMOR_MUL;
      B.hp -= dmg; B.flash = 0.1;
      if (B.hp > 0) return false;
      const gain = 2000 + this.stage * 120;
      this.score += gain;
      if (byPlayer) { byPlayer.score += gain; byPlayer.kills++; }
      this.fx.push({ t: 'bossdown', x: B.x, y: B.y, r: B.r });
      for (let i = 0; i < 10; i++) {
        const k = this.addPickup('star', B.x + (this.rng() - 0.5) * B.r, B.y + (this.rng() - 0.5) * B.r * 1.4, -60 - this.rng() * 160);
        k.t = -2;   // 보통 메달보다 2초 더 남아 있습니다
      }
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
        if (b.cg) {
          if (!b.hits) b.hits = new Set();
          for (let j = this.grounds.length - 1; j >= 0; j--) {
            const g = this.grounds[j];
            if (b.hits.has(g.id)) continue;
            const rr = g.r + b.r;
            if (d2(b.x, b.y, g.x, g.y) > rr * rr) continue;
            b.hits.add(g.id);
            this.damageGround(j, b.dmg, p);
          }
          if (this.boss) {
            const B = this.boss;
            for (let j = 0; j < B.parts.length; j++) {
              const pt = B.parts[j];
              if (!pt.alive || b.hits.has('p' + j)) continue;
              const rr = pt.r + b.r;
              if (d2(b.x, b.y, B.x + pt.dx, B.y + pt.dy) > rr * rr) continue;
              b.hits.add('p' + j);
              this.damagePart(j, b.dmg, p);
            }
          }
          for (let j = this.enemies.length - 1; j >= 0; j--) {
            const e = this.enemies[j];
            if (b.hits.has(e.id)) continue;
            const rr = e.r + b.r;
            if (d2(b.x, b.y, e.x, e.y) > rr * rr) continue;
            b.hits.add(e.id);
            this.fx.push({ t: 'hit', x: e.x, y: e.y });
            this.damageEnemy(j, b.dmg, p);             // 방패도 뚫습니다
          }
          if (this.boss && !b.hits.has('boss')) {
            const B = this.boss, rr = B.r * 0.8 + b.r;
            if (!B.entering && d2(b.x, b.y, B.x, B.y) < rr * rr) {
              b.hits.add('boss');
              this.fx.push({ t: 'hit', x: b.x, y: b.y });
              this.damageBoss(b.dmg * 2, p);             // 보스에게는 두 배
            }
          }
          continue;
        }
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
        if (!hit) {
          for (let j = this.grounds.length - 1; j >= 0; j--) {
            const g = this.grounds[j], rr = g.r + b.r;
            if (d2(b.x, b.y, g.x, g.y) > rr * rr) continue;
            this.damageGround(j, b.dmg, p);
            this.fx.push({ t: 'hit', x: b.x, y: b.y });
            hit = true; break;
          }
        }
        if (!hit && this.boss && !this.boss.entering) {
          const B = this.boss;
          for (let j = 0; j < B.parts.length; j++) {
            const pt = B.parts[j];
            if (!pt.alive) continue;
            const rr = pt.r + b.r;
            if (d2(b.x, b.y, B.x + pt.dx, B.y + pt.dy) > rr * rr) continue;
            this.damagePart(j, b.dmg, p);
            this.fx.push({ t: 'hit', x: b.x, y: b.y });
            hit = true; break;
          }
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
                p.shieldT > 0 ? 1 : 0, R1(p.downT),
                R1(p.charge * 10), p.chain, R1(p.chainT * 10)]);
      }
      const E = [];
      for (const e of this.enemies) E.push([e.id, e.art, R1(e.x), R1(e.y), R1(e.hp), R1(e.maxHp), R1(e.ang * 100), e.flash > 0 ? 1 : 0]);
      const K = [];
      for (const k of this.pickups) K.push([k.id, k.type, R1(k.x), R1(k.y)]);
      const BM = [];
      for (const b of this.beams) BM.push([b.id, R1(b.x), R1(b.y), R1(b.ang * 100), b.w, b.state === 'fire' ? 1 : 0, Math.round(b.t * 100)]);
      const HB = [];
      for (const b of this.bullets) if (b.hom || full) HB.push([b.id, R1(b.x), R1(b.y), R1(Math.atan2(b.vy, b.vx) * 100), b.kind, b.col]);
      const GT = [];
      for (const g of this.grounds) GT.push([g.id, g.type, R1(g.x), R1(g.y), R1(g.hp), R1(g.maxHp), R1(g.ang * 100), g.flash > 0 ? 1 : 0]);

      const s = {
        t: this.tick, ph: this.phase, phT: Math.round(this.phT * 10) / 10,
        st: this.stage, zone: this.plan ? this.plan.zone : 0, sc: this.score,
        wv: this.waveIdx, wvN: this.plan ? this.plan.waves.length : 0,
        P, E, K, BM, HB, GT,
        Bn: this.newBullets.filter((b) => !b.hom).map((b) => [b.id, R1(b.x), R1(b.y), R1(b.vx), R1(b.vy), b.kind, b.born, b.col]),
        Bd: this.deadBullets.slice(),
        X: this.fx.slice(),
        B: this.boss ? [this.boss.art, R1(this.boss.x), R1(this.boss.y), R1(this.boss.hp), R1(this.boss.maxHp),
                        this.boss.name, this.boss.flash > 0 ? 1 : 0, this.boss.phaseIdx, this.boss.entering ? 1 : 0,
                        this.boss.parts.map((q) => [R1(q.dx), R1(q.dy), q.alive ? Math.max(1, R1(q.hp / q.maxHp * 100)) : 0, R1(q.ang * 100), q.flash > 0 ? 1 : 0]),
                        this.boss.armored ? 1 : 0] : null,
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
    WING, wingCount, CHARGE_MAX, CHARGE_SEC, MEDAL, CHAIN_SEC,
    SHIP_TYPES, shipType, TERRAIN, TERRAIN_W, TERRAIN_H, GROUND_SPEED, terrainHeight, terrainAt, groundOffset,
    GROUND_UNITS, ZONE_GROUND, GOLD, ARMOR_MUL,
  };
})();

// CommonJS 내보내기(module.exports)는 두지 않습니다. 이 파일은 <script> 로도 읽히고
// 워커에서는 ES 모듈 안에 그대로 심기는데, 후자에서 esbuild 가 "module 은 전역이라
// 뜻대로 안 될 수 있다"고 경고합니다. 저장소에 Node 로 이 파일을 읽는 곳도 없습니다.
`;
