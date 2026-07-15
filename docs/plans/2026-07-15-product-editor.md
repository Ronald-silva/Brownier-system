# Editor de Sabores no Painel Admin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir criar, editar (nome/categoria/preço-base/descrição/ingredientes/alergênicos) e excluir sabores pelo painel admin, e tornar instantâneo (otimista) o toggle de disponibilidade e "Brownie do Dia".

**Architecture:** Tudo em `src/AdminOperations.tsx`, seguindo a convenção do projeto de manter o painel inteiro em um único arquivo. Um componente `ProductEditor` reutilizável (criar/editar) expande dentro de cada `<article className="op-product">` via `<details>`, reaproveitando o CSS `.editor` já existente no projeto. As rotas `POST`/`PUT`/`DELETE /api/admin/products` já existem no servidor — este plano só adiciona a UI que as usa.

**Tech Stack:** React 19, TypeScript, sem dependências novas.

## Global Constraints

- Nenhuma dependência nova.
- Não alterar a lógica de preço/promoção (`src/lib/pricing.ts`), o fluxo de upload de foto, nem a aba "Promoções" — permanecem exatamente como estão.
- Conversão de preço reais↔centavos idêntica à já usada em `Promotions` (`p.promotionalPrice/100` para exibir, `Math.round(Number(v)*100)` para salvar).
- `slug` nunca é editável pelo formulário (gerado pelo servidor a partir do nome).
- `npm test`, `npm run lint`, `npm run build` devem passar após cada task.
- Cada task termina com commit próprio.
- Nunca commitar `data/brownies-fortal.demo.json`.
- Toda copy em pt-BR, no mesmo tom já usado no painel (frases diretas, sem gírias).

---

## File Structure

| Arquivo | Ação | Responsabilidade |
| --- | --- | --- |
| `src/AdminOperations.tsx` | Modificar | `type Product` estendido; novo componente `ProductEditor`; novas funções `toggleAvailability`, `toggleDay`, `createProduct`, `deleteProduct`; wiring das quatro tasks na aba "Sabores" e no atalho "Novo produto" do painel "Hoje". |
| `src/experience.css` | Modificar | Uma regra nova: `.op-product details{grid-column:1/-1}` (o `.op-product` é grid de 4 colunas; o `<details>` precisa ocupar a linha inteira) + estilo mínimo do `<summary>`. |
| `tests/admin_product_editor_smoke.py` | Criar | Regressão Playwright cobrindo criar, editar, excluir e o toggle otimista (incluindo reversão em caso de falha de rede). |

---

### Task 1: Toggle otimista de disponibilidade e "Brownie do Dia"

**Files:**
- Modify: `src/AdminOperations.tsx:18-21`

**Interfaces:**
- Produces: `toggleAvailability(item: Product): void`, `toggleDay(item: Product): void` — chamadas pelos botões existentes de disponibilidade e "☆ Dia".

**Contexto:** Hoje, `product()` (linha 14) sempre faz `await load()` após o `PUT`, recarregando toda a lista (`GET /api/admin/bootstrap`) antes de qualquer atualização visual — perceptível como atraso a cada clique. As duas novas funções atualizam o estado local imediatamente e só revertem se o servidor rejeitar.

- [ ] **Step 1: Adicionar as duas funções em `AdminOperations`**

Em `src/AdminOperations.tsx`, logo após a linha 18 (`const today = ...` e antes do `return` da linha 19), adicionar:

