# ADR S1: catálogo de mantenimiento y modularización

**Estado:** aceptado (05/11/2026) · **Tarea:** T1.1 · **Afecta:** `index.html` (`SERVICE_ITEMS`, `computeAlerts`, `serviceCounters`), `tests/smoke.mjs`

## Resumen de decisiones (para Bryan, una página)

1. **El catálogo pasa a ser un dato.** Cada ítem es una fila de `SERVICE_ITEMS` con `id, grupo, km, meses, tipo, warnKm, warnDias, prioridad, motivo, fuente, match`. Agregar un ítem es agregar una fila, sin tocar la lógica.
2. **28 ítems de mantenimiento + 4 vencimientos por fecha = 32 alertas.** El plan dice "31 ítems", pero es un error de suma: la tabla del plan tiene 28 filas (11 que ya existían o salen de dividir neumáticos, y 17 nuevas). Igual supera la meta de 25.
3. **Los datos guardados no cambian de formato.** Cada ítem sigue guardando su último service en dos campos planos de `settings`: `ultimo<Algo>Km` y `ultimo<Algo>Fecha`. Los 8 ítems que ya existían conservan exactamente sus claves, así que los datos de aceite, filtros, bujías, etc. siguen apareciendo igual que antes.
4. **"Rotación y alineación" se divide en tres:** Rotación, Alineación y Balanceo. Los tres heredan el km y la fecha de `ultimoNeumaticosKm/Fecha` **una sola vez** (migración con marca). La clave vieja **no se borra**: queda como respaldo hasta el checkpoint.
5. **Cambian dos intervalos:** bujías de 20.000 a **15.000 km**, y correa de distribución de 60.000 a **50.000 km** (confirmado por tu taller); se mantiene el tope de 5 años.
6. **GNC queda como está:** un único ítem, "Equipo de GNC (filtros y revisión)", más la oblea y la prueba hidráulica de `DATE_ALERTS`. **No** se agregan regulador, filtro de gas ni válvulas, según lo que decidiste el 05/11.
7. **Tres estados nuevos por ítem, guardados en `settings`:** "no aplica" (se oculta de todas las listas), "no sé, revisar ya" (queda en rojo hasta que cargues un dato) y "revisado" (para las inspecciones; reinicia el contador sin crear un gasto).
8. **No se modulariza `index.html` en este sprint.** Se sigue con el archivo único y la regla de tareas 🔒 en serie. Se vuelve a evaluar en **T4.3 (CSP)**, donde puede convenir sacar el script a un único `app.js`. Motivos abajo.

**Qué tenés que mirar vos:** que los intervalos y avisos de la tabla del plan te cierren (todos se pueden editar en la fila), y que los ítems marcados "práctica de taller" no tienen fuente oficial.

---

## 1. Esquema de una fila

| Campo | Tipo | Uso |
|---|---|---|
| `id` | string | Identificador estable (`aceite`, `pastillas`, `rotacion`). Clave de `noAplica`, `pendientes` y `revisiones`. |
| `stem` | string, opcional | Raíz de las claves de `settings`. Por defecto es el `id` con mayúscula inicial. Solo se fija para conservar claves heredadas (`liquidoFrenos` → `Frenos`, `filtroComb` → `FiltroComb`). |
| `key` / `fkey` | derivados | `ultimo${stem}Km` y `ultimo${stem}Fecha`. La smoke verifica que no se repitan. |
| `grupo` | enum | `Neumáticos, Frenos, Suspensión, Eléctrico, Motor, Confort, Legal, GNC`. Es el orden en Vencimientos. |
| `label` | string | Nombre visible. |
| `km` | número o `null` | Intervalo por kilometraje. |
| `meses` | número o `null` | Intervalo por tiempo. Vence por lo que ocurra primero. |
| `tipo` | `service` o `inspeccion` | Las inspecciones muestran el botón "Marcar revisado". |
| `warnKm` / `warnDias` | número | Margen para pasar a amarillo. Por defecto: 1.000 km si el intervalo es de hasta 10.000, 2.000 km hasta 20.000 y 3.000 km por encima; 30 días si el intervalo es de hasta 12 meses y 60 si es mayor. Las inspecciones mensuales usan 7 días. |
| `prioridad` | `critico`, `importante` o `recomendado` | Se muestra como dato. No cambia el orden, que lo define la urgencia. |
| `motivo` | string | Por qué importa (una línea). |
| `fuente` | URL o `"practica"` | `practica` se muestra como "Práctica de taller (sin fuente oficial)". |
| `match` | `{ re, not? }` | Expresiones regulares sobre el `tipo` normalizado del gasto (sin acentos y en minúsculas). Reconocen el gasto que reinicia el contador. |
| `icon` | string | Ícono de `ICONS`. |

**Ejemplo `service`:**

```js
{ id: 'aceite', grupo: 'Motor', label: 'Aceite y filtro de aceite', km: 10000, meses: 12, tipo: 'service',
  warnKm: 1000, warnDias: 30, prioridad: 'critico', motivo: 'Mantener 12 meses por uso con GNC', fuente: 'practica',
  match: { re: /aceite/, not: /^filtro de aceite$|caja|transmision|diferencial|direccion|hidraulic|frenos/ }, icon: 'drop' }
// claves: ultimoAceiteKm / ultimoAceiteFecha (las de siempre)
```

