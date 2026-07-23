# Feedback visual ao adicionar ao carrinho — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ao adicionar um brownie ao carrinho (pelo ícone `+` do card no cardápio ou pelo botão "Adicionar ao pedido" na página de detalhe), o usuário deve perceber isso imediatamente: o botão confirma por 800ms, o contador do carrinho no header anima, e um toast discreto some sozinho.

**Architecture:** Mudança contida em `src/App.tsx` (estado local por botão + um novo estado de toast em `App()`) e `src/polish.css` (animações). Nenhuma dependência nova, nenhum componente novo além do já existente `ProductCard`/`ProductDetail`, nenhuma mudança de rota, lógica de preço ou de outras telas.

**Tech Stack:** React 19 + TypeScript (`src/App.tsx`), CSS puro (`src/polish.css`), Playwright via Python para o smoke test (padrão já usado no projeto em `tests/routing_smoke.py` etc.).

## Global Constraints

- Não alterar nenhuma outra funcionalidade além do feedback de adicionar ao carrinho.
- Não refatorar código fora do necessário para esta mudança.
- Não modificar layout de outras páginas (`Cart`, `Checkout`, `Confirmation`, `AdminOperations.tsx` ficam intocados).
- Botão deve mostrar "✓ Adicionado" por ~800ms e depois voltar ao normal.
- Contador do carrinho deve atualizar instantaneamente e ter uma microanimação de scale/pop.
- A microanimação deve respeitar `prefers-reduced-motion` (reaproveitar a regra global já existente em `src/polish.css:24`, não criar uma nova).
- Confirmação visual "✓ {produto} adicionado ao pedido" deve desaparecer sozinha após alguns segundos e não pode bloquear a navegação.
- Cliques rápidos e repetidos devem continuar contabilizando corretamente no carrinho (nenhuma duplicação visual de toast, nenhum botão travado).
- `notice`/`.toast` (usado hoje para erros de carregamento) não pode ter seu comportamento alterado — a confirmação de "adicionado" usa um mecanismo novo e separado.
- Build (`npm run build`) e typecheck (`npm run lint`, que roda `tsc --noEmit`) precisam passar sem erro ao final.

---

## Contexto do código atual (para quem nunca viu este arquivo)

`src/App.tsx` é um arquivo único com todas as telas públicas do app (estilo compacto, poucas quebras de linha por componente — siga esse estilo ao editar, não reformate o arquivo). Pontos relevantes:

- `App()` (linhas 18–31): componente raiz. Tem `cart` (estado, persistido em `sessionStorage`), `notice` (estado do toast genérico, também usado para erros de carregamento), e a função `add(product, quantity)` que insere/soma quantidade no carrinho e hoje também seta `notice`.
- O header (dentro do `return` de `App()`) renderiza o botão do carrinho com um `<b>{total}</b>` mostrando a quantidade total.
- `ProductCard` (linha 86): usado no grid do cardápio e na Home. Tem um botão `.add-icon` (ícone `+` da lib local `./icons.tsx`) que chama `onAdd` (== `add(product)`) diretamente, sem estado próprio.
- `ProductDetail` (linha 87): página de detalhe do produto. Tem um botão `.primary.wide` com texto `Adicionar ao pedido · {preço}` que chama `onAdd(product, quantity)`.
- `./icons.tsx` já exporta `Check` (glyph `✓`) e `Plus` (glyph `+`) — não precisa criar ícone novo.
- `src/polish.css` já tem, na última linha, uma regra global `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: .01ms !important; animation-duration: .01ms !important; } }` — qualquer `animation`/`transition` CSS nova já é cortada automaticamente por essa regra. Não adicione media queries de motion novas.
- Testes de UI neste projeto são scripts Playwright em Python dentro de `tests/*_smoke.py`, rodados manualmente contra o dev server (não fazem parte de `npm test`, que só roda os `.test.ts` de lógica pura). Padrão de execução:
  `python3 /home/ronald/.claude/plugins/marketplaces/anthropic-agent-skills/skills/webapp-testing/scripts/with_server.py --server "npm run dev" --port 3000 -- python3 tests/<arquivo>.py`

