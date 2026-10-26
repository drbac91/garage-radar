# Garage Radar

Webapp privada (un solo `index.html`) para llevar consumo, gastos, mantenimiento y vencimientos de un vehículo bi-fuel (Nafta + GNC). Datos en Firestore, acceso solo con tu cuenta de Google, hosting en GitHub Pages.

## 1. Crear el proyecto en Firebase

1. Entrá a <https://console.firebase.google.com> → **Agregar proyecto** (podés desactivar Google Analytics).
2. En **Compilación → Authentication → Comenzar → Método de acceso**, habilitá **Google**.
3. En **Compilación → Firestore Database → Crear base de datos**. Elegí modo producción y una región cercana (p. ej. `southamerica-east1`).
4. En **Configuración del proyecto → Tus apps → Web (`</>`)** registrá una app y copiá el objeto `firebaseConfig`.

## 2. Pegar la configuración

En `index.html`, buscá la constante `FIREBASE_CONFIG` (al inicio del script) y reemplazá los valores `COMPLETAR_...` por `apiKey`, `authDomain`, `projectId` y `appId`.

> La configuración web de Firebase es pública por diseño: no es un secreto. Lo que protege tus datos son las **reglas de Firestore** (paso 4), la **restricción de la API key** (paso 5) y los **dominios autorizados** (paso 6).

## 3. Obtener tu UID

1. Publicá la app (paso 7) o abrila en `localhost` e ingresá una vez con Google. Si las reglas ya están publicadas verás un error de permisos: es esperable.
2. En **Authentication → Users** copiá el **User UID** de tu cuenta.

## 4. Publicar las reglas

1. En `firestore.rules` reemplazá `COMPLETAR_UID` por tu UID.
2. En **Firestore → Reglas** pegá el contenido y **Publicar** (o `firebase deploy --only firestore:rules` si usás la CLI).

Con esto solo tu UID puede leer o escribir en `users/<tu-uid>/**`; cualquier otra cuenta de Google queda bloqueada.

## 5. Restringir la API key

En <https://console.cloud.google.com/apis/credentials> → tu **Browser key** → *Restricciones de aplicaciones* → **Sitios web (referrers HTTP)** y agregá:

- `https://<tu-usuario>.github.io/*`
- `http://localhost/*` (opcional, solo para pruebas)

## 6. Dominio autorizado en Auth

En **Authentication → Configuración → Dominios autorizados** agregá `<tu-usuario>.github.io`.

## 7. Publicar en GitHub Pages

1. Creá un repositorio (sugerido: `garage-radar`) y subí `index.html`, `firestore.rules`, `README.md` y `.gitignore`.
2. **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`**.
3. Abrí `https://<tu-usuario>.github.io/garage-radar/`.

> **No subas el CSV de Drivvo ni tus respaldos JSON**: contienen datos personales. El `.gitignore` ya los excluye.

## 8. Importar tu historial de Drivvo

1. Ingresá a la app y tocá **Importar Datos** en el pie de página.
2. Elegí el CSV exportado desde Drivvo.
3. Revisá la vista previa (cantidad por sección, rango de fechas, duplicados y filas rechazadas) y confirmá.

Reimportar el mismo archivo no duplica nada: los registros importados tienen IDs deterministas. Al terminar, la app deriva el último cambio de aceite y de bujías/cables desde el historial (editables en **Configurar**). La oblea de GNC, la prueba hidráulica, la VTV y el seguro los cargás vos en **Configurar**.

Mapeo aplicado:

| Drivvo | Garage Radar |
|---|---|
| Refuelling: GNC | Carga GNC |
| Refuelling: Nafta / Nafta Super / Nafta Premium | Carga NAFTA (el grado se guarda aparte) |
| Expense: VTV, Seguro Automotor, Registro, Impuestos | Trámites e Impuestos |
| Expense: Autopartes, Mano De Obra | Reparación / Taller |
| Expense: Lavadero, Peajes, Estacionamiento y otros | Otros |
| Service: aceite, filtros, bujías, cables, neumáticos (rotación, alineación, presión), líquidos, limpiaparabrisas, inspección, control de pérdidas GNC | Mantenimiento Preventivo |
| Service: el resto | Reparación / Taller |

Los ítems de un mismo service (misma fecha y odómetro) se muestran agrupados como un evento. La columna de eficiencia de Drivvo se ignora: la app recalcula con la regla de tanque lleno. La matrícula no se importa.

## Cálculos

- **Rendimiento**: entre dos cargas "tanque lleno" consecutivas del mismo combustible, km recorridos ÷ volumen de las cargas posteriores al primer lleno (parciales incluidas) hasta el segundo lleno. El histórico es suma de km ÷ suma de volúmenes. Se descartan tramos con km ≤ 0 o fuera de 3–30 km por unidad.
- **Costo por km**: (combustible + gastos) ÷ (odómetro máximo − mínimo).
- **Mix de uso (estimado)**: los km entre dos cargas se atribuyen al combustible de la carga más reciente del par.
- **Alertas**: fechas en rojo si vencieron, amarillo si faltan 30 días o menos; kilometraje en rojo si restan 0 km o menos, amarillo si restan 1.000 km o menos.

## Respaldo

Pie de página → **Exportar Copia de Seguridad (JSON)** descarga `autolog-backup-AAAA-MM-DD.json`. **Importar Datos** acepta ese JSON (con vista previa) o el CSV de Drivvo.

## Probar sin Firebase

Abrí la app en `localhost` o como archivo con `?demo=1` (por ejemplo `http://localhost:8000/index.html?demo=1`). Usa un almacén en memoria y no se activa en dominios de producción. Los datos se pierden al recargar.
