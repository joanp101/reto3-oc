# Conocimiento del proceso: Órdenes de Compra SAP

Este documento describe el conocimiento de negocio del proceso de compras en Periferia (basado en el PRD del Reto 03).

## 1. Fuentes del paquete de entrada (`fixtures/reto-03/solicitudes/<caso>/`)

- `correo.json`: metadatos del correo de solicitud (`id`, `de`, `asunto`, `fecha`, `cuerpo`, `adjuntos[]`).
- `solicitud.json`: solicitud normalizada (`solicitud_id`, `solicitante`, `proveedor_nombre`, `proveedor_nit?`, `descripcion`, `centro_costo`, `subarea`, `cantidad`, `valor_unitario`, `valor_total`, `moneda`, `indicador_iva?`, `condiciones_pago?`, `fecha_solicitud`).
- `cotizacion.txt`: cotización del proveedor (proveedor, NIT, ítems, subtotal, IVA, total, validez).
- `aprobacion.json`: correo de aprobación del líder (`de`, `para`, `fecha`, `asunto`, `cuerpo`).
- `factura.txt`: presente únicamente en casos retroactivos (cuando la factura llegó antes de crear la OC).

## 2. Maestros (`fixtures/reto-03/maestros/`)

- `proveedores.json`: `codigo_sap`, `nit`, `nombre`, `condiciones_pago_default`, `indicador_iva_default`, `activo`.
- `centros-costo.json`: `centro_costo`, `subareas[]`, `aprobadores: [{ email, tope }]`.
- `indicadores-iva.json`: `codigo`, `descripcion`, `tasa`.
- `condiciones-pago.json`: `codigo`, `descripcion`, `dias`.

## 3. Reglas de control (RC1–RC10)

| Código | Regla | Efecto |
|---|---|---|
| RC1 | Proveedor existe en `proveedores.json` (por NIT o nombre normalizado) y `activo = true`. | Bloqueo |
| RC2 | Aprobación existe, contiene `"Aprobado"` y proviene de un aprobador listado en el `centro_costo`. | Bloqueo |
| RC3 | `valor_total <= tope` del aprobador en ese `centro_costo`. | Bloqueo |
| RC4 | `subarea` pertenece al `centro_costo`. | Bloqueo |
| RC5 | `abs(cotizacion.total - solicitud.valor_total) / solicitud.valor_total <= 0.02`. Si excede o falta cotización. | Confirmación |
| RC6 | `indicador_iva` ausente: se deriva de `indicador_iva_default` del proveedor. | Confirmación + derivado |
| RC7 | `condiciones_pago` ausente: se deriva de `condiciones_pago_default` del proveedor y se informa. | Derivado |
| RC8 | Existe `factura` con `fecha < fecha_solicitud`: marca `retroactiva = true` y se registra en `out/control.csv`. | Confirmación |
| RC9 | `aprobacion.fecha >= solicitud.fecha_solicitud`; si es anterior. | Confirmación |
| RC10 | `abs(cantidad * valor_unitario - valor_total) <= 1`. | Bloqueo |

## 4. Salidas y auditoría (`out/`)

- `out/<caso>/trazabilidad.json`: origen de cada campo del payload (`solicitud`, `cotizacion`, `maestro.<nombre>`, `derivado`).
- `out/<caso>/aprobacion.txt`: evidencia del correo de aprobación con encabezados, cuerpo y hash `sha256`.
- `out/sap/ordenes.jsonl`: registro secuencial de órdenes creadas (inicia en `4500000001`, idempotente por `solicitud_id`).
- `out/control.csv`: trazabilidad de todos los intentos (`solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts`).
- `out/log.jsonl`: bitácora de llamadas a herramientas del agente.