Ver spec completa em `docs/specs/2026-07-22-cart-add-feedback-design.md` para o racional das decisões (por que um toast novo e separado, por que 800ms, por que a posição do snackbar).

---

### Task 1: Estado de confirmação e contador animado em `App()`

**Files:**
- Modify: `src/App.tsx:1` (import), `src/App.tsx:19` (novos estados), `src/App.tsx:23-24` (novo effect + `add()`), `src/App.tsx:30` (render do header e dos toasts)
- Modify: `src/polish.css` (novas regras no fim do arquivo)

**Interfaces:**
- Produces: `AppContext.add` mantém a mesma assinatura `(p: Product, q?: number) => void` — nenhum consumidor (`ProductCard`, `ProductDetail`, `Home`, `Menu`) precisa mudar sua forma de chamar `add`.
- Produces: nova classe CSS `.added-toast` (toast de confirmação) e `.cart-count-pop` (keyframe usado pelo `<b>` do contador) — usadas só dentro de `App()`.

- [ ] **Step 1: Ler o arquivo atual para confirmar os números de linha antes de editar**

Rode:
```bash
sed -n '1,31p' src/App.tsx
```
Confirme que a linha 1 é o import de `"react"`, a linha 19 declara `business`/`products`/`cart`/`notice`, a linha 23 é o `useEffect` do `sessionStorage`, a linha 24 é `add`, e a linha 30 é o `return` de `App()`. Se os números de linha tiverem mudado (por exemplo, por edições anteriores), ajuste os passos abaixo para o conteúdo real — o texto a substituir (`old_string`) é o que importa, não o número da linha.

- [ ] **Step 2: Adicionar `useRef` ao import do React**

Trocar:
```tsx
import { FormEvent, useEffect, useMemo, useState } from "react";
```
Por:
```tsx
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
```

- [ ] **Step 3: Adicionar o estado `addedNotice` e o ref de id sequencial**

Trocar:
```tsx
  const [business, setBusiness] = useState<Business | null>(null); const [products, setProducts] = useState<Product[]>([]); const [cart, setCart] = useState<CartLine[]>(() => { try { const raw = sessionStorage.getItem("bf-cart"); return raw ? JSON.parse(raw) : []; } catch { return []; } }); const [notice, setNotice] = useState("");
```
Por:
```tsx
  const [business, setBusiness] = useState<Business | null>(null); const [products, setProducts] = useState<Product[]>([]); const [cart, setCart] = useState<CartLine[]>(() => { try { const raw = sessionStorage.getItem("bf-cart"); return raw ? JSON.parse(raw) : []; } catch { return []; } }); const [notice, setNotice] = useState(""); const [addedNotice, setAddedNotice] = useState<{ id: number; text: string } | null>(null);
  const addedNoticeId = useRef(0);
```

- [ ] **Step 4: Adicionar o effect de auto-dismiss e trocar `setNotice` por `setAddedNotice` dentro de `add()`**

