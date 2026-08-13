// Message Catalog — templates de texto em português (pt-BR) para cada
// messageKey devolvido pelo Conversation Engine. Nenhuma lógica de conversa
// mora aqui, apenas a tradução de um resultado estruturado em texto
// humanizado. Não consulta Agent Tools nem Session Store.

export type AgentPlaceholderValues = Record<string, unknown>;

const FIELD_LABELS: Record<string, string> = {
  items: "itens",
  customerName: "nome",
  customerPhone: "telefone",
  fulfillmentType: "forma de retirada",
  pickupTime: "horário de retirada",
};

// Chaves batem com os códigos lançados por OrderCreationError (src/lib/orders.ts).
const ORDER_CREATION_FAILED_REASONS: Record<string, string> = {
  invalid_idempotency_key: "Ocorreu um problema técnico ao finalizar seu pedido. Tente novamente.",
  IDEMPOTENCY_KEY_REUSED: "Esse pedido já estava sendo processado. Tente novamente em instantes.",
  invalid_items: "Não conseguimos identificar os itens do seu pedido.",
  invalid_customer: "Precisamos do seu nome e telefone para finalizar o pedido.",
  invalid_fulfillment_or_payment: "A forma de retirada ou de pagamento informada não é válida.",
  invalid_delivery_address: "Precisamos do endereço para entrega.",
  pickup_disabled: "A retirada não está disponível no momento.",
  invalid_pickup_time: "Escolha um horário de retirada válido.",
  invalid_item: "Um dos itens do seu pedido ficou indisponível.",
};

const GENERIC_ORDER_CREATION_FAILED_REASON = "Ocorreu um problema ao finalizar seu pedido. Tente novamente em instantes.";

export function friendlyOrderCreationFailedReason(code: unknown): string {
  if (typeof code === "string" && ORDER_CREATION_FAILED_REASONS[code]) {
    return ORDER_CREATION_FAILED_REASONS[code];
  }
  return GENERIC_ORDER_CREATION_FAILED_REASON;
}

export function friendlyMissingFieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

export function formatCurrency(value: unknown): string {
  const amount = typeof value === "number" && Number.isFinite(value) ? value : 0;
  // Intl usa espaço não separável (U+00A0) entre "R$" e o valor — trocado por
  // espaço comum para manter o texto puro pedido pelo Renderer.
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })
    .format(amount)
    .replace(/\u00A0/g, " ");
}

export function formatList(items: unknown, bullet = "-"): string {
  if (!Array.isArray(items) || items.length === 0) return "";
  return items.map(item => `${bullet} ${String(item)}`).join("\n");
}

export function formatOptions(options: unknown): string {
  if (!Array.isArray(options) || options.length === 0) return "";
  return options.map(option => `• ${String(option)}`).join("\n");
}

// Aceita tanto o produto público das Tools (basePrice) quanto o produto já
// normalizado pela camada de apresentação (price) — o Renderer não sabe qual
// dos dois vem em cada chamada.
type CatalogProductLike = { name?: unknown; price?: unknown; basePrice?: unknown };

export function formatProducts(products: unknown): string {
  if (!Array.isArray(products) || products.length === 0) return "";
  return products
    .map((product, index) => {
      const p = (product ?? {}) as CatalogProductLike;
      const name = typeof p.name === "string" ? p.name : "";
      const price = p.price ?? p.basePrice;
      return `${index + 1}.\n${name}\n\n${formatCurrency(price)}`;
    })
    .join("\n\n");
}