```tsx
  const toggleAvailability = (item: Product) => {
    const previous = store.products;
    setStore({ ...store, products: previous.map(p => p.id === item.id ? { ...p, isAvailable: !p.isAvailable } : p) });
    fetch(`/api/admin/products/${item.id}`, { method: "PUT", headers, body: JSON.stringify({ ...item, isAvailable: !item.isAvailable }) }).then(r => {
      if (!r.ok) { setStore({ ...store, products: previous }); return notify("Não foi possível salvar. Tente de novo."); }
      notify(`${item.name} atualizado.`);
    });
  };
  const toggleDay = (item: Product) => {
    const previous = store.products;
    const next = previous.map(p => p.id === item.id ? { ...p, isDay: true } : p.isDay ? { ...p, isDay: false } : p);
    setStore({ ...store, products: next });
    const others = previous.filter(p => p.isDay && p.id !== item.id);
    Promise.all([
      ...others.map(p => fetch(`/api/admin/products/${p.id}`, { method: "PUT", headers, body: JSON.stringify({ ...p, isDay: false }) })),
      fetch(`/api/admin/products/${item.id}`, { method: "PUT", headers, body: JSON.stringify({ ...item, isDay: true }) }),
    ]).then(responses => {
      if (responses.some(r => !r.ok)) { setStore({ ...store, products: previous }); return notify("Não foi possível salvar. Tente de novo."); }
      notify("Brownie do Dia atualizado.");
    });
  };
```

Note: `store` já está com tipo `Store` (não `Store | null`) neste ponto do componente, porque a linha 17 (`if (!store) return ...`) já retornou antes — o TypeScript estreita o tipo automaticamente, sem precisar de `!` ou checagem extra.

- [ ] **Step 2: Trocar os `onClick` dos dois botões existentes**

Na linha 21 (dentro do `.map(p => ...)` da aba `products`), substituir:

```tsx
<button className={p.isAvailable?"switch on":"switch"} aria-label={`Alterar disponibilidade de ${p.name}`} onClick={() => product(p,{isAvailable:!p.isAvailable},`${p.name} atualizado.`)}><i /></button><button className="day-toggle" onClick={() => Promise.all(store.products.filter(x => x.isDay && x.id !== p.id).map(x => product(x,{isDay:false},""))).then(() => product(p,{isDay:true},"Brownie do Dia atualizado."))}>☆ Dia</button>
```

por:

```tsx
<button className={p.isAvailable?"switch on":"switch"} aria-label={`Alterar disponibilidade de ${p.name}`} onClick={() => toggleAvailability(p)}><i /></button><button className="day-toggle" onClick={() => toggleDay(p)}>☆ Dia</button>
```

- [ ] **Step 3: Rodar lint, testes e build**

Run: `npm run lint && npm test && npm run build`
Expected: todos passam (mudança é só de wiring, nenhum teste existente depende deste comportamento).

- [ ] **Step 4: Verificar o comportamento otimista e a reversão em falha**

Escreva um script Playwright temporário (apagar depois de confirmar, ou manter como base para a Task 5) que faz login no admin (`brownies-demo`), vai na aba "Sabores", e roda estas duas checagens:

**4a. Caminho normal (persiste de verdade):** clique na chave de disponibilidade do primeiro sabor, confirme que o atributo `class` mudou de `"switch on"` para `"switch"` (ou vice-versa), recarregue a página (`page.reload(wait_until="networkidle")`) e confirme que o novo estado se manteve — prova que não é só otimismo visual, o servidor de fato salvou.

**4b. Reversão em falha:** force a próxima chamada `PUT /api/admin/products/*` a falhar, clique na chave, e confirme que ela volta ao estado anterior (reversão) e que aparece o toast de erro:

```python
def fail_once(route):
    route.fulfill(status=500, body="{}")
page.route("**/api/admin/products/*", fail_once, times=1)
switch = page.locator(".switch").first
class_before = switch.get_attribute("class")
switch.click()
page.wait_for_timeout(500)
assert switch.get_attribute("class") == class_before, "deve reverter ao estado anterior quando o servidor rejeita"
assert page.locator(".admin-toast").count() == 1, "deve mostrar o toast de erro"
```

Expected: 4a confirma que o clique realmente persiste (sobrevive a um reload); 4b confirma que uma falha do servidor reverte o estado local e avisa o usuário.

- [ ] **Step 5: Commit**

```bash
git add src/AdminOperations.tsx
git commit -m "feat: make availability and day-of toggles optimistic (instant feedback, revert on failure)"
```

