# Preço por Quantidade Agregada + Cardápio Real — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mudar a regra de desconto por quantidade para considerar a soma de todos os brownies do pedido (não mais por sabor isolado), e atualizar os dados de demonstração para o cardápio e preço reais informados pelo dono da Brownieria Fortal.

**Architecture:** `calculateLinePrice` (motor de preço em `src/lib/pricing.ts`, já reexecutado no servidor por segurança) ganha um terceiro parâmetro obrigatório `totalQuantity` — a quantidade agregada do pedido inteiro — usado para decidir se o preço promocional se aplica, no lugar da quantidade da linha isolada. Todo chamador (resumo do carrinho, cada linha exibida, a dica de desconto, a página de detalhe do produto, e a validação server-side) precisa somar e passar essa quantidade agregada.

**Tech Stack:** TypeScript, Express, React 19, node:test, sem dependências novas.

## Global Constraints

- Nenhuma dependência nova.
- `basePrice`/`promotionalPrice` continuam em reais inteiros (não centavos) — ver `docs/plans/2026-07-15-product-editor.md` para o histórico desse bug já corrigido; não reintroduzir conversão por 100 em nenhum lugar.
- O desconto de 20+ unidades vale pela soma de **todos** os itens do pedido, independente do sabor — confirmado com o dono do negócio.
- Manter `promotionalPrice`/`minimumPromotionalQuantity` como campo por produto (não criar configuração global nova) — decisão registrada em `docs/specs/2026-07-15-aggregate-pricing-and-real-menu-design.md`.
- `npm test`, `npm run lint`, `npm run build` devem passar após cada task.
- Cada task termina com commit próprio.
- Nunca commitar `data/brownies-fortal.demo.json`.
- Copy em pt-BR no mesmo tom já usado no app.

---

## File Structure

| Arquivo | Ação | Responsabilidade |
| --- | --- | --- |
| `src/lib/pricing.ts` | Modificar | `calculateLinePrice` ganha o parâmetro `totalQuantity`. |
| `tests/pricing.test.ts` | Modificar | Reescrito para cobrir o comportamento agregado. |
| `src/App.tsx` | Modificar | `summary`, `ProductRoute`/`ProductDetail` (novo prop `cart`), `Cart` (`promotionHint` agregado) — todos os chamadores client-side de `calculateLinePrice`. |
| `server.ts` | Modificar | Validação de pedido: soma `totalQuantity` antes do laço de itens; dados de demonstração (`demoStore.products`) trocados pelo cardápio real. |
| `tests/aggregate_pricing_smoke.py` | Criar | Regressão Playwright: dois sabores diferentes somando 20+ unidades disparam o preço promocional no carrinho e no checkout. |

---

### Task 1: Motor de preço agregado (pricing.ts + todos os chamadores)

**Files:**
- Modify: `src/lib/pricing.ts`
- Modify: `tests/pricing.test.ts`
- Modify: `src/App.tsx` (linhas 4, 27, 87, 89 — ver detalhes por step)
- Modify: `server.ts` (linhas 114-119)

**Interfaces:**
- Produces: `calculateLinePrice(product: PricingProduct, quantity: number, totalQuantity: number): { unitPrice: number; total: number; discount: number }` — assinatura final; nenhuma task futura depende de mudança adicional aqui.

**Nota importante:** este é o único task deste plano que toca o motor de preço. Como o terceiro parâmetro é **obrigatório** (sem valor padrão, de propósito — força o TypeScript a recusar compilar qualquer chamador esquecido), a mudança em `pricing.ts` e a atualização de **todos** os chamadores (`App.tsx` e `server.ts`) precisam entrar no mesmo commit — se separadas, o build quebraria entre commits. Por isso os Steps 1-8 abaixo cobrem os dois arquivos e o motor juntos, mas seguem TDD: teste primeiro, depois implementação, depois cada chamador.

- [ ] **Step 1: Escrever os testes que falham**

