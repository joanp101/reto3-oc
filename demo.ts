import fs from "node:fs/promises";
import path from "node:path";
import {
  ocTools,
  type OrdenCompra,
  type Paquete,
  type ResultadoValidacion,
  type ToolContext,
} from "./src/tools/oc.js";

const CASOS = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"] as const;

type Respuesta<T> = { ok: true; data: T } | { ok: false; error: string };
type OcCreada = { numero_oc: string; fecha: string; idempotente: boolean };
type Payload = OrdenCompra & { ruta_trazabilidad: string };

function parse<T>(raw: string): Respuesta<T> {
  return JSON.parse(raw) as Respuesta<T>;
}

function lista(titulo: string, items: ResultadoValidacion["bloqueos"]): void {
  console.log(`  ${titulo.padEnd(15)}: ${items.length === 0 ? "ninguna" : ""}`);
  for (const i of items) {
    console.log(`    - ${i.codigo}: ${i.detalle}`);
    console.log(`      acción: ${i.accion_sugerida}`);
  }
}

async function crear(
  caso: string,
  payload: OrdenCompra | null,
  ctx: ToolContext,
  confirmado?: boolean,
): Promise<Respuesta<OcCreada>> {
  const res = parse<OcCreada>(await ocTools.oc_crear.execute({ caso, payload, confirmado }, ctx));
  const etiqueta = `oc_crear${confirmado ? " (confirmado)" : ""}`;
  console.log(
    `  ${etiqueta.padEnd(15)}: ${
      res.ok ? `OC ${res.data.numero_oc} (idempotente=${res.data.idempotente}, fecha ${res.data.fecha})` : `NO CREADA — ${res.error}`
    }`,
  );
  return res;
}

async function procesar(caso: string, directory: string, confirmarTrasPendiente = false): Promise<string> {
  const ctx = { directory, sessionId: `demo-${caso}` };
  console.log(`\n=== ${caso} ===`);

  const leido = parse<Paquete>(await ocTools.oc_leer_paquete.execute({ caso }, ctx));
  if (!leido.ok) {
    console.log(`  oc_leer_paquete : ERROR — ${leido.error}`);
    return "error de lectura";
  }
  const paquete = leido.data;
  const sol = paquete.solicitud;
  console.log(`  solicitud      : ${sol.solicitud_id} · ${sol.proveedor_nombre} · ${sol.moneda} ${sol.valor_total}`);

  const val = parse<ResultadoValidacion>(await ocTools.oc_validar.execute({ caso, paquete }, ctx));
  if (!val.ok) {
    console.log(`  oc_validar     : ERROR — ${val.error}`);
    return "error de validación";
  }
  const v = val.data;
  console.log(`  apta           : ${v.apta}`);
  lista("bloqueos", v.bloqueos);
  lista("confirmaciones", v.confirmaciones);
  console.log(`  derivados      : ${JSON.stringify(v.derivados)}`);
  console.log(`  retroactiva    : ${v.retroactiva}`);

  let payload: OrdenCompra | null = null;
  if (v.apta) {
    const construido = parse<Payload>(
      await ocTools.oc_construir_payload.execute({ caso, paquete, derivados: v.derivados }, ctx),
    );
    if (!construido.ok) {
      console.log(`  payload        : ERROR — ${construido.error}`);
    } else {
      const { ruta_trazabilidad, ...orden } = construido.data;
      const p = orden.posiciones[0];
      console.log(
        `  payload        : ${orden.proveedor.codigo_sap} ${orden.proveedor.nombre} · ${p.cantidad} ${p.unidad} × ${p.precio_unitario} ${orden.moneda} · IVA ${p.indicador_iva} · pago ${orden.condiciones_pago} · "${p.descripcion}"`,
      );
      console.log(`  trazabilidad   : ${ruta_trazabilidad}`);
      payload = orden;
    }
    const ev = parse<{ ruta: string; sha256: string }>(await ocTools.oc_generar_evidencia.execute({ caso }, ctx));
    console.log(`  evidencia      : ${ev.ok ? `${ev.data.ruta} · sha256 ${ev.data.sha256}` : `ERROR — ${ev.error}`}`);
  }

  // Siempre se intenta crear: los intentos bloqueados y pendientes también quedan en out/control.csv.
  let res = await crear(caso, payload, ctx);
  if (!res.ok && confirmarTrasPendiente && v.apta && v.confirmaciones.length > 0) {
    console.log("  >> el usuario confirma explícitamente las excepciones");
    res = await crear(caso, payload, ctx, true);
  }
  if (res.ok) return `OC ${res.data.numero_oc}${res.data.idempotente ? " (idempotente)" : ""}`;
  if (!v.apta) return `bloqueada (${v.bloqueos.map((b) => b.codigo).join(", ")})`;
  return `pendiente de confirmación (${v.confirmaciones.map((c) => c.codigo).join(", ")})`;
}

async function main(): Promise<void> {
  const directory = process.cwd();
  await fs.rm(path.join(directory, "out"), { recursive: true, force: true });
  console.log("Demo Reto 03 — herramientas sin modelo LLM (out/ limpiado)");

  const resumen: Array<[string, string]> = [];
  for (const caso of CASOS) {
    resumen.push([caso, await procesar(caso, directory, caso === "sol-004")]);
  }

  console.log("\n=== Idempotencia: sol-001 por segunda vez ===");
  resumen.push(["sol-001 (2ª)", await procesar("sol-001", directory)]);

  console.log("\n=== Resumen ===");
  for (const [caso, resultado] of resumen) console.log(`  ${caso.padEnd(13)} ${resultado}`);

  console.log("\n=== out/control.csv ===");
  console.log((await fs.readFile(path.join(directory, "out", "control.csv"), "utf8")).trimEnd());
}

main().catch((err) => {
  console.error("Error fatal en demo.ts:", err);
  process.exit(1);
});
