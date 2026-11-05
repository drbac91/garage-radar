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
  await page.addInitScript(() => { window.gx = k => document.querySelector('#gx-' + k)?.value ?? null; });
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
      eq(s.total, 31, 'cantidad de alertas (3 por fecha + 28 ítems del catálogo; el seguro ahora es recurrente)');
      eq(s.none, 31, 'sin datos, todas las alertas quedan sin configurar');
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
      // El seguro del respaldo (vencimientos.seguro = 01/03/2027) migra a recurrente mensual: al día hasta marzo.
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
      eq(await progress(), 'Ítem 1 de 31 · Legal', 'primer ítem');
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
      eq(await progress(), 'Ítem 1 de 29 · GNC', 'retoma con los 29 pendientes');
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
      eq({ none: s.none, total: s.total, red: s.red.length, green: s.green, expenses: exp }, { none: 0, total: 30, red: 29, green: ['vtv'], expenses: 0 }, 'resultado del onboarding');
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

    // ---------------------------- S2 · pagos recurrentes ----------------------------
    const seedRec = (page, recs, expenses = []) => page.evaluate(async ([recs, expenses]) => {
      const g = window.__garage;
      if (expenses.length) await g.store.writeMany('expenses', expenses);
      await g.store.saveSettings({ recurrentes: recs });
    }, [recs, expenses]);
    const recPago = (id, recurrenteId, periodo, monto, extra = {}) => ({ id, fecha: `${periodo}-08T10:00:00`, odometro: null, categoria: 'TRAMITES', tipo: 'Seguro', descripcion: '',
      monto, local: '', grupoId: null, origen: 'manual', recurrenteId, periodo, cubre: 1, clase: 'cuota', ...extra });
    const SEG = (extra = {}) => ({ seguro: { id: 'seguro', nombre: 'Seguro', tipo: 'seguro', modo: 'mensual', diaVencimiento: 10, desde: '2026-10', activo: true, ...extra } });

    await test('T2.2 crear recurrente (seguro mensual y patente con próximo vencimiento +2 meses); desactivar conserva el historial', async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      await goTab(page, 'ajustes');
      // Seguro: día de vencimiento y monto estimado.
      await page.locator('#rec-list [data-action=rec-edit][data-tipo=seguro]').click();
      await page.locator('#rc-form').waitFor({ state: 'visible' });
      eq(await page.evaluate(() => [document.querySelector('#rc-modo').value, document.querySelector('#rc-desde').value]), ['mensual', '2026-11'], 'el seguro arranca en modo mensual desde el mes actual');
      await page.locator('#rc-dia').fill('10');
      await page.locator('#rc-monto').fill('60000');
      await page.locator('#rc-aseg').fill('Aseguradora <b>Ficticia</b>');
      await page.locator('#rc-inicio').fill('2026-01');
      await page.locator('#rc-form button[type=submit]').click();
      await page.locator('#rc-form').waitFor({ state: 'detached' });
      await settle(page);
      const seg = await page.evaluate(() => { const r = window.__garage.state.settings.recurrentes.seguro;
        return [r.tipo, r.modo, r.diaVencimiento, r.desde, r.montoEstimado, r.aseguradora, r.inicioPoliza, r.activo]; });
      eq(seg, ['seguro', 'mensual', 10, '2026-11', 60000, 'Aseguradora <b>Ficticia</b>', '2026-01', true], 'seguro guardado');
      assert(!(await page.locator('#rec-list b').count()), 'el nombre de la aseguradora no se escapó en Ajustes');
      // Patente: sin día fijo; el próximo vencimiento se prellena a +2 meses.
      await page.locator('#rec-list [data-action=rec-edit][data-tipo=patente]').click();
      await page.locator('#rc-form').waitFor({ state: 'visible' });
      eq(await page.evaluate(() => ['modo', 'proximo', 'meses'].map(k => document.querySelector('#rc-' + k).value)), ['manual', '2027-01-05', '2'], 'patente prellenada');
      assert(await page.locator('#rc-dia').isHidden(), 'la patente no pide día fijo');
      await page.locator('#rc-form button[type=submit]').click();
      await page.locator('#rc-form').waitFor({ state: 'detached' });
      await settle(page);
      const al = await page.evaluate(() => { const g = window.__garage; return g.computeAlerts(g.derive()).filter(a => a.kind === 'rec').map(a => [a.id, a.st, a.iso, a.monto]); });
      eq(al, [['seguro', 'yellow', '2026-11-10', 60000], ['patente', 'green', '2027-01-05', null]], 'alertas de los dos recurrentes');
      // Cada pago de patente guarda el próximo vencimiento (prellenado a +2 meses, editable).
      await page.evaluate(() => window.__garage.openAlertExpense('patente'));
      eq(await page.evaluate(() => [gx('next'), gx('periodo')]), ['2027-03-05', '2027-01'], 'pago de patente: próximo vencimiento y período');
      await page.locator('#gx-monto').fill('20000');
      await page.locator('#gx-next').fill('2027-04-15');
      await page.locator('#gx-form button[type=submit]').click();
      await page.locator('#gx-form').waitFor({ state: 'detached' });
      await settle(page);
      eq(await page.evaluate(() => window.__garage.state.settings.recurrentes.patente.proximo), '2027-04-15', 'el pago actualiza el próximo vencimiento de la patente');
      // Desactivar la patente: sale de las alertas y sus pagos quedan.
      await page.locator('#rec-list [data-action=rec-edit][data-tipo=patente]').click();
      await page.locator('#rc-activo').uncheck();
      await page.locator('#rc-form button[type=submit]').click();
      await page.locator('#rc-form').waitFor({ state: 'detached' });
      await settle(page);
      const off = await page.evaluate(() => { const g = window.__garage, r = g.recurrentesList().find(x => x.id === 'patente');
        return [g.computeAlerts(g.derive()).some(a => a.id === 'patente'), g.recPayments(r).length, g.state.expenses.length]; });
      eq(off, [false, 1, 1], 'patente desactivada: sin alerta, con historial');
      assert((await page.locator('#rec-list [data-rec=patente]').textContent()).includes('Inactivo'), 'Ajustes no marca la patente como inactiva');
      eq(errors, [], 'errores de consola');
      await ctx.close();
    });

    await test('T2.2 migración seguro idempotente (también con la migración de neumáticos ya hecha, como en producción)', async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      const pure = await page.evaluate(() => {
        const g = window.__garage, prod = { migraciones: { neumaticos3: true }, vencimientos: { seguro: '2026-11-10', vtv: '2027-01-01' } };
        const p1 = g.migrateSettings(prod);
        const merged = { ...prod, migraciones: { ...prod.migraciones, ...p1.migraciones }, recurrentes: p1.recurrentes };
        return { p1, again: g.migrateSettings(merged), sinFecha: g.migrateSettings({ migraciones: { neumaticos3: true } }),
          noAplica: g.migrateSeguro({ vencimientos: { seguro: '2026-12-01' }, noAplica: { seguro: true } }).recurrentes.seguro.activo,
          yaExiste: g.migrateSeguro({ recurrentes: { seguro: { diaVencimiento: 3 } }, vencimientos: { seguro: '2026-12-01' } }),
          enDateAlerts: g.DATE_ALERTS.some(a => a.id === 'seguro') };
      });
      eq([pure.p1.migraciones, pure.p1.recurrentes.seguro.modo, pure.p1.recurrentes.seguro.diaVencimiento, pure.p1.recurrentes.seguro.desde, pure.p1.recurrentes.seguro.activo],
        [{ seguroRecurrente: true }, 'mensual', 10, '2026-11', true], 'primera migración');
      eq([pure.again, pure.sinFecha, pure.noAplica, pure.yaExiste, pure.enDateAlerts], [{}, {}, false, { migraciones: { seguroRecurrente: true } }, false], 'idempotencia y casos borde');
      // Por la suscripción real: migra una vez, no duplica la alerta y no pisa una edición posterior.
      await saveSettings(page, { migraciones: { neumaticos3: true }, vencimientos: { seguro: '2026-11-10' } });
      await settle(page);
      await saveSettings(page, { recurrentes: { seguro: { diaVencimiento: 15 } } });
      await saveSettings(page, { vencimientos: { vtv: '2027-01-01' } });
      await settle(page);
      const r = await page.evaluate(() => { const g = window.__garage, s = g.state.settings;
        return [s.recurrentes.seguro.diaVencimiento, s.migraciones, s.vencimientos.seguro, g.computeAlerts(g.derive()).filter(a => a.id === 'seguro').map(a => a.kind)]; });
      eq(r, [15, { neumaticos3: true, seguroRecurrente: true }, '2026-11-10', ['rec']], 'migración por la suscripción');
      eq(errors, [], 'errores de consola');
      await ctx.close();
    });

    await test('T2.3 registrar pago precarga último monto: 2 toques desde Resumen, gasto TRAMITES con recurrenteId y periodo', async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      await goTab(page, 'resumen');
      // Historial de Drivvo sin vincular + fecha vieja del seguro (15ff551): migra a recurrente y precarga el último pago.
      await page.evaluate(() => window.__garage.store.writeMany('expenses', [
        { id: 'sg1', fecha: '2026-09-10T10:00:00', odometro: null, categoria: 'TRAMITES', tipo: 'Seguro Automotor', descripcion: '', monto: 55000, local: 'Aseguradora Ficticia', grupoId: null, origen: 'drivvo' },
        { id: 'sg2', fecha: '2026-10-10T10:00:00', odometro: null, categoria: 'TRAMITES', tipo: 'Seguro Automotor', descripcion: '', monto: 59000, local: 'Aseguradora Ficticia', grupoId: null, origen: 'drivvo' }]));
      await saveSettings(page, { vencimientos: { seguro: '2026-11-10' } });
      await settle(page);
      await page.locator('#next-list .alert[data-id="seguro"] .alert-name').click();                 // toque 1
      await page.locator('#gx-form').waitFor({ state: 'visible' });
      const f = await page.evaluate(() => ({ title: document.querySelector('#m-title').textContent, monto: gx('monto'), cat: gx('cat'), tipo: gx('tipo'), local: gx('local'), periodo: gx('periodo'),
        next: gx('next'), last: document.querySelector('#gx-last').textContent }));
      eq({ ...f, last: undefined }, { title: 'Registrar · Seguro', monto: '59000', cat: 'TRAMITES', tipo: 'Seguro Automotor', local: 'Aseguradora Ficticia', periodo: '2026-11', next: null, last: undefined }, 'formulario precargado');
      assert(/59\.000/.test(f.last) && f.last.includes('10/10/2026'), `no muestra el pago anterior: "${f.last}"`);
      await page.locator('#gx-form button[type=submit]').click();                                    // toque 2
      await page.locator('#gx-form').waitFor({ state: 'detached' });
      await settle(page);
      const r = await page.evaluate(() => { const g = window.__garage, e = g.state.expenses.find(x => !['sg1', 'sg2'].includes(x.id)), a = g.computeAlerts(g.derive()).find(a => a.id === 'seguro');
        return { monto: e.monto, fecha: e.fecha.slice(0, 10), cat: e.categoria, rec: e.recurrenteId, periodo: e.periodo, cubre: e.cubre, clase: e.clase, varPct: e.variacionPct, st: a.st, iso: a.iso }; });
      eq(r, { monto: 59000, fecha: '2026-11-05', cat: 'TRAMITES', rec: 'seguro', periodo: '2026-11', cubre: 1, clase: 'cuota', varPct: 0, st: 'green', iso: '2026-12-10' }, 'pago registrado y próximo vencimiento adelantado');
      await goTab(page, 'gastos');
      assert((await page.locator('#gx-history .tag.ok').allTextContents()).some(t => /seguro · nov 2026/i.test(t)), 'la lista de gastos no muestra el vínculo con el recurrente');
      eq(errors, [], 'errores de consola');
      await ctx.close();
    });

    await test('T2.3 variación % correcta (por cuota, guardada en el gasto y conservada al editar)', async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      await seedRec(page, SEG(), [recPago('p10', 'seguro', '2026-10', 59000)]);
      await settle(page);
      await page.evaluate(() => window.__garage.openAlertExpense('seguro'));
      const vtxt = () => page.locator('#gx-var').textContent();
      await page.locator('#gx-monto').fill('64015');
      assert((await vtxt()).startsWith('+8,5 %'), `variación al subir: "${await vtxt()}"`);
      await page.locator('#gx-monto').fill('55000');
      assert((await vtxt()).startsWith('-6,8 %'), `variación al bajar: "${await vtxt()}"`);
      // Dos cuotas juntas: se compara el monto por cuota (118.000 / 2 = 59.000 → 0 %).
      await page.locator('#gx-form details summary').click();
      await page.locator('#gx-cubre').selectOption('2');
      await page.locator('#gx-monto').fill('118000');
      assert((await vtxt()).startsWith('0,0 %'), `variación con 2 cuotas: "${await vtxt()}"`);
      await page.locator('#gx-cubre').selectOption('1');
      await page.locator('#gx-monto').fill('64015');
      await page.locator('#gx-form button[type=submit]').click();
      await page.locator('#gx-form').waitFor({ state: 'detached' });
      await settle(page);
      const id = await page.evaluate(() => window.__garage.state.expenses.find(e => e.id !== 'p10').id);
      eq(await page.evaluate(i => { const e = window.__garage.state.expenses.find(x => x.id === i); return [e.periodo, e.variacionPct]; }, id), ['2026-11', 8.5], 'variación guardada');
      // Editar desde Gastos (sin contexto de alerta) mantiene el vínculo y recalcula la variación.
      await goTab(page, 'gastos');
      await page.locator(`[data-action=edit-expense][data-id="${id}"]`).first().click();
      await page.locator('#gx-form').waitFor({ state: 'visible' });
      eq(await page.evaluate(() => gx('periodo')), '2026-11', 'el período se ve al editar');
      await page.locator('#gx-monto').fill('61950');
      await page.locator('#gx-form button[type=submit]').click();
      await page.locator('#gx-form').waitFor({ state: 'detached' });
      await settle(page);
      eq(await page.evaluate(i => { const e = window.__garage.state.expenses.find(x => x.id === i); return [e.recurrenteId, e.periodo, e.cubre, e.clase, e.variacionPct]; }, id),
        ['seguro', '2026-11', 1, 'cuota', 5], 'editar conserva el vínculo');
      eq(errors, [], 'errores de consola');
      await ctx.close();
    });

    await test('T2.3 no duplica el período (avisa y pide confirmar; un ajuste en el mismo mes no avisa)', async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      await seedRec(page, SEG(), [recPago('p10', 'seguro', '2026-10', 59000), recPago('p11', 'seguro', '2026-11', 59000)]);
      await settle(page);
      await page.evaluate(() => window.__garage.openAlertExpense('seguro'));
      eq(await page.evaluate(() => gx('periodo')), '2026-12', 'propone el primer período sin pagar');
      assert(await page.locator('#gx-dup').isHidden(), 'avisa duplicado sin motivo');
      await page.locator('#gx-periodo').fill('2026-11');
      assert(await page.locator('#gx-dup').isVisible(), 'no avisa que noviembre ya está pagado');
      const submit = page.locator('#gx-form button[type=submit]');
      await submit.click();
      await settle(page);
      eq([await page.evaluate(() => window.__garage.state.expenses.length), await submit.textContent(), await page.locator('#gx-form').count()], [2, 'Guardar igual', 1], 'el primer intento no guarda');
      // Un ajuste (diferencia de póliza) en un mes pagado no es duplicado.
      await page.locator('#gx-form details summary').click();
      await page.locator('#gx-clase').selectOption('ajuste');
      assert(await page.locator('#gx-dup').isHidden(), 'un ajuste no debería avisar duplicado');
      eq(await submit.textContent(), 'Registrar pago', 'cambiar la clase reinicia la confirmación');
      await page.locator('#gx-clase').selectOption('cuota');
      await submit.click(); await settle(page);
      await submit.click();                       // confirma "Guardar igual"
      await page.locator('#gx-form').waitFor({ state: 'detached' });
      await settle(page);
      eq(await page.evaluate(() => window.__garage.state.expenses.filter(e => e.periodo === '2026-11').length), 2, 'confirmado, se guarda');
      // Dos cuotas que pisan un mes pagado también avisan (oct pagado; sep + oct).
      await page.evaluate(() => window.__garage.openAlertExpense('seguro'));
      await page.locator('#gx-periodo').fill('2026-09');
      await page.locator('#gx-form details summary').click();
      await page.locator('#gx-cubre').selectOption('2');
      assert(await page.locator('#gx-dup').isVisible(), 'no avisa la superposición de dos cuotas');
      eq(errors, [], 'errores de consola');
      await ctx.close();
    });

    await test('T2.4 estados pagado/pendiente/vencido con fecha simulada (reloj fijo en 05/11/2026)', async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      const pure = await page.evaluate(() => {
        const g = window.__garage, r = { id: 'seguro', tipo: 'seguro', modo: 'mensual', diaVencimiento: 10, desde: '2026-10' };
        const pago = (periodo, cubre = 1, clase = 'cuota') => ({ periodo, cubre, clase, e: {} });
        const st = (pays, today, rr = r) => { const x = g.recStatus(rr, pays, today); return x && [x.st, x.periodo, x.iso, x.days]; };
        return [
          st([pago('2026-10')], '2026-11-05'), st([pago('2026-10')], '2026-11-12'), st([pago('2026-10'), pago('2026-11')], '2026-11-05'),
          st([], '2026-11-05'), st([pago('2026-10'), pago('2026-11')], '2026-12-03'), st([pago('2026-10', 2)], '2026-11-05'),
          st([pago('2026-10'), pago('2026-11', 1, 'ajuste')], '2026-11-05'), st([pago('2027-01')], '2027-02-01', { ...r, diaVencimiento: 31, desde: '2027-01' }),
          st([], '2026-11-05', { modo: 'manual', proximo: '2026-11-15' }), st([], '2026-11-05', { modo: 'manual', proximo: '2027-01-15' }), st([], '2026-11-05', { modo: 'manual', proximo: null })];
      });
      eq(pure, [
        ['yellow', '2026-11', '2026-11-10', 5], ['red', '2026-11', '2026-11-10', -2], ['green', '2026-12', '2026-12-10', 35],
        ['red', '2026-10', '2026-10-10', -26], ['yellow', '2026-12', '2026-12-10', 7], ['green', '2026-12', '2026-12-10', 35],
        ['yellow', '2026-11', '2026-11-10', 5], ['yellow', '2027-02', '2027-02-28', 27],
        ['yellow', '2026-11', '2026-11-15', 10], ['green', '2027-01', '2027-01-15', 71], null], 'tabla de estados del ADR');
      // Por la UI (computeAlerts → Vencimientos) con el reloj del harness.
      await goTab(page, 'vencimientos');
      for (const [dia, pagos, want] of [[3, ['2026-10'], ['red', 'VENCIDO']], [10, ['2026-10'], ['yellow', 'PENDIENTE']], [10, ['2026-10', '2026-11'], ['green', 'AL DÍA']]]) {
        await page.evaluate(() => window.__garage.store.removeMany('expenses', window.__garage.state.expenses.map(e => e.id)));
        await seedRec(page, SEG({ diaVencimiento: dia, montoEstimado: 60000 }), pagos.map((p, i) => recPago('x' + i, 'seguro', p, 61000)));
        await settle(page);
        const row = page.locator('#radar-list .alert[data-id="seguro"]');
        eq([await row.getAttribute('data-s'), await row.locator('.badge').textContent()], want, `estado con día ${dia} y pagos ${pagos.join(',') || 'ninguno'}`);
        assert(/\$\s?6[01]\.000/.test(await row.locator('.alert-sub').textContent()), 'la alerta no muestra el monto');
      }
      eq(await page.evaluate(() => window.__garage.DATE_ALERTS.map(a => a.id)), ['vtv', 'oblea', 'pruebaHidraulica'], 'seguro ya no está en DATE_ALERTS');
      eq(errors, [], 'errores de consola');
      await ctx.close();
    });

    await test('T2.5 ajuste acumulado calculado (cuotas, 2 cuotas juntas, ajuste aparte, inicio de póliza) y gráfico de 14 puntos sin desbordar', async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      await seedRec(page, SEG({ desde: '2026-01', inicioPoliza: '2026-03' }), [
        recPago('h1', 'seguro', '2026-01', 50000), recPago('h2', 'seguro', '2026-02', 50000), recPago('h2b', 'seguro', '2026-02', 1333, { clase: 'ajuste' }),
        recPago('h3', 'seguro', '2026-03', 110000, { cubre: 2 }), recPago('h5', 'seguro', '2026-05', 60000, { variacionPct: 9.1 })]);
      await settle(page);
      const h = await page.evaluate(() => { const g = window.__garage, x = g.recHistory(g.recurrentesList()[0]);
        return { pts: x.pts.map(p => [p.periodo, p.monto]), acum: x.acum, poliza: x.acumPoliza, total: x.total }; });
      eq(h, { pts: [['2026-01', 50000], ['2026-02', 50000], ['2026-03', 55000], ['2026-04', 55000], ['2026-05', 60000]], acum: 20, poliza: { desde: '2026-03', pct: 9.1 }, total: 271333 }, 'historial calculado');
      await goTab(page, 'ajustes');
      await page.locator('#rec-list [data-action=rec-history][data-id=seguro]').click();
      await page.locator('#rh-list').waitFor({ state: 'visible' });
      eq([await page.locator('#rh-acum').textContent(), await page.locator('#rh-chart circle').count(), await page.locator('#rh-list .rh-item').count()], ['+20,0 %', 5, 5], 'modal de historial');
      eq(await page.locator('#rh-list .rh-item').evaluateAll(els => els.map(e => e.dataset.periodo)), ['2026-05', '2026-03', '2026-02', '2026-02', '2026-01'], 'lista ordenada por período');
      eq(await page.locator('#rh-list .rh-var').allTextContents(), ['+9,1 %', '+10,0 %', '0,0 %'], 'variación entre pagos');
      // 14 meses de pagos: el gráfico entra en el ancho del iPhone (390 px) sin zoom ni scroll horizontal.
      await page.locator('[data-modal-close]').first().click();
      await page.evaluate(() => window.__garage.store.removeMany('expenses', window.__garage.state.expenses.map(e => e.id)));
      const many = Array.from({ length: 14 }, (_, i) => { const d = new Date(Date.UTC(2025, 8 + i, 1)); return recPago('m' + i, 'seguro', d.toISOString().slice(0, 7), 40000 + i * 1500); });
      await seedRec(page, SEG({ desde: '2025-09' }), many);
      await settle(page);
      await page.evaluate(() => window.__garage.openRecHistory('seguro'));
      await page.locator('#rh-chart').waitFor({ state: 'visible' });
      const box = await page.evaluate(() => { const c = document.querySelector('#rh-chart').getBoundingClientRect(), sh = document.querySelector('.sheet').getBoundingClientRect();
        return { pts: document.querySelectorAll('#rh-chart circle').length, fits: c.left >= sh.left && c.right <= sh.right + 0.5, overflow: document.documentElement.scrollWidth > window.innerWidth, w: Math.round(c.width) }; });
      eq({ ...box, w: box.w >= 300 }, { pts: 14, fits: true, overflow: false, w: true }, 'gráfico legible en 390 px');
      eq(errors, [], 'errores de consola');
      await ctx.close();
    });

    await test('Cada alerta abre su gasto: services con su casilla tildada y vencimientos con el próximo', async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      const bad = await page.evaluate(() => {
        const g = window.__garage, out = [];
        for (const a of g.computeAlerts(g.derive())) {
          g.openAlertExpense(a.id);
          const title = document.querySelector('#m-title')?.textContent, next = document.querySelector('#gx-next');
          if (title !== `Registrar · ${a.label}`) out.push(`${a.id}: título "${title}"`);
          if (a.tipo === 'fecha') { if (!next || !next.value) out.push(`${a.id}: sin próximo vencimiento`); }
          else {
            const lb = document.querySelector(`#gx-resets [data-reset="${a.id}"]`);
            if (!lb || lb.hidden || !lb.querySelector('input').checked) out.push(`${a.id}: casilla de reinicio no tildada`);
            if (!a.match({ tipo: a.label })) out.push(`${a.id}: el nombre no coincide con su propio match`);
          }
          document.querySelector('[data-modal-close]').click();
        }
        return out;
      });
      eq(bad, [], 'alertas sin gasto precargado correcto');
      // Service: tocar Aceite precarga el odómetro actual y reinicia su contador.
      await goTab(page, 'vencimientos');
      await page.evaluate(() => window.__garage.store.save('refuels', { id: 'ac', fecha: '2026-11-01T10:00:00', odometro: 219500, combustible: 'GNC', grado: null, volumen: 10, costoTotal: 7000, lleno: true, estacion: '', notas: '', origen: 'manual' }));
      await saveSettings(page, { ultimoAceiteKm: 209100, ultimoAceiteFecha: '2026-02-15' });
      await settle(page);
      await page.locator('#radar-list .alert[data-id="aceite"] .alert-name').click();
      await page.locator('#gx-form').waitFor({ state: 'visible' });
      eq(await page.evaluate(() => [gx('odo'), gx('cat'), gx('tipo')]), ['219500', 'PREVENTIVO', 'Aceite y filtro de aceite'], 'service precargado');
      await page.locator('#gx-monto').fill('90000');
      await page.locator('#gx-form button[type=submit]').click();
      await page.locator('#gx-form').waitFor({ state: 'detached' });
      await settle(page);
      eq(await page.evaluate(() => { const s = window.__garage.state.settings, e = window.__garage.state.expenses[0]; return [s.ultimoAceiteKm, s.ultimoAceiteFecha, e.vencimientoId]; }),
        [219500, '2026-11-05', 'aceite'], 'contador del aceite reiniciado y gasto vinculado');
      eq(errors, [], 'errores de consola');
      await ctx.close();
    });

    await test('El vínculo gasto → alerta sobrevive al respaldo JSON', async () => {
      const { ctx, page, errors } = await openDemo(browser, base);
      const r = await page.evaluate(() => {
        const p = window.__garage.buildJsonPlan(JSON.stringify({ app: 'garage-radar', version: 1, settings: {}, refuels: [], expenses: [
          { id: 'a', fecha: '2026-10-10T10:00:00', odometro: null, categoria: 'TRAMITES', tipo: 'Seguro', monto: 1, vencimientoId: 'seguro' },
          { id: 'b', fecha: '2026-10-10T10:00:00', odometro: null, categoria: 'TRAMITES', tipo: 'Seguro', monto: 1, vencimientoId: '<img>' },
          { id: 'c', fecha: '2026-10-10T10:00:00', odometro: null, categoria: 'TRAMITES', tipo: 'Seguro', monto: 1, recurrenteId: 'seguro', periodo: '2026-10', cubre: 2, clase: 'ajuste', variacionPct: 3.5 },
          { id: 'd', fecha: '2026-10-10T10:00:00', odometro: null, categoria: 'TRAMITES', tipo: 'Seguro', monto: 1, recurrenteId: '<x>', periodo: 'mal', cubre: 99, clase: 'x' },
          { id: 'e', fecha: '2026-10-10T10:00:00', odometro: null, categoria: 'TRAMITES', tipo: 'Seguro', monto: 1, recurrenteId: 'patente', periodo: '2026-13', cubre: 99, clase: 'x', variacionPct: 'NaN' }] }));
        return p.expenses.map(e => [e.vencimientoId ?? null, e.recurrenteId ?? null, e.periodo ?? null, e.cubre ?? null, e.clase ?? null, e.variacionPct ?? null]);
      });
      eq(r, [['seguro', null, null, null, null, null], [null, null, null, null, null, null], [null, 'seguro', '2026-10', 2, 'ajuste', 3.5], [null, null, null, null, null, null], [null, 'patente', null, 1, 'cuota', null]],
        'vínculos importados (y descartados si no son válidos); el vencimientoId "seguro" de 15ff551 se conserva');
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