Substituir todo o conteúdo de `tests/pricing.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { calculateLinePrice } from "../src/lib/pricing.ts";

const brownie = { name: "Brownie demonstrativo", basePrice: 5, promotionalPrice: 3, minimumPromotionalQuantity: 20 };

test("preço promocional é aplicado quando o total do pedido atinge o mínimo, mesmo com poucas unidades desta linha", () => {
  assert.deepEqual(calculateLinePrice(brownie, 5, 20), { unitPrice: 3, total: 15, discount: 10 });
});

test("sem desconto quando o total do pedido não atinge o mínimo, mesmo que a linha isolada seja grande", () => {
  assert.deepEqual(calculateLinePrice(brownie, 19, 19), { unitPrice: 5, total: 95, discount: 0 });
});

test("produto sem promoção mantém preço base independente do total do pedido", () => {
  assert.deepEqual(calculateLinePrice({ name: "Brownie", basePrice: 7, promotionalPrice: null, minimumPromotionalQuantity: null }, 2, 50), { unitPrice: 7, total: 14, discount: 0 });
});
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `node --experimental-strip-types --test tests/pricing.test.ts`
Expected: FAIL — `calculateLinePrice` chamada com 3 argumentos, mas a assinatura atual só aceita 2 (TypeScript aceita argumentos extras em runtime já que é `.ts` executado via strip-types sem checagem, então o teste vai FALHAR pela asserção `deepEqual` retornar valores calculados com a lógica antiga de `quantity`, não `totalQuantity` — confirme lendo a saída: o teste 1 deve falhar porque `calculateLinePrice(brownie, 5, 20)` com a lógica atual usa `quantity=5 < minimumPromotionalQuantity=20`, então NÃO aplica desconto, retornando `{unitPrice:5, total:25, discount:0}` em vez do esperado `{unitPrice:3, total:15, discount:10}`).

- [ ] **Step 3: Implementar a mudança em `pricing.ts`**

Em `src/lib/pricing.ts`, substituir:

```ts
export function calculateLinePrice(product: PricingProduct, quantity: number) {
  const promotional = product.promotionalPrice !== null && product.minimumPromotionalQuantity !== null && quantity >= product.minimumPromotionalQuantity;
  const unitPrice = promotional ? product.promotionalPrice! : product.basePrice;
  return { unitPrice, total: unitPrice * quantity, discount: promotional ? (product.basePrice - unitPrice) * quantity : 0 };
}
```

por:

```ts
export function calculateLinePrice(product: PricingProduct, quantity: number, totalQuantity: number) {
  const promotional = product.promotionalPrice !== null && product.minimumPromotionalQuantity !== null && totalQuantity >= product.minimumPromotionalQuantity;
  const unitPrice = promotional ? product.promotionalPrice! : product.basePrice;
  return { unitPrice, total: unitPrice * quantity, discount: promotional ? (product.basePrice - unitPrice) * quantity : 0 };
}
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `node --experimental-strip-types --test tests/pricing.test.ts`
Expected: PASS (3 testes) — mas `npm run lint` (Step 8) ainda vai falhar até os chamadores serem atualizados nos próximos steps, porque agora eles passam só 2 argumentos para uma função que exige 3.

- [ ] **Step 5: Atualizar os chamadores em `src/App.tsx`**

**5a. `summary` (dentro do componente `App`, por volta da linha 27):**

Substituir:

```tsx
const summary = useMemo(() => cart.reduce((acc, line) => { const price = calculateLinePrice(line.product, line.quantity); return { subtotal: acc.subtotal + price.total, discount: acc.discount + price.discount }; }, { subtotal: 0, discount: 0 }), [cart]);
```

por:

```tsx
const summary = useMemo(() => { const totalQuantity = cart.reduce((sum, line) => sum + line.quantity, 0); return cart.reduce((acc, line) => { const price = calculateLinePrice(line.product, line.quantity, totalQuantity); return { subtotal: acc.subtotal + price.total, discount: acc.discount + price.discount }; }, { subtotal: 0, discount: 0 }); }, [cart]);
```

