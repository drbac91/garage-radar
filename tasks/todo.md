# Garage Radar v2: tareas

**Leyenda:** ⇄ = paralelizable con otras tareas · 🔒 = toca `index.html` (se ejecuta en serie, una sola a la vez).
**Tamaños:** XS / S / M. Si una tarea crece a L, se parte.
**Referencias:** `:NNN` son líneas de `index.html` al momento del plan; buscá por nombre de función. Contexto completo en `tasks/plan.md`.

---

# S0 · Base de calidad

## T0.0: Exportar respaldo JSON de producción  [⇄]
**Agente / Modelo:** general-purpose / Haiku
**Descripción:** Guía paso a paso para que Bryan exporte el respaldo JSON de la app en producción (Ajustes, exportar) antes de tocar nada. Es manual: el agente redacta los pasos (iPhone y escritorio) y le pide a Bryan que guarde el archivo fuera de la carpeta del proyecto, con la fecha en el nombre. Hoy el archivo se llama `autolog-backup-AAAA-MM-DD.json` (:1095).
**Criterios de aceptación:**
- [ ] La guía tiene menos de 8 pasos, en voseo, sin jerga.
- [ ] Bryan confirma en el chat que el archivo existe y no está vacío.
**Verificación:**
- [ ] `node tests/smoke.mjs` (no aplica todavía; se agrega en T0.1)
- [ ] Revisión manual: Bryan abre el JSON y ve sus gastos y sus fechas de VTV/oblea/seguro.
**Dependencias:** Ninguna
**Archivos probables:** ninguno (guía en el chat)
**Tamaño:** XS

## T0.1: Harness Playwright sobre ?demo=1  [🔒]
**Agente / Modelo:** test-engineer / Sonnet
**Descripción:** Crear `tests/smoke.mjs`: levanta `python3 -m http.server`, abre `index.html?demo=1` con Playwright, falla ante cualquier error de consola, importa las fixtures de T0.2 y verifica alertas (`computeAlerts`) y totales con `window.__garage`. Cambio mínimo en `index.html` (:1831): ampliar `window.__garage` con `parseCSV`, `finishPlan`, `executePlan` y `showPlanPreview`, solo bajo `DEMO`.
**Criterios de aceptación:**
- [x] `node tests/smoke.mjs` sale con código 0 sobre el código actual.
- [x] Falla (código distinto de 0) si se inyecta un `console.error` a propósito.
- [x] Cubre: carga sin errores, import de Drivvo, import de JSON, conteo de alertas.
- [x] `window.__garage` sigue sin existir fuera de `?demo=1`.
**Verificación:**
- [x] `node tests/smoke.mjs` (caso: "carga demo sin errores" y "import Drivvo fixture produce N gastos")
- [ ] Revisión manual: abrir `?demo=1` en el navegador y comprobar que la app se ve igual que antes.
**Dependencias:** T0.2
**Archivos probables:** `tests/smoke.mjs`, `package.json` (solo devDependency de playwright), `index.html` (:1831)
**Tamaño:** M

## T0.2: Fixtures sintéticas  [⇄]
**Agente / Modelo:** general-purpose / Haiku
**Descripción:** Crear en `tests/fixtures/` datos inventados (nunca reales): un mini CSV de Drivvo (con "Seguro Automotor", un cambio de aceite y una rotación), un mini CSV de Wallet (BOM, separador `;`, columnas `account,category,currency,amount,type,date,transfer,note`, con 3 pagos de "Seguro del vehículo", 1 patente, 1 gasto ajeno y 1 ingreso) y un respaldo JSON con `ultimoNeumaticosKm/Fecha` seteados.
**Criterios de aceptación:**
- [x] Tres archivos: `drivvo-mini.csv`, `wallet-mini.csv`, `backup-mini.json`.
- [x] El CSV de Wallet tiene al menos un pago que coincide en fecha (±5 días) y monto (±1 %) con un gasto del CSV de Drivvo.
- [x] Ningún dato real de Bryan.
**Verificación:**
- [x] `node tests/smoke.mjs` (T0.1 los consume)
- [x] Revisión manual: abrir los CSV en un editor y confirmar BOM y separador. (Lo verifica también el primer caso del smoke.)
**Dependencias:** Ninguna
**Archivos probables:** `tests/fixtures/drivvo-mini.csv`, `tests/fixtures/wallet-mini.csv`, `tests/fixtures/backup-mini.json`
**Tamaño:** S