Trocar:
```tsx
  useEffect(() => { try { sessionStorage.setItem("bf-cart", JSON.stringify(cart)); } catch { /* ignore storage failures (quota exceeded, private browsing) — cart still works in-memory for this session */ } }, [cart]);
  const add = (product: Product, quantity = 1) => { if (!product.isAvailable) return; setCart(lines => { const found = lines.find(line => line.product.id === product.id); return found ? lines.map(line => line.product.id === product.id ? { ...line, quantity: line.quantity + quantity } : line) : [...lines, { product, quantity }]; }); setNotice(`${product.name} adicionado ao pedido.`); };
```
Por:
```tsx
  useEffect(() => { try { sessionStorage.setItem("bf-cart", JSON.stringify(cart)); } catch { /* ignore storage failures (quota exceeded, private browsing) — cart still works in-memory for this session */ } }, [cart]);
  useEffect(() => { if (!addedNotice) return; const timer = setTimeout(() => setAddedNotice(null), 2600); return () => clearTimeout(timer); }, [addedNotice]);
  const add = (product: Product, quantity = 1) => { if (!product.isAvailable) return; setCart(lines => { const found = lines.find(line => line.product.id === product.id); return found ? lines.map(line => line.product.id === product.id ? { ...line, quantity: line.quantity + quantity } : line) : [...lines, { product, quantity }]; }); addedNoticeId.current += 1; setAddedNotice({ id: addedNoticeId.current, text: `✓ ${product.name} adicionado ao pedido` }); };
```

Nota: `notice` (o toast genérico) continua existindo e sendo usado só pelo `useEffect` de erro de carregamento (`refresh().catch(error => setNotice(error.message))`, linha 22) — não tocamos nessa linha.

- [ ] **Step 5: Adicionar `key` no contador do carrinho e renderizar o novo toast**

Trocar:
```tsx
  return <main className="app-shell"><header className="public-header"><button className="brand" onClick={() => navigate("/")} aria-label="Ir para o início"><BrandLogo compact /></button><button className="cart-button" onClick={() => navigate("/carrinho")} aria-label="Abrir pedido"><ShoppingBag size={19} aria-hidden="true" />{cart.length > 0 && <b>{cart.reduce((n, l) => n + l.quantity, 0)}</b>}</button></header>{notice && <div className="toast" role="status">{notice}<button onClick={() => setNotice("")}>×</button></div>}<Outlet context={context} /></main>;
```
Por:
```tsx
  return <main className="app-shell"><header className="public-header"><button className="brand" onClick={() => navigate("/")} aria-label="Ir para o início"><BrandLogo compact /></button><button className="cart-button" onClick={() => navigate("/carrinho")} aria-label="Abrir pedido"><ShoppingBag size={19} aria-hidden="true" />{cart.length > 0 && <b key={cart.reduce((n, l) => n + l.quantity, 0)}>{cart.reduce((n, l) => n + l.quantity, 0)}</b>}</button></header>{notice && <div className="toast" role="status">{notice}<button onClick={() => setNotice("")}>×</button></div>}{addedNotice && <div className="added-toast" role="status" aria-live="polite">{addedNotice.text}</div>}<Outlet context={context} /></main>;
```

- [ ] **Step 6: Adicionar as regras CSS no fim de `src/polish.css`**

Adicionar ao final do arquivo (depois da linha `@media (prefers-reduced-motion: reduce) { ... }`):
```css
@keyframes cart-count-pop { 0% { transform: scale(.6); opacity: .5; } 60% { transform: scale(1.2); } 100% { transform: scale(1); opacity: 1; } }
.cart-button b { animation: cart-count-pop .28s ease; }
.add-icon.added { background: var(--brand-pink); border-color: var(--brand-pink); color: #fff; }
@keyframes added-toast-in { 0% { transform: translate(-50%, 8px); opacity: 0; } 100% { transform: translate(-50%, 0); opacity: 1; } }
.added-toast { position: fixed; z-index: 6; left: 50%; bottom: 20px; transform: translateX(-50%); background: var(--brand-brown-dark); color: #fff; border-radius: 999px; padding: 10px 16px; font-size: 12px; font-weight: 800; box-shadow: 0 8px 24px rgb(63 36 24 / .18); pointer-events: none; animation: added-toast-in .22s ease; }
```

`pointer-events: none` garante que o toast nunca intercepta cliques, mesmo sobrepondo visualmente um botão por um instante — isso resolve o risco de bloqueio de navegação identificado na spec.

- [ ] **Step 7: Typecheck**