**5b. `ProductRoute` (a função que renderiza `ProductDetail` dentro da rota `/cardapio/:slug`):**

Localizar a função (procure por `function ProductRoute()`). Ela hoje desestrutura `const { products, add } = useOutletContext<AppContext>();` — adicionar `cart`:

```tsx
const { products, add, cart } = useOutletContext<AppContext>();
```

E no `return`, adicionar a prop `cart={cart}` na chamada de `<ProductDetail .../>`:

```tsx
return <ProductDetail product={product} recommendations={recommendations} cart={cart} onBack={() => navigate("/cardapio")} onAdd={add} />;
```

**5c. `ProductDetail` (a função que renderiza a página de detalhe, por volta da linha 87):**

Substituir a assinatura e a linha do preço:

```tsx
function ProductDetail({ product, recommendations, onBack, onAdd }: { product: Product; recommendations: Product[]; onBack: () => void; onAdd: (p: Product, q: number) => void }) { const [quantity, setQuantity] = useState(1); const price = calculateLinePrice(product, quantity); return <section className="section page product-page">
```

por:

```tsx
function ProductDetail({ product, recommendations, cart, onBack, onAdd }: { product: Product; recommendations: Product[]; cart: CartLine[]; onBack: () => void; onAdd: (p: Product, q: number) => void }) { const [quantity, setQuantity] = useState(1); const cartQuantity = cart.reduce((sum, line) => sum + line.quantity, 0); const price = calculateLinePrice(product, quantity, cartQuantity + quantity); return <section className="section page product-page">
```

(`cartQuantity + quantity` reflete o total do pedido **após** o cliente clicar "Adicionar ao pedido" com a quantidade selecionada — confirmado com o usuário que o preço exibido nesta página deve já bater com o que aparecerá no carrinho.)

**5d. `Cart` (a função que renderiza o carrinho, por volta da linha 89):**

Substituir:

```tsx
function Cart({ lines, subtotal, discount, onBack, onChange, onCheckout }: { lines: CartLine[]; subtotal: number; discount: number; onBack: () => void; onChange: (id: string, q: number) => void; onCheckout: () => void }) { const [confirmingClear, setConfirmingClear] = useState(false); const promotionHint = lines.find(line => line.product.minimumPromotionalQuantity && line.quantity < line.product.minimumPromotionalQuantity); return <section className="section page cart-page"><Back onClick={onBack} /><p className="eyebrow">SEU PEDIDO</p><h1>Sua caixa está quase pronta.</h1>{lines.length === 0 ? <div className="empty"><ShoppingBag aria-hidden="true" /><h2>Ainda não tem brownie por aqui.</h2><p>Escolha seus sabores favoritos no cardápio.</p><button className="primary" onClick={onBack}>Ver sabores</button></div> : <>{promotionHint && <p className="cart-nudge">Faltam {promotionHint.product.minimumPromotionalQuantity! - promotionHint.quantity} brownies de {promotionHint.product.name} para aproveitar o preço por quantidade.</p>}<h2 className="sr-only">Itens do pedido</h2><div className="cart-list">{lines.map(line => { const price = calculateLinePrice(line.product, line.quantity); return <article className="cart-line" key={line.product.id}>
```

por:

```tsx
function Cart({ lines, subtotal, discount, onBack, onChange, onCheckout }: { lines: CartLine[]; subtotal: number; discount: number; onBack: () => void; onChange: (id: string, q: number) => void; onCheckout: () => void }) { const [confirmingClear, setConfirmingClear] = useState(false); const totalQuantity = lines.reduce((sum, line) => sum + line.quantity, 0); const promoLine = lines.find(line => line.product.minimumPromotionalQuantity !== null); const promotionHint = promoLine && totalQuantity < promoLine.product.minimumPromotionalQuantity! ? promoLine.product.minimumPromotionalQuantity! - totalQuantity : null; return <section className="section page cart-page"><Back onClick={onBack} /><p className="eyebrow">SEU PEDIDO</p><h1>Sua caixa está quase pronta.</h1>{lines.length === 0 ? <div className="empty"><ShoppingBag aria-hidden="true" /><h2>Ainda não tem brownie por aqui.</h2><p>Escolha seus sabores favoritos no cardápio.</p><button className="primary" onClick={onBack}>Ver sabores</button></div> : <>{promotionHint !== null && <p className="cart-nudge">Faltam {promotionHint} brownies para aproveitar o preço por quantidade.</p>}<h2 className="sr-only">Itens do pedido</h2><div className="cart-list">{lines.map(line => { const price = calculateLinePrice(line.product, line.quantity, totalQuantity); return <article className="cart-line" key={line.product.id}>
```

(A dica deixa de citar um sabor específico — `"Faltam X brownies de {sabor}..."` vira `"Faltam X brownies..."` — porque agora o desconto é por soma do pedido, não por sabor isolado.)

- [ ] **Step 6: Atualizar o chamador em `server.ts`**

Localizar (por volta da linha 114-119):

```ts
    const orderItems = [] as Array<Record<string, unknown>>; let subtotal = 0; let discount = 0;
    for (const item of items) {
      const quantity = Number(item?.quantity); const product = store.products.find(p => p.id === item?.productId && p.isActive && p.isAvailable);
      if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) return res.status(400).json({ error: "Há um produto indisponível ou uma quantidade inválida." });
      const price = calculateLinePrice(product, quantity); subtotal += price.total; discount += price.discount;
      orderItems.push({ productId: product.id, productName: product.name, unitPrice: price.unitPrice, quantity, totalPrice: price.total });
    }
```

Substituir por:

```ts
    const orderItems = [] as Array<Record<string, unknown>>; let subtotal = 0; let discount = 0;
    const totalQuantity = items.reduce((sum: number, item: any) => sum + Number(item?.quantity || 0), 0);
    for (const item of items) {
      const quantity = Number(item?.quantity); const product = store.products.find(p => p.id === item?.productId && p.isActive && p.isAvailable);
      if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) return res.status(400).json({ error: "Há um produto indisponível ou uma quantidade inválida." });
      const price = calculateLinePrice(product, quantity, totalQuantity); subtotal += price.total; discount += price.discount;
      orderItems.push({ productId: product.id, productName: product.name, unitPrice: price.unitPrice, quantity, totalPrice: price.total });
    }
```

(`totalQuantity` é somado a partir do array `items` bruto, antes da validação por item, porque se qualquer item for inválido a requisição inteira é rejeitada de qualquer forma pelo `return res.status(400)` dentro do laço — então o valor de `totalQuantity` só importa quando todos os itens já são válidos, e nesse caso a soma bruta é exatamente a soma correta.)

- [ ] **Step 7: Rodar lint, testes e build**

Run: `npm run lint && npm test && npm run build`
Expected: todos passam — `npm run lint` confirma que não sobrou nenhum chamador de `calculateLinePrice` com 2 argumentos (o TypeScript acusaria erro de tipo se sobrasse).

- [ ] **Step 8: Verificação manual do cenário agregado**

**Atenção:** a Task 2 (próxima task deste plano) ainda não rodou neste ponto, então os dados de demonstração ainda são os antigos — apenas "Brownie Tradicional" (`index 0`) e "Brownie de Brigadeiro" (`index 1`) têm promoção configurada (`promotionalPrice: 600, minimumPromotionalQuantity: 4`); os outros 4 sabores não têm promoção (`promotionalPrice: null`). Use exatamente esses dois sabores para testar o comportamento agregado.

