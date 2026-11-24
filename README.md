# Agente de Órdenes de Compra SAP — Reto 03

Estructura base alineada al contrato del PRD (secciones 6 y 7) para el agente conversacional de Órdenes de Compra en SAP.

## Requisitos previos

- **Node.js 20+** (probado en Node 24) o **Bun**

## Variables de entorno

Copia `.env.example` a `.env` y configura tu clave:

```powershell
Copy-Item .env.example .env
```

Variables soportadas:

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `GEMINI_API_KEY` | Para el chat con modelo | — | Clave de API de Google Gemini (solo en `.env`, nunca en el repo ni en el front). |
| `GEMINI_MODEL` | No | `gemini-4-hydrogen` | Modelo Gemini usado por `src/llm/gemini.ts`. |
| `PORT` | No | `3000` | Puerto HTTP del servidor en `src/server.ts`. |
| `MAX_ITERATIONS` | No | `25` | Tope de iteraciones herramienta → modelo por turno. |
| `SESSION_TOKEN_LIMIT` | No | `200000` | Tope de tokens acumulados por sesión. |

## Instalación

```powershell
npm install
```

### Dependencias

- **Runtime**: `zod` (validación y descripción de argumentos de herramientas y esquemas de OC) y `@google/genai` (cliente oficial de Gemini). No se agregaron librerías HTTP o de frontend adicionales: el servidor usa `node:http` y el chat en `web/` usa HTML/CSS/JS plano.
- **Desarrollo**: `typescript`, `tsx`, `@types/node` (estrictamente necesarios para ejecutar TypeScript en Node.js y correr `tsc --noEmit`).

## Comandos (PowerShell)

### Verificar tipos

```powershell
npm run typecheck
```

### Ejecutar el demo sin modelo (`demo.ts`)

```powershell
npm run demo
```

### Iniciar el servidor y el chat web

```powershell
npm run dev
```

Luego abre `http://localhost:3000` en el navegador.

## API mínima (PRD 6.4)

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | Recibe `{ sessionId?, message }` y devuelve `{ sessionId, reply, toolCalls, needsConfirmation }`. |
| `GET` | `/api/sessions/:id` | Devuelve el historial completo de la sesión y las llamadas a herramientas. |
| `GET` | `/api/health` | Devuelve `{ ok: true, provider, model }` sin exponer claves. |

## Estructura del repositorio

```text
reto3-oc/
├── agent/prompt.md                  # System prompt del agente
├── src/
│   ├── server.ts                    # API HTTP y ciclo del agente
│   ├── llm/
│   │   ├── adapter.ts               # Interfaz LlmAdapter
│   │   └── gemini.ts                # Implementación Gemini (@google/genai)
│   ├── tools/
│   │   └── oc.ts                    # Herramientas P0 (oc_*) y esquemas Zod
│   ├── sap/
│   │   ├── adapter.ts               # Interfaz SapAdapter
│   │   └── mock.ts                  # Implementación mock sobre out/sap/
│   └── knowledge/
│       └── ordenes-compra.md        # Conocimiento de negocio del proceso
├── web/                             # Chat en HTML plano
├── fixtures/                        # Fixtures del reto (no modificar)
├── out/                             # Salidas generadas (gitignored)
├── demo.ts                          # Ejecución directa de los 6 casos sin modelo
├── .env.example
├── package.json
├── README.md
└── SOLUCION.md
```
