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