## Checkpoint S0
- [x] `node tests/smoke.mjs` en verde
- [x] code-reviewer (Opus) sin hallazgos altos (1 medio en .gitignore, corregido)
- [ ] Respaldo JSON de producción guardado por Bryan (T0.0)
- [ ] Bryan confirma que la app sigue igual en iPhone
- [ ] Push a GitHub Pages + forzar recarga por caché del service worker

---

# S1 · Recordatorios completos

## T1.1: Esquema del catálogo y ADR de modularización  [⇄]
**Agente / Modelo:** Software Architect / Opus
**Descripción:** Escribir `tasks/adr-catalogo.md` con: esquema del catálogo (`id, grupo, km, meses, tipo service/inspección, warnKm, warnDias, prioridad, motivo, fuente, match`), cómo se guardan los contadores por ítem frente a las claves viejas `ultimo*Km/Fecha` de `SERVICE_ITEMS` (:502), la migración de `ultimoNeumaticosKm/Fecha` a rotación/alineación/balanceo, y si conviene modularizar en ES modules sin build.
**Criterios de aceptación:**
- [x] El ADR define el esquema y un ejemplo para cada `tipo`.
- [x] Define la migración de forma idempotente (correrla dos veces da lo mismo).
- [x] Decide explícitamente modularizar sí/no, con el costo para el service worker y Pages.
- [x] Respeta la decisión de Bryan (05/11): GNC queda solo con el ítem existente "Equipo de GNC" más la oblea y la prueba hidráulica de `DATE_ALERTS`. No se agregan regulador, filtro de gas ni válvulas.
**Verificación:**
- [x] `node tests/smoke.mjs` (no cambia; el ADR no toca código)
- [ ] Revisión manual: Bryan lee el resumen de decisiones (máx. una página).
**Dependencias:** T0.1
**Archivos probables:** `tasks/adr-catalogo.md`
**Tamaño:** S

## T1.2: Catálogo ampliado y migración sin pérdida  [🔒]
**Agente / Modelo:** Frontend Developer / Sonnet
**Descripción:** Reemplazar `SERVICE_ITEMS` (:502) por el catálogo declarativo del plan (31 ítems). Migrar `ultimoNeumaticosKm/Fecha` a los ítems rotación, alineación y balanceo (los tres heredan el valor, sin borrar la clave vieja hasta el checkpoint). Subir el intervalo de bujías de 20.000 a 15.000 km. Adaptar `computeAlerts` (:850) y `serviceCounters` (:1058) al nuevo esquema. Hacer esto después de T0.0 y con el respaldo a mano.
**Criterios de aceptación:**
- [ ] Hay 25 o más ítems en `computeAlerts` con el demo.
- [ ] Con `backup-mini.json`, los tres ítems de neumáticos arrancan con el km/fecha de `ultimoNeumaticosKm/Fecha`.
- [ ] Bujías avisa a 15.000 km.
- [ ] Correr la migración dos veces no cambia el resultado.
**Verificación:**
- [ ] `node tests/smoke.mjs` (casos nuevos: "catálogo >= 25 ítems", "migración neumáticos idempotente", "bujías 15.000")
- [ ] Revisión manual: en iPhone, los datos reales de oil/filtros siguen mostrando las mismas fechas que antes.
**Dependencias:** T1.1, T0.0
**Archivos probables:** `index.html` (:502, :850, :1058), `tests/smoke.mjs`
**Tamaño:** M

## T1.3: Vencimientos agrupado por sistema  [🔒]
**Agente / Modelo:** Frontend Developer / Sonnet
**Descripción:** En la pantalla de Vencimientos (`alertRowHTML` :1133 y su lista), agrupar los ítems por `grupo` (Neumáticos, Frenos, Suspensión, Eléctrico, Motor, Confort, Legal, GNC) con encabezado y conteo de rojos/amarillos. Los ítems "no aplica" se ocultan. Orden dentro del grupo: rojo, amarillo, verde, sin configurar.
**Criterios de aceptación:**
- [ ] Se ven 8 grupos con encabezado.
- [ ] Un ítem marcado "no aplica" no aparece en ninguna lista.
- [ ] El orden por urgencia se mantiene dentro de cada grupo.
**Verificación:**
- [ ] `node tests/smoke.mjs` (caso: "grupos presentes y 'no aplica' oculto")
- [ ] Revisión manual: en iPhone, la pantalla se lee sin scroll infinito y los encabezados son legibles.
**Dependencias:** T1.2
**Archivos probables:** `index.html`
**Tamaño:** S