---

### Task 2: Editor de sabor existente (nome, categoria, preço, descrição, ingredientes, alergênicos)

**Files:**
- Modify: `src/AdminOperations.tsx:1,5,21`
- Modify: `src/experience.css`

**Interfaces:**
- Consumes: `product(item: Product, patch: Partial<Product>, message: string): Promise<void>` (já existe, linha 14 — reaproveitado sem mudança de assinatura).
- Produces: `type ProductFormFields = { name: string; category: string; basePrice: number; description: string; ingredients: string; allergens: string }`; componente `ProductEditor({ product, onSave, onCancel, onDelete }): JSX.Element` — Tasks 3 e 4 dependem exatamente desta assinatura (`onDelete` opcional; `product: Product | null`, `null` = modo criação).

**Contexto:** `type Product` hoje (linha 5) não declara `category`, `ingredients`, `allergens`, `slug` — campos que o servidor já armazena e retorna (ver `server.ts`, criação de produto). Sem esses campos no tipo local, o formulário não consegue ler/exibir os valores atuais com segurança de tipos.

- [ ] **Step 1: Adicionar `FormEvent` ao import do React**

Em `src/AdminOperations.tsx`, linha 1, substituir:

```tsx
import { useEffect, useMemo, useState } from "react";
```

por:

```tsx
import { FormEvent, useEffect, useMemo, useState } from "react";
```

- [ ] **Step 2: Estender `type Product`**

Na linha 5, substituir:

```tsx
type Product = { id: string; name: string; description: string; basePrice: number; promotionalPrice: number | null; minimumPromotionalQuantity: number | null; isAvailable: boolean; isFeatured: boolean; isDay?: boolean; imageUrl: string };
```

por:

```tsx
type Product = { id: string; slug: string; name: string; description: string; category: string; ingredients: string; allergens: string; basePrice: number; promotionalPrice: number | null; minimumPromotionalQuantity: number | null; isAvailable: boolean; isFeatured: boolean; isDay?: boolean; imageUrl: string };
```

- [ ] **Step 3: Criar o componente `ProductEditor`**

Adicionar, após a função `Metric` (linha 27 atual, antes de `Promotions`):

```tsx
type ProductFormFields = { name: string; category: string; basePrice: number; description: string; ingredients: string; allergens: string };
function ProductEditor({ product, onSave, onCancel, onDelete }: { product: Product | null; onSave: (fields: ProductFormFields) => Promise<void>; onCancel: () => void; onDelete?: () => void }) {
  const [name, setName] = useState(product?.name || "");
  const [category, setCategory] = useState(product?.category || "Brownies");
  const [price, setPrice] = useState(product ? String(product.basePrice / 100) : "");
  const [description, setDescription] = useState(product?.description || "");
  const [ingredients, setIngredients] = useState(product?.ingredients || "");
  const [allergens, setAllergens] = useState(product?.allergens || "");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const submit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); onSave({ name, category, basePrice: Math.round(Number(price) * 100), description, ingredients, allergens }); };
  return <form className="editor" onSubmit={submit}>
    <label>Nome<input required value={name} onChange={e => setName(e.target.value)} /></label>
    <label>Categoria<input value={category} onChange={e => setCategory(e.target.value)} /></label>
    <label>Preço-base (R$)<input required type="number" step=".01" min="0" value={price} onChange={e => setPrice(e.target.value)} /></label>
    <label>Descrição<textarea value={description} onChange={e => setDescription(e.target.value)} /></label>
    <label>Ingredientes<input value={ingredients} onChange={e => setIngredients(e.target.value)} /></label>
    <label>Alergênicos<input value={allergens} onChange={e => setAllergens(e.target.value)} /></label>
    <div className="choice-row">
      <button type="button" className="secondary" onClick={onCancel}>Cancelar</button>
      <button className="primary">{product ? "Salvar sabor" : "Criar sabor"}</button>
    </div>
    {onDelete && (confirmingDelete
      ? <p className="clear-confirm"><span>Excluir {product?.name}?</span><button type="button" className="link-danger" onClick={onDelete}>Sim, excluir</button><button type="button" className="text-button" onClick={() => setConfirmingDelete(false)}>Cancelar</button></p>
      : <button type="button" className="link-danger" onClick={() => setConfirmingDelete(true)}>Excluir sabor</button>)}
  </form>;
}
```

