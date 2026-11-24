import {
  GoogleGenAI,
  Type,
  type Content,
  type FunctionDeclaration,
  type Part,
  type Schema,
} from "@google/genai";
import { z } from "zod";
import type {
  EnviarOpciones,
  HerramientaLLM,
  LlamadaHerramientaLLM,
  LlmAdapter,
  MensajeLLM,
  RespuestaLLM,
} from "./adapter.js";

export const DEFAULT_GEMINI_MODEL = "gemini-4-hydrogen";
const DEFAULT_TIMEOUT_MS = 60_000;

function zodToGeminiSchema(schema: z.ZodTypeAny): Schema {
  const description = schema.description;

  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    const inner = zodToGeminiSchema(schema._def.innerType);
    return description ? { ...inner, description } : inner;
  }

  if (schema instanceof z.ZodNullable) {
    const inner = zodToGeminiSchema(schema._def.innerType);
    return {
      ...inner,
      nullable: true,
      ...(description ? { description } : {}),
    };
  }

  if (schema instanceof z.ZodLiteral) {
    const val = schema.value;
    if (typeof val === "number") {
      return {
        type: Type.NUMBER,
        format: "enum",
        enum: [String(val)],
        ...(description ? { description } : {}),
      };
    }
    if (typeof val === "boolean") {
      return {
        type: Type.BOOLEAN,
        ...(description ? { description } : {}),
      };
    }
    return {
      type: Type.STRING,
      format: "enum",
      enum: [String(val)],
      ...(description ? { description } : {}),
    };
  }

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, Schema> = {};
    const required: string[] = [];

    for (const [key, fieldSchema] of Object.entries(shape)) {
      properties[key] = zodToGeminiSchema(fieldSchema);
      if (!fieldSchema.isOptional()) {
        required.push(key);
      }
    }

    return {
      type: Type.OBJECT,
      properties,
      ...(required.length > 0 ? { required } : {}),
      ...(description ? { description } : {}),
    };
  }

  if (schema instanceof z.ZodArray) {
    return {
      type: Type.ARRAY,
      items: zodToGeminiSchema(schema.element),
      ...(description ? { description } : {}),
    };
  }

  if (schema instanceof z.ZodEnum) {
    return {
      type: Type.STRING,
      format: "enum",
      enum: [...schema.options],
      ...(description ? { description } : {}),
    };
  }

  if (schema instanceof z.ZodNumber) {
    return {
      type: schema.isInt ? Type.INTEGER : Type.NUMBER,
      ...(description ? { description } : {}),
    };
  }

  if (schema instanceof z.ZodBoolean) {
    return {
      type: Type.BOOLEAN,
      ...(description ? { description } : {}),
    };
  }

  return {
    type: Type.STRING,
    ...(description ? { description } : {}),
  };
}

function toFunctionDeclarations(herramientas: HerramientaLLM[]): FunctionDeclaration[] {
  return herramientas.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: zodToGeminiSchema(tool.parameters),
  }));
}

function safeParseJsonForFunctionResponse(rawJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { output: parsed };
  } catch {
    return { output: rawJson };
  }
}

function toGeminiContents(mensajes: MensajeLLM[]): Content[] {
  const contents: Content[] = [];

  for (const msg of mensajes) {
    if (msg.role === "assistant" && msg.providerData && typeof msg.providerData === "object") {
      contents.push(msg.providerData as Content);
      continue;
    }

    if (msg.role === "user") {
      contents.push({
        role: "user",
        parts: [{ text: msg.texto ?? "" }],
      });
      continue;
    }

    if (msg.role === "assistant") {
      const parts: Part[] = [];
      if (msg.texto) {
        parts.push({ text: msg.texto });
      }
      for (const call of msg.llamadas ?? []) {
        parts.push({
          functionCall: {
            id: call.id,
            name: call.name,
            args: call.args,
          },
        });
      }
      contents.push({ role: "model", parts });
      continue;
    }

    if (msg.role === "tool") {
      const parts: Part[] = (msg.resultados ?? []).map((res) => ({
        functionResponse: {
          id: res.id,
          name: res.name,
          response: safeParseJsonForFunctionResponse(res.responseJson),
        },
      }));
      contents.push({ role: "user", parts });
    }
  }

  return contents;
}

export class GeminiAdapter implements LlmAdapter {
  readonly provider = "gemini";
  readonly model: string;

  constructor(model?: string) {
    this.model = model?.trim() || process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  }

  async enviar(
    mensajes: MensajeLLM[],
    herramientas: HerramientaLLM[],
    opciones?: EnviarOpciones,
  ): Promise<RespuestaLLM> {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY no está configurada en las variables de entorno.");
    }

    const ai = new GoogleGenAI({ apiKey });
    const contents = toGeminiContents(mensajes);
    const functionDeclarations = toFunctionDeclarations(herramientas);
    const timeoutMs = opciones?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await ai.models.generateContent({
        model: this.model,
        contents,
        config: {
          ...(opciones?.systemPrompt ? { systemInstruction: opciones.systemPrompt } : {}),
          ...(functionDeclarations.length > 0 ? { tools: [{ functionDeclarations }] } : {}),
          abortSignal: controller.signal,
        },
      });

      const modelContent = response.candidates?.[0]?.content;
      const llamadas: LlamadaHerramientaLLM[] = (response.functionCalls ?? []).map((call, idx) => ({
        id: call.id ?? `call_${Date.now()}_${idx}`,
        name: call.name ?? "",
        args: (call.args ?? {}) as Record<string, unknown>,
      }));

      const usage = response.usageMetadata;
      const usoTokens = usage
        ? {
            entrada: usage.promptTokenCount ?? 0,
            salida: usage.candidatesTokenCount ?? 0,
            total: usage.totalTokenCount ?? 0,
          }
        : undefined;

      return {
        texto: response.text ?? "",
        llamadas,
        usoTokens,
        providerData: modelContent,
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Tiempo de espera agotado (${timeoutMs} ms) al consultar el proveedor Gemini.`);
      }
      const message = err instanceof Error ? err.message : "Error desconocido al consultar Gemini";
      throw new Error(`Error del proveedor Gemini: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