Rode:
```bash
npm run lint
```
Esperado: sem erros (roda `tsc --noEmit`).

- [ ] **Step 8: Commit**

```bash
git add src/App.tsx src/polish.css
git commit -m "feat: add auto-dismissing cart confirmation toast and animated cart counter"
```

---

### Task 2: Feedback no botão do card do cardápio (`ProductCard`)

**Files:**
- Modify: `src/App.tsx` (função `ProductCard`, atualmente linha 86)

**Interfaces:**
- Consumes: `useState`, `useEffect`, `useRef` (já importados na Task 1); `Check`, `Plus` de `./icons.tsx` (já importados no topo do arquivo).
- Produces: nenhuma interface nova exposta a outros componentes — `ProductCard` continua recebendo as mesmas props (`product`, `isDay?`, `onClick`, `onAdd?`).

- [ ] **Step 1: Localizar a função atual**

Rode:
```bash
grep -n "^function ProductCard" src/App.tsx
```

- [ ] **Step 2: Substituir a implementação**

Trocar (a função inteira, hoje em uma linha):
```tsx
function ProductCard({ product, isDay = false, onClick, onAdd }: { key?: string; product: Product; isDay?: boolean; onClick: () => void; onAdd?: () => void }) { const promo = product.promotionalPrice && product.minimumPromotionalQuantity; return <article className={`product-card ${!product.isAvailable ? "sold-out" : ""}`}><button className="product-main" onClick={onClick}><div className="product-photo"><img loading="lazy" decoding="async" src={productImageSrc(product)} alt={`Imagem demonstrativa de ${product.name}`} />{isDay && <span className="day-badge">Brownie do Dia</span>}</div><div className="product-copy"><p className="product-category">{product.category}</p><h3>{product.name}</h3><p>{product.description}</p>{promo && <small className="promo">{formatCurrency(product.promotionalPrice!)} cada a partir de {product.minimumPromotionalQuantity} un. no pedido</small>}<strong>{formatCurrency(product.basePrice)}</strong></div></button><div className="product-footer"><span className={product.isAvailable ? "available" : "unavailable"}>{product.isAvailable ? "Disponível hoje" : "Esgotado hoje"}</span>{onAdd && <button disabled={!product.isAvailable} className="add-icon" onClick={onAdd} aria-label={`Adicionar ${product.name}`}>{product.isAvailable ? <Plus size={18} aria-hidden="true" /> : "—"}</button>}</div></article> }
```
Por:
```tsx
function ProductCard({ product, isDay = false, onClick, onAdd }: { key?: string; product: Product; isDay?: boolean; onClick: () => void; onAdd?: () => void }) {
  const promo = product.promotionalPrice && product.minimumPromotionalQuantity;
  const [justAdded, setJustAdded] = useState(false);
  const addedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (addedTimer.current) clearTimeout(addedTimer.current); }, []);
  const handleAdd = () => { onAdd?.(); setJustAdded(true); if (addedTimer.current) clearTimeout(addedTimer.current); addedTimer.current = setTimeout(() => setJustAdded(false), 800); };
  return <article className={`product-card ${!product.isAvailable ? "sold-out" : ""}`}><button className="product-main" onClick={onClick}><div className="product-photo"><img loading="lazy" decoding="async" src={productImageSrc(product)} alt={`Imagem demonstrativa de ${product.name}`} />{isDay && <span className="day-badge">Brownie do Dia</span>}</div><div className="product-copy"><p className="product-category">{product.category}</p><h3>{product.name}</h3><p>{product.description}</p>{promo && <small className="promo">{formatCurrency(product.promotionalPrice!)} cada a partir de {product.minimumPromotionalQuantity} un. no pedido</small>}<strong>{formatCurrency(product.basePrice)}</strong></div></button><div className="product-footer"><span className={product.isAvailable ? "available" : "unavailable"}>{product.isAvailable ? "Disponível hoje" : "Esgotado hoje"}</span>{onAdd && <button disabled={!product.isAvailable} className={`add-icon${justAdded ? " added" : ""}`} onClick={handleAdd} aria-label={justAdded ? `${product.name} adicionado` : `Adicionar ${product.name}`}>{product.isAvailable ? (justAdded ? <Check size={18} aria-hidden="true" /> : <Plus size={18} aria-hidden="true" />) : "—"}</button>}</div></article>;
}
```

