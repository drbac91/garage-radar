# Plan de implementación: Garage Radar v2

> Fuente: plan aprobado `/Users/bryan/.claude/plans/lively-hugging-unicorn.md`. Las referencias `:NNN` son líneas de `index.html` (1.848 líneas al momento de escribir este plan; se corren a medida que se edita, buscalas por nombre de función).

## Contexto

Bryan usó Garage Radar (`index.html`: un solo archivo, Firebase + GitHub Pages) por primera vez y encontró dos problemas:

1. **Recordatorios incompletos.** Solo ve aceite, filtros y bujías.
2. **El seguro no se puede configurar.** Es una cuota mensual cuyo monto cambia con ajustes, y quiere cargar los pagos anteriores desde el CSV de su app de gastos (Wallet).

Pidió una auditoría completa (UI, UX, seguridad y operatividad) convertida en sprints con objetivos, metas y criterios de aceptación. Este plan no programa nada: lo ejecutan otras sesiones, un sprint por sesión.

## Decisiones de Bryan

- Los avisos son **solo dentro de la app** (sin push ni calendario).
- El seguro es una **cuota mensual con ajuste** (monto variable).
- La **patente** también se trata como pago recurrente.

## Diagnóstico

### R1. Recordatorios

- `SERVICE_ITEMS` (:502) ya tiene 9 ítems. Los que no tienen historial aparecen en gris como "SIN CONFIGURAR" y al final de la lista (`computeAlerts` :850, `alertRowHTML` :1133). No se leen como recordatorios.
- Resumen corta la lista con `.slice(0,3)` (:1182).
- Rotación, alineación y balanceo comparten un solo ítem (`ultimoNeumaticosKm`, :517).
- Faltan unos 17 ítems: frenos, tren delantero, amortiguadores, neumáticos, batería, matafuego y otros (GNC ya está cubierto).
- No hay forma de cargar el "punto de partida" de cada ítem.
- Las inspecciones solo se reinician registrando un gasto.

### R2. Seguro

- `seguro` es solo una fecha dentro de `DATE_ALERTS` (:491).
- No existe el concepto de obligación recurrente: día de pago, monto variable, historial y "registrar pago".
- Pagar la VTV o el seguro no adelanta el próximo vencimiento.

### R3. Importación

- Solo se aceptan el CSV de Drivvo y el JSON propio (`handleImportFile` :1099).
- Drivvo ya importa "Seguro Automotor" como TRAMITES (`TRAMITE_EXPENSES` :933). Si después se importa el CSV de Wallet, hay riesgo de duplicar.
- La app de gastos es Wallet (BudgetBakers), confirmado por `finanzas/importers/wallet.py:37` del proyecto Finanzas.
- `parseCSV` (:897) necesita un parámetro de separador.

### Operatividad

- Las escrituras no esperan la confirmación del servidor (`fire` :719).
- Al borrar no hay opción de deshacer.
- `serviceCounters` (:1058) solo avanza: editar un gasto viejo con la casilla tildada puede hacer retroceder un contador.
- El km actual se queda viejo si no hay cargas recientes.
- El respaldo se llama `autolog-backup-…` (:1095).

### Seguridad

- Tailwind se carga desde un CDN en producción (:10): script de terceros con acceso a los datos, sin SRI.
- No hay CSP.
- Las reglas de Firestore (`firestore.rules`) no validan forma ni tamaño de los datos.
- La importación JSON aplica `Object.assign(patch, plan.settings)` sin lista blanca (:1080).

### Calidad

- No hay tests ni build.
- Todo vive en un solo archivo: dos agentes en paralelo se pisan.
- `window.__garage` solo existe con `?demo=1` (:1831) y hoy expone `state, derive, buildDrivvoPlan, buildJsonPlan, computeAlerts, serviceCounters`; **no** expone `parseCSV`, `finishPlan` ni `executePlan`, que el harness va a necesitar.

## Decisiones de arquitectura

