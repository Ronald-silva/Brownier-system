// Allowed Facts — a ÚNICA ponte entre o resultado real da execução
// (Conversation Engine + Agent Tools, inalterados) e o que a verbalização
// NVIDIA pode citar. Nunca inventa, arredonda ou infere: cada AllowedFact é
// lido diretamente de um resultado de ação já executado ou de uma consulta
// direta às Tools/operating-status.ts (relógio real). factId é único por
// instância dentro do array devolvido em cada turno.
import type { AgentConversationResult } from "./conversation.types.ts";
import type { AgentTools } from "./tools.ts";
import type { OperatingStatus } from "./operating-status.ts";
import type { AllowedFact, AllowedFactKey } from "./conversation-intelligence.types.ts";

function productFact(tools: AgentTools, productId: string): AllowedFact | undefined {
  const product = tools.getProduct(productId);
  if (!product) return undefined;
  return {
    factId: `product:${product.id}`,
    key: "PRODUCT",
    id: product.id,
    name: product.name,
    price: product.basePrice,
    promotionalPrice: product.promotionalPrice,
  };
}

function cartSummaryFact(tools: AgentTools, items: Array<{ productId: string; quantity: number }>): AllowedFact {
  return {
    factId: "cart_summary:turn",
    key: "CART_SUMMARY",
    items: items.map(item => ({
      productId: item.productId,
      name: tools.getProduct(item.productId)?.name ?? "Produto indisponível",
      quantity: item.quantity,
    })),
  };
}

function paymentOptionsFact(tools: AgentTools): AllowedFact | undefined {
  const options = tools.getBusiness().paymentMethods;
  if (!Array.isArray(options) || options.length === 0) return undefined;
  return { factId: "payment_options:turn", key: "PAYMENT_OPTIONS", options: [...options] };
}

function pickupSlotsFact(tools: AgentTools): AllowedFact | undefined {
  const slots = tools.getPickupSlots();
  if (!slots || slots.length === 0) return undefined;
  return { factId: "pickup_slots:turn", key: "PICKUP_SLOTS", slots: [...slots] };
}

function businessAddressFact(tools: AgentTools): AllowedFact | undefined {
  const address = tools.getBusinessAddress?.();
  if (!address) return undefined;
  return { factId: "business_address", key: "BUSINESS_ADDRESS", address };
}

function operatingStatusFact(status: OperatingStatus | undefined): AllowedFact | undefined {
  if (!status) return undefined;
  const day = status.known ? status.nowLocal.slice(0, 10) : "unknown";
  return { factId: `operating_status:${day}`, key: "OPERATING_STATUS", status };
}

function extractProductId(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  if (typeof data.productId === "string") return data.productId;
  const item = data.item as { productId?: unknown } | undefined;
  if (item && typeof item.productId === "string") return item.productId;
  return undefined;
}

// Dedup por factId, preservando a primeira ocorrência — garante a invariante
// de unicidade dentro do array final, mesmo quando o mesmo fato é requisitado
// por mais de uma fonte (ex.: ação executada + factKeys pedidos pelo plano).
function dedupeByFactId(facts: AllowedFact[]): AllowedFact[] {
  const seen = new Set<string>();
  const out: AllowedFact[] = [];
  for (const fact of facts) {
    if (seen.has(fact.factId)) continue;
    seen.add(fact.factId);
    out.push(fact);
  }
  return out;
}

export type BuildAllowedFactsInput = {
  result?: AgentConversationResult;
  tools: AgentTools;
  operatingStatus?: OperatingStatus;
  // Chaves adicionais pedidas pelo plano (ResponseIntent.ANSWER_FACTUAL) —
  // usadas para trazer fatos que a ação executada não produziu sozinha (ex.:
  // pergunta de endereço/horário no meio de uma etapa de checkout).
  requestedFactKeys?: AllowedFactKey[];
};

// --- fatos derivados diretamente do resultado real da execução --------------

