import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { MockSapAdapter } from "../sap/mock.js";

/**
 * Contexto de ejecución recibido por cada herramienta (PRD 6.2).
 */
export interface ToolContext {
  directory: string;
  sessionId: string;
}

/**
 * Contrato genérico de herramienta (PRD 6.2).
 */
export interface ToolDefinition<TShape extends z.ZodRawShape> {
  description: string;
  args: TShape;
  execute: (args: z.infer<z.ZodObject<TShape>>, ctx: ToolContext) => Promise<string>;
}

// ============================================================================
// Esquemas Zod según PRD 7.1, 7.2 y 7.4 (cada campo con .describe())
// ============================================================================

export const CorreoSchema = z.object({
  id: z.string().min(1).describe("Identificador único del correo electrónico de solicitud."),
  de: z.string().min(1).describe("Dirección de correo del remitente de la solicitud."),
  asunto: z.string().describe("Asunto del correo electrónico de solicitud."),
  fecha: z.string().min(1).describe("Fecha del correo de solicitud en formato ISO o YYYY-MM-DD."),
});

export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1).describe("Identificador único de la solicitud de compra (ej. sol-001)."),
  solicitante: z.string().min(1).describe("Nombre o correo de quien solicita la compra."),
  proveedor_nombre: z.string().min(1).describe("Razón social o nombre del proveedor en la solicitud."),
  proveedor_nit: z.string().optional().describe("NIT del proveedor si viene informado en la solicitud."),
  descripcion: z.string().min(1).describe("Descripción del bien o servicio solicitado."),
  centro_costo: z.string().min(1).describe("Código del centro de costos al que se imputa el gasto."),
  subarea: z.string().min(1).describe("Subárea perteneciente al centro de costos."),
  cantidad: z.number().describe("Cantidad solicitada del bien o servicio."),
  valor_unitario: z.number().describe("Valor unitario antes de impuestos según la solicitud."),
  valor_total: z.number().describe("Valor total de la solicitud."),
  moneda: z.string().min(1).describe("Código de moneda de la solicitud (ej. COP o USD)."),
  indicador_iva: z.string().optional().describe("Código de indicador de IVA si viene informado en la solicitud."),
  condiciones_pago: z.string().optional().describe("Código de condiciones de pago si viene informado en la solicitud."),
  fecha_solicitud: z.string().min(1).describe("Fecha de la solicitud de compra (YYYY-MM-DD)."),
});

export const CotizacionSchema = z.object({
  proveedor: z.string().describe("Nombre del proveedor extraído de la cotización."),
  nit: z.string().nullable().describe("NIT del proveedor en la cotización o null si no aparece."),
  total: z.number().describe("Valor total informado en la cotización."),
  moneda: z.string().describe("Moneda indicada en la cotización (ej. COP o USD)."),
  validez_hasta: z.string().nullable().describe("Fecha límite de validez de la cotización o null si no figura."),
  texto: z.string().describe("Contenido textual completo de la cotización."),
});

export const AprobacionSchema = z.object({
  de: z.string().describe("Correo del líder que envía la aprobación."),
  fecha: z.string().describe("Fecha del correo de aprobación."),
  aprobado: z.boolean().describe("Indica si el cuerpo del correo contiene aprobación explícita."),
  texto: z.string().describe("Texto completo del cuerpo del correo de aprobación."),
});

export const FacturaSchema = z.object({
  numero: z.string().describe("Número de la factura recibida."),
  fecha: z.string().describe("Fecha de emisión de la factura."),
  total: z.number().describe("Valor total registrado en la factura."),
});

export const PaqueteSchema = z.object({
  correo: CorreoSchema.describe("Datos normalizados del correo de entrada."),
  solicitud: SolicitudSchema.describe("Datos normalizados de la solicitud de compra."),
  cotizacion: CotizacionSchema.nullable().describe("Datos normalizados de la cotización o null si falta."),
  aprobacion: AprobacionSchema.nullable().describe("Datos normalizados del correo de aprobación o null si falta."),
  factura: FacturaSchema.nullable().describe("Datos normalizados de la factura si existe, o null."),
  faltantes: z
    .array(z.string().describe("Nombre del archivo adjunto ausente en el paquete."))
    .optional()
    .describe("Lista de adjuntos esperados que no estuvieron presentes en el paquete."),
});

export const DerivadosSchema = z.object({
  codigo_sap: z.string().optional().describe("Código SAP del proveedor resuelto desde el maestro."),
  nit: z.string().optional().describe("NIT del proveedor resuelto o confirmado desde el maestro."),
  proveedor_nombre: z.string().optional().describe("Nombre oficial del proveedor en el maestro SAP."),
  indicador_iva: z.string().optional().describe("Indicador de IVA derivado desde el maestro del proveedor."),
  condiciones_pago: z.string().optional().describe("Condiciones de pago derivadas desde el maestro del proveedor."),
  moneda: z.enum(["COP", "USD"]).optional().describe("Moneda normalizada para la orden de compra."),
  unidad: z.enum(["UN", "H", "MES"]).optional().describe("Unidad de medida asignada a la posición."),
});

export const OrdenCompraReferenciaSchema = z.object({
  solicitud_id: z.string().min(1).describe("Identificador de la solicitud de origen."),
  correo_id: z.string().min(1).describe("Identificador del correo de origen."),
  cotizacion_ref: z.string().nullable().describe("Referencia o validez de la cotización, o null si no existe."),
});

export const OrdenCompraProveedorSchema = z.object({
  codigo_sap: z.string().min(1).describe("Código SAP del proveedor en el maestro."),
  nit: z.string().min(1).describe("NIT del proveedor."),
  nombre: z.string().min(1).describe("Razón social del proveedor."),
});

export const OrdenCompraAprobadorSchema = z.object({
  email: z.string().min(1).describe("Correo electrónico del aprobador autorizado."),
  fecha_aprobacion: z.string().min(1).describe("Fecha del correo de aprobación."),
  evidencia_sha256: z.string().min(1).describe("Hash SHA-256 del archivo de evidencia de aprobación."),
});

export const OrdenCompraPosicionSchema = z.object({
  numero: z.number().int().positive().describe("Número secuencial de posición en SAP (10, 20, 30...)."),
  descripcion: z.string().min(1).max(40).describe("Texto breve de la posición en SAP (máximo 40 caracteres)."),
  cantidad: z.number().positive().describe("Cantidad a comprar en la posición."),
  unidad: z.enum(["UN", "H", "MES"]).describe("Unidad de medida SAP de la posición."),
  precio_unitario: z.number().nonnegative().describe("Precio unitario de la posición."),
  centro_costo: z.string().min(1).describe("Centro de costos imputado a la posición."),
  subarea: z.string().min(1).describe("Subárea imputada dentro del centro de costos."),
  indicador_iva: z.string().min(1).describe("Código del indicador de IVA aplicado (ej. C1)."),
});

export const OrdenCompraExcepcionSchema = z.object({
  codigo: z.string().min(1).describe("Código de la regla o excepción controlada (ej. RC5, RC8)."),
  detalle: z.string().min(1).describe("Descripción legible de la excepción detectada."),
  confirmado_por: z.string().nullable().describe("Identificador de quien confirmó la excepción o null si no aplica."),
});