1. **Catálogo como dato.** `SERVICE_ITEMS` pasa a ser una lista declarativa con campos `id, grupo, km, meses, tipo (service|inspeccion), warnKm, warnDias, prioridad, motivo, fuente, match`. Agregar un ítem es agregar una fila, no código. La definición se fija en T1.1.
2. **Modelo `recurrentes`.** Campos: `id, nombre, tipo (seguro|patente), frecuencia (mensual|bimestral|cuotas), diaVencimiento, montoEstimado, aseguradora/póliza, activo`. Cada pago es un gasto TRAMITES con `recurrenteId` y `periodo` (YYYY-MM). Estados: pagado / pendiente / vencido. Migra la fecha `seguro` actual. Se fija en T2.1.
3. **Harness Playwright sobre `?demo=1`.** `node tests/smoke.mjs` levanta `python3 -m http.server`, abre `?demo=1`, verifica cero errores de consola y usa `window.__garage` (ampliado en T0.1) para chequear alertas, totales e importaciones con fixtures.
4. **Ejecución en serie sobre `index.html`.** Toda tarea marcada 🔒 se ejecuta sola, sin otra tarea 🔒 en paralelo. Solo van en paralelo las ⇄ (fixtures, docs, CSS, reglas).
5. **ADR opcional de modularización (T1.1).** Evaluar partir `index.html` en ES modules sin build (`<script type="module">`, archivos en `js/`). Si se aprueba, se hace como tarea propia antes de T1.2; si no, se sigue con el archivo único y la regla de serie.
6. **Reuso obligatorio:** `parseCSV` (agregar parámetro de separador), `finishPlan`, `showPlanPreview`, `executePlan`, `hash53` para IDs deterministas, `serviceCounters`, `openModal`, `confirmDialog`, `computeAlerts`.

## Catálogo de mantenimiento

Referencias de la columna "Estado": **Existente** = ya está en `SERVICE_ITEMS`; **Cambia** = existe y se modifica; **Nuevo**. Prioridad: crítico (seguridad/legal), importante, recomendado. Avisos por defecto: 1.000 km (intervalos de 10.000), 2.000 km (15.000–20.000), 3.000 km (60.000); 30 días (12 m), 60 días (24 m o más). "Práctica" = práctica habitual de taller, sin fuente oficial.