function factsFromResult(result: AgentConversationResult, tools: AgentTools): AllowedFact[] {
  const { messageKey, data, session } = result;
  const facts: AllowedFact[] = [];

  switch (messageKey) {
    case "MENU_READY": {
      for (const product of tools.listProducts()) {
        const fact = productFact(tools, product.id);
        if (fact) facts.push(fact);
      }
      break;
    }
    case "ITEM_ADDED":
    case "ITEM_QUANTITY_UPDATED":
    case "ITEM_REMOVED": {
      const productId = extractProductId(data);
      if (productId) {
        const fact = productFact(tools, productId);
        if (fact) facts.push(fact);
      }
      facts.push(cartSummaryFact(tools, session.items));
      break;
    }
    case "ITEMS_ADDED_BATCH": {
      const items = Array.isArray((data as { items?: unknown } | undefined)?.items)
        ? ((data as { items: Array<{ productId?: unknown }> }).items)
        : [];
      for (const item of items) {
        if (typeof item?.productId === "string") {
          const fact = productFact(tools, item.productId);
          if (fact) facts.push(fact);
        }
      }
      facts.push(cartSummaryFact(tools, session.items));
      break;
    }
    case "CART_READY":
    case "ORDER_REVIEW": {
      facts.push(cartSummaryFact(tools, session.items));
      const payment = paymentOptionsFact(tools);
      if (payment) facts.push(payment);
      const pickup = pickupSlotsFact(tools);
      if (pickup) facts.push(pickup);
      break;
    }
    case "ASK_PAYMENT_METHOD":
    case "PAYMENT_METHOD_INVALID":
    case "PAYMENT_METHOD_UNAVAILABLE":
    case "PAYMENT_METHOD_REQUIRED": {
      const payment = paymentOptionsFact(tools);
      if (payment) facts.push(payment);
      break;
    }
    case "ASK_PICKUP_TIME":
    case "INVALID_PICKUP_TIME": {
      const pickup = pickupSlotsFact(tools);
      if (pickup) facts.push(pickup);
      break;
    }
    case "ORDER_CREATED":
    case "ORDER_ALREADY_CREATED": {
      const publicCode = typeof data?.publicCode === "string" ? data.publicCode : session.createdOrderPublicCode;
      if (publicCode) {
        facts.push({
          factId: `order_confirmation:${publicCode}`,
          key: "ORDER_CONFIRMATION",
          publicCode,
          replayed: typeof data?.replayed === "boolean" ? data.replayed : false,
        });
      }
      break;
    }
    case "ORDER_CREATION_FAILED": {
      const code = typeof data?.code === "string" ? data.code : "UNKNOWN";
      facts.push({ factId: `order_failure_reason:${code}`, key: "ORDER_FAILURE_REASON", reasonCode: code });
      break;
    }
    case "INCOMPLETE_ORDER_DATA": {
      const fields = Array.isArray(data?.missingFields) ? data.missingFields.filter((f): f is string => typeof f === "string") : [];
      facts.push({ factId: "missing_fields:turn", key: "MISSING_FIELDS", fields });
      break;
    }
    default:
      break;
  }

  return facts;
}

// --- fatos adicionais pedidos explicitamente pelo plano ---------------------

function factsForRequestedKeys(keys: AllowedFactKey[], tools: AgentTools, operatingStatus: OperatingStatus | undefined): AllowedFact[] {
  const facts: AllowedFact[] = [];
  for (const key of keys) {
    switch (key) {
      case "BUSINESS_ADDRESS": {
        const fact = businessAddressFact(tools);
        if (fact) facts.push(fact);
        break;
      }
      case "OPERATING_STATUS": {
        const fact = operatingStatusFact(operatingStatus ?? tools.getOperatingStatus?.());
        if (fact) facts.push(fact);
        break;
      }
      case "PICKUP_SLOTS": {
        const fact = pickupSlotsFact(tools);
        if (fact) facts.push(fact);
        break;
      }
      case "PAYMENT_OPTIONS": {
        const fact = paymentOptionsFact(tools);
        if (fact) facts.push(fact);
        break;
      }
      case "PRODUCT": {
        for (const product of tools.listProducts()) {
          const fact = productFact(tools, product.id);
          if (fact) facts.push(fact);
        }
        break;
      }
      // CART_SUMMARY/ORDER_CONFIRMATION/MISSING_FIELDS/ORDER_FAILURE_REASON só
      // fazem sentido atrelados a uma execução real — nunca pedidos "soltos".
      default:
        break;
    }
  }
  return facts;
}

export function buildAllowedFacts(input: BuildAllowedFactsInput): AllowedFact[] {
  const { result, tools, operatingStatus, requestedFactKeys } = input;
  const facts: AllowedFact[] = [];

  if (result) facts.push(...factsFromResult(result, tools));
  if (requestedFactKeys && requestedFactKeys.length > 0) {
    facts.push(...factsForRequestedKeys(requestedFactKeys, tools, operatingStatus));
  }

  return dedupeByFactId(facts);
}
