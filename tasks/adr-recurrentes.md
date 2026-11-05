# ADR: modelo de pagos recurrentes (seguro y patente)

- **Estado:** aceptado (T2.1, sprint S2, 05/11/2026)
- **Contexto:** `tasks/plan.md` → "Formato CSV de Wallet" y "Decisiones de Bryan".
- **Respuesta de Bryan (05/11/2026):** la patente se paga de forma **irregular**. Cada pago carga la fecha del próximo vencimiento, prellenada a **+2 meses** y editable. Cambiar el modo o los meses sugeridos es un ajuste del recurrente, no del código.

## 1. Dónde se guarda

Los recurrentes van en el documento de ajustes, en `settings.recurrentes` (un mapa `id → recurrente`). No se crea una colección nueva.

Por qué:
- `exportBackup` solo serializa `settings`, `refuels` y `expenses`. `buildJsonPlan` exige `version: 1`. Con otra colección, el respaldo perdería los recurrentes o habría que subir la versión del formato.
- El almacén en memoria del demo (`createMemoryStore`) tiene colecciones fijas. Agregar una implica tocar las dos implementaciones y la suscripción.
- Son uno o dos documentos chicos. `saveSettings` ya hace merge profundo (`deepMerge` en memoria, `setDoc(..., { merge: true })` en Firestore).

**Desvío del todo.md:** T2.2 decía "agregar el store y la suscripción". No hace falta, porque la suscripción a `settings` ya existe. Queda anotado en el todo.

## 2. Modelo

```js
settings.recurrentes.seguro = {
  id: 'seguro',              // un recurrente por tipo: id = tipo ('seguro' | 'patente')
  nombre: 'Seguro',
  tipo: 'seguro',            // 'seguro' | 'patente'
  modo: 'mensual',           // 'mensual' (día fijo) | 'manual' (próximo vencimiento cargado en cada pago)
  diaVencimiento: 10,        // 1..31; solo en modo mensual. En meses cortos se usa el último día (31 → 28/02)
  desde: '2026-11',          // primer período que se controla (YYYY-MM). Los anteriores no generan "vencido"
  proximo: null,             // solo en modo manual: fecha ISO del próximo vencimiento
  mesesSugeridos: 2,         // solo en modo manual: cuánto se prellena el próximo vencimiento (+2 meses por defecto)
  montoEstimado: 63000,      // opcional; si hay pagos, se precarga el último pago
  aseguradora: '',           // opcional (texto libre, ≤ 60)
  poliza: '',                // opcional (texto libre, ≤ 40)
  inicioPoliza: '2026-01',   // opcional (YYYY-MM): desde cuándo se mide el ajuste "de esta póliza"
  activo: true               // false: sale de las alertas, el historial queda
}
```

Por ahora la app ofrece un seguro y una patente (un auto). El `id` existe para no atarse a esto más adelante.

**Valores por defecto al dar de alta:**

| Tipo | modo | Otros valores |
|---|---|---|
| Seguro | mensual | día = el de hoy, `desde` = mes actual |
| Patente | manual | `proximo` = hoy + 2 meses, `mesesSugeridos` = 2 |

## 3. Pagos

Cada pago es un **gasto** (`expenses`) de categoría `TRAMITES` con estos campos extra:

| Campo | Valor | Para qué |
|---|---|---|
| `recurrenteId` | `'seguro'` / `'patente'` | Vincula el gasto al recurrente |
| `periodo` | `'YYYY-MM'` | Primer período que paga |
| `cubre` | entero 1..12 (por defecto 1) | Cuántos períodos consecutivos cubre |
| `clase` | `'cuota'` / `'ajuste'` | `ajuste` = diferencia de póliza, recargo, etc. Suma al gasto, **no cubre períodos** y no entra en la variación |
| `variacionPct` | número con 1 decimal, o ausente | Variación de la cuota respecto de la cuota anterior, guardada al registrar el pago |

**Variación % (criterio "sin recalcular a mano"):** se calcula una vez, al guardar, y queda en `variacionPct`. La fórmula compara **montos por cuota**: `monto / cubre` contra la cuota `clase: 'cuota'` anterior (por `periodo`, y a igual período, por fecha). El historial recalcula la serie para el gráfico, pero la lista muestra el valor guardado.