| Grupo | Ítem | km | meses | tipo | aviso | prioridad | motivo | fuente | Estado |
|---|---|---|---|---|---|---|---|---|---|
| Neumáticos | Rotación | 10.000 | – | service | 1.000 km | importante | Desgaste parejo | https://noticias.autocosmos.com.mx/2025/06/21/los-errores-mas-comunes-en-el-cuidado-de-los-neumaticos | Cambia (se divide de "Rotación y alineación"; `ultimoNeumaticosKm` migra) |
| Neumáticos | Alineación | 10.000 | 12 | service | 1.000 km / 30 d | importante | Desgaste y estabilidad | https://www.pirelli.com/tyres/es-ar/news/2024/09/19/el-mito-de-lavida-util-de-los-neumaticos-pirelli-cuenta-la-verdad | Cambia (ídem) |
| Neumáticos | Balanceo | 10.000 | 12 | service | 1.000 km / 30 d | importante | Vibraciones y desgaste | https://autotest.com.ar/consejos/bridgestone-consejos-para-el-uso-inteligente-de-los-neumaticos/ | Cambia (ídem) |
| Neumáticos | Presión (incl. auxilio) | – | 1 (mensual) | inspección | 7 d | importante | Seguridad y consumo | https://autotest.com.ar/consejos/bridgestone-consejos-para-el-uso-inteligente-de-los-neumaticos/ | Nuevo |
| Neumáticos | Profundidad y edad | 10.000 | 12 | inspección | aviso con <3 mm; legal mínimo 1,6 mm (Ley 24.449); revisar a los 5 años; cambiar a ~10 años (DOT) | crítico | Adherencia y legalidad | https://www.airedesantafe.com.ar/sociedad/el-60-los-conductores-desconoce-como-evaluar-los-neumaticos-antes-viajar-n260984 | Nuevo |
| Frenos | Pastillas | 10.000 | 12 | inspección | 1.000 km / 30 d | crítico | Seguridad | https://noticias.autocosmos.com.ar/2024/12/24/todo-lo-que-tenes-que-tener-en-cuenta-si-tenes-un-auto-con-gnc-en-argentina | Nuevo |
| Frenos | Discos | 20.000 | 24 | inspección | 2.000 km / 60 d | importante | Desgaste de frenado | Práctica de taller | Nuevo |
| Frenos | Líquido de frenos | – | 24 | service | 60 d | importante | Absorbe humedad | (existente) | Existente |
| Suspensión | Tren delantero | 20.000 | 12 | inspección | 2.000 km / 30 d | crítico | Seguridad y desgaste (216k km) | Práctica de taller | Nuevo |
| Suspensión | Amortiguadores | 20.000 | 12 | inspección | 2.000 km / 30 d | importante | Estabilidad y frenado | https://www.mansuera.com/el-amortiguador-componente-fundamental-de-la-suspension/b | Nuevo |
| Eléctrico | Batería | – | 12 | inspección | 30 d | importante | Arranque confiable | https://www.cronista.com/clase/break/vacaciones-2026-los-puntos-que-si-o-si-tenes-que-controlar-en-tu-auto-antes-de-salir-a-la-ruta | Nuevo |
| Motor | Aceite y filtro de aceite | 10.000 | 12 | service | 1.000 km / 30 d | crítico | Mantener 12 m por uso con GNC | (existente) | Existente |
| Motor | Bujías y cables | 15.000 (antes 20.000) | – | service | 2.000 km | importante | Crítico con GNC | Práctica de taller | Cambia (20.000 → 15.000) |
| Motor | Correa de distribución, tensor y bomba de agua | **50.000** (antes 60.000) | 60 | service | 3.000 km / 60 d | crítico | Motor de interferencia | Taller de Bryan (05/11/2026) | Cambia (60.000 → 50.000) |
| Motor | Correa poly-V | insp. 25.000 / cambio 50.000 (junto con la distribución) | 48 | inspección + service | 3.000 km / 60 d | importante | Accesorios y alternador | https://omecanico.com.br/ed-283-motor-troca-das-correias-e-bomba-dagua-volkswagen-voyage-2015/ | Nuevo |
| Motor | Filtro de aire | 15.000 | 12 | service | 2.000 km / 30 d | recomendado | Respiración del motor | (existente) | Existente |
| Motor | Filtro de combustible | 20.000 | 24 | service | 2.000 km / 60 d | importante | Inyección | (existente) | Existente |
| Motor | Líquido refrigerante | – | 24 | service | 60 d | importante | Temperatura del motor | (existente) | Existente |
| Motor | Aceite de caja MQ200 | 60.000 | – | service | 3.000 km | recomendado | Sin fuente oficial | Sin fuente oficial | Nuevo |
| Motor | Embrague | 20.000 | 12 | inspección | 2.000 km / 30 d | recomendado | Desgaste | Práctica de taller | Nuevo |
| Motor | Escape | 20.000 | 12 | inspección | 2.000 km / 30 d | recomendado | Fugas y corrosión | Práctica de taller | Nuevo |
| Confort | Filtro de habitáculo | 15.000 | 12 | service | 2.000 km / 30 d | recomendado | Aire de cabina | https://www.volkswagen-comerciales.es/idhub/content/dam/onehub_nfz/importers/es/pdf/plan_mantenimiento_caddy.pdf | Nuevo |
| Confort | Escobillas | – | 12 | service | 30 d | recomendado | Visibilidad | Práctica | Nuevo |
| Confort | Aire acondicionado | – | 12 | inspección | 30 d | recomendado | Funcionamiento | Práctica | Nuevo |
| Legal | Luces | – | 1 (mensual) | inspección | 7 d | importante | Seguridad y VTV | https://www.cronista.com/informacion-gral/aproba-la-vtv-los-elementos-clave-para-pasar-la-verificacion-sin-problemas | Nuevo |
| Legal | Matafuego | – | 12 | inspección | 30 d | crítico | Obligatorio (Ley 24.449) | https://www.derechoenzapatillas.com/2026/que-elementos-de-seguridad-son-obligatorios-en-el-auto/ | Nuevo |
| Legal | Kit de seguridad | – | 12 | inspección | 30 d | importante | Obligatorio, multa | https://www.c5n.com/sociedad/de-cuanto-es-la-multa-no-tener-el-matafuegos-y-las-balizas-el-auto-n119470 | Nuevo |
| GNC | Equipo de GNC (filtros y revisión) | 15.000 | 12 | service | 2.000 km / 30 d | importante | Mantenimiento general | (existente) | Existente; **se mantiene como único ítem de GNC** (decisión de Bryan, 05/11: equipo vigente; oblea y prueba hidráulica ya cargadas en `DATE_ALERTS`). Regulador, filtro de gas y válvulas se revisan dentro de este service y de la oblea, sin ítems aparte |

Total: 31 ítems (8 existentes, de los cuales bujías cambia de intervalo; 3 por la división de rotación/alineación/balanceo; 20 nuevos). Cumple la meta de 25 o más.

