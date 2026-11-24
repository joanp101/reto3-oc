import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { HerramientaLLM, LlmAdapter, MensajeLLM, ResultadoHerramientaLLM } from "./llm/adapter.js";
import { GeminiAdapter } from "./llm/gemini.js";
import { ocTools, type OcToolName } from "./tools/oc.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const PROMPT_PATH = path.join(ROOT_DIR, "agent", "prompt.md");
const WEB_DIR = path.join(ROOT_DIR, "web");
const OUT_DIR = path.join(ROOT_DIR, "out");
const LOG_PATH = path.join(OUT_DIR, "log.jsonl");

function loadEnvFile(): void {
  const envPath = path.join(ROOT_DIR, ".env");
  if (!fsSync.existsSync(envPath)) return;

  const raw = fsSync.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const PORT = Number(process.env.PORT ?? 3000);
const MAX_ITERATIONS = Math.min(Math.max(Number(process.env.MAX_ITERATIONS ?? 25), 1), 25);
const SESSION_TOKEN_LIMIT = Math.max(Number(process.env.SESSION_TOKEN_LIMIT ?? 200_000), 1000);
const CONFIRMATION_MARKER = "[CONFIRMACION_REQUERIDA]";

export interface ToolCallLogEntry {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  result: unknown;
}

export interface ChatMessageEntry {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallLogEntry[];
  needsConfirmation?: boolean;
  ts: string;
}

export interface SessionState {
  id: string;
  llmHistory: MensajeLLM[];
  messages: ChatMessageEntry[];
  toolCalls: ToolCallLogEntry[];
  needsConfirmation: boolean;
  tokensUsed: number;
  createdAt: string;
  updatedAt: string;
}

const sessions = new Map<string, SessionState>();
const llmAdapter: LlmAdapter = new GeminiAdapter();

function buildHerramientasLLM(): HerramientaLLM[] {
  return (Object.entries(ocTools) as Array<[OcToolName, (typeof ocTools)[OcToolName]]>).map(
    ([name, tool]) => ({
      name,
      description: tool.description,
      parameters: z.object(tool.args),
    }),
  );
}

function summarizeToolResult(parsed: { ok?: boolean; data?: unknown; error?: string }): {
  ok: boolean;
  summary: string;
  result: unknown;
} {
  if (!parsed.ok) {
    const errText = typeof parsed.error === "string" ? parsed.error : "Error en herramienta";
    return {
      ok: false,
      summary: errText.length > 140 ? `${errText.slice(0, 137)}...` : errText,
      result: parsed,
    };
  }

  const data = parsed.data as Record<string, unknown> | undefined;
  let summary = "ok";
  if (data && typeof data === "object") {
    if ("numero_oc" in data) {
      summary = `OC ${String(data.numero_oc)} (${String(data.fecha ?? "")})`;
    } else if ("apta" in data) {
      const bloqueos = Array.isArray(data.bloqueos) ? data.bloqueos.length : 0;
      const confs = Array.isArray(data.confirmaciones) ? data.confirmaciones.length : 0;
      summary = `apta=${String(data.apta)}, bloqueos=${bloqueos}, confirmaciones=${confs}`;
    } else if ("solicitud" in data && data.solicitud && typeof data.solicitud === "object") {
      const sol = data.solicitud as Record<string, unknown>;
      summary = `paquete ${String(sol.solicitud_id ?? "")} leído`;
    } else if ("sha256" in data) {
      summary = `evidencia ${String(data.ruta ?? "")}`;
    } else if ("referencia" in data) {
      summary = "payload OC construido";
    }
  }

  return { ok: true, summary, result: parsed };
}

async function appendToolLog(entry: {
  ts: string;
  sessionId: string;
  iteration: number;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
}): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.appendFile(LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
}

async function executeRegisteredTool(
  name: string,
  args: Record<string, unknown>,
  sessionId: string,
): Promise<{ responseJson: string; record: ToolCallLogEntry }> {
  const tool = ocTools[name as OcToolName];
  if (!tool) {
    const responseJson = JSON.stringify({ ok: false, error: `Herramienta desconocida: ${name}` });
    return {
      responseJson,
      record: {
        name,
        args,
        ok: false,
        summary: `Herramienta desconocida: ${name}`,
        result: { ok: false, error: `Herramienta desconocida: ${name}` },
      },
    };
  }

  const schema = z.object(tool.args);
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const errMsg = `Argumentos inválidos para ${name}: ${parsed.error.message}`;
    const responseJson = JSON.stringify({ ok: false, error: errMsg });
    return {
      responseJson,
      record: {
        name,
        args,
        ok: false,
        summary: errMsg.slice(0, 140),
        result: { ok: false, error: errMsg },
      },
    };
  }

  const responseJson = await tool.execute(parsed.data as never, {
    directory: ROOT_DIR,
    sessionId,
  });

  let parsedOutput: { ok?: boolean; data?: unknown; error?: string };
  try {
    parsedOutput = JSON.parse(responseJson) as { ok?: boolean; data?: unknown; error?: string };
  } catch {
    parsedOutput = { ok: false, error: "Respuesta JSON inválida de herramienta" };
  }

  const summarized = summarizeToolResult(parsedOutput);
  return {
    responseJson,
    record: {
      name,
      args,
      ok: summarized.ok,
      summary: summarized.summary,
      result: summarized.result,
    },
  };
}