Run: `npm run dev`. No cardápio, adicionar 2 unidades de "Brownie Tradicional" e 2 unidades de "Brownie de Brigadeiro" (2+2 = 4, o mínimo configurado para ambos — mas nenhuma das duas linhas isoladamente chega a 4). Ir ao carrinho.
Expected: as duas linhas mostram o preço promocional (R$ 600,00 cada — valor antigo, ainda não corrigido pela Task 2 de dados), e a dica "Faltam X..." não aparece (porque o total de 4 já atingiu o mínimo, mesmo que cada sabor isolado tenha só 2 unidades — isso é exatamente o comportamento agregado que esta task implementa, diferente do comportamento antigo por linha). Reduzir a quantidade de um dos dois sabores para 1 (total vira 3, abaixo do mínimo) e confirmar que a dica "Faltam 1 brownies..." aparece e o preço de ambas as linhas volta ao valor base.

- [ ] **Step 9: Commit**

```bash
git add src/lib/pricing.ts tests/pricing.test.ts src/App.tsx server.ts
git commit -m "feat: apply quantity discount based on total order quantity, not per-flavor"
```

---

### Task 2: Cardápio real (dados de demonstração)

**Files:**
- Modify: `server.ts:34-46`

**Interfaces:**
- Nenhuma — mudança de dados apenas. Depende da Task 1 já ter mudado o motor de preço (para que `promotionalPrice: 3, minimumPromotionalQuantity: 20` funcionem com a lógica agregada correta), mas não depende de nenhuma interface nova.

- [ ] **Step 1: Substituir a lista de sabores e a lógica de preço/promoção do seed**

Em `server.ts`, substituir o bloco (linhas 34-46):

```ts
  products: [
    ["tradicional", "Brownie Tradicional", "Massa intensa de chocolate com casquinha delicada.", 700, true, "Chocolate meio amargo, farinha, ovos e manteiga", "Contém glúten, leite e ovos"],
    ["brigadeiro", "Brownie de Brigadeiro", "Brownie artesanal finalizado com brigadeiro cremoso.", 800, true, "Chocolate, brigadeiro, farinha, ovos e manteiga", "Contém glúten, leite e ovos"],
    ["ninho", "Brownie de Ninho", "Brownie de chocolate com cobertura de leite em pó.", 800, true, "Chocolate, leite em pó, farinha, ovos e manteiga", "Contém glúten, leite e ovos"],
    ["oreo", "Brownie de Oreo", "Brownie com pedaços de biscoito de chocolate.", 850, false, "Chocolate, biscoito, farinha, ovos e manteiga", "Contém glúten, leite e ovos"],
    ["doce-de-leite", "Brownie de Doce de Leite", "Brownie macio com doce de leite cremoso.", 850, true, "Chocolate, doce de leite, farinha, ovos e manteiga", "Contém glúten, leite e ovos"],
    ["prestigio", "Brownie de Prestígio", "Chocolate e coco em uma combinação clássica.", 850, true, "Chocolate, coco, farinha, ovos e manteiga", "Contém glúten, leite e ovos"],
  ].map(([slug, name, description, basePrice, available, ingredients, allergens], index) => ({
    id: `demo-${slug}`, slug: String(slug), name: String(name), description: String(description), category: "Brownies", imageUrl: "",
    basePrice: Number(basePrice), promotionalPrice: index < 2 ? 600 : null, minimumPromotionalQuantity: index < 2 ? 4 : null,
    isActive: true, isAvailable: Boolean(available), isFeatured: index < 3, isDay: slug === "brigadeiro", displayOrder: index + 1,
    ingredients: String(ingredients), allergens: String(allergens), updatedAt: new Date().toISOString(),
  })),
```

por:

```ts
  products: [
    ["brigadeiro", "Brownie de Brigadeiro", "Brownie artesanal finalizado com brigadeiro cremoso.", 5, true, "Chocolate, brigadeiro, farinha, ovos e manteiga", "Contém glúten, leite e ovos"],
    ["ninho", "Brownie de Ninho", "Brownie de chocolate com cobertura de leite em pó.", 5, true, "Chocolate, leite em pó, farinha, ovos e manteiga", "Contém glúten, leite e ovos"],
    ["oreo", "Brownie de Oreo", "Brownie com pedaços de biscoito de chocolate.", 5, true, "Chocolate, biscoito, farinha, ovos e manteiga", "Contém glúten, leite e ovos"],
    ["prestigio", "Brownie de Prestígio", "Chocolate e coco em uma combinação clássica.", 5, true, "Chocolate, coco, farinha, ovos e manteiga", "Contém glúten, leite e ovos"],
    ["ovomaltine", "Brownie de Ovomaltine", "Brownie de chocolate com cobertura crocante de Ovomaltine.", 5, true, "Chocolate, Ovomaltine, farinha, ovos e manteiga", "Contém glúten, leite, ovos e amendoim"],
    ["doce-de-leite", "Brownie de Doce de Leite", "Brownie macio com doce de leite cremoso.", 5, true, "Chocolate, doce de leite, farinha, ovos e manteiga", "Contém glúten, leite e ovos"],
  ].map(([slug, name, description, basePrice, available, ingredients, allergens], index) => ({
    id: `demo-${slug}`, slug: String(slug), name: String(name), description: String(description), category: "Brownies", imageUrl: "",
    basePrice: Number(basePrice), promotionalPrice: 3, minimumPromotionalQuantity: 20,
    isActive: true, isAvailable: Boolean(available), isFeatured: index < 3, isDay: slug === "brigadeiro", displayOrder: index + 1,
    ingredients: String(ingredients), allergens: String(allergens), updatedAt: new Date().toISOString(),
  })),
```

Mudanças: "Tradicional" removido (não está na lista real); "Ovomaltine" adicionado (novo, com descrição/ingredientes/alergênicos demonstrativos, já que não foram enviados); todos os 6 sabores com `basePrice: 5` (era um mix de 700/800/850, valores de placeholder); `promotionalPrice`/`minimumPromotionalQuantity` fixos em `3`/`20` para todos (era `index < 2 ? 600/4 : null`, um resquício do preço em centavos já corrigido e de uma regra só para os 2 primeiros sabores — agora a regra é uniforme, confirmado com o dono do negócio); "Oreo" passa a `isAvailable: true` (estava `false`/esgotado no placeholder; não há indicação de que deva continuar esgotado nos dados reais).

- [ ] **Step 2: Apagar o arquivo de dados de demonstração local para forçar a regeneração**

Run: `rm -f data/brownies-fortal.demo.json`
(Esse arquivo é gitignorado e recriado a partir do `demoStore` na primeira execução — apagá-lo garante que o próximo `npm run dev` gere o cardápio novo em vez de reaproveitar dados antigos já salvos localmente.)

- [ ] **Step 3: Rodar lint, testes e build**

Run: `npm run lint && npm test && npm run build`
Expected: todos passam (mudança de dados não afeta tipos nem lógica).

- [ ] **Step 4: Verificação manual**

Run: `npm run dev`, abrir `http://localhost:3000/cardapio`.
Expected: 6 sabores exibidos — Brigadeiro, Ninho, Oreo, Prestígio, Ovomaltine, Doce de Leite (sem "Tradicional") — cada um com preço base "R$ 5,00" e a nota de preço por quantidade "R$ 3,00 cada a partir de 20 unidades.".

- [ ] **Step 5: Commit**

```bash
git add server.ts
git commit -m "feat: update demo menu to the real flavor list and pricing from the business owner"
```

(Não commitar `data/brownies-fortal.demo.json` — confirme com `git status` que ele não aparece, já que está no `.gitignore`.)

---

### Task 3: Smoke test do desconto agregado

**Files:**
- Create: `tests/aggregate_pricing_smoke.py`

**Interfaces:**
- Nenhuma — teste end-to-end via Playwright, seguindo o padrão já usado em `tests/visual_smoke.py`, `tests/routing_smoke.py` e `tests/admin_product_editor_smoke.py`.

