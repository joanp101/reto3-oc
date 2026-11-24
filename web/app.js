const chatLog = document.getElementById("chat-log");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const thinkingEl = document.getElementById("thinking-indicator");
const healthBadge = document.getElementById("health-badge");
const sessionLabel = document.getElementById("session-id-label");
const newSessionBtn = document.getElementById("new-session-btn");

let currentSessionId = localStorage.getItem("reto3_session_id") || crypto.randomUUID();
localStorage.setItem("reto3_session_id", currentSessionId);
sessionLabel.textContent = currentSessionId;

function scrollToBottom() {
  chatLog.scrollTop = chatLog.scrollHeight;
}

function appendMessage(role, text) {
  const el = document.createElement("article");
  el.className = `message ${role}`;
  el.textContent = text;
  chatLog.appendChild(el);
  scrollToBottom();
}

function appendToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return;

  const list = document.createElement("div");
  list.className = "tool-list";

  for (const tc of toolCalls) {
    const item = document.createElement("aside");
    item.className = tc.ok ? "tool-call" : "tool-call error";

    const header = document.createElement("div");
    header.className = "tool-header";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = `Herramienta: ${tc.name}`;
    const statusSpan = document.createElement("span");
    statusSpan.textContent = tc.ok ? "OK" : "ERROR";
    header.append(nameSpan, statusSpan);

    const argsDiv = document.createElement("div");
    argsDiv.className = "tool-args";
    argsDiv.textContent = `Args: ${JSON.stringify(tc.args ?? {})}`;

    const resDiv = document.createElement("div");
    resDiv.className = "tool-result";
    resDiv.textContent = `Resultado: ${tc.summary ?? JSON.stringify(tc.result)}`;

    item.append(header, argsDiv, resDiv);
    list.appendChild(item);
  }

  chatLog.appendChild(list);
  scrollToBottom();
}

function appendConfirmationHighlight() {
  const box = document.createElement("section");
  box.className = "confirmation-box";

  const title = document.createElement("strong");
  title.textContent = "Confirmación humana requerida";

  const desc = document.createElement("div");
  desc.textContent =
    "El agente pausó el flujo antes de crear la orden de compra. Confirma explícitamente para continuar o cancela.";

  const actions = document.createElement("div");
  actions.className = "confirmation-actions";

  const approveBtn = document.createElement("button");
  approveBtn.type = "button";
  approveBtn.className = "confirm-btn";
  approveBtn.textContent = "Confirmar";
  approveBtn.addEventListener("click", () => {
    void sendChatMessage("Confirmo, procede con la creación de la orden de compra.");
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "cancel-btn";
  cancelBtn.textContent = "No confirmar";
  cancelBtn.addEventListener("click", () => {
    void sendChatMessage("No confirmo, detén el proceso de creación.");
  });

  actions.append(approveBtn, cancelBtn);
  box.append(title, desc, actions);
  chatLog.appendChild(box);
  scrollToBottom();
}

function setLoading(loading) {
  thinkingEl.classList.toggle("hidden", !loading);
  chatInput.disabled = loading;
  sendBtn.disabled = loading;
}

async function sendChatMessage(message) {
  const trimmed = message.trim();
  if (!trimmed) return;

  appendMessage("user", trimmed);
  setLoading(true);

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: currentSessionId,
        message: trimmed,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      appendMessage("assistant", data.error || "Error al comunicarse con el servidor.");
      return;
    }

    if (data.sessionId && data.sessionId !== currentSessionId) {
      currentSessionId = data.sessionId;
      localStorage.setItem("reto3_session_id", currentSessionId);
      sessionLabel.textContent = currentSessionId;
    }

    appendToolCalls(data.toolCalls);
    appendMessage("assistant", data.reply || "");
    if (data.needsConfirmation) {
      appendConfirmationHighlight();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error de red";
    appendMessage("assistant", `No se pudo contactar al backend: ${msg}`);
  } finally {
    setLoading(false);
    chatInput.focus();
  }
}

async function loadHealth() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    if (res.ok && data.ok) {
      healthBadge.textContent = `${data.provider} · ${data.model}`;
      healthBadge.classList.add("ok");
      return;
    }
  } catch {
    // ignorar error de red en salud inicial
  }
  healthBadge.textContent = "Sin conexión";
}

async function restoreSession() {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}`);
    if (!res.ok) return;
    const data = await res.json();
    chatLog.innerHTML = "";
    for (const msg of data.messages ?? []) {
      if (msg.role === "assistant") {
        appendToolCalls(msg.toolCalls);
        appendMessage("assistant", msg.content);
        if (msg.needsConfirmation) {
          appendConfirmationHighlight();
        }
      } else {
        appendMessage("user", msg.content);
      }
    }
  } catch {
    // sesión nueva o servidor reiniciado
  }
}

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = chatInput.value;
  if (!message.trim()) return;
  chatInput.value = "";
  void sendChatMessage(message);
});

newSessionBtn.addEventListener("click", () => {
  currentSessionId = crypto.randomUUID();
  localStorage.setItem("reto3_session_id", currentSessionId);
  sessionLabel.textContent = currentSessionId;
  chatLog.innerHTML = "";
  chatInput.focus();
});

void loadHealth();
void restoreSession();