## T1.4: Onboarding de línea base por ítem  [🔒]
**Agente / Modelo:** Frontend Developer / Sonnet
**Descripción:** Flujo (modal con `openModal`) que recorre los ítems sin historial y pregunta por cada uno: "última vez (fecha/km)", "no sé, revisar ya" (queda vencido para forzar la revisión) o "no aplica". Debe poder retomarse y salir en cualquier momento. Guarda en el contador del ítem sin crear gastos.
**Criterios de aceptación:**
- [ ] Tras completar el onboarding, ningún ítem queda en "SIN CONFIGURAR".
- [ ] "No sé" deja el ítem en rojo; "no aplica" lo oculta.
- [ ] Se puede cerrar a mitad y retomar sin perder lo ya cargado.
- [ ] No se crean gastos.
**Verificación:**
- [ ] `node tests/smoke.mjs` (caso: "onboarding completo deja 0 ítems sin configurar")
- [ ] Revisión manual: en iPhone, recorrer 5 ítems con el teclado numérico sin que se tape el botón.
**Dependencias:** T1.3
**Archivos probables:** `index.html`
**Tamaño:** M

## T1.5: Resumen sin el corte a 3  [🔒]
**Agente / Modelo:** Frontend Developer / Sonnet
**Descripción:** En Resumen (:1182) quitar `.slice(0,3)` y mostrar todos los rojos y amarillos, más una línea "N al día" colapsada. Si hay ítems sin configurar, mostrar un llamado a acción que abre el onboarding de T1.4.
**Criterios de aceptación:**
- [ ] Con 5 rojos y 4 amarillos en el demo, Resumen los muestra a los 9.
- [ ] Aparece "N al día" con el conteo correcto.
- [ ] El llamado a acción solo aparece si hay ítems sin configurar y abre el onboarding.
**Verificación:**
- [ ] `node tests/smoke.mjs` (caso: "Resumen lista todos los rojos y amarillos")
- [ ] Revisión manual: en iPhone, Resumen no queda abrumador con muchos rojos.
**Dependencias:** T1.4
**Archivos probables:** `index.html` (:1182)
**Tamaño:** S

## T1.6: Botón "Marcar revisado" para inspecciones  [🔒]
**Agente / Modelo:** Frontend Developer / Sonnet
**Descripción:** Para ítems de tipo inspección, agregar el botón "Marcar revisado" que reinicia el contador del ítem a hoy y al km actual sin crear un gasto, registrando el evento (fecha, km, ítem) en un historial liviano. Hoy las inspecciones solo se reinician registrando un gasto.
**Criterios de aceptación:**
- [ ] El botón aparece solo en ítems tipo inspección.
- [ ] Al tocarlo, el ítem pasa a verde y no se crea ningún gasto.
- [ ] El evento queda registrado y se puede ver la fecha de la última revisión.
**Verificación:**
- [ ] `node tests/smoke.mjs` (caso: "marcar revisado reinicia sin gasto")
- [ ] Revisión manual: en iPhone, el botón se alcanza con el pulgar y confirma con un toast.
**Dependencias:** T1.3
**Archivos probables:** `index.html`
**Tamaño:** S

## T1.7: Casillas de reinicio coherentes y contadores que no retroceden  [🔒]
**Agente / Modelo:** Frontend Developer / Sonnet
**Descripción:** En el formulario de gasto, mostrar solo las casillas de reinicio que coinciden con el tipo (`match`). Corregir `serviceCounters` (:1058) para que nunca retroceda un contador al editar o borrar un gasto viejo: usar el máximo entre el contador actual y el recalculado.
**Criterios de aceptación:**
- [ ] Un gasto de tipo "Cambio de aceite" solo ofrece la casilla del aceite.
- [ ] Editar un gasto de hace 2 años con la casilla tildada no baja el contador.
- [ ] Borrar un gasto no deja un contador por debajo de otro más reciente.
**Verificación:**
- [ ] `node tests/smoke.mjs` (caso: "editar gasto viejo no retrocede contador")
- [ ] Revisión manual: en iPhone, editar un gasto antiguo y confirmar que las alertas no cambian.
**Dependencias:** T1.2
**Archivos probables:** `index.html` (:1058), `tests/smoke.mjs`
**Tamaño:** S

## Checkpoint S1
- [ ] `node tests/smoke.mjs` en verde
- [ ] code-reviewer (Opus) sin hallazgos altos
- [ ] Respaldo JSON exportado por Bryan antes de la migración (T1.2) y reconfirmado después
- [ ] Bryan revisa en iPhone: 25 o más ítems, onboarding, Resumen
- [x] Correa de distribución confirmada: 50.000 km (05/11). T1.2 cambia el intervalo de `ultimoDistribucionKm` de 60.000 a 50.000
- [ ] Push a GitHub Pages + forzar recarga por caché del service worker

---

# S2 · Seguro y patente recurrentes