- [ ] **Step 4: Adicionar o CSS que falta para o `<details>` dentro de `.op-product`**

Em `src/experience.css`, logo após a regra `.op-product{...}` existente, adicionar:

```css
.op-product details{grid-column:1/-1;margin-top:6px}
.op-product summary{cursor:pointer;font-size:11px;font-weight:800;color:var(--brand-brown)}
```

- [ ] **Step 5: Adicionar o `<details>` de edição em cada sabor da lista**

Na linha 21 (dentro do `.map(p => ...)`), logo após o `</button>` do "☆ Dia" e antes do `</article>` de fechamento, adicionar:

```tsx
<details><summary>Editar</summary><ProductEditor product={p} onCancel={() => {}} onSave={async fields => { await product(p, fields, "Sabor atualizado."); }} onDelete={() => deleteProduct(p)} /></details>
```

(`deleteProduct` ainda não existe — será criado na Task 4. Para esta task, comentar a prop `onDelete` temporariamente **não é necessário**: declare a função `deleteProduct` desde já como uma função que só faz `notify("Excluir ainda não disponível.")`, e a Task 4 substitui pela implementação real. Isso mantém o app buildando a cada commit sem introduzir um `TODO`.)

Adicionar, junto com `toggleAvailability`/`toggleDay` (após a linha 18):

```tsx
  const deleteProduct = (_item: Product) => notify("Excluir ainda não disponível.");
```

- [ ] **Step 6: Rodar lint, testes e build**

Run: `npm run lint && npm test && npm run build`
Expected: todos passam.

- [ ] **Step 7: Verificação manual**

Run: `npm run dev`, entrar no admin (`brownies-demo`), aba Sabores, clicar "Editar" em um sabor, mudar o preço-base e a descrição, clicar "Salvar sabor".
Expected: o card atualiza com o novo preço (via `formatCurrency`) e a nova descrição some do parágrafo (o parágrafo do card não exibe descrição hoje — apenas preço/promoção — então a confirmação visual principal é o preço mudando e o toast "Sabor atualizado.").

- [ ] **Step 8: Commit**

```bash
git add src/AdminOperations.tsx src/experience.css
git commit -m "feat: add product editor (name, category, price, description, ingredients, allergens) to admin panel"
```

---

### Task 3: Criar novo sabor

**Files:**
- Modify: `src/AdminOperations.tsx:10,20,21`

**Interfaces:**
- Consumes: `ProductEditor` (Task 2, chamado com `product={null}`).
- Produces: `createProduct(fields: ProductFormFields): Promise<void>`.

- [ ] **Step 1: Adicionar estado `creatingProduct` e a função `createProduct`**

Na linha 11 (declaração de estados do componente `AdminOperations`), adicionar `creatingProduct` à lista de `useState`:

```tsx
const [code, setCode] = useState(sessionStorage.getItem("bf-admin") || ""); const [store, setStore] = useState<Store | null>(null); const [tab, setTab] = useState("dashboard"); const [feedback, setFeedback] = useState(""); const [search, setSearch] = useState(""); const [creatingProduct, setCreatingProduct] = useState(false); const headers = { "Content-Type": "application/json", "x-admin-code": code };
```

Junto com `toggleAvailability`/`toggleDay`/`deleteProduct` (após a linha 18), adicionar:

```tsx
  const createProduct = async (fields: ProductFormFields) => {
    const r = await fetch("/api/admin/products", { method: "POST", headers, body: JSON.stringify(fields) });
    if (!r.ok) return notify("Não foi possível criar o sabor. Tente de novo.");
    setCreatingProduct(false); await load(); notify("Sabor criado.");
  };
```

