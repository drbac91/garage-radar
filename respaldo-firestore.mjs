// Respaldo de solo lectura de Firestore (users/**) a respaldos/garage-AAAA-MM-DD-HHMM.json.
// Sin dependencias. La clave de la cuenta de servicio sale del Llavero y nunca se imprime ni se guarda.
import { createSign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SCOPE = 'https://www.googleapis.com/auth/datastore';
const CONSERVAR = 30;
const b64u = b => Buffer.from(b).toString('base64url');

async function tokenDeAcceso(fetchFn, clave) {
  const t = Math.floor(Date.now() / 1000);
  const cuerpo = `${b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64u(JSON.stringify({
    iss: clave.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: t, exp: t + 3000 }))}`;
  const firma = createSign('RSA-SHA256').update(cuerpo).sign(clave.private_key, 'base64url');
  const r = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${cuerpo}.${firma}` }),
  });
  if (!r.ok) throw new Error(`No se pudo obtener el token (HTTP ${r.status})`);
  return (await r.json()).access_token;
}

export function aPlano(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return aMapa(v.mapValue.fields);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(aPlano);
  if ('geoPointValue' in v) return v.geoPointValue;
  if ('referenceValue' in v) return v.referenceValue;
  if ('bytesValue' in v) return v.bytesValue;
  return null;
}
const aMapa = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, aPlano(v)]));

const pad = n => String(n).padStart(2, '0');
export const nombreArchivo = d => `garage-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;

export async function exportar({ fetch: fetchFn = fetch, clave, destino, ahora = new Date() }) {
  const token = await tokenDeAcceso(fetchFn, clave);
  const proyecto = clave.project_id;
  const raiz = `https://firestore.googleapis.com/v1/projects/${proyecto}/databases/(default)/documents`;
  const cabeceras = { authorization: `Bearer ${token}` };
  const pedir = async (url, init) => {
    const r = await fetchFn(url, { ...init, headers: { ...cabeceras, 'content-type': 'application/json' } });
    if (!r.ok) throw new Error(`Firestore respondió HTTP ${r.status}`);
    return r.json();
  };
  // listCollectionIds es un POST, pero solo lee.
  const colecciones = async padre => {
    const ids = []; let pageToken;
    do {
      const j = await pedir(`${raiz}${padre ? '/' + padre : ''}:listCollectionIds`, { method: 'POST', body: JSON.stringify({ pageSize: 100, ...(pageToken && { pageToken }) }) });
      ids.push(...(j.collectionIds || [])); pageToken = j.nextPageToken;
    } while (pageToken);
    return ids;
  };
  const documentos = [], conteos = {};
  const recorrer = async (padre, coleccion) => {
    let pageToken;
    do {
      const q = new URLSearchParams({ pageSize: '300', showMissing: 'true', ...(pageToken && { pageToken }) });
      const j = await pedir(`${raiz}/${padre ? padre + '/' : ''}${coleccion}?${q}`);
      for (const d of j.documents || []) {
        const ruta = d.name.slice(d.name.indexOf('/documents/') + 11);
        if (d.createTime) { // sin createTime es un documento "fantasma" (solo tiene subcolecciones)
          documentos.push({ ruta, campos: aMapa(d.fields) });
          const p = ruta.split('/'); // users/<uid>/<colección>/...
          const k = p.length >= 4 ? `${p[0]}/${p[1]}/${p[2]}` : p.slice(0, -1).join('/');
          conteos[k] = (conteos[k] || 0) + 1;
        }
        for (const sub of await colecciones(ruta)) await recorrer(ruta, sub);
      }
      pageToken = j.nextPageToken;
    } while (pageToken);
  };
  await recorrer('', 'users');

  mkdirSync(destino, { recursive: true, mode: 0o700 });
  chmodSync(destino, 0o700);
  const archivo = join(destino, nombreArchivo(ahora));
  const tmp = `${archivo}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, generado: ahora.toISOString(), proyecto, documentos }, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, archivo);
  const viejos = readdirSync(destino).filter(f => /^garage-\d{4}-\d\d-\d\d-\d{4}\.json$/.test(f)).sort().slice(0, -CONSERVAR);
  for (const f of viejos) unlinkSync(join(destino, f));
  return { archivo, conteos, total: documentos.length };
}

function leerClave() {
  let txt;
  try { txt = execFileSync('security', ['find-generic-password', '-s', 'garage-firestore', '-a', process.env.USER, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch {
    console.error('Falta la clave en el Llavero. Guardala con: security add-generic-password -U -s garage-firestore -a "$USER" -w "$(cat RUTA_DEL_JSON)" (y borrá el archivo descargado).');
    process.exit(2);
  }
  return JSON.parse(txt);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { archivo, conteos, total } = await exportar({ clave: leerClave(), destino: join(AQUI, 'respaldos') });
    console.log(`${new Date().toISOString()} ok ${total} documentos -> ${archivo}`);
    for (const [k, n] of Object.entries(conteos).sort()) console.log(`  ${k}: ${n}`);
  } catch (e) { console.error(`${new Date().toISOString()} error: ${e.message}`); process.exit(1); }
}