**Ejemplo `inspeccion`:**

```js
{ id: 'pastillas', grupo: 'Frenos', label: 'Pastillas de freno', km: 10000, meses: 12, tipo: 'inspeccion',
  warnKm: 1000, warnDias: 30, prioridad: 'critico', motivo: 'Seguridad', fuente: 'https://noticias.autocosmos.com.ar/…',
  match: { re: /pastilla/ }, icon: 'shield' }
// claves: ultimoPastillasKm / ultimoPastillasFecha
```

La correa poly-V se modela como **inspección cada 25.000 km o 48 meses**, y el motivo aclara que se cambia junto con la distribución. "Profundidad y edad" de neumáticos es una inspección cada 10.000 km o 12 meses, y el motivo lleva el mínimo legal (1,6 mm) y el aviso a los 3 mm.

## 2. Estado por ítem en `settings`

- `ultimo<Stem>Km` y `ultimo<Stem>Fecha`: el último service o revisión. Son las mismas claves planas de siempre.
- `noAplica: { [id]: true|false }`: el ítem sale de `computeAlerts`, así que no aparece en Vencimientos, Resumen ni el onboarding. Se reactiva desde Configurar (con `false`, porque Firestore `merge` no borra un campo con `undefined`).
- `pendientes: { [id]: 'YYYY-MM-DD' }`: "no sé, revisar ya". Si el ítem no tiene datos, cuenta como **rojo** ("REVISAR"). Cuando aparece un dato, la marca se ignora.
- `revisiones: { [id]: [{ fecha, km }] }`: historial liviano de "Marcar revisado", el más reciente primero, con un tope de 10 por ítem.
- Para los vencimientos por fecha (`vtv`, `oblea`, `pruebaHidraulica`, `seguro`), el `id` es la misma `key`. "No sé" y "no aplica" funcionan igual.

**Km de referencia:** `computeAlerts` usa como km actual el mayor entre el odómetro registrado y los km base cargados. Así, un ítem por km configurado en el onboarding no queda "sin configurar" en una cuenta sin cargas.

## 3. Contadores

- `serviceCounters(expenses, cur)` recorre el catálogo y solo **avanza** (máximo entre el valor actual y el del historial). La fecha se guarda siempre, aunque el ítem no tenga `meses`, porque sirve para "última vez".
- El formulario de gasto solo ofrece las casillas cuyo `match` coincide con el tipo, y escribe un contador únicamente si el valor nuevo es mayor al guardado (T1.7). Borrar un gasto no toca contadores.

## 4. Migración de neumáticos (idempotente)

`migrateSettings(s) → patch` es una función pura:

1. Si `s.migraciones?.neumaticos3` es verdadero, devuelve `{}`.
2. Si no, para cada uno de `Rotacion`, `Alineacion` y `Balanceo`, copia `ultimoNeumaticosKm` y `ultimoNeumaticosFecha` **solo si** el destino está vacío (`undefined` **o** `null`, porque el formulario de Configurar guarda `null` en los campos vacíos).
3. Agrega `migraciones: { neumaticos3: true }`. Si no hay `ultimoNeumaticosKm` ni `ultimoNeumaticosFecha`, no hace nada **ni pone la marca**, así que un respaldo viejo importado en una cuenta nueva también se migra.
4. **Nunca** borra ni modifica `ultimoNeumaticosKm/Fecha`.

Corre en la suscripción de `settings`. En Firestore se saltea si el snapshot viene de la caché (`metadata.fromCache`), para que una caché vieja no pise valores ya migrados desde otro dispositivo. Correrla dos veces da `{}` la segunda vez, y la smoke lo verifica. **Caso borde:** si después de migrar se importa un respaldo viejo con `ultimoNeumaticosKm`, no se vuelve a copiar (la marca ya está). Se puede usar "Calcular desde el historial" o cargar el dato a mano.

## 5. Modularización: **no** (por ahora)

| | ES modules sin build (`js/*.js`) | Archivo único (elegido) |
|---|---|---|
| Conflictos entre agentes | Menos | Se evitan con la regla 🔒 en serie, que ya funciona |
| Service worker | **El repo no tiene hoy.** Si se agrega, hay que versionar cada archivo (`?v=`) o una lista de precache | Un solo archivo para invalidar |
| GitHub Pages / iPhone | Más pedidos y caché por archivo. Un `app.js` viejo junto a un `index.html` nuevo rompe la app | Atómico: o está la versión vieja o la nueva |
| `file://` y demo | Los módulos no cargan desde `file://` (CORS) | Funciona |
| CSP (S4) | Ayuda: permite `script-src 'self'` sin `unsafe-inline` | Requiere un hash del script inline o extraerlo |
| Costo | Partir unas 1.400 líneas de JS, rehacer `window.__garage`, revisar imports dinámicos de Firebase | Cero |

**Decisión:** seguir con el archivo único en S1–S3. En **T4.3** se decide entre usar un hash del script inline en la CSP o extraerlo a **un solo** `app.js` versionado, sin partirlo en muchos módulos. El incentivo real para separar es la CSP, no la organización del código.

## 6. Fuera de alcance

- Regulador, filtro de gas y válvulas de GNC (decisión de Bryan).
- Avisos fuera de la app.
- Borrar `ultimoNeumaticosKm/Fecha`: se hace después del checkpoint S1, con el respaldo confirmado.
