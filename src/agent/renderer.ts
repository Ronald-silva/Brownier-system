// Renderer — transforma um AgentConversationPresentation (result + context
// público já resolvido) em AgentChatMessage[] usando o Message Catalog.
// Não importa Agent Tools, não consulta o domínio e não conhece Session
// Store, WhatsApp ou HTML/Markdown complexo: apenas texto puro em
// português, a partir do que já está em `presentation.context`.
import { randomUUID } from "node:crypto";
import type { AgentConversationPresentation, AgentPresentationContext } from "./presentation.ts";
import type { AgentConversationResult } from "./conversation.types.ts";
import {
  MESSAGE_CATALOG,
  interpolate,
  formatProducts,
  formatOptions,
  formatList,
  formatCurrency,
  friendlyOrderCreationFailedReason,
  friendlyMissingFieldLabel,
} from "./messages.ts";

export type AgentChatMessage = {
  id: string;
  type: "text";
  text: string;
  metadata?: Record<string, unknown>;
};

type RawData = Record<string, unknown> | undefined;

function buildText(messageKey: string, context: AgentPresentationContext, data: RawData): string {
  const d = data ?? {};

  switch (messageKey) {
    case "WELCOME": {
      const business = d.business as { name?: unknown } | undefined;
      const name = context.business?.name ?? (typeof business?.name === "string" ? business.name : undefined);
      return name
        ? interpolate(MESSAGE_CATALOG.WELCOME, { businessName: name, greeting: context.business?.greeting ?? "Olá" })
        : MESSAGE_CATALOG.WELCOME_NO_NAME;
    }

    case "MENU_READY": {
      const products = context.products ?? (Array.isArray(d.products) ? d.products : []);
      return interpolate(MESSAGE_CATALOG.MENU_READY, { products: formatProducts(products) });
    }

    case "ITEM_ADDED": {
      const name = context.currentProduct?.name;
      const base = name
        ? interpolate(MESSAGE_CATALOG.ITEM_ADDED_WITH_NAME, { quantity: d.quantity, productName: name })
        : interpolate(MESSAGE_CATALOG.ITEM_ADDED, { quantity: d.quantity });
      return context.cartQuote ? `${base}\n\nTotal parcial: ${formatCurrency(context.cartQuote.total)}.` : base;
    }

    case "ITEMS_ADDED_BATCH": {
      const items = context.cartItems ?? [];
      if (items.length === 0) return MESSAGE_CATALOG.ITEM_ADDED;
      const lines = items.map(item => `${item.quantity}x ${item.name}`);
      const base = interpolate(MESSAGE_CATALOG.ITEMS_ADDED_BATCH, { items: formatList(lines) });
      return context.cartQuote ? `${base}\n\nTotal parcial: ${formatCurrency(context.cartQuote.total)}.` : base;
    }

    case "CART_READY":
      return context.cartQuote
        ? `${MESSAGE_CATALOG.CART_READY}\n\nTotal parcial: ${formatCurrency(context.cartQuote.total)}.`
        : MESSAGE_CATALOG.CART_READY;

    case "ITEM_QUANTITY_UPDATED": {
      const name = context.currentProduct?.name;
      const base = name
        ? interpolate(MESSAGE_CATALOG.ITEM_QUANTITY_UPDATED_WITH_NAME, { quantity: d.quantity, productName: name })
        : interpolate(MESSAGE_CATALOG.ITEM_QUANTITY_UPDATED, { quantity: d.quantity });
      return context.cartQuote ? `${base}\n\nTotal parcial: ${formatCurrency(context.cartQuote.total)}.` : base;
    }

    case "ITEM_REMOVED": {
      const name = context.currentProduct?.name;
      const base = name ? interpolate(MESSAGE_CATALOG.ITEM_REMOVED_WITH_NAME, { productName: name }) : MESSAGE_CATALOG.ITEM_REMOVED;
      return context.cartQuote ? `${base}\n\nTotal parcial: ${formatCurrency(context.cartQuote.total)}.` : base;
    }

    case "CUSTOMER_PHONE_SET":
      return interpolate(MESSAGE_CATALOG.CUSTOMER_PHONE_SET, { customerPhone: d.customerPhone });

    case "ASK_PAYMENT_METHOD":
    case "PAYMENT_METHOD_INVALID": {
      const options = context.paymentOptions ?? (Array.isArray(d.options) ? d.options : undefined);
      const formatted = formatOptions(options);
      if (!formatted) return MESSAGE_CATALOG.PAYMENT_METHOD_UNAVAILABLE;
      const base = messageKey === "ASK_PAYMENT_METHOD" ? MESSAGE_CATALOG.ASK_PAYMENT_METHOD : MESSAGE_CATALOG.PAYMENT_METHOD_INVALID;
      return interpolate(base, { options: formatted });
    }

    case "PAYMENT_METHOD_UNAVAILABLE":
      return MESSAGE_CATALOG.PAYMENT_METHOD_UNAVAILABLE;

    case "PAYMENT_METHOD_REQUIRED":
      return MESSAGE_CATALOG.PAYMENT_METHOD_REQUIRED;

    case "PAYMENT_METHOD_ACCEPTED":
      return interpolate(MESSAGE_CATALOG.PAYMENT_METHOD_ACCEPTED, { paymentMethod: context.paymentMethod ?? d.paymentMethod });

    case "ASK_PICKUP_TIME":
    case "INVALID_PICKUP_TIME": {
      const slots = context.pickupSlots ?? (Array.isArray(d.pickupSlots) ? d.pickupSlots : []);
      const formatted = formatList(slots);
      if (!formatted) {
        return messageKey === "ASK_PICKUP_TIME" ? MESSAGE_CATALOG.ASK_PICKUP_TIME : MESSAGE_CATALOG.INVALID_PICKUP_TIME;
      }
      const withSlots =
        messageKey === "ASK_PICKUP_TIME" ? MESSAGE_CATALOG.ASK_PICKUP_TIME_WITH_SLOTS : MESSAGE_CATALOG.INVALID_PICKUP_TIME_WITH_SLOTS;
      return interpolate(withSlots, { pickupSlots: formatted });
    }

    case "ORDER_REVIEW": {
      type LegacyItem = { quantity?: unknown; productId?: unknown; product?: { name?: unknown } | null };
      const items =
        context.cartItems ??
        (Array.isArray(d.items)
          ? (d.items as LegacyItem[]).map(item => ({
              quantity: item.quantity ?? 0,
              name: (typeof item.product?.name === "string" ? item.product.name : item.productId) ?? "",
              unitPrice: undefined as number | undefined,
            }))
          : []);
      const itemLines = items.map(item => {
        const priceSuffix =
          typeof item.unitPrice === "number" ? ` — preço unitário de catálogo ${formatCurrency(item.unitPrice)}` : "";
        return `${item.quantity ?? 0}x ${item.name}${priceSuffix}`;
      });

      const pickupTime = context.pickupTime ?? d.pickupTime;
      const paymentMethod = context.paymentMethod ?? d.paymentMethod;
      const customerName = context.customerName ?? d.customerName;
      const customerNotes = context.customerNotes ?? d.customerNotes;

      const sections = [`Pedido\n\n${formatList(itemLines)}`];
      if (pickupTime) sections.push(`Retirada:\n${pickupTime}`);
      if (paymentMethod) sections.push(`Pagamento:\n${paymentMethod}`);
      if (customerName) sections.push(`Nome:\n${customerName}`);
      if (customerNotes) sections.push(`Observações:\n${customerNotes}`);
      if (context.cartQuote) {
        if (context.cartQuote.discount > 0) sections.push(`Desconto:\n${formatCurrency(context.cartQuote.discount)}`);
        sections.push(`Total do pedido:\n${formatCurrency(context.cartQuote.total)}`);
      }
      return sections.join("\n\n");
    }

    case "INCOMPLETE_ORDER_DATA": {
      const missing = context.missingFields ?? (Array.isArray(d.missingFields) ? d.missingFields.map(String) : []);
      const labeled = missing.map(field => friendlyMissingFieldLabel(field));
      return interpolate(MESSAGE_CATALOG.INCOMPLETE_ORDER_DATA, { missingFields: formatList(labeled) });
    }

    case "ORDER_CREATED":
    case "ORDER_ALREADY_CREATED": {
      const publicCode = context.order?.publicCode ?? d.publicCode;
      const base = messageKey === "ORDER_CREATED" ? MESSAGE_CATALOG.ORDER_CREATED : MESSAGE_CATALOG.ORDER_ALREADY_CREATED;
      return interpolate(base, { publicCode });
    }

    case "ORDER_CREATION_FAILED":
      return friendlyOrderCreationFailedReason(context.reasonCode ?? d.code);

    case "HUMAN_HANDOFF_STARTED": {
      const contact = context.business?.whatsapp ?? context.business?.phone;
      return contact
        ? interpolate(MESSAGE_CATALOG.HUMAN_HANDOFF_STARTED_WITH_CONTACT, { contact })
        : MESSAGE_CATALOG.HUMAN_HANDOFF_STARTED;
    }

    default:
      return MESSAGE_CATALOG[messageKey] ?? MESSAGE_CATALOG.INVALID_ACTION;
  }
}