## T2.1: ADR del modelo `recurrentes`  [⇄]
**Agente / Modelo:** Software Architect / Opus
**Descripción:** Escribir `tasks/adr-recurrentes.md`: colección o campo (`id, nombre, tipo seguro/patente, modo: mensual (seguro) o próximo vencimiento manual (patente, que es irregular), diaVencimiento, montoEstimado, aseguradora/póliza, inicioPoliza opcional, activo`). Basarse en los patrones reales documentados en plan.md → "Formato CSV de Wallet": varios pagos en un mismo mes, un pago que cubre dos cuotas, pagos tipo "diferencia de póliza" y meses sin pago, pagos como gastos TRAMITES con `recurrenteId` y `periodo` (YYYY-MM), estados pagado/pendiente/vencido, regla para calcular el período vigente, y migración de la fecha `seguro` de `DATE_ALERTS` (:491). Incluir el impacto en `firestore.rules`.
**Criterios de aceptación:**
- [ ] Define el cálculo del estado de un período con ejemplos (día 10, hoy día 12, sin pago, etc.).
- [ ] Define la migración de `seguro` y qué pasa si no hay fecha.
- [ ] Define el campo para guardar la variación % sin recalcular a mano.
**Verificación:**
- [ ] `node tests/smoke.mjs` (no cambia; el ADR no toca código)
- [ ] El ADR cubre con ejemplos los casos reales: jul-2022 (un pago = 2 cuotas), feb-2023 (cuota + diferencia), patente con huecos de 8 meses.
**Dependencias:** T1.2
**Archivos probables:** `tasks/adr-recurrentes.md`
**Tamaño:** S

## T2.2: Alta y edición de recurrentes en Ajustes  [🔒]
**Agente / Modelo:** Frontend Developer / Sonnet
**Descripción:** En Ajustes agregar la sección "Pagos recurrentes": crear, editar y desactivar seguro y patente con los campos del ADR. Migrar la fecha `seguro` existente a un recurrente de tipo seguro (idempotente). Agregar el store para `recurrentes` y la suscripción correspondiente.
**Criterios de aceptación:**
- [ ] Se puede crear un seguro mensual con día de vencimiento y monto estimado.
- [ ] Se puede crear la patente sin frecuencia fija. Cada pago guarda la fecha del próximo vencimiento, prellenada a +2 meses y editable.
- [ ] La fecha `seguro` previa se migra una sola vez y no queda duplicada en `DATE_ALERTS`.
- [ ] Desactivar un recurrente lo saca de las alertas sin borrar el historial.
**Verificación:**
- [ ] `node tests/smoke.mjs` (casos: "crear recurrente", "migración seguro idempotente")
- [ ] Revisión manual: en iPhone, cargar el seguro real en menos de un minuto.
**Dependencias:** T2.1
**Archivos probables:** `index.html`, `tests/smoke.mjs`
**Tamaño:** M

## T2.3: Registrar pago desde la alerta  [🔒]
**Agente / Modelo:** Frontend Developer / Sonnet
**Descripción:** Botón "Registrar pago" en la alerta del recurrente que abre un modal con el monto precargado con el último pago, la fecha de hoy y el período; al confirmar crea un gasto TRAMITES con `recurrenteId` y `periodo`. Muestra la variación % respecto del pago anterior (ej. "+8,5 %"). Reutilizar `openModal` y el alta de gastos existente.
**Criterios de aceptación:**
- [ ] ≤3 toques, monto precargado con el último pago, muestra % de variación.
- [ ] El pago crea un gasto TRAMITES con `recurrenteId` y `periodo` correctos.
- [ ] Si ya hay un pago para ese período, avisa antes de duplicar.
- [ ] Pagar adelanta el próximo vencimiento del recurrente.
**Verificación:**
- [ ] `node tests/smoke.mjs` (casos: "registrar pago precarga último monto", "variación % correcta", "no duplica el período")
- [ ] Revisión manual: en iPhone, contar los toques desde Resumen hasta guardado (máx. 3).
**Dependencias:** T2.2
**Archivos probables:** `index.html`, `tests/smoke.mjs`
**Tamaño:** M