Por que `handleAdd` reinicia o timeout em vez de ignorar cliques repetidos: se o usuário clicar de novo antes dos 800ms acabarem, o clique **precisa** contar (requisito de negócio) — `onAdd?.()` sempre roda. O `clearTimeout`/novo `setTimeout` só evita que o ícone pisque de volta para `+` no meio de uma sequência de cliques rápidos.

- [ ] **Step 3: Typecheck**

```bash
npm run lint
```
Esperado: sem erros.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat: show temporary checkmark feedback on the menu card add button"
```

---

### Task 3: Feedback no botão da página de detalhe (`ProductDetail`)

**Files:**
- Modify: `src/App.tsx` (função `ProductDetail`, atualmente linha 87)

**Interfaces:**
- Consumes: mesmos hooks da Task 2.
- Produces: nenhuma interface nova — mesmas props de `ProductDetail`.

- [ ] **Step 1: Localizar a função atual**

```bash
grep -n "^function ProductDetail" src/App.tsx
```

- [ ] **Step 2: Substituir a implementação**

Trocar:
```tsx
function ProductDetail({ product, recommendations, cart, onBack, onAdd }: { product: Product; recommendations: Product[]; cart: CartLine[]; onBack: () => void; onAdd: (p: Product, q: number) => void }) { const [quantity, setQuantity] = useState(1); const cartQuantity = cart.reduce((sum, line) => sum + line.quantity, 0); const price = calculateLinePrice(product, quantity, cartQuantity + quantity); return <section className="section page product-page"><Back onClick={onBack} /><figure className="product-hero-photo"><img src={productImageSrc(product)} alt={`Imagem demonstrativa de ${product.name}`} /><figcaption>Imagem demonstrativa — aguardando foto oficial</figcaption></figure><p className="eyebrow">FEITO ARTESANALMENTE</p><h1>{product.name}</h1><p className="detail-description">{product.description}</p><strong className="big-price">{formatCurrency(price.unitPrice)}</strong>{product.promotionalPrice && <p className="promo">Quanto mais brownies no pedido — de qualquer sabor —, melhor o preço: {formatCurrency(product.promotionalPrice)} cada a partir de {product.minimumPromotionalQuantity} unidades.</p>}<Info label="Ingredientes" value={product.ingredients} /><Info label="Alergênicos" value={product.allergens} /><div className="quantity"><button aria-label="Diminuir quantidade" onClick={() => setQuantity(q => Math.max(1, q - 1))}><Minus size={18} aria-hidden="true" /></button><b>{quantity}</b><button aria-label="Aumentar quantidade" onClick={() => setQuantity(q => q + 1)}><Plus size={18} aria-hidden="true" /></button></div><button disabled={!product.isAvailable} className="primary wide" onClick={() => onAdd(product, quantity)}>{product.isAvailable ? `Adicionar ao pedido · ${formatCurrency(price.total)}` : "Esgotado hoje"}</button><RelatedProducts products={recommendations} /></section> }
```
Por:
```tsx
function ProductDetail({ product, recommendations, cart, onBack, onAdd }: { product: Product; recommendations: Product[]; cart: CartLine[]; onBack: () => void; onAdd: (p: Product, q: number) => void }) {
  const [quantity, setQuantity] = useState(1);
  const [justAdded, setJustAdded] = useState(false);
  const addedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (addedTimer.current) clearTimeout(addedTimer.current); }, []);
  const cartQuantity = cart.reduce((sum, line) => sum + line.quantity, 0);
  const price = calculateLinePrice(product, quantity, cartQuantity + quantity);
  const handleAdd = () => { onAdd(product, quantity); setJustAdded(true); if (addedTimer.current) clearTimeout(addedTimer.current); addedTimer.current = setTimeout(() => setJustAdded(false), 800); };
  return <section className="section page product-page"><Back onClick={onBack} /><figure className="product-hero-photo"><img src={productImageSrc(product)} alt={`Imagem demonstrativa de ${product.name}`} /><figcaption>Imagem demonstrativa — aguardando foto oficial</figcaption></figure><p className="eyebrow">FEITO ARTESANALMENTE</p><h1>{product.name}</h1><p className="detail-description">{product.description}</p><strong className="big-price">{formatCurrency(price.unitPrice)}</strong>{product.promotionalPrice && <p className="promo">Quanto mais brownies no pedido — de qualquer sabor —, melhor o preço: {formatCurrency(product.promotionalPrice)} cada a partir de {product.minimumPromotionalQuantity} unidades.</p>}<Info label="Ingredientes" value={product.ingredients} /><Info label="Alergênicos" value={product.allergens} /><div className="quantity"><button aria-label="Diminuir quantidade" onClick={() => setQuantity(q => Math.max(1, q - 1))}><Minus size={18} aria-hidden="true" /></button><b>{quantity}</b><button aria-label="Aumentar quantidade" onClick={() => setQuantity(q => q + 1)}><Plus size={18} aria-hidden="true" /></button></div><button disabled={!product.isAvailable} className="primary wide" onClick={handleAdd}>{!product.isAvailable ? "Esgotado hoje" : justAdded ? "✓ Adicionado" : `Adicionar ao pedido · ${formatCurrency(price.total)}`}</button><RelatedProducts products={recommendations} /></section>;
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run lint
```
Esperado: sem erros.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat: show temporary confirmation label on the product detail add button"
```