export const OrdenCompraSchema = z.object({
  referencia: OrdenCompraReferenciaSchema.describe("Referencias documentales que originan la orden de compra."),
  sociedad: z.literal("1000").describe("Código de sociedad SAP fijo en '1000'."),
  organizacion_compras: z.literal("1000").describe("Código de organización de compras SAP fijo en '1000'."),
  proveedor: OrdenCompraProveedorSchema.describe("Datos maestros del proveedor para la orden de compra."),
  moneda: z.enum(["COP", "USD"]).describe("Moneda de la orden de compra (COP o USD)."),
  condiciones_pago: z.string().min(1).describe("Código SAP de condiciones de pago (ej. Z030)."),
  aprobador: OrdenCompraAprobadorSchema.describe("Datos del aprobador y hash de la evidencia."),
  posiciones: z
    .array(OrdenCompraPosicionSchema.describe("Línea individual de la orden de compra."))
    .min(1)
    .describe("Lista de posiciones de la orden de compra."),
  excepciones: z
    .array(OrdenCompraExcepcionSchema.describe("Excepción registrada durante las validaciones."))
    .describe("Lista de excepciones o confirmaciones asociadas a la orden."),
});

export type Correo = z.infer<typeof CorreoSchema>;
export type Solicitud = z.infer<typeof SolicitudSchema>;
export type Cotizacion = z.infer<typeof CotizacionSchema>;
export type Aprobacion = z.infer<typeof AprobacionSchema>;
export type Factura = z.infer<typeof FacturaSchema>;
export type Paquete = z.infer<typeof PaqueteSchema>;
export type Derivados = z.infer<typeof DerivadosSchema>;
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>;

// ============================================================================
// Helpers internos para oc_leer_paquete
// ============================================================================

const CorreoArchivoSchema = z.object({
  id: z.string().min(1),
  de: z.string().min(1),
  asunto: z.string().default(""),
  fecha: z.string().min(1),
  cuerpo: z.string().optional(),
  adjuntos: z.array(z.string()).optional(),
});

const AprobacionArchivoSchema = z.object({
  de: z.string().min(1),
  para: z.string().optional(),
  fecha: z.string().min(1),
  asunto: z.string().optional(),
  cuerpo: z.string(),
});

function okJson(data: unknown): string {
  return JSON.stringify({ ok: true, data });
}

function errorJson(error: string): string {
  return JSON.stringify({ ok: false, error });
}

function resolveSafeCaseDir(projectDir: string, caso: string): string | null {
  const trimmed = caso.trim();
  if (!trimmed || trimmed.includes("..") || path.isAbsolute(trimmed) || /[\\/]/.test(trimmed)) {
    return null;
  }
  const baseDir = path.resolve(projectDir, "fixtures", "reto-03", "solicitudes");
  const targetDir = path.resolve(baseDir, trimmed);
  if (!targetDir.startsWith(baseDir + path.sep)) {
    return null;
  }
  return targetDir;
}

function parseLocaleNumber(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,-]/g, "").trim();
  if (!cleaned) return null;

  // Si tiene tanto puntos como comas, asume que el último separador puede ser decimal si tiene <=2 dígitos.
  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");
  let normalized = cleaned;

  if (lastDot !== -1 && lastComma !== -1) {
    if (lastComma > lastDot) {
      normalized = cleaned.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = cleaned.replace(/,/g, "");
    }
  } else if (lastComma !== -1) {
    const decimals = cleaned.length - lastComma - 1;
    normalized = decimals <= 2 ? cleaned.replace(",", ".") : cleaned.replace(/,/g, "");
  } else if (lastDot !== -1) {
    const parts = cleaned.split(".");
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) {
      normalized = cleaned.replace(/\./g, "");
    }
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractField(text: string, labels: string[]): string | null {
  for (const label of labels) {
    // Admite un calificativo entre paréntesis antes de ":" (ej. "TOTAL (IVA incluido): COP 11.400.000").
    const regex = new RegExp(`^\\s*${label}\\s*(?:\\([^)]*\\))?\\s*[:\\-]\\s*(.+)$`, "im");
    const match = text.match(regex);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

function parseCotizacionText(texto: string): { ok: true; value: Cotizacion } | { ok: false; error: string } {
  const proveedor = extractField(texto, ["proveedor", "raz[oó]n\\s+social", "empresa"]) ?? "Desconocido";
  const nit = extractField(texto, ["nit", "rut", "identificaci[oó]n"]);
  const totalRaw = extractField(texto, ["total\\s+general", "valor\\s+total", "total"]);
  const monedaRaw = extractField(texto, ["moneda", "divisa"]);
  const validez = extractField(texto, ["validez_hasta", "validez\\s+hasta", "v[aá]lida\\s+hasta", "validez"]);

  if (!totalRaw) {
    return { ok: false, error: "cotizacion.txt no contiene una línea de Total identificable." };
  }

  const total = parseLocaleNumber(totalRaw);
  if (total === null) {
    return { ok: false, error: `cotizacion.txt tiene un total no numérico: "${totalRaw}".` };
  }

  let moneda = monedaRaw?.toUpperCase() ?? "";
  if (!moneda) {
    if (/\bUSD\b/i.test(texto) || /\bUSD\b/i.test(totalRaw)) {
      moneda = "USD";
    } else {
      moneda = "COP";
    }
  }

  return {
    ok: true,
    value: {
      proveedor,
      nit,
      total,
      moneda,
      validez_hasta: validez,
      texto,
    },
  };
}

function parseFacturaText(texto: string): { ok: true; value: Factura } | { ok: false; error: string } {
  const numero =
    /^\s*FACTURA\b.*?\bNo\.?\s*([A-Z0-9][A-Z0-9\-\/]*)/im.exec(texto)?.[1] ??
    extractField(texto, ["n[uú]mero\\s+de\\s+factura", "factura\\s*(?:no\\.?|n[uú]mero|#)", "n[uú]mero"]) ??
    "SIN-NUMERO";
  const fecha = extractField(texto, ["fecha\\s+de\\s+emisi[oó]n", "fecha\\s+factura", "fecha"]);
  const totalRaw = extractField(texto, ["valor\\s+total", "total\\s+a\\s+pagar", "total"]);

  if (!fecha) {
    return { ok: false, error: "factura.txt no contiene una fecha identificable." };
  }
  if (!totalRaw) {
    return { ok: false, error: "factura.txt no contiene un valor total identificable." };
  }

  const total = parseLocaleNumber(totalRaw);
  if (total === null) {
    return { ok: false, error: `factura.txt tiene un total no numérico: "${totalRaw}".` };
  }

  return {
    ok: true,
    value: {
      numero,
      fecha,
      total,
    },
  };
}

async function readFileIfExists(filePath: string): Promise<{ exists: boolean; content?: string; error?: string }> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return { exists: true, content };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { exists: false };
    }
    const message = err instanceof Error ? err.message : "Error desconocido al leer archivo";
    return { exists: false, error: message };
  }
}

// ============================================================================
// Maestros y reglas de control RC1–RC10 (PRD 7.3)
// ============================================================================

const ProveedorMaestroSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
});
const CentroCostoMaestroSchema = z.object({
  centro_costo: z.string(),
  subareas: z.array(z.string()),
  aprobadores: z.array(z.object({ email: z.string(), tope: z.number() })),
});
const CodigoMaestroSchema = z.object({ codigo: z.string(), descripcion: z.string() });

