// Memória conversacional de curto prazo — função pura, sem I/O. Mantém um
// teto fixo de entradas (mais antigas saem primeiro), no mesmo espírito do
// já existente maxProcessedMessageIds (session.store.ts). Nunca decide ação
// nem é usada como fonte de fato (preço, produto, endereço, horário): só
// contexto linguístico para as chamadas NVIDIA de planejamento/verbalização.
import type { AgentShortHistoryEntry } from "./session.types.ts";

export const DEFAULT_SHORT_HISTORY_LIMIT = 12;
const MAX_ENTRY_TEXT_LENGTH = 500;

// Nunca registra tokens, telefone completo, payload bruto ou metadados
// técnicos — só o texto humano já sanitizado que o cliente/agente trocou.
function sanitizeEntryText(text: string): string {
  const trimmed = typeof text === "string" ? text.trim() : "";
  return trimmed.length > MAX_ENTRY_TEXT_LENGTH ? trimmed.slice(0, MAX_ENTRY_TEXT_LENGTH) : trimmed;
}

export function appendShortHistory(
  history: AgentShortHistoryEntry[] | undefined,
  entry: AgentShortHistoryEntry,
  limit: number = DEFAULT_SHORT_HISTORY_LIMIT,
): AgentShortHistoryEntry[] {
  const text = sanitizeEntryText(entry.text);
  if (!text) return Array.isArray(history) ? [...history] : [];
  const base = Array.isArray(history) ? [...history] : [];
  const next = [
    ...base,
    entry.messageId ? { role: entry.role, text, at: entry.at, messageId: entry.messageId } : { role: entry.role, text, at: entry.at },
  ];
  while (next.length > limit) next.shift();
  return next;
}

export function appendShortHistoryTurn(
  history: AgentShortHistoryEntry[] | undefined,
  input: {
    customerText: string;
    customerAt: string;
    customerMessageId?: string;
    agentText?: string;
    agentAt: string;
  },
  limit: number = DEFAULT_SHORT_HISTORY_LIMIT,
): AgentShortHistoryEntry[] {
  let next = appendShortHistory(
    history,
    { role: "customer", text: input.customerText, at: input.customerAt, ...(input.customerMessageId ? { messageId: input.customerMessageId } : {}) },
    limit,
  );
  if (input.agentText && input.agentText.trim()) {
    next = appendShortHistory(next, { role: "agent", text: input.agentText, at: input.agentAt }, limit);
  }
  return next;
}