---

### Task 4: Smoke test Playwright + build final

**Files:**
- Create: `tests/cart_add_feedback_smoke.py`
- Test manual: `npm run build`

**Interfaces:**
- Consumes: seletores DOM já usados por outros smoke tests do projeto (`.add-icon`, `.cart-button b`, `role=status`) e os novos: `.add-icon.added`, `.added-toast`.

- [ ] **Step 1: Escrever o smoke test**

Criar `tests/cart_add_feedback_smoke.py`:
```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    page.goto("http://localhost:3000/cardapio", wait_until="networkidle")

    add_button = page.locator(".add-icon:not([disabled])").first
    add_button.click()

    # 1) Feedback imediato no próprio botão: ícone vira check por ~800ms.
    assert "added" in (add_button.get_attribute("class") or "")

    # 2) Toast de confirmação aparece, é não bloqueante e some sozinho.
    toast = page.locator(".added-toast")
    toast.wait_for(state="visible", timeout=1000)
    assert "adicionado ao pedido" in toast.inner_text()
    assert toast.evaluate("el => getComputedStyle(el).pointerEvents") == "none"

    # 3) Contador do carrinho já reflete a adição imediatamente.
    assert page.locator(".cart-button b").inner_text() == "1"

    # 4) O botão volta ao normal (ícone +) depois de ~800ms.
    page.wait_for_timeout(1000)
    assert "added" not in (add_button.get_attribute("class") or "")

    # 5) O toast some sozinho depois de ~2.6s, sem interação do usuário.
    toast.wait_for(state="detached", timeout=4000)

    # 6) Cliques rápidos repetidos continuam contabilizando corretamente
    #    e não empilham toasts (sempre no máximo um .added-toast na tela).
    for _ in range(5):
        add_button.click()
    assert page.locator(".cart-button b").inner_text() == "6"
    assert page.locator(".added-toast").count() <= 1

    # 7) O botão "Adicionar ao pedido" da página de detalhe também dá feedback.
    page.goto("http://localhost:3000/cardapio/brigadeiro", wait_until="networkidle")
    detail_button = page.get_by_role("button", name="Adicionar ao pedido", exact=False)
    detail_button.click()
    assert "✓ Adicionado" in detail_button.inner_text()
    page.wait_for_timeout(1000)
    assert "Adicionar ao pedido" in detail_button.inner_text()

    # 8) prefers-reduced-motion: reduce — a confirmação ainda funciona,
    #    só sem movimento perceptível (a regra global corta a duração da animação).
    page.emulate_media(reduced_motion="reduce")
    page.goto("http://localhost:3000/cardapio", wait_until="networkidle")
    reduced_add_button = page.locator(".add-icon:not([disabled])").first
    reduced_add_button.click()
    assert "added" in (reduced_add_button.get_attribute("class") or "")
    page.locator(".added-toast").wait_for(state="visible", timeout=1000)

    print("cart_add_feedback_smoke: OK")
    browser.close()
```

