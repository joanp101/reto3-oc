import fs from "node:fs/promises";
import path from "node:path";
import type { OrdenCompra } from "../tools/oc.js";
import type { SapAdapter } from "./adapter.js";

const PRIMER_NUMERO_OC = 4500000001;

interface RegistroOrden {
  numero_oc: string;
  fecha: string;
  solicitud_id: string;
  orden: OrdenCompra;
}

interface ProveedorArchivo {
  codigo_sap: string;
  nit: string;
  activo: boolean;
}

/** Serializa operaciones por archivo para que lectura + numeración + escritura sean atómicas en el proceso. */
const colas = new Map<string, Promise<unknown>>();
function enSerie<T>(clave: string, tarea: () => Promise<T>): Promise<T> {
  const actual = (colas.get(clave) ?? Promise.resolve()).then(tarea, tarea);
  colas.set(clave, actual.catch(() => undefined));
  return actual;
}

function normalizarNit(nit: string): string {
  return nit.split("-")[0].replace(/\D/g, "");
}

/**
 * Implementación simulada de SAP sobre archivos:
 * - Proveedores: fixtures/reto-03/maestros/proveedores.json (solo lectura).
 * - Órdenes: out/sap/ordenes.jsonl (una OC por línea, numeración desde 4500000001, idempotente por solicitud_id).
 */
export class MockSapAdapter implements SapAdapter {
  private readonly outSapDir: string;
  private readonly proveedoresPath: string;

  constructor(projectDirectory: string) {
    this.outSapDir = path.resolve(projectDirectory, "out", "sap");
    this.proveedoresPath = path.resolve(projectDirectory, "fixtures", "reto-03", "maestros", "proveedores.json");
  }

  get ordenesPath(): string {
    return path.join(this.outSapDir, "ordenes.jsonl");
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const proveedores = JSON.parse(await fs.readFile(this.proveedoresPath, "utf8")) as ProveedorArchivo[];
    const buscado = normalizarNit(nit);
    const encontrado = proveedores.find((p) => normalizarNit(p.nit) === buscado);
    return encontrado ? { codigo_sap: encontrado.codigo_sap, activo: encontrado.activo } : null;
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    return enSerie(this.ordenesPath, async () => {
      const registros = await this.leerRegistros();
      const existente = registros.find((r) => r.solicitud_id === orden.referencia.solicitud_id);
      if (existente) {
        return { numero_oc: existente.numero_oc, fecha: existente.fecha };
      }
      const ultimo = registros.reduce((max, r) => Math.max(max, Number(r.numero_oc)), PRIMER_NUMERO_OC - 1);
      const registro: RegistroOrden = {
        numero_oc: String(ultimo + 1),
        fecha: new Date().toISOString(),
        solicitud_id: orden.referencia.solicitud_id,
        orden,
      };
      await fs.mkdir(this.outSapDir, { recursive: true });
      await fs.appendFile(this.ordenesPath, `${JSON.stringify(registro)}\n`, "utf8");
      return { numero_oc: registro.numero_oc, fecha: registro.fecha };
    });
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    const existente = (await this.leerRegistros()).find((r) => r.solicitud_id === solicitud_id);
    return existente ? { numero_oc: existente.numero_oc } : null;
  }

  private async leerRegistros(): Promise<RegistroOrden[]> {
    let contenido: string;
    try {
      contenido = await fs.readFile(this.ordenesPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return contenido
      .split("\n")
      .filter((linea) => linea.trim())
      .map((linea, i) => {
        try {
          return JSON.parse(linea) as RegistroOrden;
        } catch {
          throw new Error(`out/sap/ordenes.jsonl: línea ${i + 1} malformada.`);
        }
      });
  }
}
