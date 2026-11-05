// Smoke test de Garage Radar.
// Uso: node tests/smoke.mjs   (requiere `npm install` una vez para bajar playwright)
// Levanta un servidor estático local, abre index.html?demo=1 en Chromium headless y verifica
// el comportamiento a través de window.__garage (solo existe en modo demo local).
// Falla (código != 0) ante cualquier aserción incumplida o cualquier error de consola / de página.
// SMOKE_INJECT_ERROR=1 inyecta un console.error a propósito para comprobar que el harness lo detecta.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'tests', 'fixtures');
const TODAY = '2026-11-05T12:00:00';   // reloj fijo: las alertas por fecha no dependen del día en que se corre
const INJECT = process.env.SMOKE_INJECT_ERROR === '1';

const results = [];
let current = null;
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (got, want, msg) => assert(JSON.stringify(got) === JSON.stringify(want), `${msg}: esperado ${JSON.stringify(want)}, obtenido ${JSON.stringify(got)}`);

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer(); s.unref(); s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

async function startServer() {
  const port = await freePort();
  const proc = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(base + '/index.html'); if (r.ok) return { proc, base }; } catch { /* todavía no levantó */ }
    await new Promise(r => setTimeout(r, 100));
  }
  proc.kill(); throw new Error('No levantó python3 -m http.server');
}

// Abre la app en demo con reloj fijo y registra errores de consola y de página.
async function openDemo(browser, base) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  await page.clock.setFixedTime(new Date(TODAY));
  await page.goto(base + '/index.html?demo=1');
  await page.waitForFunction(() => {
    const g = window.__garage; return g && g.state.loaded.refuels && g.state.loaded.expenses && g.state.loaded.settings;
  }, null, { timeout: 15000 });
  return { ctx, page, errors };
}

// Espera a que las suscripciones del almacén en memoria propaguen los cambios.
const settle = page => page.evaluate(() => new Promise(r => setTimeout(r, 50)));