// Interpolação simples de placeholders no formato {chave}. Placeholders sem
// valor correspondente em `values` viram string vazia — nunca lança erro.
export function interpolate(template: string, values: AgentPlaceholderValues): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = values[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

export const MESSAGE_CATALOG: Record<string, string> = {
  WELCOME: "{greeting}! Seja bem-vindo à {businessName} 😊 Como posso ajudar?",
  // Variante usada pelo Renderer quando a apresentação não resolve um nome de negócio.
  WELCOME_NO_NAME: "Olá! Seja bem-vindo 😊 Como posso ajudar?",
  MENU_READY: "🍫 Cardápio\n\n{products}",
  CART_READY: "Seu carrinho está aberto. Envie mais itens ou finalize quando estiver pronto.",
  ITEM_ADDED: "Item adicionado! Quantidade atual: {quantity}x.",
  ITEM_ADDED_WITH_NAME: "Adicionamos {quantity}x {productName} ao seu pedido.",
  // Usado quando um único lote de ações adiciona mais de um produto (ex.:
  // "2 brigadeiros e 1 de ninho" interpretado pela verbalização em uma só
  // mensagem) — ITEM_ADDED_WITH_NAME só descreve um produto por vez.
  ITEMS_ADDED_BATCH: "Adicionamos ao seu pedido:\n{items}",
  ITEM_QUANTITY_UPDATED: "Quantidade atualizada para {quantity}x.",
  ITEM_QUANTITY_UPDATED_WITH_NAME: "Quantidade de {productName} atualizada para {quantity}x.",
  ITEM_REMOVED: "Item removido do seu pedido.",
  ITEM_REMOVED_WITH_NAME: "{productName} foi removido do seu pedido.",
  CART_EMPTY: "Seu carrinho está vazio. Adicione itens antes de continuar.",
  INVALID_PRODUCT: "Não encontramos esse produto no cardápio. Poderia escolher novamente?",
  INVALID_QUANTITY: "Quantidade inválida. Informe um número válido de unidades.",
  ASK_CUSTOMER_NAME: "Para continuar, qual é o seu nome?",
  INVALID_CUSTOMER_NAME: "Não entendi o nome informado. Pode digitar novamente?",
  CUSTOMER_PHONE_SET: "Telefone registrado: {customerPhone}.",
  INVALID_CUSTOMER_PHONE: "Não entendi o telefone informado. Pode digitar novamente?",
  ASK_FULFILLMENT: "Como você prefere receber seu pedido? No momento só temos retirada no local.",
  ASK_PICKUP_TIME: "Qual horário você prefere para retirar seu pedido?",
  ASK_PICKUP_TIME_WITH_SLOTS: "Qual horário você prefere para retirar seu pedido?\n\n{pickupSlots}",
  INVALID_PICKUP_TIME: "Esse horário não está disponível. Escolha outro horário de retirada.",
  INVALID_PICKUP_TIME_WITH_SLOTS: "Esse horário não está disponível. Escolha um dos horários abaixo:\n\n{pickupSlots}",
  ASK_NOTES: "Deseja adicionar alguma observação ao pedido? Se não quiser, é só dizer que pode pular.",
  INVALID_CUSTOMER_NOTES: "A observação informada é muito longa. Pode encurtar e enviar novamente?",
  ASK_PAYMENT_METHOD: "Escolha a forma de pagamento:\n\n{options}",
  PAYMENT_METHOD_ACCEPTED: "Forma de pagamento escolhida: {paymentMethod}.",
  PAYMENT_METHOD_INVALID: "Essa forma de pagamento não é válida. Escolha uma das opções:\n\n{options}",
  PAYMENT_METHOD_UNAVAILABLE: "No momento não há formas de pagamento disponíveis. Vamos te encaminhar para um atendente.",
  PAYMENT_METHOD_REQUIRED: "Antes de confirmar, escolha uma forma de pagamento.",
  ORDER_REVIEW: "Pedido\n\n{items}\n\nRetirada:\n{pickupTime}\n\nPagamento:\n{paymentMethod}\n\nNome:\n{customerName}",
  INCOMPLETE_ORDER_DATA: "Ainda faltam algumas informações para finalizar seu pedido:\n\n{missingFields}",
  ORDER_CREATED: "Pedido criado com sucesso!\n\nCódigo:\n{publicCode}",
  ORDER_ALREADY_CREATED: "Seu pedido já tinha sido criado.\n\nCódigo:\n{publicCode}",
  ORDER_CREATION_FAILED: "{reason}",
  INVALID_ACTION: "Desculpe, não consegui entender essa ação. Vamos continuar de onde paramos?",
  CONVERSATION_CANCELLED: "Seu pedido foi cancelado. Quando quiser recomeçar, é só chamar.",
  CONVERSATION_RESET: "Tudo certo, vamos começar do zero.",
  HUMAN_HANDOFF_STARTED: "Vou te transferir para um atendente humano. Só um instante.",
  HUMAN_HANDOFF_STARTED_WITH_CONTACT:
    "Vou te transferir para um atendente humano. Só um instante.\n\nSe preferir, você também pode chamar direto em {contact}.",
  MESSAGE_ALREADY_PROCESSED: "",

  // Mensagens da Interpretation Policy (src/agent/text-conversation.service.ts) —
  // tratam contagem de não compreensão, ambiguidade e encaminhamento humano
  // automático. Nunca expõem contador técnico, etapa interna ou messageId.
  POLICY_NOT_UNDERSTOOD_FIRST: "Não consegui entender. Responda usando uma das opções apresentadas.",
  POLICY_NOT_UNDERSTOOD_REPEATED:
    "Ainda não consegui identificar sua resposta. Você pode escolher uma das opções ou pedir um atendente.",
  POLICY_AMBIGUOUS: "Encontrei mais de uma possibilidade. Pode especificar melhor?",
  POLICY_HANDOFF_TRIGGERED: "Não consegui concluir o atendimento automaticamente. Vou encaminhar você para uma pessoa.",
  POLICY_HUMAN_HANDOFF_ACTIVE: "Seu atendimento já foi encaminhado para uma pessoa. Aguarde o contato.",
  POLICY_LLM_TEMPORARILY_UNAVAILABLE:
    "Não consegui processar sua mensagem agora. Tente novamente em instantes ou peça um atendente.",
  POLICY_LLM_RECOVERY_START:
    "Ainda não consegui confirmar essa informação agora. Posso chamar um atendente para ajudar você.",
  POLICY_LLM_RECOVERY_ORDER:
    "Seu pedido continua salvo. Você pode enviar mais itens, finalizar quando estiver pronto ou pedir um atendente.",
  BUSINESS_ADDRESS: "O endereço para retirada é:\n\n{address}",
  BUSINESS_ADDRESS_UNAVAILABLE:
    "Ainda não tenho o endereço de retirada confirmado. Posso chamar um atendente para confirmar essa informação.",
  // Horário de funcionamento/retirada — texto sempre montado a partir de um
  // OperatingStatus já calculado por operating-status.ts (relógio real,
  // America/Fortaleza), nunca de string livre nem de inferência do modelo.
  BUSINESS_OPEN_NOW: "Sim, estamos abertos agora. Você pode retirar até às {closeTime}.",
  BUSINESS_CLOSED_TODAY: "No momento estamos fechados. Abrimos hoje às {nextOpenTime}.",
  BUSINESS_CLOSED_OTHER_DAY: "No momento estamos fechados. Nosso próximo horário de atendimento é {weekday}, às {nextOpenTime}.",
  BUSINESS_CLOSED_NO_NEXT_OPEN:
    "No momento estamos fechados e não encontrei o próximo horário de abertura. Posso chamar um atendente para confirmar.",
  BUSINESS_PICKUP_HOURS_UNAVAILABLE:
    "Ainda não tenho a confirmação do horário de retirada. Posso chamar um atendente para confirmar.",
  CART_TOTAL: "O total atual do seu pedido é {total}.",
  CART_TOTAL_EMPTY: "Seu carrinho ainda está vazio. Posso mostrar o cardápio para você escolher seus brownies.",
  POLICY_SUGGESTIONS_SUFFIX: "Escolha uma destas opções: {options}.",

  // Reconhecimento de intenções não-transacionais identificadas pelo
  // planejamento (ConversationIntent) — nunca mudam de assunto nem empurram
  // o pedido automaticamente. Usados como TEMPLATE por padrão e como
  // fallbackMessageKey quando a verbalização está habilitada mas falha.
  SOCIAL_ACKNOWLEDGED: "Fico à disposição! Posso ajudar com mais alguma coisa?",
  OBJECTION_ACKNOWLEDGED: "Entendo a preocupação com o valor. Posso ajudar com mais alguma dúvida sobre os itens?",
  OUT_OF_SCOPE_DECLINED:
    "Isso foge um pouco do que consigo ajudar por aqui. Posso ajudar com o cardápio, com o seu pedido ou com informações da loja.",
};

export const ALL_MESSAGE_KEYS: readonly string[] = Object.keys(MESSAGE_CATALOG);
