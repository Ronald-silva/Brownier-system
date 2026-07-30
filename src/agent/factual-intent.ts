import { normalizeInterpreterText } from "./deterministic-interpreter.ts";

export type FactualIntent =
  | { kind: "ADDRESS"; address?: string }
  | { kind: "PICKUP_AVAILABILITY"; hours?: string }
  | { kind: "MENU" };

function tokens(text: string): Set<string> {
  return new Set(normalizeInterpreterText(text).split(" ").filter(Boolean));
}

// Intenções factuais são conceitos do domínio, não uma lista de frases. Elas
// têm prioridade porque a resposta vem do Store e não exige inferência nem
// pode ser inventada pelo provider.
export function resolveFactualIntent(input: {
  text: string;
  address?: string;
  hours?: string;
}): FactualIntent | undefined {
  const words = tokens(input.text);
  const asksLocation = words.has("endereco") || words.has("localizacao") || words.has("onde") || words.has("local");
  const pickupContext = words.has("retirada") || words.has("retirar") || words.has("coleta") || words.has("coletar") || words.has("loja") || words.has("fica") || words.has("ficam");
  // No canal da loja, uma pergunta explícita pelo endereço já se refere ao
  // endereço comercial; os demais termos desambiguam "onde/local".
  if (words.has("endereco") || words.has("localizacao") || (asksLocation && pickupContext)) {
    const address = input.address?.trim();
    return address ? { kind: "ADDRESS", address } : { kind: "ADDRESS" };
  }

  const asksNow = words.has("agora") || words.has("hoje") || words.has("horario");
  if (pickupContext && asksNow) {
    const hours = input.hours?.trim();
    return hours ? { kind: "PICKUP_AVAILABILITY", hours } : { kind: "PICKUP_AVAILABILITY" };
  }

  if (words.has("menu") || words.has("cardapio") || words.has("sabores") || words.has("preco") || words.has("precos")) {
    return { kind: "MENU" };
  }
  return undefined;
}