function getOrCreateSession(rawSessionId?: unknown): SessionState {
  const requestedId =
    typeof rawSessionId === "string" && rawSessionId.trim() ? rawSessionId.trim() : crypto.randomUUID();
  const existing = sessions.get(requestedId);
  if (existing) return existing;

  const now = new Date().toISOString();
  const created: SessionState = {
    id: requestedId,
    llmHistory: [],
    messages: [],
    toolCalls: [],
    needsConfirmation: false,
    tokensUsed: 0,
    createdAt: now,
    updatedAt: now,
  };
  sessions.set(requestedId, created);
  return created;
}

function detectConfirmationPending(replyText: string, turnToolCalls: ToolCallLogEntry[]): {
  cleanReply: string;
  needsConfirmation: boolean;
} {
  const hasMarker = replyText.includes(CONFIRMATION_MARKER);
  const cleanReply = replyText.replaceAll(CONFIRMATION_MARKER, "").trim();

  if (hasMarker) {
    return { cleanReply, needsConfirmation: true };
  }

  // Verificar si alguna llamada a oc_validar reportó confirmaciones pendientes sin haberse llamado oc_crear con éxito.
  const hasPendingValidacion = turnToolCalls.some((tc) => {
    if (tc.name !== "oc_validar" || !tc.ok || !tc.result || typeof tc.result !== "object") return false;
    const data = (tc.result as { data?: { confirmaciones?: unknown[] } }).data;
    return Array.isArray(data?.confirmaciones) && data.confirmaciones.length > 0;
  });
  const createdOc = turnToolCalls.some((tc) => tc.name === "oc_crear" && tc.ok);

  if (hasPendingValidacion && !createdOc && /\?|confirm/i.test(cleanReply)) {
    return { cleanReply, needsConfirmation: true };
  }

  return { cleanReply, needsConfirmation: false };
}