- [ ] **Step 2: Abrir o formulário de criação no atalho "Novo produto" do painel Hoje**

Na linha 20 (aba `dashboard`), substituir:

```tsx
<button onClick={() => setTab("products")}>＋<span>Novo produto</span></button>
```

por:

```tsx
<button onClick={() => { setTab("products"); setCreatingProduct(true); }}>＋<span>Novo produto</span></button>
```

- [ ] **Step 3: Adicionar o botão "+ Novo sabor" e o formulário de criação na aba Sabores**

Na linha 21, logo após `<h2 className="sr-only">Lista de sabores</h2>` e antes de `<div className="admin-list">`, adicionar:

```tsx
<button className="secondary" onClick={() => setCreatingProduct(v => !v)}>{creatingProduct ? "Cancelar novo sabor" : "+ Novo sabor"}</button>
{creatingProduct && <ProductEditor product={null} onCancel={() => setCreatingProduct(false)} onSave={createProduct} />}
```

- [ ] **Step 4: Rodar lint, testes e build**

Run: `npm run lint && npm test && npm run build`
Expected: todos passam.

- [ ] **Step 5: Verificação manual**

Run: `npm run dev`, admin → Sabores → "+ Novo sabor", preencher nome "Brownie Teste" e preço 5,00, clicar "Criar sabor".
Expected: formulário fecha, toast "Sabor criado.", o novo sabor aparece na lista com "R$ 5,00".

- [ ] **Step 6: Commit**

```bash
git add src/AdminOperations.tsx
git commit -m "feat: add create-new-flavor flow to admin panel"
```

---

### Task 4: Excluir sabor

**Files:**
- Modify: `src/AdminOperations.tsx` (linha onde `deleteProduct` foi declarada como placeholder na Task 2)

**Interfaces:**
- Consumes: `ProductEditor`'s `onDelete` prop (já wired na Task 2).
- Produces: `deleteProduct(item: Product): Promise<void>` (substitui o placeholder da Task 2).

- [ ] **Step 1: Substituir o placeholder de `deleteProduct` pela implementação real**

Substituir:

```tsx
  const deleteProduct = (_item: Product) => notify("Excluir ainda não disponível.");
```

por:

```tsx
  const deleteProduct = async (item: Product) => {
    const r = await fetch(`/api/admin/products/${item.id}`, { method: "DELETE", headers });
    if (!r.ok) return notify("Não foi possível excluir o sabor. Tente de novo.");
    await load(); notify("Sabor removido.");
  };
```

- [ ] **Step 2: Rodar lint, testes e build**

Run: `npm run lint && npm test && npm run build`
Expected: todos passam.

- [ ] **Step 3: Verificação manual**

Run: `npm run dev`, admin → Sabores → "Editar" no sabor de teste criado na Task 3 → "Excluir sabor" → confirmar "Sim, excluir".
Expected: aparece a confirmação inline antes de excluir (não exclui no primeiro clique), depois de confirmar o sabor some da lista e aparece o toast "Sabor removido.".

- [ ] **Step 4: Commit**

```bash
git add src/AdminOperations.tsx
git commit -m "feat: add delete-flavor flow with inline confirmation to admin panel"
```

---

### Task 5: Smoke test de regressão do editor de sabores

**Files:**
- Create: `tests/admin_product_editor_smoke.py`

**Interfaces:**
- Nenhuma — teste end-to-end via Playwright, seguindo o padrão já usado em `tests/visual_smoke.py` e `tests/routing_smoke.py`.

