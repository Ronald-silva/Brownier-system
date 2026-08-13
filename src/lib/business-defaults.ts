import { INITIAL_OPERATING_HOURS, isStructuredWeeklyHours } from "./business-hours.ts";

export const BROWNIER_PICKUP_ADDRESS = "Rua Professor Leite Gondim, 896, Antônio Bezerra, Fortaleza – CE, CEP 60360-332";
export const BROWNIER_RESPONSIBLE_NAME = "Mateus";
export const BROWNIER_PIX_KEY = "38.011.069/0001-93";
export const BROWNIER_WHATSAPP = "+55 85 9145-7889";
export const BROWNIER_PAYMENT_METHODS = ["PIX", "DINHEIRO"] as const;
export const BROWNIER_DELIVERY_ENABLED = false;
export const BROWNIER_HOURS_VERSION = 2;

type StoreWithBusiness = { business: Record<string, unknown> };

// O endereço de retirada é uma informação comercial oficial. Além de compor
// a semente, este backfill mantém instalações que já tinham o JSON criado com
// o valor vazio consistentes após reinício ou novo deploy.
export function ensureBrownierPickupAddress<T extends StoreWithBusiness>(store: T): T {
  if (store.business.address === BROWNIER_PICKUP_ADDRESS) return store;
  return {
    ...store,
    business: {
      ...store.business,
      address: BROWNIER_PICKUP_ADDRESS,
    },
  };
}

// Fato comercial confirmado pelo responsável. Mantido no Store para que o
// agente responda de modo determinístico, inclusive em instalações antigas.
export function ensureBrownierResponsible<T extends StoreWithBusiness>(store: T): T {
  if (store.business.responsibleName === BROWNIER_RESPONSIBLE_NAME) return store;
  return { ...store, business: { ...store.business, responsibleName: BROWNIER_RESPONSIBLE_NAME } };
}

// Chave PIX comercial confirmada. O backfill aplica o dado em instalações
// existentes, para que o atendimento nunca precise inventar informação de
// pagamento nem encaminhar uma dúvida simples.
export function ensureBrownierPixKey<T extends StoreWithBusiness>(store: T): T {
  if (store.business.pixKey === BROWNIER_PIX_KEY) return store;
  return { ...store, business: { ...store.business, pixKey: BROWNIER_PIX_KEY } };
}

// Canal oficial para comprovantes e dúvidas. O backfill mantém o contato
// disponível tanto para o link público do site quanto para o agente.
export function ensureBrownierWhatsapp<T extends StoreWithBusiness>(store: T): T {
  if (store.business.whatsapp === BROWNIER_WHATSAPP) return store;
  return { ...store, business: { ...store.business, whatsapp: BROWNIER_WHATSAPP } };
}

export function ensureBrownierPaymentMethods<T extends StoreWithBusiness>(store: T): T {
  const current = store.business.paymentMethods;
  if (Array.isArray(current) && current.length === BROWNIER_PAYMENT_METHODS.length && current.every((value, index) => value === BROWNIER_PAYMENT_METHODS[index])) return store;
  return { ...store, business: { ...store.business, paymentMethods: [...BROWNIER_PAYMENT_METHODS] } };
}

export function ensureBrownierDeliveryEnabled<T extends StoreWithBusiness>(store: T): T {
  if (store.business.deliveryEnabled === BROWNIER_DELIVERY_ENABLED) return store;
  return { ...store, business: { ...store.business, deliveryEnabled: BROWNIER_DELIVERY_ENABLED } };
}

// Backfill idempotente do horário estruturado: só preenche quando
// `business.operatingHours` está ausente ou já não é um horário estruturado
// válido — instalações que já têm horário cadastrado pelo painel nunca são
// sobrescritas. Mesmo padrão de `ensureBrownierPickupAddress`: função pura,
// devolve a MESMA referência quando nada muda.
export function ensureBrownierOperatingHours<T extends StoreWithBusiness>(store: T): T {
  // Migração versionada: aplica a agenda oficial nova uma única vez às lojas
  // antigas; edições posteriores feitas no painel preservam a mesma versão.
  if (store.business.operatingHoursVersion === BROWNIER_HOURS_VERSION && isStructuredWeeklyHours(store.business.operatingHours)) return store;
  return {
    ...store,
    business: {
      ...store.business,
      operatingHours: INITIAL_OPERATING_HOURS,
      operatingHoursVersion: BROWNIER_HOURS_VERSION,
    },
  };
}