export type ProveedorMaestro = z.infer<typeof ProveedorMaestroSchema>;
type CentroCostoMaestro = z.infer<typeof CentroCostoMaestroSchema>;

export interface Maestros {
  proveedores: ProveedorMaestro[];
  centros: CentroCostoMaestro[];
  iva: Array<z.infer<typeof CodigoMaestroSchema>>;
  pagos: Array<z.infer<typeof CodigoMaestroSchema>>;
}

async function leerMaestro<T>(directory: string, archivo: string, schema: z.ZodType<T>): Promise<T[]> {
  const ruta = path.resolve(directory, "fixtures", "reto-03", "maestros", archivo);
  const parsed = z.array(schema).safeParse(JSON.parse(await fs.readFile(ruta, "utf8")));
  if (!parsed.success) throw new Error(`Maestro ${archivo} malformado: ${parsed.error.message}`);
  return parsed.data;
}

export async function cargarMaestros(directory: string): Promise<Maestros> {
  return {
    proveedores: await leerMaestro(directory, "proveedores.json", ProveedorMaestroSchema),
    centros: await leerMaestro(directory, "centros-costo.json", CentroCostoMaestroSchema),
    iva: await leerMaestro(directory, "indicadores-iva.json", CodigoMaestroSchema),
    pagos: await leerMaestro(directory, "condiciones-pago.json", CodigoMaestroSchema),
  };
}

/** "900.555.111-2" -> "900555111" (sin puntos ni dígito de verificación). */
export function normalizarNit(nit: string): string {
  return nit.split("-")[0].replace(/\D/g, "");
}

