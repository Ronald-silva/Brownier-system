import { normalizeInterpreterText } from "./deterministic-interpreter.ts";

export type CommercialInformationRequest =
  | { kind: "ADDRESS"; address?: string };

// Classificador semântico pequeno para fatos comerciais públicos. Não tenta
// converter frases inteiras em comandos: identifica conceitos de localização
// e deixa o valor vir exclusivamente do Store, via Agent Tools.
const LOCATION_TERMS = new Set(["endereco", "localizacao", "local", "onde"]);
const PICKUP_TERMS = new Set(["retirada", "retirar", "coleta", "coletar", "buscar", "loja", "fica", "ficam"]);

function words(text: string): string[] {
  return normalizeInterpreterText(text).split(" ").filter(Boolean);
}

export function resolveCommercialInformationRequest(
  text: string,
  address: string | undefined,
): CommercialInformationRequest | undefined {
  const tokens = words(text);
  const asksLocation = tokens.some(token => LOCATION_TERMS.has(token));
  const mentionsPickupContext = tokens.some(token => PICKUP_TERMS.has(token));
  if (!asksLocation || (!mentionsPickupContext && !tokens.includes("endereco") && !tokens.includes("localizacao"))) {
    return undefined;
  }
  const normalizedAddress = typeof address === "string" ? address.trim() : "";
  return normalizedAddress ? { kind: "ADDRESS", address: normalizedAddress } : { kind: "ADDRESS" };
}