**Pagos anteriores al S2:** el commit 15ff551 ya guardaba `vencimientoId: 'seguro'` en los gastos que se registraban desde la alerta. Esos gastos cuentan como pagos del recurrente `seguro`, con `periodo` igual al mes de su fecha y `cubre` = 1. No se reescriben los documentos. Lo mismo vale al restaurar un respaldo JSON viejo: `vencimientoId: 'seguro'` se conserva y se interpreta así.

**Monto precargado:** es el del último pago del recurrente (`clase: 'cuota'`). Si todavía no hay ninguno, se usa el último gasto cuyo tipo coincide (`/seguro/` o `/patente|impuesto automotor/`), por ejemplo "Seguro Automotor" importado de Drivvo. Si tampoco hay, se usa `montoEstimado`.

## 4. Estado de un período

### Modo mensual (seguro)

1. Los **períodos cubiertos** son la unión de `[periodo, periodo + cubre − 1]` de los pagos `clase: 'cuota'`.
2. El **próximo período a pagar** (P) es el primero que no está cubierto, empezando en `desde`.
3. El **vencimiento de P** (V) es el día `diaVencimiento` de P, o el último día del mes si ese mes es más corto.
4. El estado se calcula así, con `hoy` como fecha local y `días` = V − hoy:
   - **Vencido** (rojo): `días < 0`.
   - **Pendiente** (amarillo): `días ≥ 0` y (P ≤ mes actual o `días ≤ 7`).
   - **Al día** (verde): en cualquier otro caso. La alerta muestra el próximo vencimiento.

Al registrar un pago, el formulario propone **P** como período, no el mes de la fecha del pago. Así, pagar octubre tarde (el 5/11) cubre octubre, y el próximo pasa a noviembre.

**Ejemplos** (seguro con día 10, `desde` = 2026-10):

| Hoy | Pagos (`periodo` × `cubre`) | P | V | Estado |
|---|---|---|---|---|
| 05/11/2026 | 2026-10 | 2026-11 | 10/11 | Pendiente (vence en 5 días) |
| 12/11/2026 | 2026-10 | 2026-11 | 10/11 | Vencido (hace 2 días) |
| 05/11/2026 | 2026-10, 2026-11 | 2026-12 | 10/12 | Al día (35 días) |
| 05/11/2026 | ninguno | 2026-10 | 10/10 | Vencido (hace 26 días) |
| 03/12/2026 | 2026-10, 2026-11 | 2026-12 | 10/12 | Pendiente (7 días; P = mes actual) |
| 28/01/2027 | …, 2027-01 | 2027-02 | 10/02 | Al día (13 días) |
| Día 31, en febrero | — | 2027-02 | 28/02 | (último día del mes) |

### Modo manual (patente)

- V = `proximo`. Vencido si `días < 0`. Pendiente si `días ≤ 15`. Al día en el resto. Sin `proximo` no hay alerta, y la tarjeta de Ajustes pide la fecha.
- Al registrar un pago, el formulario propone `periodo` = mes de `proximo` (o el mes de hoy si no hay fecha) y "Próximo vencimiento" = `proximo + mesesSugeridos` (si no hay `proximo`, hoy + `mesesSugeridos`). Es editable y tiene que ser posterior a la fecha del pago. Al guardar, se actualiza `proximo`.

### Recurrentes inactivos

`activo: false` no genera alerta. El historial y los gastos quedan.

## 5. Casos reales de Wallet

