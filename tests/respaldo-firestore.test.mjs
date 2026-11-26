import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { exportar, aPlano } from '../respaldo-firestore.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const clave = { client_email: 'x@y.iam.gserviceaccount.com', private_key: privateKey, project_id: 'proy' };
const base = 'projects/proy/databases/(default)/documents';
const doc = (ruta, fields) => ({ name: `${base}/${ruta}`, createTime: 't', fields });
const json = o => ({ ok: true, status: 200, json: async () => o });

function falso(log) {
  return async (url, init = {}) => {
    log.push({ url, method: init.method || 'GET' });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'TOKEN-SECRETO' });
    assert.equal(init.headers.authorization, 'Bearer TOKEN-SECRETO');
    const u = new URL(url); const p = decodeURIComponent(u.pathname).split('/documents')[1] || '';
    if (p === ':listCollectionIds') return json({ collectionIds: ['users'] });
    if (p === '/users') return u.searchParams.get('pageToken')
      ? json({ documents: [doc('users/u2', {})] })
      : json({ documents: [{ name: `${base}/users/u1` }], nextPageToken: 'n2' }); // u1 es fantasma
    if (p === '/users/u1:listCollectionIds') return json({ collectionIds: ['refuels'] });
    if (p === '/users/u1/refuels') return json({ documents: [doc('users/u1/refuels/r1', {
      km: { integerValue: '123' }, l: { doubleValue: 4.5 }, ok: { booleanValue: true }, n: { nullValue: null }, s: { stringValue: 'hola' },
      f: { timestampValue: '2026-01-02T03:04:05Z' }, m: { mapValue: { fields: { a: { stringValue: 'b' } } } }, a: { arrayValue: { values: [{ integerValue: '1' }, { stringValue: 'x' }] } } })] });
    if (p === '/users/u1/refuels/r1:listCollectionIds') return json({ collectionIds: ['fotos'] });
    if (p === '/users/u1/refuels/r1/fotos') return json({ documents: [doc('users/u1/refuels/r1/fotos/f1', {})] });
    if (p === '/users/u2:listCollectionIds') return json({});
    return json({}); // listados vacíos
  };
}

test('conversión de tipos', () => {
  assert.deepEqual(aPlano({ arrayValue: {} }), []);
  assert.equal(aPlano({ integerValue: '-7' }), -7);
});

test('recorrido recursivo, paginación, modo 0600, rotación y nada secreto en stdout', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'resp-')), 'respaldos');
  const log = [];
  const r = await exportar({ fetch: falso(log), clave, destino: dir, ahora: new Date(2026, 10, 26, 12, 45) });
  assert.equal(r.total, 3);
  assert.equal(r.conteos['users/u1/refuels'], 2); // r1 + su subcolección
  assert.ok(log.some(l => l.url.includes('pageToken=n2')), 'pidió la segunda página');
  assert.ok(log.every(l => l.method === 'GET' || l.url.includes(':listCollectionIds') || l.url.includes('oauth2')), 'solo lecturas');
  const j = JSON.parse(readFileSync(r.archivo, 'utf8'));
  assert.equal(j.v, 1); assert.equal(j.proyecto, 'proy');
  const r1 = j.documentos.find(d => d.ruta === 'users/u1/refuels/r1').campos;
  assert.deepEqual(r1, { km: 123, l: 4.5, ok: true, n: null, s: 'hola', f: '2026-01-02T03:04:05Z', m: { a: 'b' }, a: [1, 'x'] });
  assert.ok(j.documentos.some(d => d.ruta === 'users/u1/refuels/r1/fotos/f1'));
  assert.equal(statSync(r.archivo).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const txt = readFileSync(r.archivo, 'utf8');
  assert.ok(!txt.includes('TOKEN-SECRETO') && !txt.includes('PRIVATE KEY'));

  // rotación: 35 viejos + el nuevo => quedan 30, y el nuevo sigue
  for (let i = 0; i < 35; i++) writeFileSync(join(dir, `garage-2026-01-${String(i % 28 + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}00.json`), '{}');
  const r2 = await exportar({ fetch: falso([]), clave, destino: dir, ahora: new Date(2026, 10, 27, 12, 45) });
  const quedan = readdirSync(dir);
  assert.equal(quedan.length, 30);
  assert.ok(quedan.includes(r2.archivo.split('/').pop()));
});

test('sin clave en el Llavero sale con 2 y no imprime secretos', () => {
  const r = (() => { try { execFileSync(process.execPath, [join(import.meta.dirname, '../respaldo-firestore.mjs')], { env: { PATH: '/nonexistent', USER: 'nadie' }, encoding: 'utf8', stdio: 'pipe' }); return { status: 0 }; } catch (e) { return e; } })();
  assert.equal(r.status, 2);
  assert.ok(String(r.stderr).includes('security add-generic-password'));
  assert.ok(!String(r.stdout).includes('PRIVATE KEY'));
});
