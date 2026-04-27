# Auditoria de logica frontend

Fecha: 2026-04-25

## Decision

La reconstruccion React no debe heredar CSS ni estructura de `public/`. La version legacy sirve solo como evidencia funcional. Cualquier flujo recuperado debe implementarse desde cero con `frontend/src`, tokens actuales y componentes React.

## Corregido en React

- Se retiro el contador del header.
- Se retiraron accesos visibles sin contrato React completo: `Multidestino` y `Calendario`.
- Se conecto `Flexible`: solo ida envia `stay-range` con `departureStart/departureEnd`, ida y vuelta usa `/api/matrix` con `flexibleMode: "exact-stay"` y `stayNights`, con ampliacion opcional `-4/+4` dias.
- Se conecto `Migratorio`: usa origen/destino, genera 8 rangos mensuales desde el mes actual, lanza busquedas `stay-range` con concurrencia limitada y agrega la mejor tarifa de cada mes.
- La busqueda exacta ahora envia filtros backend para `maxStops`, `maxLayoverMinutes`, `baggageRequired` e `includedAirlineCodes` cuando aplican.
- La normalizacion de ofertas conserva datos operativos del backend: itinerarios, equipaje estructurado, estado/confianza de precio, `fareMeta`, advertencias y `purchasePaths`.
- Resultados muestra advertencias agregadas, llegada real del tramo de salida, equipaje normalizado y presencia de enlace de proveedor.
- Detalle muestra equipaje, asientos, fecha limite de emision, cambios/reembolso, advertencias, cotizacion y accion para abrir la ruta de compra registrada.

## Pendiente de reconstruir

- Calendario de matriz: requiere tipos `MatrixCell`, ejes, estados por celda y accion de reconsulta.
- `reprice`: endpoint y estado existen en el backend/legado, pero falta diseno React actual.
- Layout persistente de columnas: existe `/api/results-layout`, pero la tabla React aun usa columnas fijas.