- [ ] **Step 2: Rodar o smoke test**

```bash
python3 /home/ronald/.claude/plugins/marketplaces/anthropic-agent-skills/skills/webapp-testing/scripts/with_server.py --server "npm run dev" --port 3000 -- python3 tests/cart_add_feedback_smoke.py
```
Esperado: `cart_add_feedback_smoke: OK`, sem asserts falhando.

Se o clique em `role=button, name="Adicionar ao pedido"` não encontrar o botão por causa do preço concatenado no texto (`Adicionar ao pedido · R$ 5,00`), use `exact=False` (já incluído acima) — o Playwright faz match parcial.

- [ ] **Step 3: Rodar os smoke tests existentes para checar regressão**

```bash
python3 /home/ronald/.claude/plugins/marketplaces/anthropic-agent-skills/skills/webapp-testing/scripts/with_server.py --server "npm run dev" --port 3000 -- python3 tests/routing_smoke.py
python3 /home/ronald/.claude/plugins/marketplaces/anthropic-agent-skills/skills/webapp-testing/scripts/with_server.py --server "npm run dev" --port 3000 -- python3 tests/visual_smoke.py
python3 /home/ronald/.claude/plugins/marketplaces/anthropic-agent-skills/skills/webapp-testing/scripts/with_server.py --server "npm run dev" --port 3000 -- python3 tests/aggregate_pricing_smoke.py
```
Esperado: todos passam sem alteração de comportamento (nenhum desses três depende do toast genérico `notice`, então a remoção do `setNotice` dentro de `add()` não deve quebrá-los — confirme lendo a saída, não assuma).

- [ ] **Step 4: Rodar os testes unitários de lógica pura (não deveriam ser afetados, mas confirme)**

```bash
npm test
```
Esperado: todos passam (nenhum arquivo `.test.ts` toca em `App.tsx`).

- [ ] **Step 5: Build de produção**

```bash
npm run build
```
Esperado: build conclui sem erro.

- [ ] **Step 6: Commit**

```bash
git add tests/cart_add_feedback_smoke.py
git commit -m "test: add Playwright smoke test for the add-to-cart feedback"
```

---

## Verificação final (checklist de aceitação da spec)

- [ ] Usuário entende imediatamente que o brownie foi adicionado (botão muda + toast aparece).
- [ ] Nenhuma duplicação visual (no máximo um `.added-toast` por vez; toast de erro genérico continua separado e intocado).
- [ ] Nenhuma regressão (`routing_smoke.py`, `visual_smoke.py`, `aggregate_pricing_smoke.py`, `npm test` continuam passando).
- [ ] Build funcionando (`npm run build`).
- [ ] Motion respeita `prefers-reduced-motion` (verificado no Step 8 do smoke test da Task 4, via `page.emulate_media`).