- **jul-2022, un pago = 2 cuotas ($7.896 = 2 × $3.948):** un gasto con `periodo: '2022-07'` y `cubre: 2`. Cubre julio y agosto. La cuota para la variación es $3.948, y el gráfico muestra $3.948 en los dos meses.
- **feb-2023, cuota + "Diferencia póliza" ($1.333):** dos gastos con `periodo: '2023-02'`. Uno es `clase: 'cuota'` y el otro `clase: 'ajuste'`. El ajuste suma al gasto mensual, pero no cubre febrero dos veces, no dispara el aviso de período duplicado y no entra en la variación.
- **Meses sin pago (seguro):** si un mes anterior a `desde` no tiene pago, no pasa nada. Si después de `desde` hay un mes sin pago, aparece vencido. Bryan puede registrar el pago con su período real o mover `desde` en Ajustes.
- **Patente con huecos de 8 meses:** como está en modo manual, el hueco no genera vencidos falsos. Solo cuenta la fecha `proximo` cargada en el último pago. El pago anual de sep-2024 ($23.067) se carga con un `proximo` un año después.
- **Dos pagos de patente el mismo día (abr-2022):** dos gastos con el mismo `periodo`. El segundo dispara el aviso de período duplicado. Bryan confirma, o lo carga como `cubre: 2` o como `clase: 'ajuste'`.

## 6. Aviso de período duplicado

Antes de guardar un pago `clase: 'cuota'`, si otro pago `clase: 'cuota'` del mismo recurrente ya cubre alguno de los períodos que cubriría el nuevo, se muestra un `confirmDialog` con el período y el monto existente. Si se cancela, no se guarda. Al editar un pago, el propio gasto no cuenta como duplicado.

## 7. Migración de la fecha `seguro`

`seguro` sale de `DATE_ALERTS`. La migración es pura, es un paso aparte dentro de `migrateSettings` (su parche se combina con el de neumáticos) y queda marcada en `migraciones.seguroRecurrente`.

| Situación | Resultado |
|---|---|
| `migraciones.seguroRecurrente` ya está | Nada (idempotente) |
| Ya existe `recurrentes.seguro` (alta manual o respaldo) | Solo se marca la bandera |
| `vencimientos.seguro` tiene una fecha válida | Se crea `recurrentes.seguro` en modo mensual, con `diaVencimiento` = día de esa fecha, `desde` = su mes y `activo` = !`noAplica.seguro`. Se marca la bandera |
| No hay fecha | No se crea nada ni se marca la bandera, igual que en la migración de neumáticos: un respaldo viejo importado después todavía migra. Vencimientos y Resumen muestran la tarjeta "Agregá el seguro y la patente", que abre el alta |

- La migración **no borra** `vencimientos.seguro`, `noAplica.seguro` ni `pendientes.seguro`, por si hace falta volver atrás. Como `seguro` ya no está en `DATE_ALERTS`, ninguna pantalla lo vuelve a mostrar.
- La migración corre igual que la de neumáticos: en `startSession`, solo con un snapshot que no viene de caché, y en `executePlan` después de importar un respaldo.
- En producción, `migraciones.neumaticos3` ya está marcada desde S1. Por eso cada paso tiene su propia bandera, y el smoke cubre ese caso.

**Antes de publicar:** Bryan exporta un respaldo JSON (checkpoint S2).

## 8. Impacto en `firestore.rules`

No hace falta cambiar nada para que S2 funcione. `users/{uid}/{document=**}` ya cubre `settings/main` y `expenses`. **Para T4.4** (validación de forma y tamaño), hay que agregar:

- **`expenses`:**
  - `recurrenteId` es string de 1 a 40 caracteres.
  - `periodo` cumple `^\d{4}-\d{2}$`.
  - `cubre` es entero entre 1 y 12.
  - `clase` está en `['cuota', 'ajuste']`.
  - `variacionPct` es number.
- **`settings/main.recurrentes`:** un mapa de 4 entradas como máximo, donde cada valor cumple:
  - `tipo` en `['seguro', 'patente']`
  - `modo` en `['mensual', 'manual']`
  - `diaVencimiento` entero entre 1 y 31, o null
  - `desde` y `inicioPoliza` con el formato `YYYY-MM`, o null
  - `proximo` como fecha ISO, o null
  - strings de 60 caracteres como máximo
  - `activo` bool

## 9. Consecuencias

- Una sola fuente de verdad para "pagado": los gastos vinculados. Borrar el gasto deja el período otra vez pendiente.
- El ajuste acumulado (T2.5) compara la primera cuota con la última. Si hay `inicioPoliza`, también compara la primera cuota desde esa fecha con la última.
- S3 (importar Wallet y vincular Drivvo) solo tiene que asignar `recurrenteId`, `periodo`, `cubre` y `clase` a los gastos. El estado y el historial salen solos.