async function runAgentTurn(
  session: SessionState,
  userMessage: string,
): Promise<{
  sessionId: string;
  reply: string;
  toolCalls: ToolCallLogEntry[];
  needsConfirmation: boolean;
}> {
  const now = new Date().toISOString();
  session.messages.push({ role: "user", content: userMessage, ts: now });
  session.llmHistory.push({ role: "user", texto: userMessage });
  session.needsConfirmation = false;
  session.updatedAt = now;

  if (session.tokensUsed >= SESSION_TOKEN_LIMIT) {
    const limitReply = `Se alcanzó el tope de tokens configurado para esta sesión (${SESSION_TOKEN_LIMIT}). Inicia una nueva sesión para continuar.`;
    session.messages.push({ role: "assistant", content: limitReply, ts: new Date().toISOString() });
    return {
      sessionId: session.id,
      reply: limitReply,
      toolCalls: [],
      needsConfirmation: false,
    };
  }

  let systemPrompt: string;
  try {
    systemPrompt = await fs.readFile(PROMPT_PATH, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo leer agent/prompt.md";
    const errReply = `Error de configuración del agente: ${msg}`;
    session.messages.push({ role: "assistant", content: errReply, ts: new Date().toISOString() });
    return { sessionId: session.id, reply: errReply, toolCalls: [], needsConfirmation: false };
  }

  const herramientas = buildHerramientasLLM();
  const turnToolCalls: ToolCallLogEntry[] = [];

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    let respuesta;
    try {
      respuesta = await llmAdapter.enviar(session.llmHistory, herramientas, { systemPrompt });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error desconocido del proveedor LLM";
      const safeReply = `No fue posible obtener respuesta del modelo (${msg}). La sesión sigue activa y puedes reintentar.`;
      session.messages.push({
        role: "assistant",
        content: safeReply,
        toolCalls: turnToolCalls,
        ts: new Date().toISOString(),
      });
      return {
        sessionId: session.id,
        reply: safeReply,
        toolCalls: turnToolCalls,
        needsConfirmation: false,
      };
    }

    if (respuesta.usoTokens) {
      session.tokensUsed += respuesta.usoTokens.total;
    }

    session.llmHistory.push({
      role: "assistant",
      texto: respuesta.texto,
      llamadas: respuesta.llamadas,
      providerData: respuesta.providerData,
    });

    if (respuesta.llamadas.length === 0) {
      const { cleanReply, needsConfirmation } = detectConfirmationPending(respuesta.texto, turnToolCalls);
      const reply = cleanReply || "Listo.";
      session.needsConfirmation = needsConfirmation;
      session.updatedAt = new Date().toISOString();
      session.messages.push({
        role: "assistant",
        content: reply,
        toolCalls: turnToolCalls,
        needsConfirmation,
        ts: session.updatedAt,
      });
      return {
        sessionId: session.id,
        reply,
        toolCalls: turnToolCalls,
        needsConfirmation,
      };
    }

    const resultados: ResultadoHerramientaLLM[] = [];
    for (const call of respuesta.llamadas) {
      const executed = await executeRegisteredTool(call.name, call.args, session.id);
      turnToolCalls.push(executed.record);
      session.toolCalls.push(executed.record);

      await appendToolLog({
        ts: new Date().toISOString(),
        sessionId: session.id,
        iteration,
        name: executed.record.name,
        args: executed.record.args,
        ok: executed.record.ok,
        summary: executed.record.summary,
      });

      resultados.push({
        id: call.id,
        name: call.name,
        responseJson: executed.responseJson,
      });
    }

    session.llmHistory.push({
      role: "tool",
      resultados,
    });
  }

  const executedNames = turnToolCalls.map((tc) => `${tc.name} (${tc.ok ? "ok" : "error"})`).join(", ");
  const capReply =
    `Se alcanzó el tope de ${MAX_ITERATIONS} iteraciones del ciclo del agente en este turno. ` +
    `Herramientas ejecutadas hasta ahora: ${executedNames || "ninguna"}. ` +
    "Indica cómo deseas continuar o qué paso falta confirmar.";

  session.updatedAt = new Date().toISOString();
  session.messages.push({
    role: "assistant",
    content: capReply,
    toolCalls: turnToolCalls,
    needsConfirmation: false,
    ts: session.updatedAt,
  });

  return {
    sessionId: session.id,
    reply: capReply,
    toolCalls: turnToolCalls,
    needsConfirmation: false,
  };
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function serveStaticFile(
  res: http.ServerResponse,
  filePath: string,
  contentType: string,
): Promise<void> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "Archivo estático no encontrado" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      provider: llmAdapter.provider,
      model: llmAdapter.model,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    let body: { sessionId?: unknown; message?: unknown };
    try {
      body = (await readJsonBody(req)) as { sessionId?: unknown; message?: unknown };
    } catch {
      sendJson(res, 400, { error: "Cuerpo JSON inválido" });
      return;
    }

    if (typeof body.message !== "string" || !body.message.trim()) {
      sendJson(res, 400, { error: "El campo 'message' es obligatorio y no puede estar vacío" });
      return;
    }

    const session = getOrCreateSession(body.sessionId);
    const result = await runAgentTurn(session, body.message.trim());
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length)).trim();
    if (!id) {
      sendJson(res, 400, { error: "Falta el identificador de sesión" });
      return;
    }
    const session = sessions.get(id);
    if (!session) {
      sendJson(res, 404, { error: `Sesión "${id}" no encontrada` });
      return;
    }
    sendJson(res, 200, {
      sessionId: session.id,
      messages: session.messages,
      toolCalls: session.toolCalls,
      needsConfirmation: session.needsConfirmation,
      tokensUsed: session.tokensUsed,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });
    return;
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    await serveStaticFile(res, path.join(WEB_DIR, "index.html"), "text/html; charset=utf-8");
    return;
  }

  if (req.method === "GET" && url.pathname === "/styles.css") {
    await serveStaticFile(res, path.join(WEB_DIR, "styles.css"), "text/css; charset=utf-8");
    return;
  }

  if (req.method === "GET" && url.pathname === "/app.js") {
    await serveStaticFile(res, path.join(WEB_DIR, "app.js"), "application/javascript; charset=utf-8");
    return;
  }

  sendJson(res, 404, { error: "Ruta no encontrada" });
});

server.listen(PORT, () => {
  console.log(
    `Servidor escuchando en http://localhost:${PORT} (provider=${llmAdapter.provider}, model=${llmAdapter.model})`,
  );
});