## T2.4: Alertas de próximo pago en Vencimientos y Resumen  [🔒]
**Agente / Modelo:** Frontend Developer / Sonnet
**Descripción:** Integrar los recurrentes a `computeAlerts` (:850) reemplazando la entrada `seguro` de `DATE_ALERTS` (:491). Cada recurrente activo produce una alerta con estado pagado/pendiente/vencido según el ADR, visible en Vencimientos y Resumen. Adaptar `alertRowHTML` (:1133) para mostrar monto estimado y días.
**Criterios de aceptación:**
- [ ] Un recurrente sin pago del período vigente aparece como pendiente y pasa a vencido tras el día de vencimiento.
- [ ] Un recurrente pagado aparece como al día y avisa el siguiente período.
- [ ] `seguro` ya no está en `DATE_ALERTS`.
**Verificación:**
- [ ] `node tests/smoke.mjs` (caso: "estados pagado/pendiente/vencido con fecha simulada")
- [ ] Revisión manual: en iPhone, la alerta del seguro se lee con monto y días de forma clara.
**Dependencias:** T2.3
**Archivos probables:** `index.html` (:491, :850, :1133)
**Tamaño:** S

## T2.5: Historial por recurrente  [🔒]
**Agente / Modelo:** Frontend Developer / Sonnet
**Descripción:** Pantalla o modal con la lista de pagos del recurrente, gráfico simple de evolución del monto (SVG propio, sin librerías) y el ajuste acumulado desde el primer pago. Accesible desde la alerta y desde Ajustes.
**Criterios de aceptación:**
- [ ] Lista de pagos ordenada por período, con monto y variación % entre pagos.
- [ ] Gráfico de evolución con al menos 12 puntos legible en iPhone.
- [ ] Muestra el ajuste acumulado (primer pago vs. último).
**Verificación:**
- [ ] `node tests/smoke.mjs` (caso: "ajuste acumulado calculado")
- [ ] Revisión manual: en iPhone, el gráfico no se corta ni requiere zoom.
**Dependencias:** T2.3
**Archivos probables:** `index.html`
**Tamaño:** M

## Checkpoint S2
- [ ] `node tests/smoke.mjs` en verde
- [ ] code-reviewer (Opus) sin hallazgos altos
- [ ] Respaldo JSON exportado por Bryan antes de la migración del seguro (T2.2)
- [ ] Bryan revisa en iPhone: alta del seguro, registrar un pago en ≤3 toques, historial
- [ ] Push a GitHub Pages + forzar recarga por caché del service worker

---

# S3 · Importación retroactiva

## T3.1: Diseño de deduplicación entre fuentes  [⇄]
**Agente / Modelo:** Software Architect / Opus
**Descripción:** Escribir `tasks/adr-dedup.md`: criterio de coincidencia (misma fecha ±5 días, mismo monto ±1 %, categoría seguro o patente; **el día se calcula en hora de Argentina, UTC−3**, porque Wallet guarda en UTC), qué hacer si hay más de un candidato, qué se vincula (agregar `recurrenteId` y `periodo` al gasto de Drivvo existente) y qué se inserta, formato del ID `wl_` con `hash53`, y cómo se muestra en la vista previa (`showPlanPreview` :1701).
**Criterios de aceptación:**
- [ ] Reglas de desempate y casos borde documentados (dos pagos en la misma semana, monto 0).
- [ ] Define qué columnas de Wallet entran en el hash para que reimportar no duplique.
- [ ] Mapeo real: `Seguro` → seguro, `Patente` → patente, `Mensuales` → "dudosa" (se muestra destildada en la vista previa), resto → se ignora.
**Verificación:**
- [ ] `node tests/smoke.mjs` (no cambia; el ADR no toca código)
- [ ] Revisión manual: se valida contra el CSV real `~/Downloads/wallet_records (1).csv` (55 seguro, 16 patente, 3 mensuales). No se copia al repo.
**Dependencias:** T2.1
**Archivos probables:** `tasks/adr-dedup.md`
**Tamaño:** S

## T3.2: Importador de Wallet  [🔒]
**Agente / Modelo:** Frontend Developer / Sonnet
**Descripción:** Agregar el importador de Wallet a `handleImportFile` (:1099): detección de encabezado, separador (`,`, `;`, tab; agregar parámetro a `parseCSV` :897) y BOM; filtro a gastos (`type`); mapeo de categorías a seguro o patente (`Seguro`, `Patente`; `Mensuales` como dudosa); fecha convertida a UTC−3 antes de asignar el `periodo`; **no importar `note`** (trae nombre y CUIT) y guardar `payee` en `local`; IDs `wl_` deterministas. Actualizar `tests/fixtures/wallet-mini.csv` al encabezado real de 12 columnas (`account;category;currency;amount;ref_currency_amount;type;payment_type;note;date;transfer;payee;labels`, `type`=`Gasto`, categorías `Seguro` y `Patente`) con datos inventados con `hash53` (:567); vista previa con `showPlanPreview`/`finishPlan`/`executePlan`; asignación de `recurrenteId` y `periodo`.
**Criterios de aceptación:**
- [ ] Reimportar el mismo CSV no duplica.
- [ ] Filas que coinciden con gastos Drivvo existentes se vinculan, no se insertan.
- [ ] Acepta `,`, `;` y tab, con y sin BOM. Con el CSV real, la vista previa da 55 de seguro + 16 de patente + 3 dudosas.
- [ ] Una fecha como `2025-07-01T00:13Z` queda en el período 2025-06.
- [ ] Las filas ajenas al auto (otras categorías) se ignoran y se informa la cantidad en la vista previa.
**Verificación:**
- [ ] `node tests/smoke.mjs` (casos con `wallet-mini.csv`: "import Wallet", "reimport no duplica", "match Drivvo se vincula")
- [ ] Revisión manual: en iPhone, la vista previa lista cada fila con su acción (nueva / vinculada / ignorada).
**Dependencias:** T3.1, T2.2, T0.2
**Archivos probables:** `index.html` (:897, :1099, :1701), `tests/smoke.mjs`
**Tamaño:** M