**Salvedades:**
- No hay un plan oficial de VW Argentina verificado para este modelo. Los intervalos son referencias de taller y de las fuentes citadas.
- Las filas "práctica" no tienen fuente; se las identifica así en la app.
- VTV y neumáticos varían por provincia.
- Correa de distribución confirmada por el taller: 50.000 km. Falta confirmar el filtro de habitáculo (opcional).

## Formato CSV de Wallet (verificado con el archivo real de Bryan, 05/11/2026)

Archivo de referencia: `~/Downloads/wallet_records (1).csv`. **No se copia al repo** (`.gitignore` ya excluye `*.csv`): las notas traen nombre completo y CUIT. Las fixtures de T0.2 se inventan imitando este formato.

- **Encabezado exacto:** `account;category;currency;amount;ref_currency_amount;type;payment_type;note;date;transfer;payee;labels`
- **Separador `;`**, **decimal con punto** (`15931.92`), sin separador de miles, moneda `ARS`, `type` = `Gasto`, `transfer` = `false`.
- **Fechas ISO en UTC** (`2025-07-01T00:13:14.155Z`). **Se convierten a hora de Argentina (UTC−3) antes de tomar el día:** esa fila corresponde al 30/06/2025, es decir, al período de junio.
- **Categorías literales:** `Seguro` (55 filas, oct-2022 → oct-2026 y abr-2022 en adelante), `Patente` (16 filas) y `Mensuales` (3 filas).
- **`Mensuales` es ambigua:** dos filas (06/02/2024 y 06/03/2024, $11.530) tienen el mismo monto y la misma nota que los pagos del seguro de esa época, así que son el seguro mal categorizado. La de 03/10/2022 ($7.500, otro destinatario) no lo es. **La vista previa las muestra como "dudosas", destildadas por defecto, para que Bryan elija.**
- **`note` no se importa** (trae nombre y CUIT). `payee` se guarda en `local` (ej. "Battagliero", "Municipalidad De Vicente López"). `labels`, `account` y `payment_type` se ignoran.
- **IDs deterministas** `wl_<hash53(fechaUTC|monto|category|ocurrencia)>`: reimportar no duplica.

**Lo que muestran los datos (y condiciona el modelo de T2.1):**
- **Seguro:** casi siempre un pago por mes, con montos que van de $3.948 (2022) a $105.000 (dic-2025) y bajan a $59.000 en ene-2026 (probable cambio de póliza o aseguradora). **Hay meses con dos pagos** (jul-2022: $7.896 = 2 × $3.948, es decir, dos cuotas juntas; feb-2023: cuota + "Diferencia póliza" de $1.333; sep-2023) **y meses sin pago**. El modelo admite **varios pagos por período**, un pago que cubre **varios períodos** y un tipo "ajuste/diferencia".
- **Patente (Vicente López):** **irregular**. 16 pagos en 4,5 años, entre $2.511 y $23.067 (un pago anual en sep-2024), dos el mismo día en abr-2022, y huecos de hasta 8 meses. **No se modela con frecuencia fija:** al registrar cada pago se carga la **fecha del próximo vencimiento** (manual, prellenada a +2 meses), y la alerta se basa en esa fecha.

## Sprints

| Sprint | Objetivo | Meta medible | Duración estimada (sesiones) |
|---|---|---|---|
| S0 | Base de calidad | `node tests/smoke.mjs` en verde; respaldo de producción hecho | 1 |
| S1 | Recordatorios completos | 25 o más ítems; ninguno "sin configurar" tras el onboarding; Resumen muestra todos los rojos y amarillos | 2 |
| S2 | Seguro y patente recurrentes | Registrar un pago en 3 toques o menos, con el monto anterior precargado | 2 |
| S3 | Importación retroactiva | Importar el CSV real de Wallet sin duplicar lo de Drivvo; reimportar no duplica | 1 a 2 |
| S4 | Seguridad | Sin hallazgos altos; sin scripts de terceros; CSP activa; reglas publicadas | 1 a 2 |
| S5 | UX y operatividad | Checklist de UX aprobado por Bryan en iPhone | 1 a 2 |

## Índice de tareas

Detalle de cada una en `tasks/todo.md`.

