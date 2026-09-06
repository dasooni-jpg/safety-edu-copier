// 실행: node pixel-flow/tools/smoke-test.mjs   (Playwright 필요)
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
// playwright 는 로컬 설치본이 없으면 전역(-g) 설치본을 찾는다
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (e) {
  const req = createRequire(import.meta.url);
  const roots = (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)
    .concat(['/opt/node22/lib/node_modules', '/usr/lib/node_modules', '/usr/local/lib/node_modules']);
  for (const r of roots) {
    try { ({ chromium } = req(path.join(r, 'playwright'))); break; } catch (e2) {}
  }
  if (!chromium) { console.error('Playwright 가 없습니다:  npm i -D playwright  후 다시 실행하세요.'); process.exit(1); }
}
const url = pathToFileURL(path.join(here, '..', 'index.html')).href;
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 420, height: 860 } });
const errs = [];
pg.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
pg.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
await pg.goto(url);
const t = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { console.log('FAIL', name, '-', e.message); } };

await t('홈 표시', async () => { if (!(await pg.locator('#home').isVisible())) throw new Error('home hidden'); });
await pg.click('#btnStart');
await t('레벨 선택 표시', async () => { if (!(await pg.locator('#select').isVisible())) throw new Error('select hidden'); });
await t('레벨 카드 100개', async () => { const n = await pg.locator('#lvGrid .lv').count(); if (n !== 100) throw new Error('cards=' + n); });
await t('썸네일 생성', async () => { const s = await pg.locator('#lvGrid .lv .thumb').first().getAttribute('src'); if (!s.startsWith('data:image/png')) throw new Error('no thumb'); });
await t('잠금 규칙', async () => { const n = await pg.locator('#lvGrid .lv.lock').count(); if (n !== 97) throw new Error('locked=' + n); });

await pg.locator('#lvGrid .lv').first().click();
await t('게임 화면', async () => { if (!(await pg.locator('#game').isVisible())) throw new Error('game hidden'); });
await t('더미 4 · 손칸 5', async () => {
  const s = await pg.locator('#tray .stack').count(), h = await pg.locator('#slots .slot').count();
  if (s !== 4 || h !== 5) throw new Error(s + '/' + h);
});
// 손칸 채우기 → 가방 보내기
for (let i = 0; i < 4; i++) await pg.locator('#tray .stack').nth(i).locator('button.bag').first().click();
await t('손칸 4개 채움', async () => { const n = await pg.locator('#slots .bag').count(); if (n !== 4) throw new Error('hand=' + n); });
const before = await pg.evaluate(() => G.remain[G.colors[0]] + G.remain[G.colors[1] || G.colors[0]]);
await pg.locator('#slots .bag').first().click();
await pg.waitForTimeout(2500);
await t('가방이 픽셀을 지움', async () => {
  const used = await pg.evaluate(() => G.used);
  const left = await pg.evaluate(() => G.colors.reduce((s, c) => s + G.remain[c], 0));
  if (used !== 1) throw new Error('used=' + used);
  if (left >= 990) throw new Error('nothing erased');
});
await t('점수 반영', async () => { const s = await pg.evaluate(() => G.score); if (!(s > 0)) throw new Error('score=' + s); });
await t('되돌리기 동작', async () => {
  const b1 = await pg.evaluate(() => G.colors.reduce((s, c) => s + G.remain[c], 0));
  await pg.click('#btnUndo');
  const st = await pg.evaluate(() => ({ used: G.used, undos: G.undos, left: G.colors.reduce((s, c) => s + G.remain[c], 0), hand: G.hand.filter(Boolean).length }));
  if (st.used !== 0 || st.undos !== 2 || st.left <= b1 || st.hand !== 4) throw new Error(JSON.stringify(st));
});
await t('힌트 동작', async () => {
  await pg.click('#btnHint');
  const h = await pg.evaluate(() => ({ hints: G.hints, at: G.hintAt }));
  if (h.hints !== 2 || h.at < 0) throw new Error(JSON.stringify(h));
});
await t('속도 전환', async () => {
  await pg.click('#btnSpeed');
  const s = await pg.evaluate(() => SP()); if (s !== 1.5) throw new Error('sp=' + s);
});
await t('키보드 조작', async () => {
  await pg.keyboard.press('q');
  const n = await pg.evaluate(() => G.hand.filter(Boolean).length); if (n !== 5) throw new Error('hand=' + n);
});
await t('자동 저장(이어하기)', async () => {
  const s = await pg.evaluate(() => localStorage.getItem('pixelflow.resume.v1'));
  if (!s || JSON.parse(s).b.length !== 990) throw new Error('no resume');
});
// 자동 클리어 시뮬레이션 (엔진 강제 종료 경로 확인)
await t('클리어 판정 → 별/기록 저장', async () => {
  await pg.evaluate(() => {
    G.used = 5; G.score = 1234; G.perfects = 2; G.bestCombo = 2;
    G.colors.forEach(c => G.remain[c] = 0);
    G.board.fill(0); repaintAll();
    checkEnd(10, 10);
  });
  await pg.waitForTimeout(2200);
  const p = await pg.evaluate(() => JSON.parse(localStorage.getItem('pixelflow.progress.v2')));
  if (!p || !p['1'] || !p['1'].s) throw new Error('prog=' + JSON.stringify(p));
  if (!(await pg.locator('#mask').isVisible())) throw new Error('win modal hidden');
});
await t('도감 해금 반영', async () => {
  await pg.click('.modal [data-a="select"]');
  await pg.click('#btnGal');
  const txt = await pg.locator('#galTxt').textContent();
  if (!txt.startsWith('1 /')) throw new Error(txt);
  const n = await pg.locator('#galGrid .gal').count(); if (n !== 31) throw new Error('gal=' + n);
});
await t('설정 토글', async () => {
  await pg.click('#btnGalBack');
  await pg.click('#btnPractice');
  const on = await pg.evaluate(() => PRACTICE); if (!on) throw new Error('practice off');
});
await t('연습 모드 진입(제한 없음)', async () => {
  await pg.locator('#lvGrid .lv').nth(1).click();
  const g = await pg.evaluate(() => ({ p: G.practice, txt: document.querySelector('#gauge span').textContent }));
  if (!g.p || !g.txt.includes('연습')) throw new Error(JSON.stringify(g));
});
await t('이어하기 버튼 노출', async () => {
  await pg.evaluate(() => { saveResume(); });
  await pg.click('#btnBack'); await pg.click('#btnHome');
  const vis = await pg.locator('#btnResume').isVisible(); if (!vis) throw new Error('resume hidden');
  await pg.click('#btnResume');
  if (!(await pg.locator('#game').isVisible())) throw new Error('resume failed');
});
await pg.screenshot({ path: path.join(here, 'shot-game.png') });
console.log(errs.length ? '\nERRORS:\n' + errs.join('\n') : '\n에러 없음');
await b.close();
