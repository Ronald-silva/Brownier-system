export const BROWNIER_PICKUP_ADDRESS = "Rua Professor Leite Gondim, 896, Antônio Bezerra, Fortaleza – CE, CEP 60360-332";

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
