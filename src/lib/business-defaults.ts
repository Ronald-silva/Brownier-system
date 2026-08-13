import { INITIAL_OPERATING_HOURS, isStructuredWeeklyHours } from "./business-hours.ts";

export const BROWNIER_PICKUP_ADDRESS = "Rua Professor Leite Gondim, 896, Antônio Bezerra, Fortaleza – CE, CEP 60360-332";
export const BROWNIER_RESPONSIBLE_NAME = "Mateus";

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

// Backfill idempotente do horário estruturado: só preenche quando
// `business.operatingHours` está ausente ou já não é um horário estruturado
// válido — instalações que já têm horário cadastrado pelo painel nunca são
// sobrescritas. Mesmo padrão de `ensureBrownierPickupAddress`: função pura,
// devolve a MESMA referência quando nada muda.
export function ensureBrownierOperatingHours<T extends StoreWithBusiness>(store: T): T {
  if (isStructuredWeeklyHours(store.business.operatingHours)) return store;
  return {
    ...store,
    business: {
      ...store.business,
      operatingHours: INITIAL_OPERATING_HOURS,
    },
  };
}