## T3.3: Vincular gastos de seguro de Drivvo al recurrente  [🔒]
**Agente / Modelo:** Frontend Developer / Sonnet
**Descripción:** Acción única ("Vincular pagos anteriores") que recorre los gastos "Seguro Automotor" ya importados de Drivvo (:933) y les asigna `recurrenteId` y `periodo` según su fecha, con vista previa. Es idempotente y no cambia montos.
**Criterios de aceptación:**
- [ ] Muestra cuántos gastos se vinculan antes de confirmar.
- [ ] Correrla dos veces no cambia nada la segunda vez.
- [ ] Los montos y fechas originales quedan intactos.
**Verificación:**
- [ ] `node tests/smoke.mjs` (caso: "vincular Drivvo es idempotente")
- [ ] Revisión manual: en iPhone, el historial del seguro (T2.5) muestra los pagos anteriores.
**Dependencias:** T3.2
**Archivos probables:** `index.html`
**Tamaño:** S

## Checkpoint S3
- [ ] `node tests/smoke.mjs` en verde
- [ ] code-reviewer (Opus) sin hallazgos altos
- [ ] Bryan importa su CSV real de Wallet y confirma que no hay duplicados ni faltantes
- [ ] Push a GitHub Pages + forzar recarga por caché del service worker

---

# S4 · Seguridad

## T4.1: Auditoría de seguridad completa  [⇄]
**Agente / Modelo:** security-auditor / Opus
**Descripción:** Auditar `index.html`, `firestore.rules` y la configuración de Firebase/Pages: XSS (uso de `esc`, `innerHTML`), importaciones, reglas, CDN, claves expuestas, service worker. Entregar `tasks/security-report.md` priorizado (alto/medio/bajo) sin modificar código.
**Criterios de aceptación:**
- [ ] Cada hallazgo tiene severidad, ubicación (archivo:línea) y arreglo sugerido.
- [ ] Confirma o descarta los riesgos conocidos: CDN de Tailwind (:10), falta de CSP, reglas sin validación, `Object.assign` sin lista blanca (:1080).
**Verificación:**
- [ ] `node tests/smoke.mjs` (no cambia; auditoría solamente)
- [ ] Revisión manual: Bryan lee el resumen ejecutivo del informe.
**Dependencias:** Ninguna
**Archivos probables:** `tasks/security-report.md`
**Tamaño:** M

## T4.2: Quitar el CDN de Tailwind  [🔒]
**Agente / Modelo:** Frontend Developer / Haiku
**Descripción:** Eliminar `<script src="https://cdn.tailwindcss.com">` (:10) y reemplazar las clases de utilidad realmente usadas por CSS propio en el `<style>` del archivo. Inventariar primero las clases (grep) y comparar capturas antes y después. Se marca 🔒 aunque el plan original lo daba como ⇄, porque edita `index.html`.
**Criterios de aceptación:**
- [ ] No queda ninguna request a `cdn.tailwindcss.com`.
- [ ] La app se ve igual en las pantallas principales (comparación con capturas).
- [ ] El smoke test no registra errores de consola.
**Verificación:**
- [ ] `node tests/smoke.mjs` (caso nuevo: "ninguna request a dominios de terceros salvo Firebase/gstatic")
- [ ] Revisión manual: en iPhone, recorrer Resumen, Vencimientos, Gastos y Ajustes buscando cambios de estilo.
**Dependencias:** T4.1
**Archivos probables:** `index.html`, `tests/smoke.mjs`
**Tamaño:** M