- [ ] **Step 1: Criar o teste**

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    page.goto("http://localhost:3000/cardapio", wait_until="networkidle")

    # Adiciona 10 unidades do primeiro sabor disponível e 10 do segundo — 20 no total, sabores diferentes
    add_buttons = page.locator(".add-icon:not([disabled])")
    add_buttons.nth(0).click()
    for _ in range(9):
        add_buttons.nth(0).click()
    add_buttons.nth(1).click()
    for _ in range(9):
        add_buttons.nth(1).click()
    page.wait_for_timeout(300)

    page.get_by_label("Abrir pedido").click()
    page.wait_for_load_state("networkidle")

    # Sem a dica de "faltam X" — o total de 20 já atingiu o mínimo
    assert page.locator("text=Faltam").count() == 0, "não deve mostrar a dica de desconto quando o total já atingiu o mínimo"

    # Cada linha deve mostrar o preço promocional (R$ 3,00 cada), não o preço base (R$ 5,00 cada)
    assert page.locator("text=R$ 3,00 cada").count() == 2, "as duas linhas devem exibir o preço promocional, mesmo com apenas 10 unidades cada"
    assert page.locator("text=R$ 5,00 cada").count() == 0, "nenhuma linha deve mostrar o preço base quando o total do pedido atinge o mínimo"

    browser.close()
print("aggregate pricing smoke: ok")
```

- [ ] **Step 2: Rodar o teste**

Run: `python3 <caminho do with_server.py do skill webapp-testing> --server "npm run dev" --port 3000 -- python3 tests/aggregate_pricing_smoke.py`
Expected: imprime `aggregate pricing smoke: ok`, sem `AssertionError`. Se o teste falhar porque menos de 2 sabores estão disponíveis (`.add-icon:not([disabled])` com menos de 2 elementos), verifique se a Task 2 já rodou e todos os 6 sabores reais estão com `isAvailable: true` (exceto se algum foi intencionalmente marcado esgotado).

- [ ] **Step 3: Commit**

```bash
git add tests/aggregate_pricing_smoke.py
git commit -m "test: add Playwright smoke test for order-wide quantity discount across different flavors"
```

---

## Self-Review

**1. Cobertura do spec (`docs/specs/2026-07-15-aggregate-pricing-and-real-menu-design.md`):**
- Motor de preço agregado (`totalQuantity` obrigatório) → Task 1. ✅
- Todos os 5 chamadores listados no spec (`summary`, linha do carrinho, dica de desconto, `ProductDetail`, servidor) → Task 1, Steps 5-6, todos cobertos individualmente. ✅
- Cardápio real (6 sabores, sem Tradicional, com Ovomaltine) e preço real (R$5/R$3 a partir de 20) → Task 2. ✅
- Decisão de não criar configuração de preço global → nenhuma task cria esse conceito nem toca `business`; confirmado. ✅
- Teste cobrindo o cenário que motivou a mudança (sabores diferentes somando o mínimo) → Task 3. ✅

**2. Varredura de placeholders:** nenhum "TBD"; a descrição/ingredientes do Ovomaltine são conteúdo completo e explicitamente identificados como demonstrativos no texto da Task 2, não deixados em branco.

**3. Consistência de tipos/nomes:** `totalQuantity` é o nome usado em todos os cinco chamadores (Task 1) com o mesmo significado (soma de quantidades do pedido/carrinho inteiro); `calculateLinePrice(product, quantity, totalQuantity)` é a assinatura final desde o Step 3 da Task 1, sem variação em nenhuma task posterior. `promotionalPrice: 3, minimumPromotionalQuantity: 20` (Task 2) usa os mesmos valores do `brownie` de teste na Task 1 (`promotionalPrice: 3, minimumPromotionalQuantity: 20`), então o comportamento testado na Task 1 é exatamente o que os dados reais da Task 2 vão exercitar.
