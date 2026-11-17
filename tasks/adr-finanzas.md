# ADR · Garage Radar integrado a Finanzas (borrador, 2026-11-16)

## Decisiones de Bryan (2026-11-16)

1. Finanzas es dueña de monto y cuenta; Garage no carga sin enviar.
2. Garage tiene su propio token de carga hacia Finanzas (no comparte la clave K del iPhone).
3. **Sin backfill**: los gastos viejos no se mandan. Todo rige de ahora en adelante (Finanzas arrancó en limpio). Se elimina F6 y el riesgo de doble carga histórica.

> Estado: **propuesta para decidir**. No se programó nada. Dos frentes independientes: (M) métricas honestas y (F) integración con Finanzas. M no depende de F y conviene hacerla primero.

4. **Flujo bidireccional** (2026-11-17): hay gastos del auto que Bryan va a cargar desde Finanzas/iPhone (seguro, peajes, posiblemente combustible) y no desde Garage. Entonces el canal tiene dos sentidos y la opción C (Finanzas → Garage) deja de estar descartada.

## 0. Qué hace hoy la app con las métricas (`derive()`, `index.html` ~985)

- **Costo por km** = (todo el combustible + todos los gastos) / (km máximo − km mínimo registrado). **Historial completo, en pesos nominales, sin ventana ni ajuste.** Un litro de 2023 y uno de hoy pesan igual en pesos, pero no valen lo mismo: el número queda contaminado por la inflación. Tenés razón.
- **Rendimiento (km/L)**: promedio de todos los tramos válidos de todo el historial. No lo afecta la inflación, pero sí el desgaste (un auto de 2 años atrás rendía distinto).
- **Mix NAFTA/GNC**: todo el historial.
- Lo único con ventana es el gráfico mensual (últimos 12 meses).

## 1. Principio: una sola carga, cada dato con un dueño

| Dato | Dueño | Por qué |
|---|---|---|
| Odómetro, litros, tipo de servicio, ítem del catálogo, vencimientos | Garage Radar | Finanzas no lo modela |
| Monto, cuenta/medio de pago, fecha de pago, cuotas, bonificaciones, categoría contable | Finanzas | Ya tiene ledger de partida doble, tarjetas, conciliación |

Garage Radar sigue siendo el único formulario del auto. Al guardar, emite **un evento** a Finanzas con `id` estable (el id del gasto). Finanzas ya es idempotente por `(origen, ref_externa)`: reenviar o editar no duplica.

## 2. Opciones de integración

- **A. Fusionar Garage Radar dentro de Finanzas.** Un solo producto, pero reescribe una PWA Firebase en Flask y hoy Garage funciona. Descartada por ahora (viola «lo más simple que cumple»).
- **B. Garage Radar → buzón cifrado de Finanzas (recomendada).** Mismo canal que ya usa el iPhone: sobre AES-GCM `tipo:"carga"` al Worker de Cloudflare, el servidor lo procesa como `origen='garage'`. Finanzas ya acepta cuenta, categoría, cuotas y compartido. Cambio en Finanzas: un adaptador chico que además guarda `odómetro/litros` como metadatos. Costo: Garage necesita la clave K → decisión de seguridad (ver §6).
- **C. Finanzas → Garage (lectura).** Finanzas es Tailscale-only; Garage vive en GitHub Pages/Firebase. Sin odómetro/litros del lado Finanzas no sirve como fuente. Descartada.

## 3. Medio de pago y reglas de tarjeta

- Campo nuevo en el gasto y en la carga de combustible: `cuenta` (lista de cuentas de Finanzas, copiada una vez a `settings`: Mercado Pago, Visa, efectivo…) y `cuotas`.
- **Dos fechas**: `fecha` del consumo (la usa el vehículo: km, rendimiento, costo por km) y la de caja (cuándo sale la plata) que la maneja Finanzas. Para tarjeta, Finanzas ya registra la cuota 1 «sin conciliar» y la concilia con el resumen mensual (adaptador Tarjetas), sin contarla dos veces. Garage **no** replica esa lógica; solo manda `cuenta` y `cuotas`.
- Sin cuenta elegida → el evento no se envía y el gasto queda «pendiente de enviar» (no se inventa una cuenta por defecto).

## 4. Bonificaciones (fase posterior, pero el modelo se deja listo)

- Un gasto puede tener `bonificacion` (monto, nota): descuento bancario o reintegro que llega después.
- Métricas del vehículo usan **monto neto** (bruto − bonificación). En Finanzas se registra como reintegro/ingreso contra la misma cuenta, ligado por `ref_externa`.
- Decisión abierta: ¿el reintegro llega el mismo mes o después (tarjeta)? Si es después, se carga como evento aparte que apunta al gasto original.

## 5. Métricas (frente M, independiente)

- **M1. Ventana.** Costo por km y rendimiento con selector: 3 / 6 / 12 meses / todo. Default **12 meses**. El km de la ventana sale del primer y último odómetro dentro de ella.
- **M2. Pesos reales.** Cada gasto se lleva a pesos del mes actual con el IPC acumulado (la tabla `inflacion` de Finanzas ya existe: `mes`, variación %). En Garage: tabla chica `ipc` en `settings`, cargada a mano o sincronizada desde Finanzas después. Mostrar siempre «nominal» al lado como referencia.
- **M3. Desglose.** Costo por km separado en combustible / mantenimiento / fijos (seguro, patente), porque el combustible se mueve con el precio y los fijos con el tiempo, no con los km.
- Check: con los datos reales de Bryan, el costo/km nominal histórico (~104) vs. real 12 meses debe mostrarse lado a lado y explicarse.

## 6. Riesgos y decisiones de seguridad