async function test(name, fn) {
  current = name;
  try { await fn(); results.push({ name, ok: true }); console.log(`  ok   ${name}`); }
  catch (e) { results.push({ name, ok: false, err: e.message }); console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const alertSummary = page => page.evaluate(() => {
  const g = window.__garage, A = g.computeAlerts(g.derive());
  const by = st => A.filter(a => a.st === st).map(a => a.key).sort();
  return { total: A.length, red: by('red'), yellow: by('yellow'), green: by('green'), none: by('none').length };
});

async function main() {
  const drivvo = await readFile(path.join(FIX, 'drivvo-mini.csv'), 'utf8');
  const walletRaw = await readFile(path.join(FIX, 'wallet-mini.csv'));
  const backup = await readFile(path.join(FIX, 'backup-mini.json'), 'utf8');

  const { proc, base } = await startServer();
  let browser = null;
  try {
    browser = await chromium.launch();
    console.log('Garage Radar · smoke test');

    await test('fixtures: Wallet con BOM, separador ";" y un pago que coincide con Drivvo (±5 días, ±1 %)', async () => {
      assert(walletRaw[0] === 0xEF && walletRaw[1] === 0xBB && walletRaw[2] === 0xBF, 'wallet-mini.csv no empieza con BOM');
      const lines = walletRaw.toString('utf8').replace(/^﻿/, '').trim().split(/\r?\n/).map(l => l.split(';'));
      eq(lines[0], ['account', 'category', 'currency', 'amount', 'type', 'date', 'transfer', 'note'], 'encabezado de Wallet');
      const rows = lines.slice(1).map(c => Object.fromEntries(lines[0].map((h, i) => [h, c[i]])));
      const seguro = rows.filter(r => /^seguro de(l)? veh[ií]culo$/i.test(r.category));
      eq(seguro.length, 3, 'pagos de seguro en Wallet');
      assert(rows.some(r => r.type === 'Income'), 'falta el ingreso');
      const dvSeguro = { fecha: '2026-03-05', monto: 45000 };   // fila "Seguro Automotor" de drivvo-mini.csv
      assert(drivvo.includes('2026-03-05 10:00:00,209300,Seguro Automotor'), 'drivvo-mini.csv cambió: actualizar dvSeguro');
      const days = d => Math.abs(Date.parse(d.slice(0, 10)) - Date.parse(dvSeguro.fecha)) / 86400000;
      assert(seguro.some(r => days(r.date) <= 5 && Math.abs(Number(r.amount) - dvSeguro.monto) <= dvSeguro.monto * 0.01), 'ningún pago de Wallet coincide con el seguro de Drivvo');
    });

    await test('carga demo sin errores y estado inicial vacío', async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      if (INJECT) await page.evaluate(() => console.error('error inyectado por SMOKE_INJECT_ERROR'));
      const api = await page.evaluate(() => Object.keys(window.__garage).sort());
      for (const k of ['parseCSV', 'finishPlan', 'executePlan', 'showPlanPreview', 'computeAlerts', 'serviceCounters', 'derive', 'buildDrivvoPlan', 'buildJsonPlan', 'state'])
        assert(api.includes(k), `window.__garage no expone ${k}`);
      assert(await page.locator('#screen-app').isVisible(), 'la pantalla principal no está visible');
      const s = await alertSummary(page);
      eq(s.total, 13, 'cantidad de alertas (4 por fecha + 9 services)');
      eq(s.none, 13, 'sin datos, todas las alertas quedan sin configurar');
      await settle(page);
      eq(errors, [], 'errores de consola');
      await ctx.close();
    });

    await test('parseCSV respeta comillas y comas internas', async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      const rows = await page.evaluate(t => window.__garage.parseCSV(t), '﻿a,b\n"x, y","di ""hola"""\r\n');
      eq(rows, [['a', 'b'], ['x, y', 'di "hola"']], 'filas parseadas');
      eq(errors, [], 'errores de consola');
      await ctx.close();
    });

    await test('import Drivvo fixture produce 3 cargas y 3 gastos (vista previa → importar), reimportar no duplica', async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      const plan = await page.evaluate(t => { const p = window.__garage.buildDrivvoPlan(t); window.__plan = p;
        return { refuels: p.refuels.length, expenses: p.expenses.length, rejected: p.rejected.length, dupes: p.dupes, cats: p.expenses.map(e => `${e.categoria}:${e.tipo}`).sort() }; }, drivvo);
      eq(plan, { refuels: 3, expenses: 3, rejected: 0, dupes: 0, cats: ['PREVENTIVO:Cambio de aceite', 'PREVENTIVO:Rotar neumáticos', 'TRAMITES:Seguro Automotor'] }, 'plan Drivvo');

      // Flujo real de la UI: vista previa y botón Importar.
      await page.evaluate(() => window.__garage.showPlanPreview(window.__plan));
      const go = page.locator('#imp-go');
      await go.waitFor({ state: 'visible' });
      eq(await go.textContent(), 'Importar 6 registros', 'texto del botón de importación');
      await go.click();
      await page.waitForFunction(() => window.__garage.state.expenses.length === 3 && window.__garage.state.refuels.length === 3);
      await settle(page);

      const after = await page.evaluate(() => {
        const g = window.__garage, D = g.derive(), s = g.state.settings;
        return { kmNow: D.kmNow, fuelTotal: D.fuelTotal, otherTotal: D.otherTotal, vehiculo: s.vehiculo?.nombre,
          aceite: [s.ultimoAceiteKm, s.ultimoAceiteFecha], neumaticos: s.ultimoNeumaticosKm };
      });
      eq(after, { kmNow: 209300, fuelTotal: 102500, otherTotal: 122000, vehiculo: 'Auto de prueba', aceite: [209100, '2026-02-15'], neumaticos: 209100 }, 'totales y contadores tras importar');

      const again = await page.evaluate(t => { const p = window.__garage.buildDrivvoPlan(t); return { dupes: p.dupes, nuevos: p.newRefuels.length + p.newExpenses.length }; }, drivvo);
      eq(again, { dupes: 6, nuevos: 0 }, 'reimportación');

      const s = await alertSummary(page);
      eq({ red: s.red, yellow: s.yellow, green: s.green }, { red: [], yellow: [], green: ['ultimoAceiteKm', 'ultimoNeumaticosKm'] }, 'alertas tras Drivvo');
      eq(errors, [], 'errores de consola');
      await ctx.close();
    });

    await test('import de respaldo JSON aplica ajustes y conteo de alertas', async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      const res = await page.evaluate(async t => {
        const g = window.__garage, p = g.buildJsonPlan(t);
        const r = await g.executePlan(p);
        return { refuels: p.refuels.length, expenses: p.expenses.length, rejected: p.rejected.length, inserted: r.inserted };
      }, backup);
      eq(res, { refuels: 2, expenses: 1, rejected: 0, inserted: 3 }, 'plan JSON');
      await settle(page);
      const st = await page.evaluate(() => { const s = window.__garage.state.settings; return [s.ultimoNeumaticosKm, s.ultimoNeumaticosFecha, s.vencimientos?.vtv]; });
      eq(st, [205000, '2025-12-01', '2026-11-20'], 'ajustes del respaldo');
      const s = await alertSummary(page);
      eq(s, { total: 13, red: ['oblea'], yellow: ['ultimoNeumaticosKm', 'vtv'], green: ['pruebaHidraulica', 'seguro', 'ultimoAceiteKm'], none: 7 }, 'conteo de alertas con reloj fijo en 2026-11-05');
      eq(errors, [], 'errores de consola');
      await ctx.close();
    });

    await test('window.__garage no existe fuera de ?demo=1', async () => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(base + '/index.html');
      // El arranque tiene que haber corrido de verdad: termina en login (o config / error de Firebase), nunca en la app.
      await page.waitForFunction(() => ['login', 'config'].some(n => !document.querySelector('#screen-' + n).hidden), null, { timeout: 15000 });
      assert(await page.locator('#screen-app').isHidden(), 'la app no debería abrirse sin sesión fuera del demo');
      eq(await page.evaluate(() => typeof window.__garage), 'undefined', 'typeof window.__garage');
      await ctx.close();
    });
  } finally {
    if (browser) await browser.close();
    proc.kill();
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} casos en verde`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(`Error del harness${current ? ` en "${current}"` : ''}:`, e); process.exit(2); });