## T4.3: Content-Security-Policy  [🔒]
**Agente / Modelo:** Frontend Developer / Sonnet
**Descripción:** Agregar una CSP en un `<meta http-equiv>` con `script-src` limitado a `'self'` y gstatic (más lo que Firebase necesite para conectar: `connect-src`), `object-src 'none'`, `base-uri 'self'`. Probar en demo y en producción. Requiere T4.2 (sin CDN) y que no queden handlers inline que la CSP rompa; si los hay, migrarlos.
**Criterios de aceptación:**
- [ ] La CSP está activa y la consola no reporta violaciones en las pantallas principales.
- [ ] El inicio de sesión y la sincronización con Firebase funcionan.
- [ ] Documentado el valor anterior para poder revertir.
**Verificación:**
- [ ] `node tests/smoke.mjs` (caso: "sin violaciones de CSP en consola")
- [ ] Revisión manual: en iPhone, iniciar sesión, cargar un gasto y verlo sincronizado.
**Dependencias:** T4.2
**Archivos probables:** `index.html`
**Tamaño:** M

## T4.4: Reglas de Firestore con validación  [⇄]
**Agente / Modelo:** security-auditor / Sonnet
**Descripción:** Reescribir `firestore.rules` con validación de forma y tamaño de los documentos (gastos, ajustes, recurrentes), tipos y rangos, y límites de tamaño. Redactar una guía paso a paso para que Bryan publique las reglas en la consola de Firebase, con una prueba rápida de que la app sigue escribiendo.
**Criterios de aceptación:**
- [ ] Las reglas rechazan un gasto con tipos incorrectos o campos enormes.
- [ ] Las reglas aceptan todo lo que genera la app hoy (gastos, ajustes, recurrentes).
- [ ] La guía para Bryan tiene menos de 10 pasos.
**Verificación:**
- [ ] `node tests/smoke.mjs` (no cubre reglas: se prueban en el simulador de reglas de la consola)
- [ ] Revisión manual: Bryan publica las reglas y registra un gasto de prueba en iPhone.
**Dependencias:** T2.2, T4.1
**Archivos probables:** `firestore.rules`
**Tamaño:** M

## T4.5: Lista blanca en la importación JSON  [🔒]
**Agente / Modelo:** Frontend Developer / Sonnet
**Descripción:** En `executePlan` (:1071) reemplazar `Object.assign(patch, plan.settings)` (:1080) por una copia con lista blanca de claves de configuración y validación de tipos (fechas ISO, números en rango, textos acotados). Ignorar y reportar en la vista previa las claves desconocidas.
**Criterios de aceptación:**
- [ ] Un JSON con una clave no permitida no la escribe en los ajustes.
- [ ] Un JSON con tipos inválidos se rechaza o se corrige con aviso.
- [ ] Un respaldo legítimo exportado por la app se importa completo.
**Verificación:**
- [ ] `node tests/smoke.mjs` (casos: "JSON con clave desconocida se ignora", "respaldo legítimo importa completo")
- [ ] Revisión manual: en iPhone, importar el respaldo propio y comprobar que todo vuelve igual.
**Dependencias:** T2.2
**Archivos probables:** `index.html` (:1071), `tests/smoke.mjs`, `tests/fixtures/`
**Tamaño:** S

## Checkpoint S4
- [ ] `node tests/smoke.mjs` en verde
- [ ] code-reviewer (Opus) sin hallazgos altos
- [ ] Informe de seguridad sin hallazgos altos abiertos
- [ ] Bryan publicó las reglas de Firestore y verificó que escribe
- [ ] Push a GitHub Pages + forzar recarga por caché del service worker

---

# S5 · UX y operatividad

## T5.1: Deshacer un borrado  [🔒]
**Agente / Modelo:** Frontend Developer / Sonnet
**Descripción:** Al borrar un gasto, recurrente o ítem, mostrar un toast de 5 s con "Deshacer" que restaura el documento exacto (mismo ID). Reemplaza la fricción del `confirmDialog` en borrados simples sin quitar la confirmación en acciones masivas.
**Criterios de aceptación:**
- [ ] Borrar y tocar "Deshacer" dentro de 5 s restaura el gasto con el mismo ID y los contadores correctos.
- [ ] Pasados 5 s el borrado queda firme.
- [ ] Deshacer no duplica el registro.
**Verificación:**
- [ ] `node tests/smoke.mjs` (caso: "borrar y deshacer restaura el gasto")
- [ ] Revisión manual: en iPhone, el toast se alcanza con el pulgar y no tapa la barra inferior.
**Dependencias:** T1.7
**Archivos probables:** `index.html`
**Tamaño:** S

