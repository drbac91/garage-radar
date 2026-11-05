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

const saveSettings = (page, patch) => page.evaluate(p => window.__garage.store.saveSettings(p), patch);
const goTab = async (page, tab) => { await page.evaluate(t => { location.hash = '#/' + t; }, tab); await page.locator(`[data-view=${tab}]`).waitFor({ state: 'visible' }); };
const rowStates = (page, sel) => page.$$eval(sel, els => els.map(e => [e.dataset.id, e.dataset.s]));

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
      eq(s.total, 32, 'cantidad de alertas (4 por fecha + 28 ítems del catálogo)');
      eq(s.none, 32, 'sin datos, todas las alertas quedan sin configurar');
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
          aceite: [s.ultimoAceiteKm, s.ultimoAceiteFecha], rotacion: s.ultimoRotacionKm };
      });
      eq(after, { kmNow: 209300, fuelTotal: 102500, otherTotal: 122000, vehiculo: 'Auto de prueba', aceite: [209100, '2026-02-15'], rotacion: 209100 }, 'totales y contadores tras importar');

      const again = await page.evaluate(t => { const p = window.__garage.buildDrivvoPlan(t); return { dupes: p.dupes, nuevos: p.newRefuels.length + p.newExpenses.length }; }, drivvo);
      eq(again, { dupes: 6, nuevos: 0 }, 'reimportación');

      const s = await alertSummary(page);
      eq({ red: s.red, yellow: s.yellow, green: s.green }, { red: [], yellow: [], green: ['ultimoAceiteKm', 'ultimoRotacionKm'] }, 'alertas tras Drivvo');
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
      eq(st, [205000, '2025-12-01', '2026-11-20'], 'ajustes del respaldo (la clave vieja de neumáticos no se borra)');
      // T1.2: los tres ítems de neumáticos heredan km y fecha de ultimoNeumaticosKm/Fecha.
      const tires = await page.evaluate(() => { const s = window.__garage.state.settings;
        return ['Rotacion', 'Alineacion', 'Balanceo'].map(k => [s[`ultimo${k}Km`], s[`ultimo${k}Fecha`]]).concat([[!!s.migraciones?.neumaticos3]]); });
      eq(tires, [[205000, '2025-12-01'], [205000, '2025-12-01'], [205000, '2025-12-01'], [true]], 'neumáticos migrados desde el respaldo');
      // km actual 214.600: rotación/alineación/balanceo vencen a los 215.000 (faltan 400 ≤ 1.000 de aviso); alineación y
      // balanceo además vencen por fecha el 01/12/2026 (26 días ≤ 30). Aceite: 219.100 km / 15/02/2027.
      const s = await alertSummary(page);
      eq(s, { total: 32, red: ['oblea'], yellow: ['ultimoAlineacionKm', 'ultimoBalanceoKm', 'ultimoRotacionKm', 'vtv'], green: ['pruebaHidraulica', 'seguro', 'ultimoAceiteKm'], none: 24 }, 'conteo de alertas con reloj fijo en 2026-11-05');
      eq(errors, [], 'errores de consola');
      await ctx.close();
    });

    await test('T1.2 catálogo >= 25 ítems, 8 grupos y claves únicas', async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      const c = await page.evaluate(() => {
        const g = window.__garage, items = g.SERVICE_ITEMS, all = [...g.DATE_ALERTS, ...items];
        const keys = items.flatMap(a => [a.key, a.fkey]).concat(g.DATE_ALERTS.map(a => a.key));
        const ids = all.map(a => a.id);
        return { alerts: g.computeAlerts(g.derive()).length, items: items.length,
          keysUnique: new Set(keys).size === keys.length, idsUnique: new Set(ids).size === ids.length,
          groups: [...new Set(all.map(a => a.grupo))].sort().join('|') === [...g.GROUPS].sort().join('|') && g.GROUPS.length,
          tipos: [...new Set(items.map(a => a.tipo))].sort(),
          bad: items.filter(a => !(a.km || a.meses) || !a.prioridad || !a.fuente || !a.motivo).map(a => a.id),
          legacy: Object.fromEntries(['aceite', 'bujias', 'distribucion', 'filtroAire', 'filtroComb', 'liquidoFrenos', 'refrigerante', 'gnc'].map(id => [id, items.find(a => a.id === id)?.key])),
          gnc: items.filter(a => a.grupo === 'GNC').map(a => a.id), distribucion: items.find(a => a.id === 'distribucion').km };
      });
      assert(c.alerts >= 25, `computeAlerts devuelve ${c.alerts} ítems (< 25)`);
      eq({ items: c.items, keysUnique: c.keysUnique, idsUnique: c.idsUnique, groups: c.groups, tipos: c.tipos, bad: c.bad },
        { items: 28, keysUnique: true, idsUnique: true, groups: 8, tipos: ['inspeccion', 'service'], bad: [] }, 'forma del catálogo');
      eq(c.legacy, { aceite: 'ultimoAceiteKm', bujias: 'ultimoBujiasKm', distribucion: 'ultimoDistribucionKm', filtroAire: 'ultimoFiltroAireKm',
        filtroComb: 'ultimoFiltroCombKm', liquidoFrenos: 'ultimoFrenosKm', refrigerante: 'ultimoRefrigeranteKm', gnc: 'ultimoGncKm' }, 'claves heredadas sin cambios');
      eq([c.gnc, c.distribucion], [['gnc'], 50000], 'GNC con un solo ítem y distribución a 50.000 km');
      eq(errors, [], 'errores de consola');
      await ctx.close();
    });

    await test('T1.2 migración neumáticos idempotente', async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      const r = await page.evaluate(() => {
        const m = window.__garage.migrateSettings;
        const old = { ultimoNeumaticosKm: 205000, ultimoNeumaticosFecha: '2025-12-01', ultimoAlineacionKm: null, ultimoBalanceoKm: 207000 };
        const p1 = m(old), s1 = { ...old, ...p1 }, p2 = m(s1);
        return { p1, p2, empty: m({}), keepsOld: [s1.ultimoNeumaticosKm, s1.ultimoNeumaticosFecha] };
      });
      eq(r.p1, { migraciones: { neumaticos3: true }, ultimoRotacionKm: 205000, ultimoRotacionFecha: '2025-12-01', ultimoAlineacionKm: 205000,
        ultimoAlineacionFecha: '2025-12-01', ultimoBalanceoFecha: '2025-12-01' }, 'primera corrida (null cuenta como vacío; no pisa balanceo 207.000)');
      eq(r.p2, {}, 'segunda corrida');
      eq(r.empty, {}, 'sin datos viejos no hace nada');
      eq(r.keepsOld, [205000, '2025-12-01'], 'la clave vieja queda');
      // En la app: la migración corre al recibir los ajustes y una segunda vuelta no cambia nada.
      await page.evaluate(() => window.__garage.store.saveSettings({ ultimoNeumaticosKm: 205000, ultimoNeumaticosFecha: '2025-12-01' }));
      await page.waitForFunction(() => window.__garage.state.settings.migraciones?.neumaticos3);
      const before = await page.evaluate(() => JSON.stringify(window.__garage.state.settings));
      await page.evaluate(() => window.__garage.store.saveSettings({}));
      await settle(page);
      eq(await page.evaluate(() => JSON.stringify(window.__garage.state.settings)), before, 'ajustes tras una segunda vuelta');
      eq(errors, [], 'errores de consola');
      await ctx.close();
    });

    await test('T1.2 bujías avisa a 15.000 km', async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      const at = async odo => page.evaluate(async odo => {
        const g = window.__garage;
        await g.store.saveSettings({ ultimoBujiasKm: 200000 });
        await g.store.save('refuels', { id: 'bj', fecha: '2026-11-01T10:00:00', odometro: odo, combustible: 'GNC', grado: null, volumen: 10, costoTotal: 7000, lleno: true, estacion: '', notas: '', origen: 'manual' });
        await new Promise(r => setTimeout(r, 30));
        const a = g.computeAlerts(g.derive()).find(x => x.id === 'bujias');
        return [a.st, a.kmPart.target];
      }, odo);
      eq(await at(212999), ['green', 215000], 'a 2.001 km del cambio');
      eq(await at(213000), ['yellow', 215000], 'a 2.000 km del cambio');
      eq(await at(215000), ['red', 215000], 'a los 15.000 km');
      eq(errors, [], 'errores de consola');
      await ctx.close();
    });

    await test("T1.3 grupos presentes y 'no aplica' oculto", async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      await goTab(page, 'vencimientos');
      // Neumáticos con un ítem de cada estado (por fecha, reloj en 05/11/2026): presión vencida, profundidad próxima, alineación al día.
      await saveSettings(page, { ultimoPresionFecha: '2026-09-01', ultimoProfundidadFecha: '2025-11-20', ultimoAlineacionFecha: '2026-06-01', noAplica: { matafuego: true } });
      await settle(page);
      const heads = await page.$$eval('#radar-list .rgroup .group-head h3', els => els.map(e => e.textContent));
      eq(heads, ['Neumáticos', 'Frenos', 'Suspensión', 'Eléctrico', 'Motor', 'Confort', 'Legal', 'GNC'], 'encabezados de grupo');
      eq(await rowStates(page, '#radar-list .rgroup[data-grupo="Neumáticos"] .alert'),
        [['presion', 'red'], ['profundidad', 'yellow'], ['alineacion', 'green'], ['rotacion', 'none'], ['balanceo', 'none']], 'orden por urgencia dentro del grupo');
      eq(await page.locator('#radar-list .rgroup[data-grupo="Neumáticos"] .group-head').getAttribute('aria-expanded'), 'true', 'grupo con rojos abierto');
      eq(await page.locator('#radar-list .rgroup[data-grupo="Confort"] .group-body').isHidden(), true, 'grupo sin rojos ni amarillos colapsado');
      const na = await page.evaluate(() => ({ radar: !!document.querySelector('#radar-list [data-id="matafuego"]'), next: !!document.querySelector('#next-list [data-id="matafuego"]'),
        alerts: window.__garage.computeAlerts(window.__garage.derive()).some(a => a.id === 'matafuego') }));
      eq(na, { radar: false, next: false, alerts: false }, "'no aplica' fuera de todas las listas");
      eq(await page.locator('#radar-list .alert[data-id="luces"]').count(), 1, 'el resto del grupo Legal sigue');
      eq(errors, [], 'errores de consola');
      await ctx.close();
    });

    await test('T1.4 onboarding completo deja 0 ítems sin configurar', async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      await goTab(page, 'vencimientos');
      const progress = () => page.locator('.ob-progress').textContent();
      await page.locator('#radar-list [data-action=onboarding]').click();
      await page.locator('#ob-form').waitFor({ state: 'visible' });
      eq(await progress(), 'Ítem 1 de 32 · Legal', 'primer ítem');
      const first = await page.locator('#ob-form').getAttribute('id') && await page.evaluate(() => window.__garage.computeAlerts(window.__garage.derive()).find(a => a.st === 'none').id);
      // 1) cargar dato real
      await page.locator('#ob-fecha').fill('2027-05-01');
      await page.locator('#ob-save').click();
      await page.waitForFunction(() => document.querySelector('.ob-progress')?.textContent.startsWith('Ítem 2 '));
      // 2) "no aplica"
      const second = await page.evaluate(() => window.__garage.computeAlerts(window.__garage.derive()).find(a => a.st === 'none').id);
      await page.locator('#ob-na').click();
      await page.waitForFunction(() => document.querySelector('.ob-progress')?.textContent.startsWith('Ítem 3 '));
      // 3) cerrar a mitad y retomar sin perder lo cargado
      await page.locator('#ob-form [data-modal-close]').click();
      await page.locator('#ob-form').waitFor({ state: 'detached' });
      const mid = await page.evaluate(() => { const s = window.__garage.state.settings; return { vtv: s.vencimientos?.vtv, na: s.noAplica }; });
      eq([first, mid.vtv, second, mid.na], ['vtv', '2027-05-01', 'oblea', { oblea: true }], 'respuestas guardadas al salir');
      await page.locator('#radar-list [data-action=onboarding]').click();
      await page.locator('#ob-form').waitFor({ state: 'visible' });
      eq(await progress(), 'Ítem 1 de 30 · GNC', 'retoma con los 30 pendientes');
      // 4) "no sé" en todo el resto
      for (let i = 0; i < 40 && await page.locator('#ob-form').count(); i++) {
        const before = await progress();
        await page.locator('#ob-unknown').click();
        await page.waitForFunction(b => { const p = document.querySelector('.ob-progress'); return !p || p.textContent !== b; }, before);
      }
      eq(await page.locator('#ob-form').count(), 0, 'el onboarding terminó');
      await settle(page);
      const s = await alertSummary(page);
      const exp = await page.evaluate(() => window.__garage.state.expenses.length);
      eq({ none: s.none, total: s.total, red: s.red.length, green: s.green, expenses: exp }, { none: 0, total: 31, red: 30, green: ['vtv'], expenses: 0 }, 'resultado del onboarding');
      eq(await page.locator('#radar-list [data-action=onboarding]').count(), 0, 'sin llamado a acción al terminar');
      eq(errors, [], 'errores de consola');
      await ctx.close();
    });

    await test('T1.4 onboarding de un ítem por km guarda el contador', async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      await page.evaluate(() => window.__garage.openOnboarding('bujias'));
      await page.locator('#ob-km').fill('210000');
      await page.locator('#ob-save').click();
      await page.locator('#ob-form').waitFor({ state: 'detached' });
      await settle(page);
      const a = await page.evaluate(() => { const g = window.__garage; const x = g.computeAlerts(g.derive()).find(a => a.id === 'bujias'); return [g.state.settings.ultimoBujiasKm, x.st, x.kmPart?.target]; });
      eq(a, [210000, 'green', 225000], 'bujías configurado sin cargas registradas');
      eq(errors, [], 'errores de consola');
      await ctx.close();
    });

    await test('T1.5 Resumen lista todos los rojos y amarillos', async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      await goTab(page, 'resumen');
      await saveSettings(page, {
        vencimientos: { vtv: '2026-10-01', oblea: '2026-11-01', pruebaHidraulica: '2026-11-20', seguro: '2026-11-25' },   // 2 rojos, 2 amarillos
        pendientes: { bateria: '2026-11-05', luces: '2026-11-05' },                                                    // 2 rojos ("no sé")
        ultimoPresionFecha: '2026-09-01',                                                                               // 1 rojo
        ultimoProfundidadFecha: '2025-11-20', ultimoMatafuegoFecha: '2025-11-25',                                       // 2 amarillos
        ultimoAlineacionFecha: '2026-06-01', ultimoEscobillasFecha: '2026-06-01'                                        // 2 al día
      });
      await settle(page);
      const rows = await rowStates(page, '#next-list > .alert');
      eq({ red: rows.filter(r => r[1] === 'red').length, yellow: rows.filter(r => r[1] === 'yellow').length, other: rows.filter(r => !['red', 'yellow'].includes(r[1])).length },
        { red: 5, yellow: 4, other: 0 }, 'filas visibles en Resumen');
      eq(await page.locator('#next-ok summary').textContent(), '2 al día', 'línea "N al día"');
      eq(await page.locator('#next-ok').getAttribute('open'), null, '"al día" colapsado');
      await page.locator('#next-list [data-action=onboarding]').click();
      await page.locator('#ob-form').waitFor({ state: 'visible' });
      await page.locator('#ob-form [data-modal-close]').click();
      await page.locator('#ob-form').waitFor({ state: 'detached' });
      // Sin ítems sin configurar no hay llamado a acción.
      await page.evaluate(() => { const g = window.__garage; return g.store.saveSettings({ noAplica: Object.fromEntries(g.computeAlerts(g.derive()).filter(a => a.st === 'none').map(a => [a.id, true])) }); });
      await settle(page);
      eq(await page.locator('#next-list [data-action=onboarding]').count(), 0, 'sin llamado a acción cuando no hay ítems sin configurar');
      eq(errors, [], 'errores de consola');
      await ctx.close();
    });

    await test('T1.6 marcar revisado reinicia sin gasto', async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      await goTab(page, 'vencimientos');
      await page.evaluate(() => window.__garage.store.save('refuels', { id: 'mr', fecha: '2026-11-01T10:00:00', odometro: 214000, combustible: 'GNC', grado: null, volumen: 10, costoTotal: 7000, lleno: true, estacion: '', notas: '', origen: 'manual' }));
      await saveSettings(page, { pendientes: { luces: '2026-11-01' }, ultimoPastillasKm: 200000, ultimoPastillasFecha: '2025-01-01', ultimoAceiteFecha: '2025-01-01' });
      await settle(page);
      eq(await page.locator('#radar-list .alert[data-id="aceite"] [data-action=mark-reviewed]').count(), 0, 'un service no tiene el botón');
      eq(await page.locator('#radar-list [data-action=mark-reviewed]').count(), await page.evaluate(() => window.__garage.SERVICE_ITEMS.filter(a => a.tipo === 'inspeccion').length), 'un botón por inspección');
      await page.locator('#radar-list .alert[data-id="luces"] [data-action=mark-reviewed]').click();
      await page.locator('#radar-list .alert[data-id="pastillas"] [data-action=mark-reviewed]').click();
      await settle(page);
      const r = await page.evaluate(() => { const g = window.__garage, s = g.state.settings, A = g.computeAlerts(g.derive());
        return { luces: A.find(a => a.id === 'luces').st, pastillas: A.find(a => a.id === 'pastillas').st, expenses: g.state.expenses.length,
          rev: s.revisiones.luces, km: [s.ultimoPastillasKm, s.ultimoPastillasFecha] }; });
      eq(r, { luces: 'green', pastillas: 'green', expenses: 0, rev: [{ fecha: '2026-11-05', km: 214000 }], km: [214000, '2026-11-05'] }, 'estado tras marcar revisado');
      const sub = await page.locator('#radar-list .alert[data-id="luces"] .alert-sub').textContent();
      assert(sub.includes('revisado el 05/11/2026'), `la fila no muestra la última revisión: "${sub}"`);
      eq(errors, [], 'errores de consola');
      await ctx.close();
    });

    await test('T1.7 casillas de reinicio según el tipo', async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      const m = await page.evaluate(() => {
        const items = window.__garage.SERVICE_ITEMS, ids = t => items.filter(a => a.match({ tipo: t })).map(a => a.id);
        return Object.fromEntries(['Cambio de aceite', 'Rotar neumáticos', 'Neumáticos - Alineación', 'Bujías', 'Control de pérdidas GNC', 'Carga de GNC', 'Filtro de aire de la cabina', 'Aceite de caja', 'Lavadero'].map(t => [t, ids(t)]));
      });
      eq(m, { 'Cambio de aceite': ['aceite'], 'Rotar neumáticos': ['rotacion'], 'Neumáticos - Alineación': ['alineacion'], 'Bujías': ['bujias'],
        'Control de pérdidas GNC': ['gnc'], 'Carga de GNC': [], 'Filtro de aire de la cabina': ['filtroHabitaculo'], 'Aceite de caja': ['aceiteCaja'], 'Lavadero': [] }, 'tipo → contadores');
      await page.locator('#fab').click();
      await page.locator('[data-action=quick-expense]').click();
      await page.locator('#gx-tipo').fill('Cambio de aceite');
      const shown = await page.$$eval('#gx-resets [data-reset]', els => els.filter(e => !e.hidden).map(e => [e.dataset.reset, e.querySelector('input').checked]));
      eq(shown, [['aceite', true]], 'casillas visibles para "Cambio de aceite"');
      eq(errors, [], 'errores de consola');
      await ctx.close();
    });

    await test('T1.7 editar gasto viejo no retrocede contador', async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      await goTab(page, 'gastos');
      await page.evaluate(async () => {
        const g = window.__garage;
        await g.store.writeMany('expenses', [
          { id: 'old', fecha: '2024-11-01T10:00:00', odometro: 180000, categoria: 'PREVENTIVO', tipo: 'Cambio de aceite', descripcion: '', monto: 50000, local: '', grupoId: null, origen: 'manual' },
          { id: 'new', fecha: '2026-10-01T10:00:00', odometro: 212000, categoria: 'PREVENTIVO', tipo: 'Cambio de aceite', descripcion: '', monto: 90000, local: '', grupoId: null, origen: 'manual' }]);
        await g.store.saveSettings({ ultimoAceiteKm: 212000, ultimoAceiteFecha: '2026-10-01' });
      });
      await settle(page);
      const counter = () => page.evaluate(() => { const s = window.__garage.state.settings; return [s.ultimoAceiteKm, s.ultimoAceiteFecha]; });
      // Editar el gasto de hace 2 años tildando la casilla del aceite.
      await page.locator('[data-action=edit-expense][data-id=old]').click();
      const box = page.locator('#gx-resets [data-reset=aceite] input');
      eq(await box.isChecked(), false, 'al editar, la casilla arranca destildada');
      await box.check();
      await page.locator('#gx-desc').fill('editado');
      await page.locator('#gx-form button[type=submit]').click();
      await page.locator('#gx-form').waitFor({ state: 'detached' });
      await settle(page);
      eq(await page.evaluate(() => window.__garage.state.expenses.find(e => e.id === 'old').descripcion), 'editado', 'el gasto se editó');
      eq(await counter(), [212000, '2026-10-01'], 'contador tras editar el gasto viejo');
      // Borrar el gasto más reciente no deja el contador por debajo de otro gasto.
      await page.locator('[data-action=del-expense][data-id=new]').click();
      await page.locator('#confirm-ok').click();
      await page.waitForFunction(() => window.__garage.state.expenses.length === 1);
      await settle(page);
      eq(await counter(), [212000, '2026-10-01'], 'contador tras borrar el gasto más reciente');
      eq(errors, [], 'errores de consola');
      await ctx.close();
    });

    await test('Configurar: guardar sin cambios no toca los ajustes y "no aplica" se tilda desde la UI', async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      await goTab(page, 'vencimientos');
      await saveSettings(page, { vehiculo: { nombre: 'Auto', modelo: 'Voyage', anio: 2015, tanque: 50 }, vencimientos: { vtv: '2026-11-20' },
        ultimoAceiteKm: 209100, ultimoAceiteFecha: '2026-02-15', ultimoNeumaticosKm: 205000, ultimoNeumaticosFecha: '2025-12-01', noAplica: { escape: true } });
      await page.waitForFunction(() => window.__garage.state.settings.migraciones?.neumaticos3);
      const before = await page.evaluate(() => JSON.stringify(window.__garage.state.settings));
      // Simula la carrera de M1: el formulario se abre y después llega un valor nuevo (otro dispositivo o la migración).
      await page.locator('[data-view=vencimientos] [data-action=open-settings]').click();
      await page.locator('#st-form').waitFor({ state: 'visible' });
      await saveSettings(page, { ultimoBateriaFecha: '2026-10-10' });
      await settle(page);
      await page.locator('#st-form button[type=submit]').click();
      await page.locator('#st-form').waitFor({ state: 'detached' });
      await settle(page);
      const after = await page.evaluate(() => window.__garage.state.settings);
      eq(JSON.stringify({ ...after, ultimoBateriaFecha: undefined }), JSON.stringify({ ...JSON.parse(before), ultimoBateriaFecha: undefined }), 'ajustes tras guardar sin cambios');
      eq(after.ultimoBateriaFecha, '2026-10-10', 'un valor llegado con el formulario abierto no se pisa con null');
      await page.locator('[data-view=vencimientos] [data-action=open-settings]').click();
      await page.locator('#st-form details.more-info summary').click();
      await page.locator('[data-noaplica=kitSeguridad]').check();
      await page.locator('#st-form button[type=submit]').click();
      await page.locator('#st-form').waitFor({ state: 'detached' });
      await settle(page);
      eq(await page.locator('#radar-list .alert[data-id="kitSeguridad"]').count(), 0, '"no aplica" tildado en Configurar oculta el ítem');
      eq(await page.evaluate(() => window.__garage.state.settings.noAplica), { escape: true, kitSeguridad: true }, 'mapa noAplica');
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
