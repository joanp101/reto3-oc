import type { z } from "zod";

export interface HerramientaLLM {
  name: string;
  description: string;
  parameters: z.ZodObject<z.ZodRawShape>;
}

export interface LlamadaHerramientaLLM {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ResultadoHerramientaLLM {
  id: string;
  name: string;
  responseJson: string;
}

export interface MensajeLLM {
  role: "user" | "assistant" | "tool";
  texto?: string;
  llamadas?: LlamadaHerramientaLLM[];
  resultados?: ResultadoHerramientaLLM[];
  /** Metadatos opacos del proveedor (p. ej. contenido original con firmas de pensamiento). */
  providerData?: unknown;
}

export interface UsoTokensLLM {
  entrada: number;
  salida: number;
  total: number;
}

export interface RespuestaLLM {
  texto: string;
  llamadas: LlamadaHerramientaLLM[];
  usoTokens?: UsoTokensLLM;
  providerData?: unknown;
}

export interface EnviarOpciones {
  systemPrompt?: string;
  timeoutMs?: number;
}

/**
 * Interfaz propia del adaptador de proveedor LLM (PRD 6.1).
 * Cambiar de proveedor no debe requerir cambios en el ciclo del agente.
 */
export interface LlmAdapter {
  readonly provider: string;
  readonly model: string;
  enviar(
    mensajes: MensajeLLM[],
    herramientas: HerramientaLLM[],
    opciones?: EnviarOpciones,
  ): Promise<RespuestaLLM>;
}