1. **Clave K en Garage.** K hoy vive en el Llavero/Face ID del iPhone de Finanzas. Dárselo a otra PWA amplía la superficie. Alternativa: token propio de Garage con permiso solo de «carga» y K distinta por dispositivo. A decidir antes de F2.
2. **Editar/borrar** un gasto ya enviado: hace falta evento `anula`/`corrige` por id (Finanzas ya anula transacciones). Si no, la plata queda dibujada en los dos lados.
3. **Doble carga histórica**: lo ya cargado en Garage (y lo que Bryan cargó a mano en Finanzas) no debe reenviarse. Backfill solo bajo demanda y con vista previa, o corte por fecha.
4. **Offline**: Garage ya tolera estar offline; los eventos van a una cola local y se reintentan (igual que la cola cifrada del iPhone).
5. Garage tiene un solo usuario por Firebase; Finanzas también. No se abre multiusuario.

## 7. Plan de nodos (cada uno: una salida, un check)

| # | Nodo | Check | Depende |
|---|---|---|---|
| M1 ✅ | Ventana temporal en `derive()` + selector | test en `smoke.mjs` con fixture de 24 meses | — |
| M2 ✅ | Pesos reales con tabla IPC | test: gasto de hace 12 m con IPC 100 % acumulado pesa el doble | M1 |
| M3 ✅ | Desglose por tipo de gasto | suma de partes = total | M1 |
| F0 | Token propio de Garage (permiso solo «carga», revocable) en el Worker | un token de Garage no puede leer ni usar el de iPhone | — |
| F1 | Campo `cuenta`/`cuotas` en formularios + lista de cuentas en settings | test: no guarda envío sin cuenta | F0 |
| F2 | Emisor de eventos con cola offline e id estable | test: reenviar no duplica; sin red queda pendiente | F1 |
| F3 | Adaptador `garage` en Finanzas (+ metadatos odómetro/litros) | `verificar` de Finanzas vacío, Σ = 0, tarjeta no cuenta doble | F2 |
| F4 | Editar/anular propaga | test de ciclo crear→editar→borrar | F3 |
| F5 | Bonificaciones y métricas netas | test: neto = bruto − bonif. | F3 |

Orden sugerido: **M1–M3 ya** (valor inmediato, sin tocar Finanzas), después F0 y F1–F3 como un sprint, y F4–F5 después.

## 8. Preguntas abiertas para Bryan

1. ¿Querés que Finanzas sea siempre el dueño de monto y cuenta (recomendado), o que Garage pueda cargar sin enviar nada?
2. ¿Aceptás que Garage tenga su propia clave/token de carga hacia Finanzas?
3. ¿Los gastos viejos de Garage se mandan a Finanzas (backfill) o Finanzas arranca limpia del 1/12 y Garage solo manda desde ahí? (Finanzas tiene arranque limpio el 2026-12-01.)

## 9. Bidireccional (agregado 2026-11-17)

**Regla central:** cada movimiento tiene un `id` global y un `origen` (`garage` | `finanzas`). Gana el origen para editar/anular; el destino guarda `ref_externa = id` y **nunca devuelve un evento a quien lo originó** (sin eco, sin lazos).

- **Finanzas → Garage**: una categoría de Finanzas se marca «vehículo» (árbol Auto: seguro, patente, peajes, estacionamiento, lavadero, combustible…) con su mapeo a las categorías de Garage (PREVENTIVO/REPARACION/TRAMITES/OTROS) y, si corresponde, a un recurrente (seguro, patente). Al conciliar un movimiento de esas categorías, Finanzas emite un evento al buzón de salida; Garage lo trae y lo guarda como gasto con `origen:'finanzas'`.
- **Combustible cargado desde Finanzas**: llega sin odómetro ni litros. Cuenta para el costo por km, pero no para el rendimiento, y Garage lo marca «completar carga» para que Bryan agregue odómetro y litros después (eso vuelve a Finanzas como `corrige` solo con metadatos, sin cambiar el monto).
- **Seguro/patente pagados desde Finanzas**: el evento trae el recurrente y el período; Garage lo registra como pago de ese período (la alerta pasa a «al día») sin pedir nada.
- **Transporte de ida y vuelta**: el mismo Worker con dos buzones, `garage→finanzas` y `finanzas→garage`, con el token propio de Garage (F0). Garage descifra lo suyo; no hay credenciales de Firestore en Finanzas.
- **Nuevos riesgos**: un gasto del mismo hecho cargado en los dos lados (ej. peaje cargado en Garage y en Finanzas) → al guardar un gasto de categoría vehículo en Finanzas se avisa si ya hay uno parecido en los últimos días (misma fecha/monto) y se propone vincular en vez de duplicar. Orden de llegada y reintentos: idempotencia por `id`.

### Nodos nuevos
| # | Nodo | Check | Depende |
|---|---|---|---|
| B1 | Marcar categorías «vehículo» en Finanzas + mapeo a categorías/recurrentes de Garage | test: movimiento de peaje → evento con categoría Garage correcta | F0 |
| B2 | Buzón de salida finanzas→garage en el Worker, cifrado con el token de Garage | Garage no lee nada que no sea suyo | F0 |
| B3 | Garage importa eventos de Finanzas (idempotente, sin eco) | reimportar no duplica; no re-emite | F2, B2 |
| B4 | Pago de recurrente desde Finanzas marca el período | alerta de seguro pasa a «al día» | B3 |
| B5 | Combustible sin odómetro/litros: «completar carga» y `corrige` de metadatos | rendimiento no cuenta el tramo hasta completarlo | B3 |
| B6 | Aviso de posible duplicado entre lados | test: mismo monto y fecha ±1 día propone vincular | B3 |