## T5.2: Confirmar escrituras con error visible  [🔒]
**Agente / Modelo:** Frontend Developer / Sonnet
**Descripción:** Hoy `fire` (:719) lanza la escritura y solo informa si falla de inmediato. Hacer que las escrituras esperen la confirmación del servidor (indicador "guardando…/guardado") y que un fallo o una escritura pendiente por falta de conexión sea visible (estado persistente, no solo un toast), usando `state.pending` (:723).
**Criterios de aceptación:**
- [ ] Sin conexión, la app muestra "pendiente de sincronizar" hasta que vuelva.
- [ ] Un error de permisos de Firestore muestra un mensaje claro y persistente.
- [ ] En el caso normal no agrega demoras perceptibles.
**Verificación:**
- [ ] `node tests/smoke.mjs` (caso: "error de escritura simulado muestra estado de error")
- [ ] Revisión manual: en iPhone en modo avión, cargar un gasto y ver el aviso; al reconectar, ver que sincroniza.
**Dependencias:** T4.3
**Archivos probables:** `index.html` (:719)
**Tamaño:** M

## T5.3: Estimar km actuales y acción "actualizar km"  [🔒]
**Agente / Modelo:** Frontend Developer / Sonnet
**Descripción:** Calcular km/día de los últimos 90 días a partir de las cargas y proyectar los km actuales cuando no hay cargas recientes; mostrar el valor como "estimado" y ofrecer una acción rápida "actualizar km" (un campo, un toque) que lo corrige. Las alertas por km usan el km estimado.
**Criterios de aceptación:**
- [ ] Con cargas de los últimos 90 días, el km estimado es coherente con el ritmo (tolerancia ±5 % en el demo).
- [ ] Sin datos suficientes, no inventa: pide actualizar.
- [ ] La acción "actualizar km" es un solo campo y se guarda en un toque.
**Verificación:**
- [ ] `node tests/smoke.mjs` (caso: "km estimado con fecha simulada")
- [ ] Revisión manual: en iPhone, el valor se marca como estimado y la acción es obvia.
**Dependencias:** T1.5
**Archivos probables:** `index.html`, `tests/smoke.mjs`
**Tamaño:** M

## T5.4: README, textos y nombre del respaldo  [⇄]
**Agente / Modelo:** Technical Writer / Haiku
**Descripción:** Actualizar `README.md` con las funciones nuevas (catálogo, recurrentes, importador Wallet, harness) y los textos de la app en voseo. Renombrar el respaldo a `garage-radar-backup-AAAA-MM-DD.json` (:1095): es un cambio de una línea en `index.html` (🔒 solo esa línea; el resto es ⇄). El plan original lo marcó ⇄, pero la línea de `index.html` obliga a hacerlo sin otra tarea 🔒 en paralelo.
**Criterios de aceptación:**
- [ ] El README describe cómo correr `node tests/smoke.mjs`.
- [ ] El respaldo se descarga como `garage-radar-backup-…`.
- [ ] La importación sigue aceptando respaldos con el nombre viejo `autolog-…`.
**Verificación:**
- [ ] `node tests/smoke.mjs` (caso: "nombre de respaldo garage-radar-")
- [ ] Revisión manual: Bryan lee el README y entiende cómo se importa su CSV.
**Dependencias:** T3.2
**Archivos probables:** `README.md`, `index.html` (:1095)
**Tamaño:** XS

## T5.5: Recorrido final de UX en móvil  [⇄]
**Agente / Modelo:** Evidence Collector / Sonnet
**Descripción:** Recorrer la app en viewport de iPhone (Playwright o simulador) y capturar cada pantalla: Resumen, Vencimientos, onboarding, registrar pago, historial, importación, Ajustes. Reportar problemas reproducibles con evidencia y dejar el checklist de UX para que Bryan apruebe. No modifica código.
**Criterios de aceptación:**
- [ ] Hay una captura por pantalla y un checklist con estado (ok / problema) y evidencia.
- [ ] Cada problema tiene pasos para reproducir.
- [ ] Se marca lo no probado explícitamente.
**Verificación:**
- [ ] `node tests/smoke.mjs` (sin cambios; recorrido visual)
- [ ] Revisión manual: Bryan recorre el checklist en su iPhone y lo aprueba.
**Dependencias:** T5.1, T5.2, T5.3, T5.4
**Archivos probables:** `tasks/ux-checklist.md`, `tasks/screenshots/`
**Tamaño:** S

## Checkpoint S5
- [ ] `node tests/smoke.mjs` en verde
- [ ] code-reviewer (Opus) sin hallazgos altos
- [ ] Bryan aprueba el checklist de UX en iPhone
- [ ] Push a GitHub Pages + forzar recarga por caché del service worker
- [ ] Respaldo JSON final exportado y guardado