export function renderConversationPresentation(presentation: AgentConversationPresentation): AgentChatMessage[] {
  const { result, context } = presentation;
  if (result.messageKey === "MESSAGE_ALREADY_PROCESSED") return [];

  return [
    {
      id: randomUUID(),
      type: "text",
      text: buildText(result.messageKey, context, result.data),
      metadata: { messageKey: result.messageKey },
    },
  ];
}

// Wrapper de compatibilidade para consumidores que só têm o
// AgentConversationResult (sem Presentation Context Builder). Renderiza
// apenas com os dados já existentes em `result.data` — não busca nada
// externo e continua produzindo mensagens genéricas quando falta contexto.
export function renderConversationResult(result: AgentConversationResult): AgentChatMessage[] {
  return renderConversationPresentation({ result, session: result.session, context: {} });
}

// Resultado estruturado da Interpretation Policy (src/agent/text-conversation.service.ts) —
// nunca é um AgentConversationResult do Engine, apenas um messageKey/data
// próprios da política de não compreensão/ambiguidade/handoff automático.
export type TextConversationPolicyPresentationInput = {
  messageKey: string;
  data?: Record<string, unknown>;
};

// Renderiza as mensagens humanizadas da Interpretation Policy. Nunca expõe
// contador técnico, etapa interna, messageId ou candidatos com productId —
// apenas o texto fixo do Message Catalog e, quando houver, uma lista curta
// de sugestões públicas.
export function renderTextConversationPolicyMessage(input: TextConversationPolicyPresentationInput): AgentChatMessage[] {
  const { messageKey, data } = input;
  if (messageKey === "MESSAGE_ALREADY_PROCESSED") return [];

  let text: string;
  switch (messageKey) {
    case "INTERPRETATION_NOT_UNDERSTOOD": {
      const remainingAttempts = typeof data?.remainingAttempts === "number" ? data.remainingAttempts : undefined;
      const base =
        remainingAttempts !== undefined && remainingAttempts <= 1
          ? MESSAGE_CATALOG.POLICY_NOT_UNDERSTOOD_REPEATED
          : MESSAGE_CATALOG.POLICY_NOT_UNDERSTOOD_FIRST;
      const suggestions = Array.isArray(data?.suggestions) ? (data.suggestions as unknown[]).map(String) : [];
      text =
        suggestions.length > 0
          ? `${base}\n\n${interpolate(MESSAGE_CATALOG.POLICY_SUGGESTIONS_SUFFIX, { options: suggestions.join(", ") })}`
          : base;
      break;
    }
    case "INTERPRETATION_AMBIGUOUS":
      text = MESSAGE_CATALOG.POLICY_AMBIGUOUS;
      break;
    case "HUMAN_HANDOFF_AUTOMATIC":
      text = MESSAGE_CATALOG.POLICY_HANDOFF_TRIGGERED;
      break;
    case "HUMAN_HANDOFF_ACTIVE":
      text = MESSAGE_CATALOG.POLICY_HUMAN_HANDOFF_ACTIVE;
      break;
    case "POLICY_LLM_TEMPORARILY_UNAVAILABLE":
      text = data?.recovery === "ORDER"
        ? MESSAGE_CATALOG.POLICY_LLM_RECOVERY_ORDER
        : MESSAGE_CATALOG.POLICY_LLM_RECOVERY_START;
      break;
    case "BUSINESS_ADDRESS":
      text = interpolate(MESSAGE_CATALOG.BUSINESS_ADDRESS, { address: data?.address });
      break;
    case "BUSINESS_ADDRESS_UNAVAILABLE":
      text = MESSAGE_CATALOG.BUSINESS_ADDRESS_UNAVAILABLE;
      break;
    case "BUSINESS_OPEN_NOW":
      text = interpolate(MESSAGE_CATALOG.BUSINESS_OPEN_NOW, { closeTime: data?.closeTime });
      break;
    case "BUSINESS_CLOSED_TODAY":
      text = interpolate(MESSAGE_CATALOG.BUSINESS_CLOSED_TODAY, { nextOpenTime: data?.nextOpenTime });
      break;
    case "BUSINESS_CLOSED_OTHER_DAY":
      text = interpolate(MESSAGE_CATALOG.BUSINESS_CLOSED_OTHER_DAY, { weekday: data?.weekday, nextOpenTime: data?.nextOpenTime });
      break;
    case "BUSINESS_CLOSED_NO_NEXT_OPEN":
      text = MESSAGE_CATALOG.BUSINESS_CLOSED_NO_NEXT_OPEN;
      break;
    case "BUSINESS_PICKUP_HOURS_UNAVAILABLE":
      text = MESSAGE_CATALOG.BUSINESS_PICKUP_HOURS_UNAVAILABLE;
      break;
    case "OUT_OF_SCOPE_PRODUCT":
      text = MESSAGE_CATALOG.OUT_OF_SCOPE_PRODUCT;
      break;
    case "PRODUCT_NOT_IN_MENU":
      text = MESSAGE_CATALOG.PRODUCT_NOT_IN_MENU;
      break;
    case "CART_TOTAL":
      text = interpolate(MESSAGE_CATALOG.CART_TOTAL, { total: data?.total });
      break;
    case "CART_TOTAL_EMPTY":
      text = MESSAGE_CATALOG.CART_TOTAL_EMPTY;
      break;
    case "BUSINESS_RESPONSIBLE":
      text = interpolate(MESSAGE_CATALOG.BUSINESS_RESPONSIBLE, { name: data?.name });
      break;
    case "BUSINESS_PAYMENT_OPTIONS":
      text = interpolate(MESSAGE_CATALOG.BUSINESS_PAYMENT_OPTIONS, { options: formatOptions(data?.options) });
      break;
    case "BUSINESS_PIX_KEY":
      text = interpolate(MESSAGE_CATALOG.BUSINESS_PIX_KEY, { pixKey: data?.pixKey, whatsappLink: data?.whatsappLink });
      break;
    case "BUSINESS_PAYMENT_PROOF":
      text = MESSAGE_CATALOG.BUSINESS_PAYMENT_PROOF;
      break;
    case "BUSINESS_WHATSAPP_LINK":
      text = interpolate(MESSAGE_CATALOG.BUSINESS_WHATSAPP_LINK, { whatsappLink: data?.whatsappLink });
      break;
    case "BUSINESS_WHATSAPP_UNAVAILABLE":
      text = MESSAGE_CATALOG.BUSINESS_WHATSAPP_UNAVAILABLE;
      break;
    case "BUSINESS_OPERATING_HOURS":
      text = interpolate(MESSAGE_CATALOG.BUSINESS_OPERATING_HOURS, { hours: data?.hours });
      break;
    case "BUSINESS_TOMORROW_OPEN":
      text = interpolate(MESSAGE_CATALOG.BUSINESS_TOMORROW_OPEN, { weekday: data?.weekday, hours: data?.hours });
      break;
    case "BUSINESS_TOMORROW_CLOSED":
      text = interpolate(MESSAGE_CATALOG.BUSINESS_TOMORROW_CLOSED, { weekday: data?.weekday });
      break;
    case "BUSINESS_PIX_KEY_UNAVAILABLE":
      text = MESSAGE_CATALOG.BUSINESS_PIX_KEY_UNAVAILABLE;
      break;
    case "BUSINESS_DELIVERY_UNAVAILABLE":
      text = MESSAGE_CATALOG.BUSINESS_DELIVERY_UNAVAILABLE;
      break;
    case "HUMAN_HANDOFF_CONFIRMATION_REQUIRED":
      text = MESSAGE_CATALOG.HUMAN_HANDOFF_CONFIRMATION_REQUIRED;
      break;
    default:
      text = MESSAGE_CATALOG.INVALID_ACTION;
  }

  return [
    {
      id: randomUUID(),
      type: "text",
      text,
      metadata: {
        policyMessageKey: messageKey,
        ...(messageKey === "BUSINESS_PIX_KEY" && typeof data?.pixKey === "string" ? { pixKey: data.pixKey } : {}),
      },
    },
  ];
}
