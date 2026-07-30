import crypto from "node:crypto";
import type { RequestHandler } from "express";

const MAX_TEXT_LENGTH = 4_096;
const REQUEST_TIMEOUT_MS = 10_000;

export type EvolutionGoConfig = {
  baseUrl: string;
  instanceName: string;
  instanceToken: string;
};

export type EvolutionGoIncomingText = {
  instanceName: string;
  messageId: string;
  contactId: string;
  text: string;
};

export type EvolutionGoWebhookParseResult =
  | { kind: "message"; message: EvolutionGoIncomingText }
  | { kind: "ignored"; reason: "unsupported_event" | "own_message" | "group" | "status" | "unsupported_message" }
  | { kind: "invalid" };

export class EvolutionGoClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvolutionGoClientError";
  }
}

type JsonRecord = Record<string, unknown>;

export type EvolutionGoTextSender = {
  sendText(input: { contactId: string; text: string }): Promise<void>;
};

export type CreateEvolutionGoTextSenderOptions = {
  config: EvolutionGoConfig;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

export function readEvolutionWebhookToken(
  env: Record<string, string | undefined>,
  options: { production: boolean; evolutionConfigured: boolean },
): string | undefined {
  const token = env.EVOLUTION_WEBHOOK_TOKEN?.trim() ?? "";
  if (!token && (options.production || options.evolutionConfigured)) {
    throw new Error("EVOLUTION_WEBHOOK_TOKEN deve ser definido para proteger o webhook Evolution Go.");
  }
  return token || undefined;
}

function hasValidWebhookToken(received: unknown, expected: string | undefined): boolean {
  if (typeof received !== "string" || !expected) return false;
  const receivedBuffer = Buffer.from(received, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (receivedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

export type EvolutionGoConversationProcessor = {
  processText(input: { channel: "whatsapp"; contactId: string; messageId: string; text: string }): Promise<{
    duplicateMessage: boolean;
    messages: Array<{ type: "text"; text: string }>;
  }>;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function contactFromJid(value: string): string | undefined {
  const user = value.split("@", 1)[0]?.split(":", 1)[0] ?? "";
  const digits = user.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 20 ? digits : undefined;
}

function textFromMessage(message: JsonRecord): string | undefined {
  const conversation = readNonEmptyString(message.conversation);
  if (conversation) return conversation;
  const extended = message.extendedTextMessage;
  if (!isRecord(extended)) return undefined;
  return readNonEmptyString(extended.text);
}

export function readEvolutionGoConfig(env: Record<string, string | undefined>): EvolutionGoConfig | undefined {
  const baseUrl = env.EVOLUTION_BASE_URL?.trim() ?? "";
  const instanceName = env.EVOLUTION_INSTANCE_NAME?.trim() ?? "";
  const instanceToken = env.EVOLUTION_INSTANCE_TOKEN?.trim() ?? "";
  if (!baseUrl && !instanceName && !instanceToken) return undefined;
  if (!baseUrl || !instanceName || !instanceToken) {
    throw new Error("EVOLUTION_BASE_URL, EVOLUTION_INSTANCE_NAME e EVOLUTION_INSTANCE_TOKEN devem ser definidos juntos.");
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("EVOLUTION_BASE_URL deve ser uma URL HTTP(S) válida.");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new Error("EVOLUTION_BASE_URL deve ser uma URL HTTP(S) sem credenciais embutidas.");
  }
  return { baseUrl: parsed.toString().replace(/\/$/, ""), instanceName, instanceToken };
}

// Contrato oficial Evolution Go 0.7.2: event="Message", data.Info e
// data.Message. A API não assina o webhook; logo, nenhum segredo/HMAC é
// inventado nesta borda.
export function parseEvolutionGoWebhook(payload: unknown): EvolutionGoWebhookParseResult {
  if (!isRecord(payload)) return { kind: "invalid" };
  if (payload.event !== "Message") return { kind: "ignored", reason: "unsupported_event" };
  const instanceName = readNonEmptyString(payload.instanceName);
  const data = payload.data;
  if (!instanceName || !isRecord(data) || !isRecord(data.Info) || !isRecord(data.Message)) return { kind: "invalid" };
  const info = data.Info;
  const messageId = readNonEmptyString(info.ID);
  const sender = readNonEmptyString(info.Sender);
  const chat = readNonEmptyString(info.Chat);
  const type = readNonEmptyString(info.Type);
  if (!messageId || !sender || !chat || !type || typeof info.IsFromMe !== "boolean" || typeof info.IsGroup !== "boolean") {
    return { kind: "invalid" };
  }
  if (info.IsFromMe) return { kind: "ignored", reason: "own_message" };
  if (info.IsGroup || chat.endsWith("@g.us")) return { kind: "ignored", reason: "group" };
  if (chat.endsWith("@broadcast") || sender.endsWith("@broadcast")) return { kind: "ignored", reason: "status" };
  const contactId = contactFromJid(sender);
  const text = textFromMessage(data.Message);
  if (!contactId || !text || text.length > MAX_TEXT_LENGTH) return { kind: "ignored", reason: "unsupported_message" };
  return { kind: "message", message: { instanceName, messageId, contactId, text } };
}

export function createEvolutionGoTextSender(options: CreateEvolutionGoTextSenderOptions): EvolutionGoTextSender {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return {
    async sendText({ contactId, text }) {
      if (!/^\d{8,20}$/.test(contactId) || typeof text !== "string" || !text.trim() || text.length > MAX_TEXT_LENGTH) {
        throw new EvolutionGoClientError("Mensagem de saída inválida.");
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchFn(`${options.config.baseUrl}/send/text`, {
          method: "POST",
          headers: { "content-type": "application/json", apikey: options.config.instanceToken },
          body: JSON.stringify({ number: contactId, text, formatJid: true }),
          signal: controller.signal,
        });
        if (!response.ok) throw new EvolutionGoClientError("Evolution Go recusou o envio da mensagem.");
      } catch (error) {
        if (error instanceof EvolutionGoClientError) throw error;
        throw new EvolutionGoClientError("Não foi possível enviar a mensagem ao Evolution Go.");
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export function createEvolutionGoWebhookHandler(input: {
  config?: EvolutionGoConfig;
  webhookToken?: string;
  conversation: EvolutionGoConversationProcessor;
  sender?: EvolutionGoTextSender;
}): RequestHandler {
  return async (req, res) => {
    // O token é validado antes de ler ou normalizar o payload. Não registrar
    // req.originalUrl/query: ambos conteriam o segredo configurado na URL.
    if (!hasValidWebhookToken(req.query?.token, input.webhookToken)) {
      res.status(401).json({ error: "Não autorizado." });
      return;
    }
    if (!input.config || !input.sender) {
      res.status(503).json({ error: "Integração WhatsApp indisponível." });
      return;
    }
    const parsed = parseEvolutionGoWebhook(req.body);
    if (parsed.kind === "invalid") {
      res.status(400).json({ error: "Payload Evolution Go inválido." });
      return;
    }
    if (parsed.kind === "ignored" || parsed.message.instanceName !== input.config.instanceName) {
      res.status(204).end();
      return;
    }
    try {
      const { contactId, messageId, text } = parsed.message;
      const result = await input.conversation.processText({ channel: "whatsapp", contactId, messageId, text });
      if (!result.duplicateMessage) {
        for (const message of result.messages) {
          await input.sender.sendText({ contactId, text: message.text });
        }
      }
      res.status(200).json({ status: "accepted" });
    } catch {
      // Não registrar payload, número, token, URL ou resposta do provider.
      console.error("Falha ao processar webhook Evolution Go.");
      res.status(502).json({ error: "Não foi possível processar a mensagem." });
    }
  };
}