- [ ] **Step 1: Criar o teste**

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    page.goto("http://localhost:3000/equipe", wait_until="networkidle")
    page.get_by_label("Código de acesso").fill("brownies-demo")
    page.get_by_text("Entrar no painel").click()
    page.wait_for_load_state("networkidle")
    page.get_by_role("button", name="Sabores", exact=True).click()
    page.wait_for_timeout(300)

    # Criar
    page.get_by_text("+ Novo sabor").click()
    page.wait_for_timeout(200)
    page.get_by_label("Nome").fill("Brownie Smoke Test")
    page.get_by_label("Preço-base (R$)").fill("9.90")
    page.get_by_text("Criar sabor").click()
    page.wait_for_timeout(500)
    assert page.locator("text=Brownie Smoke Test").count() == 1, "sabor criado deve aparecer na lista"

    # Editar
    row = page.locator(".op-product", has_text="Brownie Smoke Test")
    row.get_by_text("Editar").click()
    page.wait_for_timeout(200)
    row.get_by_label("Preço-base (R$)").fill("12.50")
    row.get_by_text("Salvar sabor").click()
    page.wait_for_timeout(500)
    assert page.locator(".op-product", has_text="Brownie Smoke Test").locator("text=R$ 12,50").count() == 1, "preço deve refletir a edição"

    # Toggle de disponibilidade persiste após reload (não é só otimismo visual)
    switch = row.locator(".switch")
    class_before = switch.get_attribute("class")
    switch.click()
    page.wait_for_timeout(300)
    assert switch.get_attribute("class") != class_before, "toggle deve mudar visualmente ao clicar"
    page.reload(wait_until="networkidle")
    page.get_by_role("button", name="Sabores", exact=True).click()
    page.wait_for_timeout(300)
    row = page.locator(".op-product", has_text="Brownie Smoke Test")
    assert row.locator(".switch").get_attribute("class") != class_before, "mudança deve persistir após reload"

    # Excluir
    row.get_by_text("Excluir sabor").click()
    page.wait_for_timeout(200)
    row.get_by_text("Sim, excluir").click()
    page.wait_for_timeout(500)
    assert page.locator("text=Brownie Smoke Test").count() == 0, "sabor excluído não deve mais aparecer"

    browser.close()
print("admin product editor smoke: ok")
```

- [ ] **Step 2: Rodar o teste**

Run: `python3 <caminho do with_server.py do skill webapp-testing> --server "ADMIN_ACCESS_CODE=brownies-demo npm run dev" --port 3000 -- python3 tests/admin_product_editor_smoke.py`
Expected: imprime `admin product editor smoke: ok`, sem `AssertionError`.

- [ ] **Step 3: Commit**

```bash
git add tests/admin_product_editor_smoke.py
git commit -m "test: add Playwright smoke test for admin product editor (create, edit, delete, optimistic toggle)"
```

---

## Self-Review

**1. Cobertura do spec (`docs/specs/2026-07-15-product-editor-design.md`):**
- Editar nome/categoria/preço/descrição/ingredientes/alergênicos → Task 2. ✅
- Criar sabor → Task 3. ✅
- Excluir sabor → Task 4. ✅
- Toggle otimista de disponibilidade e "Brownie do Dia" → Task 1. ✅
- `slug` não editável → nunca exposto no `ProductEditor`. ✅
- `isFeatured`/`displayOrder`/promoção/foto fora de escopo → não tocados em nenhuma task. ✅

**2. Varredura de placeholders:** o único "placeholder" textual (`deleteProduct` na Task 2) é intencional e documentado — existe para o app continuar buildando entre a Task 2 e a Task 4, e é substituído por uma implementação real na Task 4, não um TODO esquecido.

**3. Consistência de tipos/nomes:** `ProductFormFields` (Task 2) é o mesmo tipo usado em `onSave` do `ProductEditor`, em `createProduct` (Task 3) e implicitamente compatível com `Partial<Product>` em `product()` (usado na Task 2 para salvar edição) — todas as tasks usam exatamente os mesmos nomes de campo (`name`, `category`, `basePrice`, `description`, `ingredients`, `allergens`). `deleteProduct(item: Product)` tem a mesma assinatura do placeholder da Task 2 até a implementação real da Task 4.