- [ ] **S0**: T0.0 respaldo de producción · T0.1 harness Playwright · T0.2 fixtures
- [ ] **S1**: T1.1 esquema del catálogo + ADR · T1.2 catálogo y migración · T1.3 Vencimientos por sistema · T1.4 onboarding de línea base · T1.5 Resumen completo · T1.6 "Marcar revisado" · T1.7 casillas de reinicio
- [ ] **S2**: T2.1 ADR `recurrentes` · T2.2 alta/edición en Ajustes · T2.3 registrar pago · T2.4 alertas de próximo pago · T2.5 historial y gráfico
- [ ] **S3**: T3.1 diseño de deduplicación · T3.2 importador Wallet · T3.3 vincular gastos Drivvo
- [ ] **S4**: T4.1 auditoría · T4.2 sacar CDN de Tailwind · T4.3 CSP · T4.4 reglas de Firestore · T4.5 lista blanca en import JSON
- [ ] **S5**: T5.1 deshacer borrado · T5.2 confirmar escrituras · T5.3 estimar km · T5.4 README y respaldo · T5.5 recorrido UX móvil

## Checkpoints

Al cierre de cada sprint hay un "Checkpoint S<n>" en `todo.md` con: smoke verde, revisión de code-reviewer (Opus) sin hallazgos altos, Bryan revisa en iPhone, push a GitHub Pages con recarga forzada por caché (ver "Rutina-Gym: trampas de despliegue": service worker y versionado), y respaldo JSON exportado antes de las migraciones de S1 y S2.

## Guía de ejecución para agentes

**Reglas:**
- Un sprint por sesión, en orden. No se empieza un sprint sin el checkpoint anterior cerrado.
- Las tareas 🔒 se hacen en serie. Solo las ⇄ pueden lanzarse en paralelo.
- Marcá las casillas de `todo.md` a medida que se cumplen.
- No se avanza si `node tests/smoke.mjs` falla.

**Prompt para iniciar una sesión de sprint:**

> Leé tasks/plan.md y tasks/todo.md, ejecutá S<n> en orden, marcá las casillas, corré node tests/smoke.mjs, pedí revisión code-reviewer Opus al final.

**Ruteo de modelos:**

| Modelo | Cuándo | Razón |
|---|---|---|
| Opus | ADRs y diseño (T1.1, T2.1, T3.1), auditoría de seguridad (T4.1), revisión de cierre de cada sprint | Decisiones que condicionan todo lo demás y detección de fallas sutiles; el costo se amortiza |
| Sonnet | Implementación en `index.html`, harness, importador, reglas de Firestore, recorrido UX | Tareas de código con criterios claros; mejor relación calidad/costo |
| Haiku | Fixtures, README, CSS mecánico, guía del respaldo | Trabajo repetitivo y de bajo riesgo |

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Conflictos en `index.html` | Tareas 🔒 en serie, o modularizar según el ADR de T1.1 |
| Perder contadores al migrar | T0.0 respaldo previo + migración probada con fixtures (T1.2) |
| Duplicar pagos del seguro | Deduplicación de T3.1, vista previa obligatoria, IDs `wl_` deterministas |
| Intervalos de mantenimiento mal calibrados | Marcar "práctica" sin fuente; Bryan confirma con el taller; todo es editable |
| Reglas de Firestore publicadas a mano | Guía paso a paso para Bryan (T4.4) y prueba en emulador o consola |
| Caché de Pages / service worker en iPhone | Forzar recarga y versionar en cada checkpoint |
| CSP rompe Firebase | Probar en demo y en producción antes de cerrar T4.3; tener a mano el valor previo |
| Smoke test frágil | Aserciones sobre `window.__garage`, no sobre el DOM visual |

## Preguntas abiertas

1. ~~CSV de Wallet~~ **Resuelto 05/11:** formato y patrones documentados arriba.
2. ~~Correa de distribución~~ **Resuelto 05/11:** 50.000 km según el taller (se mantiene el tope de 5 años). El filtro de habitáculo queda en 15.000 km / 12 m salvo indicación del taller.
3. ~~GNC~~ **Resuelto 05/11:** se mantiene el ítem "Equipo de GNC" existente; no se agregan regulador, filtro de gas ni válvulas.
4. ~~Frecuencia de la patente~~ **Resuelto:** irregular; se usa la fecha del próximo vencimiento cargada en cada pago.
5. ¿Modularizar `index.html` en ES modules? Lo decide el ADR de T1.1.
6. Las filas `Mensuales` dudosas: Bryan las confirma en la vista previa del S3.
7. ¿Desde qué fecha cuenta la póliza actual (el monto bajó en ene-2026)? Sirve para mostrar el ajuste acumulado "de esta póliza". Se pregunta al dar de alta el recurrente (T2.2), con un campo opcional "inicio de póliza".