function normalizarNombre(nombre: string): string {
  return nombre.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function fechaIso(valor: string): string | null {
  return /^(\d{4}-\d{2}-\d{2})/.exec(valor.trim())?.[1] ?? null;
}

export function formatearMonto(valor: number, moneda: string): string {
  const [entero, decimales] = String(Math.abs(valor)).split(".");
  const agrupado = entero.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${moneda} ${valor < 0 ? "-" : ""}${agrupado}${decimales ? `,${decimales}` : ""}`;
}

export interface Hallazgo {
  codigo: string;
  detalle: string;
  accion_sugerida: string;
}

export interface ResultadoValidacion {
  apta: boolean;
  bloqueos: Hallazgo[];
  confirmaciones: Hallazgo[];
  derivados: Derivados;
  retroactiva: boolean;
}

interface ContextoValidacion {
  proveedor: ProveedorMaestro | null;
  centro: CentroCostoMaestro | null;
}

const TOLERANCIA_RC5_PCT = 2;

export function validarPaquete(paquete: Paquete, m: Maestros): ResultadoValidacion & { contexto: ContextoValidacion } {
  const sol = paquete.solicitud;
  const bloqueos: Hallazgo[] = [];
  const confirmaciones: Hallazgo[] = [];
  const derivados: Derivados = {};
  const monto = (v: number) => formatearMonto(v, sol.moneda);

  // RC1 — proveedor por NIT; si no hay NIT, por nombre normalizado. Debe estar activo.
  let proveedor: ProveedorMaestro | null = null;
  if (sol.proveedor_nit) {
    const nit = normalizarNit(sol.proveedor_nit);
    proveedor = m.proveedores.find((p) => normalizarNit(p.nit) === nit) ?? null;
    if (!proveedor) {
      bloqueos.push({
        codigo: "RC1",
        detalle: `El proveedor "${sol.proveedor_nombre}" (NIT ${nit}) no existe en el maestro de proveedores.`,
        accion_sugerida: "Solicitar la creación del proveedor en el maestro de SAP o corregir el NIT en la solicitud, y reprocesar.",
      });
    }
  } else {
    const nombre = normalizarNombre(sol.proveedor_nombre);
    proveedor = m.proveedores.find((p) => normalizarNombre(p.nombre) === nombre) ?? null;
    if (!proveedor) {
      bloqueos.push({
        codigo: "RC1",
        detalle: `La solicitud no trae NIT y el nombre "${sol.proveedor_nombre}" no coincide con ningún proveedor del maestro.`,
        accion_sugerida: "Pedir al solicitante el NIT del proveedor o registrar el proveedor en SAP.",
      });
    }
  }
  if (proveedor && !proveedor.activo) {
    bloqueos.push({
      codigo: "RC1",
      detalle: `El proveedor ${proveedor.nombre} (NIT ${proveedor.nit}) está inactivo en el maestro.`,
      accion_sugerida: "Solicitar la reactivación del proveedor en SAP o usar un proveedor activo.",
    });
  }

  // RC4 — subárea pertenece al centro de costo.
  const centro = m.centros.find((c) => c.centro_costo.trim().toUpperCase() === sol.centro_costo.trim().toUpperCase()) ?? null;
  if (!centro) {
    bloqueos.push({
      codigo: "RC4",
      detalle: `El centro de costo ${sol.centro_costo} no existe en el maestro.`,
      accion_sugerida: "Corregir el centro de costo con el solicitante.",
    });
  } else if (!centro.subareas.some((s) => normalizarNombre(s) === normalizarNombre(sol.subarea))) {
    bloqueos.push({
      codigo: "RC4",
      detalle: `La subárea "${sol.subarea}" no pertenece a ${centro.centro_costo} (subáreas: ${centro.subareas.join(", ")}).`,
      accion_sugerida: "Corregir la subárea o el centro de costo con el solicitante.",
    });
  }

  // RC2 — aprobación existe, contiene "Aprobado" y viene de un aprobador del centro.
  const aprob = paquete.aprobacion;
  const emailAprobador = aprob ? (/<([^>]+)>/.exec(aprob.de)?.[1] ?? aprob.de).trim().toLowerCase() : null;
  const aprobador = centro?.aprobadores.find((a) => a.email.toLowerCase() === emailAprobador) ?? null;
  if (!aprob) {
    bloqueos.push({
      codigo: "RC2",
      detalle: "El paquete no trae correo de aprobación.",
      accion_sugerida: "Solicitar al líder el correo de aprobación.",
    });
  } else if (!aprob.aprobado) {
    bloqueos.push({
      codigo: "RC2",
      detalle: `El correo de ${aprob.de} no contiene la palabra "Aprobado".`,
      accion_sugerida: "Solicitar al líder una aprobación explícita.",
    });
  } else if (centro && !aprobador) {
    const otros = m.centros.filter((c) => c.aprobadores.some((a) => a.email.toLowerCase() === emailAprobador));
    bloqueos.push({
      codigo: "RC2",
      detalle:
        `${aprob.de} no es aprobador de ${centro.centro_costo} (aprobadores: ${centro.aprobadores.map((a) => a.email).join(", ")})` +
        (otros.length ? `; sí lo es de ${otros.map((c) => c.centro_costo).join(", ")}.` : "."),
      accion_sugerida: `Obtener la aprobación de un aprobador de ${centro.centro_costo} o confirmar con el solicitante el centro de costo correcto.`,
    });
  }

  // RC3 — valor_total ≤ tope del aprobador en ese centro.
  if (centro) {
    const topeMax = Math.max(0, ...centro.aprobadores.map((a) => a.tope));
    if (aprobador && sol.valor_total > aprobador.tope) {
      bloqueos.push({
        codigo: "RC3",
        detalle: `El valor ${monto(sol.valor_total)} supera el tope de ${aprobador.email} en ${centro.centro_costo} (${monto(aprobador.tope)}).`,
        accion_sugerida: "Obtener la aprobación de un aprobador con tope suficiente o escalar.",
      });
    } else if (!aprobador && sol.valor_total > topeMax) {
      bloqueos.push({
        codigo: "RC3",
        detalle: `El valor ${monto(sol.valor_total)} supera el tope de todos los aprobadores de ${centro.centro_costo} (máximo ${monto(topeMax)}).`,
        accion_sugerida: `Escalar la aprobación o actualizar la matriz de aprobación de ${centro.centro_costo}.`,
      });
    }
  }

  // RC10 — cantidad × valor_unitario = valor_total (± 1).
  const calculado = sol.cantidad * sol.valor_unitario;
  if (Math.abs(calculado - sol.valor_total) > 1) {
    bloqueos.push({
      codigo: "RC10",
      detalle: `${sol.cantidad} × ${monto(sol.valor_unitario)} = ${monto(calculado)} no coincide con el valor total ${monto(sol.valor_total)}.`,
      accion_sugerida: "Corregir cantidad, valor unitario o valor total en la solicitud.",
    });
  }

  // RC5 — cotización vs solicitud (tolerancia 2 %).
  const cot = paquete.cotizacion;
  if (!cot) {
    confirmaciones.push({
      codigo: "RC5",
      detalle: "No hay cotización; no es posible contrastar el valor de la solicitud.",
      accion_sugerida: "Confirmar la creación sin cotización o pedir la cotización al solicitante.",
    });
  } else if (cot.moneda.toUpperCase() !== sol.moneda.toUpperCase()) {
    confirmaciones.push({
      codigo: "RC5",
      detalle: `La cotización está en ${cot.moneda} y la solicitud en ${sol.moneda}; no son comparables.`,
      accion_sugerida: "Confirmar la moneda con el solicitante.",
    });
  } else {
    const diferencia = Math.abs(cot.total - sol.valor_total);
    if (diferencia * 100 > TOLERANCIA_RC5_PCT * sol.valor_total) {
      const pct = sol.valor_total === 0 ? "∞" : ((diferencia / sol.valor_total) * 100).toFixed(2).replace(".", ",");
      confirmaciones.push({
        codigo: "RC5",
        detalle: `Solicitud ${monto(sol.valor_total)} vs cotización ${monto(cot.total)}: diferencia ${monto(diferencia)} (${pct} %), supera la tolerancia del ${TOLERANCIA_RC5_PCT} %.`,
        accion_sugerida: `Confirmar la OC por el valor de la solicitud (${monto(sol.valor_total)}) o pedir que se actualice la solicitud y su aprobación.`,
      });
    }
  }

  // RC6 — indicador de IVA ausente: se deriva del proveedor y se confirma.
  if (!sol.indicador_iva) {
    if (proveedor) {
      derivados.indicador_iva = proveedor.indicador_iva_default;
      const desc = m.iva.find((i) => i.codigo === proveedor?.indicador_iva_default)?.descripcion ?? "sin descripción en maestro";
      confirmaciones.push({
        codigo: "RC6",
        detalle: `La solicitud no informa indicador de IVA; se deriva ${proveedor.indicador_iva_default} (${desc}) del proveedor ${proveedor.nombre}.`,
        accion_sugerida: `Confirmar que el indicador ${proveedor.indicador_iva_default} es correcto para esta compra.`,
      });
    } else {
      confirmaciones.push({
        codigo: "RC6",
        detalle: "La solicitud no informa indicador de IVA y no se puede derivar (proveedor no identificado).",
        accion_sugerida: "Pedir al solicitante el indicador de IVA.",
      });
    }
  }

  // RC7 — condiciones de pago ausentes: se derivan del proveedor (solo se informa).
  if (!sol.condiciones_pago && proveedor) {
    derivados.condiciones_pago = proveedor.condiciones_pago_default;
  }

  // RC8 — factura anterior a la solicitud: retroactiva.
  const fechaSol = fechaIso(sol.fecha_solicitud);
  let retroactiva = false;
  if (paquete.factura) {
    const fechaFac = fechaIso(paquete.factura.fecha);
    if (fechaFac && fechaSol && fechaFac < fechaSol) {
      retroactiva = true;
      confirmaciones.push({
        codigo: "RC8",
        detalle: `La factura ${paquete.factura.numero} (${fechaFac}) es anterior a la solicitud (${fechaSol}): OC retroactiva.`,
        accion_sugerida: "Confirmar la creación de la OC retroactiva; quedará marcada retroactiva = true en el log de control.",
      });
    }
  }

  // RC9 — fecha de aprobación ≥ fecha de solicitud.
  if (aprob) {
    const fechaAprob = fechaIso(aprob.fecha);
    if (fechaAprob && fechaSol && fechaAprob < fechaSol) {
      confirmaciones.push({
        codigo: "RC9",
        detalle: `La aprobación (${fechaAprob}) es anterior a la solicitud (${fechaSol}).`,
        accion_sugerida: "Confirmar que la aprobación corresponde a esta solicitud o pedir una aprobación posterior.",
      });
    }
  }

  return {
    apta: bloqueos.length === 0,
    bloqueos,
    confirmaciones,
    derivados,
    retroactiva,
    contexto: { proveedor, centro },
  };
}

// ============================================================================
// Evidencia, payload y trazabilidad (PRD 7.4, HU-3, HU-4)
// ============================================================================

type Resultado<T> = { ok: true; value: T } | { ok: false; error: string };

function rutaRelativa(directory: string, absoluta: string): string {
  return path.relative(directory, absoluta).split(path.sep).join("/");
}

function resolverDirSalida(directory: string, caso: string): string | null {
  return resolveSafeCaseDir(directory, caso) ? path.resolve(directory, "out", caso.trim()) : null;
}

async function leerAprobacionArchivo(
  directory: string,
  caso: string,
): Promise<Resultado<z.infer<typeof AprobacionArchivoSchema>>> {
  const caseDir = resolveSafeCaseDir(directory, caso);
  if (!caseDir) return { ok: false, error: `Nombre de caso inválido: "${caso}".` };
  const archivo = await readFileIfExists(path.join(caseDir, "aprobacion.json"));
  if (!archivo.exists || archivo.content === undefined) {
    return { ok: false, error: `El caso "${caso}" no tiene aprobacion.json; no hay evidencia que generar.` };
  }
  try {
    const parsed = AprobacionArchivoSchema.safeParse(JSON.parse(archivo.content));
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, error: `aprobacion.json no cumple el esquema: ${parsed.error.message}` };
  } catch {
    return { ok: false, error: `aprobacion.json malformado en "${caso}".` };
  }
}

/** Contenido determinista de la evidencia (sin timestamps) para que el sha256 sea estable. */
function contenidoEvidencia(a: z.infer<typeof AprobacionArchivoSchema>): string {
  return (
    `De: ${a.de}\nPara: ${a.para ?? "(no informado)"}\nFecha: ${a.fecha}\nAsunto: ${a.asunto ?? "(no informado)"}\n\n` +
    `${a.cuerpo}\n`
  );
}

function sha256(texto: string): string {
  return crypto.createHash("sha256").update(texto, "utf8").digest("hex");
}

async function escribirEvidencia(directory: string, caso: string): Promise<Resultado<{ ruta: string; sha256: string }>> {
  const aprob = await leerAprobacionArchivo(directory, caso);
  if (!aprob.ok) return aprob;
  const outDir = resolverDirSalida(directory, caso);
  if (!outDir) return { ok: false, error: `Nombre de caso inválido: "${caso}".` };
  const contenido = contenidoEvidencia(aprob.value);
  const hash = sha256(contenido);
  const ruta = path.join(outDir, "aprobacion.txt");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(ruta, `${contenido}\nsha256 (contenido anterior, UTF-8): ${hash}\n`, "utf8");
  return { ok: true, value: { ruta: rutaRelativa(directory, ruta), sha256: hash } };
}

function truncar40(texto: string): string {
  let salida = "";
  for (const ch of Array.from(texto.normalize("NFC"))) {
    if ((salida + ch).length > 40) break;
    salida += ch;
  }
  return salida.trimEnd();
}

/** Unidad: "<cantidad> horas" -> H, "<cantidad> meses" -> MES en la descripción; si no, UN. */
function derivarUnidad(descripcion: string, cantidad: number): { unidad: "UN" | "H" | "MES"; nota: string } {
  for (const m of descripcion.matchAll(/(\d[\d.,]*)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ]+)/g)) {
    if (parseLocaleNumber(m[1]) !== cantidad) continue;
    const palabra = normalizarNombre(m[2]);
    if (/^horas?$/.test(palabra)) return { unidad: "H", nota: `"${m[0]}" en solicitud.descripcion` };
    if (/^mes(es)?$/.test(palabra)) return { unidad: "MES", nota: `"${m[0]}" en solicitud.descripcion` };
    return { unidad: "UN", nota: `"${m[0]}" en solicitud.descripcion` };
  }
  return { unidad: "UN", nota: "la solicitud no indica unidad de medida; se usa UN" };
}

interface Traza {
  valor: string | number | null;
  fuente: string;
  campo: string;
  nota?: string;
}

interface OrdenConstruida {
  orden: OrdenCompra;
  trazabilidad: Record<string, Traza>;
  validacion: ResultadoValidacion;
}

function construirOrden(
  paquete: Paquete,
  derivadosRecibidos: Derivados,
  maestros: Maestros,
  evidenciaSha256: string,
): Resultado<OrdenConstruida> {
  const v = validarPaquete(paquete, maestros);
  if (!v.apta) {
    const resumen = v.bloqueos.map((b) => `${b.codigo}: ${b.detalle}`).join(" | ");
    return { ok: false, error: `No se construye el payload: el caso tiene bloqueos. ${resumen}` };
  }
  for (const clave of ["indicador_iva", "condiciones_pago"] as const) {
    const recibido = derivadosRecibidos[clave];
    if (recibido !== undefined && recibido !== v.derivados[clave]) {
      return {
        ok: false,
        error: `derivados.${clave} = "${recibido}" no coincide con lo derivado del maestro (${v.derivados[clave] ?? "no aplica"}). Use los derivados de oc_validar.`,
      };
    }
  }
  const sol = paquete.solicitud;
  const proveedor = v.contexto.proveedor;
  const centro = v.contexto.centro;
  const aprob = paquete.aprobacion;
  if (!proveedor || !centro || !aprob) {
    return { ok: false, error: "No se pudo resolver proveedor, centro de costo o aprobación." };
  }
  const moneda = sol.moneda.trim().toUpperCase();
  if (moneda !== "COP" && moneda !== "USD") {
    return { ok: false, error: `Moneda "${sol.moneda}" no soportada (solo COP o USD).` };
  }
  const indicadorIva = sol.indicador_iva ?? v.derivados.indicador_iva;
  const condicionesPago = sol.condiciones_pago ?? v.derivados.condiciones_pago;
  if (!indicadorIva || !condicionesPago) {
    return { ok: false, error: "Falta indicador de IVA o condiciones de pago y no se pudieron derivar." };
  }
  const cotizacionRef = paquete.cotizacion
    ? (/^\s*COTIZACI[OÓoó]N\s+([A-Z0-9][A-Z0-9\-\/]*)/m.exec(paquete.cotizacion.texto)?.[1] ?? null)
    : null;
  const descripcion = truncar40(sol.descripcion);
  const { unidad, nota: notaUnidad } = derivarUnidad(sol.descripcion, sol.cantidad);
  const porNit = sol.proveedor_nit ? `identificado por NIT ${normalizarNit(sol.proveedor_nit)}` : "identificado por nombre normalizado (la solicitud no trae NIT)";
  const subarea = centro.subareas.find((s) => normalizarNombre(s) === normalizarNombre(sol.subarea)) ?? sol.subarea;

  const orden: OrdenCompra = {
    referencia: { solicitud_id: sol.solicitud_id, correo_id: paquete.correo.id, cotizacion_ref: cotizacionRef },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: proveedor.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre },
    moneda,
    condiciones_pago: condicionesPago,
    aprobador: { email: aprob.de, fecha_aprobacion: aprob.fecha, evidencia_sha256: evidenciaSha256 },
    posiciones: [
      {
        numero: 10,
        descripcion,
        cantidad: sol.cantidad,
        unidad,
        precio_unitario: sol.valor_unitario,
        centro_costo: centro.centro_costo,
        subarea,
        indicador_iva: indicadorIva,
      },
    ],
    excepciones: v.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.detalle, confirmado_por: null })),
  };

  const desdeSolicitudODerivado = (campo: "indicador_iva" | "condiciones_pago", regla: string): Omit<Traza, "valor"> =>
    sol[campo]
      ? { fuente: "solicitud", campo }
      : { fuente: "derivado", campo, nota: `${regla}: ${campo}_default del proveedor ${proveedor.nombre} (maestro.proveedores)` };

  const t: Record<string, Traza> = {
    "referencia.solicitud_id": { valor: sol.solicitud_id, fuente: "solicitud", campo: "solicitud_id" },
    "referencia.correo_id": { valor: paquete.correo.id, fuente: "correo", campo: "id" },
    "referencia.cotizacion_ref": { valor: cotizacionRef, fuente: "cotizacion", campo: "encabezado COTIZACIÓN" },
    sociedad: { valor: "1000", fuente: "constante", campo: "PRD 7.4" },
    organizacion_compras: { valor: "1000", fuente: "constante", campo: "PRD 7.4" },
    "proveedor.codigo_sap": { valor: proveedor.codigo_sap, fuente: "maestro.proveedores", campo: "codigo_sap", nota: porNit },
    "proveedor.nit": { valor: proveedor.nit, fuente: "maestro.proveedores", campo: "nit", nota: porNit },
    "proveedor.nombre": { valor: proveedor.nombre, fuente: "maestro.proveedores", campo: "nombre", nota: porNit },
    moneda: { valor: moneda, fuente: "solicitud", campo: "moneda" },
    condiciones_pago: { valor: condicionesPago, ...desdeSolicitudODerivado("condiciones_pago", "RC7") },
    "aprobador.email": { valor: aprob.de, fuente: "aprobacion", campo: "de", nota: `aprobador de ${centro.centro_costo} en maestro.centros-costo (RC2)` },
    "aprobador.fecha_aprobacion": { valor: aprob.fecha, fuente: "aprobacion", campo: "fecha" },
    "aprobador.evidencia_sha256": { valor: evidenciaSha256, fuente: "derivado", campo: "sha256", nota: "sha256 del contenido de out/<caso>/aprobacion.txt" },
    "posiciones[0].numero": { valor: 10, fuente: "derivado", campo: "numero", nota: "primera posición (numeración SAP de 10 en 10)" },
    "posiciones[0].descripcion": {
      valor: descripcion,
      fuente: "solicitud",
      campo: "descripcion",
      ...(descripcion !== sol.descripcion ? { nota: `truncada a 40 caracteres (original: ${Array.from(sol.descripcion).length})` } : {}),
    },
    "posiciones[0].cantidad": { valor: sol.cantidad, fuente: "solicitud", campo: "cantidad" },
    "posiciones[0].unidad": { valor: unidad, fuente: "derivado", campo: "unidad", nota: notaUnidad },
    "posiciones[0].precio_unitario": { valor: sol.valor_unitario, fuente: "solicitud", campo: "valor_unitario" },
    "posiciones[0].centro_costo": { valor: centro.centro_costo, fuente: "solicitud", campo: "centro_costo", nota: "validado en maestro.centros-costo" },
    "posiciones[0].subarea": { valor: subarea, fuente: "solicitud", campo: "subarea", nota: "validada en maestro.centros-costo (RC4)" },
    "posiciones[0].indicador_iva": { valor: indicadorIva, ...desdeSolicitudODerivado("indicador_iva", "RC6") },
  };
  orden.excepciones.forEach((e, i) => {
    t[`excepciones[${i}].codigo`] = { valor: e.codigo, fuente: "derivado", campo: "oc_validar" };
    t[`excepciones[${i}].detalle`] = { valor: e.detalle, fuente: "derivado", campo: "oc_validar" };
    t[`excepciones[${i}].confirmado_por`] = { valor: null, fuente: "derivado", campo: "oc_crear", nota: "se completa al crear con confirmado=true" };
  });

  const validada = OrdenCompraSchema.safeParse(orden);
  if (!validada.success) {
    return { ok: false, error: `El payload no cumple el esquema OrdenCompra: ${validada.error.message}` };
  }
  const { contexto: _contexto, ...validacion } = v;
  return { ok: true, value: { orden: validada.data, trazabilidad: t, validacion } };
}

/** Releé el caso desde fixtures y reconstruye la orden esperada (fuente de verdad para oc_crear). */
async function reconstruirCaso(
  directory: string,
  caso: string,
): Promise<Resultado<{ paquete: Paquete; validacion: ResultadoValidacion; orden: Resultado<OrdenConstruida> }>> {
  const leido = JSON.parse(await leer_paquete.execute({ caso }, { directory, sessionId: "interno" })) as
    | { ok: true; data: Paquete }
    | { ok: false; error: string };
  if (!leido.ok) return { ok: false, error: leido.error };
  const maestros = await cargarMaestros(directory);
  const { contexto: _contexto, ...validacion } = validarPaquete(leido.data, maestros);
  const aprob = await leerAprobacionArchivo(directory, caso);
  const orden: Resultado<OrdenConstruida> = aprob.ok
    ? construirOrden(leido.data, validacion.derivados, maestros, sha256(contenidoEvidencia(aprob.value)))
    : { ok: false, error: aprob.error };
  return { ok: true, value: { paquete: leido.data, validacion, orden } };
}

function diferencias(a: unknown, b: unknown, ruta = ""): string[] {
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const claves = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...claves].flatMap((k) =>
      diferencias((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], ruta ? `${ruta}.${k}` : k),
    );
  }
  return a === b ? [] : [`${ruta}: recibido ${JSON.stringify(a)}, esperado ${JSON.stringify(b)}`];
}

const CONTROL_HEADER = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts";

function csv(valor: string): string {
  return /[",\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor;
}

async function registrarControl(
  directory: string,
  fila: { solicitud_id: string; resultado: string; numero_oc: string; validacion: ResultadoValidacion },
): Promise<void> {
  const ruta = path.resolve(directory, "out", "control.csv");
  await fs.mkdir(path.dirname(ruta), { recursive: true });
  const existe = await readFileIfExists(ruta);
  const linea = [
    fila.solicitud_id,
    fila.resultado,
    fila.numero_oc,
    String(fila.validacion.retroactiva),
    fila.validacion.bloqueos.map((b) => b.codigo).join("|"),
    fila.validacion.confirmaciones.map((c) => c.codigo).join("|"),
    new Date().toISOString(),
  ]
    .map(csv)
    .join(",");
  await fs.appendFile(ruta, `${existe.exists ? "" : `${CONTROL_HEADER}\n`}${linea}\n`, "utf8");
}

/** oc_crear se serializa en el proceso: idempotencia + numeración + log de control sin carreras. */
let colaCrear: Promise<unknown> = Promise.resolve();
function enSerieCrear<T>(tarea: () => Promise<T>): Promise<T> {
  const actual = colaCrear.then(tarea, tarea);
  colaCrear = actual.catch(() => undefined);
  return actual;
}

// ============================================================================
// Herramientas P0 (PRD 6.2) -> <archivo>_<export> = oc_<export>
// ============================================================================

export const leer_paquete: ToolDefinition<{
  caso: z.ZodString;
}> = {
  description: "Lee y normaliza el paquete completo de una solicitud de compra desde fixtures/reto-03/solicitudes/<caso>/.",
  args: {
    caso: z.string().min(1).describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/ (ej. sol-001)."),
  },
  async execute(args, ctx) {
    try {
      const parsedArgs = z.object(leer_paquete.args).safeParse(args);
      if (!parsedArgs.success) {
        return errorJson(`Argumentos inválidos para oc_leer_paquete: ${parsedArgs.error.message}`);
      }

      const caseDir = resolveSafeCaseDir(ctx.directory, parsedArgs.data.caso);
      if (!caseDir) {
        return errorJson(`Nombre de caso inválido: "${parsedArgs.data.caso}".`);
      }

      try {
        const stat = await fs.stat(caseDir);
        if (!stat.isDirectory()) {
          return errorJson(`La ruta del caso "${parsedArgs.data.caso}" no es una carpeta.`);
        }
      } catch {
        return errorJson(
          `No se encontró el caso "${parsedArgs.data.caso}" en fixtures/reto-03/solicitudes/.`,
        );
      }

      const faltantes: string[] = [];

      // 1. correo.json (obligatorio)
      const correoFile = await readFileIfExists(path.join(caseDir, "correo.json"));
      if (correoFile.error) {
        return errorJson(`No se pudo leer correo.json: ${correoFile.error}`);
      }
      if (!correoFile.exists || correoFile.content === undefined) {
        return errorJson(`Paquete incompleto en "${parsedArgs.data.caso}": falta correo.json.`);
      }

      let correoRaw: unknown;
      try {
        correoRaw = JSON.parse(correoFile.content);
      } catch {
        return errorJson(`correo.json malformado en "${parsedArgs.data.caso}".`);
      }
      const correoParsed = CorreoArchivoSchema.safeParse(correoRaw);
      if (!correoParsed.success) {
        return errorJson(`correo.json no cumple el esquema esperado: ${correoParsed.error.message}`);
      }

      // 2. solicitud.json (obligatorio)
      const solicitudFile = await readFileIfExists(path.join(caseDir, "solicitud.json"));
      if (solicitudFile.error) {
        return errorJson(`No se pudo leer solicitud.json: ${solicitudFile.error}`);
      }
      if (!solicitudFile.exists || solicitudFile.content === undefined) {
        return errorJson(`Paquete incompleto en "${parsedArgs.data.caso}": falta solicitud.json.`);
      }

      let solicitudRaw: unknown;
      try {
        solicitudRaw = JSON.parse(solicitudFile.content);
      } catch {
        return errorJson(`solicitud.json malformado en "${parsedArgs.data.caso}".`);
      }
      const solicitudParsed = SolicitudSchema.safeParse(solicitudRaw);
      if (!solicitudParsed.success) {
        return errorJson(`solicitud.json no cumple el esquema esperado: ${solicitudParsed.error.message}`);
      }

      // 3. cotizacion.txt (adjunto; si falta se reporta null y se lista en faltantes)
      let cotizacion: Cotizacion | null = null;
      const cotizacionFile = await readFileIfExists(path.join(caseDir, "cotizacion.txt"));
      if (cotizacionFile.error) {
        return errorJson(`No se pudo leer cotizacion.txt: ${cotizacionFile.error}`);
      }
      if (!cotizacionFile.exists || cotizacionFile.content === undefined) {
        faltantes.push("cotizacion.txt");
      } else {
        const parsedCot = parseCotizacionText(cotizacionFile.content);
        if (!parsedCot.ok) {
          return errorJson(parsedCot.error);
        }
        cotizacion = parsedCot.value;
      }

      // 4. aprobacion.json (adjunto; si falta se reporta null y se lista en faltantes)
      let aprobacion: Aprobacion | null = null;
      const aprobacionFile = await readFileIfExists(path.join(caseDir, "aprobacion.json"));
      if (aprobacionFile.error) {
        return errorJson(`No se pudo leer aprobacion.json: ${aprobacionFile.error}`);
      }
      if (!aprobacionFile.exists || aprobacionFile.content === undefined) {
        faltantes.push("aprobacion.json");
      } else {
        let aprobacionRaw: unknown;
        try {
          aprobacionRaw = JSON.parse(aprobacionFile.content);
        } catch {
          return errorJson(`aprobacion.json malformado en "${parsedArgs.data.caso}".`);
        }
        const aprobacionParsed = AprobacionArchivoSchema.safeParse(aprobacionRaw);
        if (!aprobacionParsed.success) {
          return errorJson(`aprobacion.json no cumple el esquema esperado: ${aprobacionParsed.error.message}`);
        }
        const cuerpo = aprobacionParsed.data.cuerpo;
        const aprobado = /\baprobado\b/i.test(cuerpo) && !/\bno\s+aprobado\b/i.test(cuerpo);
        aprobacion = {
          de: aprobacionParsed.data.de,
          fecha: aprobacionParsed.data.fecha,
          aprobado,
          texto: cuerpo,
        };
      }

      // 5. factura.txt (opcional, presente en casos retroactivos)
      let factura: Factura | null = null;
      const facturaFile = await readFileIfExists(path.join(caseDir, "factura.txt"));
      if (facturaFile.error) {
        return errorJson(`No se pudo leer factura.txt: ${facturaFile.error}`);
      }
      if (!facturaFile.exists || facturaFile.content === undefined) {
        if (correoParsed.data.adjuntos?.some((a) => a.toLowerCase().includes("factura"))) {
          faltantes.push("factura.txt");
        }
      } else {
        const parsedFac = parseFacturaText(facturaFile.content);
        if (!parsedFac.ok) {
          return errorJson(parsedFac.error);
        }
        factura = parsedFac.value;
      }

      // Verificar adjuntos declarados en correo.adjuntos que no existan en la carpeta
      // Los adjuntos binarios llegan normalizados (correo.nota_fixture): .xlsx/.eml -> .json, .pdf -> .txt.
      const NORMALIZADOS: Record<string, string> = {
        solicitud: "solicitud.json",
        cotizacion: "cotizacion.txt",
        aprobacion: "aprobacion.json",
        factura: "factura.txt",
      };
      for (const adjunto of correoParsed.data.adjuntos ?? []) {
        const base = path.basename(adjunto);
        const cleanName = NORMALIZADOS[base.replace(/\.[^.]+$/, "").toLowerCase()] ?? base;
        if (!cleanName || faltantes.includes(cleanName)) continue;
        const adjFile = await readFileIfExists(path.join(caseDir, cleanName));
        if (!adjFile.exists && !adjFile.error) {
          faltantes.push(cleanName);
        }
      }

      const paquete: Paquete = {
        correo: {
          id: correoParsed.data.id,
          de: correoParsed.data.de,
          asunto: correoParsed.data.asunto,
          fecha: correoParsed.data.fecha,
        },
        solicitud: solicitudParsed.data,
        cotizacion,
        aprobacion,
        factura,
        ...(faltantes.length > 0 ? { faltantes } : {}),
      };

      const validPaquete = PaqueteSchema.safeParse(paquete);
      if (!validPaquete.success) {
        return errorJson(`Error al normalizar el paquete: ${validPaquete.error.message}`);
      }

      return okJson(validPaquete.data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error inesperado en oc_leer_paquete";
      return errorJson(msg);
    }
  },
};

export const validar: ToolDefinition<{
  caso: z.ZodString;
  paquete: typeof PaqueteSchema;
}> = {
  description: "Valida el paquete contra los maestros y reglas de control RC1–RC10 devolviendo bloqueos, confirmaciones y derivados.",
  args: {
    caso: z.string().min(1).describe("Identificador del caso de solicitud (ej. sol-001)."),
    paquete: PaqueteSchema.describe("Paquete normalizado devuelto por oc_leer_paquete."),
  },
  async execute(args, ctx) {
    try {
      const parsed = z.object(validar.args).safeParse(args);
      if (!parsed.success) {
        return errorJson(`Argumentos inválidos para oc_validar: ${parsed.error.message}`);
      }
      const maestros = await cargarMaestros(ctx.directory);
      const { apta, bloqueos, confirmaciones, derivados, retroactiva } = validarPaquete(parsed.data.paquete, maestros);
      return okJson({ apta, bloqueos, confirmaciones, derivados, retroactiva });
    } catch (err) {
      return errorJson(err instanceof Error ? err.message : "Error inesperado en oc_validar");
    }
  },
};

export const construir_payload: ToolDefinition<{
  caso: z.ZodString;
  paquete: typeof PaqueteSchema;
  derivados: typeof DerivadosSchema;
}> = {
  description: "Construye el payload OrdenCompra validado con Zod y registra la trazabilidad de cada campo en out/<caso>/trazabilidad.json.",
  args: {
    caso: z.string().min(1).describe("Identificador del caso de solicitud (ej. sol-001)."),
    paquete: PaqueteSchema.describe("Paquete normalizado devuelto por oc_leer_paquete."),
    derivados: DerivadosSchema.describe("Valores derivados desde los maestros devueltos por oc_validar."),
  },
  async execute(args, ctx) {
    try {
      const parsed = z.object(construir_payload.args).safeParse(args);
      if (!parsed.success) {
        return errorJson(`Argumentos inválidos para oc_construir_payload: ${parsed.error.message}`);
      }
      const { caso, paquete, derivados } = parsed.data;
      const outDir = resolverDirSalida(ctx.directory, caso);
      if (!outDir) return errorJson(`Nombre de caso inválido: "${caso}".`);
      const aprob = await leerAprobacionArchivo(ctx.directory, caso);
      if (!aprob.ok) return errorJson(aprob.error);
      const maestros = await cargarMaestros(ctx.directory);
      const construida = construirOrden(paquete, derivados, maestros, sha256(contenidoEvidencia(aprob.value)));
      if (!construida.ok) return errorJson(construida.error);

      const rutaTraza = path.join(outDir, "trazabilidad.json");
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(
        rutaTraza,
        `${JSON.stringify({ caso, solicitud_id: paquete.solicitud.solicitud_id, campos: construida.value.trazabilidad }, null, 2)}\n`,
        "utf8",
      );
      return okJson({ ...construida.value.orden, ruta_trazabilidad: rutaRelativa(ctx.directory, rutaTraza) });
    } catch (err) {
      return errorJson(err instanceof Error ? err.message : "Error inesperado en oc_construir_payload");
    }
  },
};

export const generar_evidencia: ToolDefinition<{
  caso: z.ZodString;
}> = {
  description: "Genera el archivo de evidencia de aprobación out/<caso>/aprobacion.txt y calcula su hash SHA-256.",
  args: {
    caso: z.string().min(1).describe("Identificador del caso de solicitud (ej. sol-001)."),
  },
  async execute(args, ctx) {
    try {
      const parsed = z.object(generar_evidencia.args).safeParse(args);
      if (!parsed.success) {
        return errorJson(`Argumentos inválidos para oc_generar_evidencia: ${parsed.error.message}`);
      }
      const evidencia = await escribirEvidencia(ctx.directory, parsed.data.caso);
      return evidencia.ok ? okJson(evidencia.value) : errorJson(evidencia.error);
    } catch (err) {
      return errorJson(err instanceof Error ? err.message : "Error inesperado en oc_generar_evidencia");
    }
  },
};

export const crear: ToolDefinition<{
  caso: z.ZodString;
  payload: z.ZodNullable<typeof OrdenCompraSchema>;
  confirmado: z.ZodOptional<z.ZodBoolean>;
}> = {
  description: "Crea la orden de compra en el adaptador SAP simulado si cumple controles y confirmación humana, con idempotencia por solicitud_id.",
  args: {
    caso: z.string().min(1).describe("Identificador del caso de solicitud (ej. sol-001)."),
    payload: OrdenCompraSchema.nullable().describe(
      "Payload OrdenCompra devuelto por oc_construir_payload, sin modificar; null si no se pudo construir (el intento queda registrado).",
    ),
    confirmado: z
      .boolean()
      .optional()
      .describe("Debe ser true únicamente cuando el humano ha confirmado explícitamente las excepciones."),
  },
  async execute(args, ctx) {
    try {
      const parsed = z.object(crear.args).safeParse(args);
      if (!parsed.success) {
        return errorJson(`Argumentos inválidos para oc_crear: ${parsed.error.message}`);
      }
      const { caso, payload, confirmado } = parsed.data;
      return await enSerieCrear(async () => {
        // La fuente de verdad es el caso en fixtures, no lo que envíe el modelo.
        const caso_ = await reconstruirCaso(ctx.directory, caso);
        if (!caso_.ok) return errorJson(caso_.error);
        const { paquete, validacion, orden: esperada } = caso_.value;
        const solicitudId = paquete.solicitud.solicitud_id;
        const sap = new MockSapAdapter(ctx.directory);
        const registrar = (resultado: string, numero_oc = "") =>
          registrarControl(ctx.directory, { solicitud_id: solicitudId, resultado, numero_oc, validacion });

        // Idempotencia: si ya existe OC para la solicitud, se devuelve la existente.
        if ((await sap.buscarOrdenPorReferencia(solicitudId)) && esperada.ok) {
          const existente = await sap.crearOrden(esperada.value.orden); // idempotente: no crea otra
          await registrar("existente", existente.numero_oc);
          return okJson({ ...existente, idempotente: true });
        }

        if (!validacion.apta) {
          await registrar("bloqueada");
          const motivos = validacion.bloqueos.map((b) => `${b.codigo}: ${b.detalle} Acción: ${b.accion_sugerida}`);
          return errorJson(`Bloqueada, no se crea la OC. ${motivos.join(" | ")}`);
        }
        if (validacion.confirmaciones.length > 0 && confirmado !== true) {
          await registrar("pendiente_confirmacion");
          const motivos = validacion.confirmaciones.map((c) => `${c.codigo}: ${c.detalle}`);
          return errorJson(
            `Pendiente de confirmación explícita del usuario. ${motivos.join(" | ")} Llamar de nuevo con confirmado=true solo si el usuario confirma.`,
          );
        }
        if (!esperada.ok) {
          await registrar("rechazada");
          return errorJson(esperada.error);
        }
        if (!payload) {
          await registrar("rechazada");
          return errorJson("Falta el payload: ejecute oc_construir_payload y muéstrelo al usuario antes de crear.");
        }
        const normalizar = (o: OrdenCompra) => ({ ...o, excepciones: o.excepciones.map((e) => ({ ...e, confirmado_por: null })) });
        const difs = diferencias(normalizar(payload), normalizar(esperada.value.orden));
        if (difs.length > 0) {
          await registrar("rechazada");
          return errorJson(`El payload no coincide con los datos validados del caso: ${difs.slice(0, 5).join("; ")}`);
        }
        const proveedorSap = await sap.consultarProveedor(esperada.value.orden.proveedor.nit);
        if (!proveedorSap?.activo) {
          await registrar("rechazada");
          return errorJson(`SAP no reconoce al proveedor ${esperada.value.orden.proveedor.nit} como activo.`);
        }
        const evidencia = await escribirEvidencia(ctx.directory, caso);
        if (!evidencia.ok) return errorJson(evidencia.error);

        const ordenFinal: OrdenCompra = {
          ...esperada.value.orden,
          excepciones: esperada.value.orden.excepciones.map((e) => ({ ...e, confirmado_por: `sesion:${ctx.sessionId}` })),
        };
        const creada = await sap.crearOrden(ordenFinal);
        await registrar("creada", creada.numero_oc);
        return okJson({ ...creada, idempotente: false });
      });
    } catch (err) {
      return errorJson(err instanceof Error ? err.message : "Error inesperado en oc_crear");
    }
  },
};

export const ocTools = {
  oc_leer_paquete: leer_paquete,
  oc_validar: validar,
  oc_construir_payload: construir_payload,
  oc_generar_evidencia: generar_evidencia,
  oc_crear: crear,
} as const;

export type OcToolName = keyof typeof ocTools;
