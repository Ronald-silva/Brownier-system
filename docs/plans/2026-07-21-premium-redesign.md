# Redesign Premium da Vitrine Pública — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Elevar o nível visual da vitrine pública (Home, Cardápio, Produto, Carrinho, Checkout, Confirmação) a um padrão premium, corrigindo também a regra de negócio que hoje oferece entrega feita pela própria empresa.

**Architecture:** `src/App.tsx` mantém as mesmas rotas exportadas e o mesmo `AppContext`. Introduzimos uma camada de tokens (`src/tokens.css`) e extraímos para `src/components/` só os componentes reutilizáveis nomeados no Vision Bible que hoje têm duplicação ou benefício claro de extração. Framer Motion entra nesses componentes para microinterações. Painel admin não é redesenhado — só herda os tokens de cor/espaço/raio via CSS compartilhado.

**Tech Stack:** React 19, react-router-dom 7, Vite, Express, TypeScript, Framer Motion (nova dependência), Playwright (Python) para os smoke tests já existentes, `node --test` para os testes unitários já existentes.

## Global Constraints

- Não adicionar novas funcionalidades de produto — só redesign visual + a correção de regra de negócio abaixo.
- A Brownieria não realiza entregas: checkout oferece só "Retirada na loja" ou "Uber Moto (por sua conta)" — nunca uma opção de entrega feita pela empresa.
- Mobile-first; validar 360, 390, 768, 1024, 1440px sem overflow horizontal; toques ≥44px.
- Preservar `AppContext`, as rotas exportadas de `App.tsx` (`HomeRoute`, `MenuRoute`, `ProductRoute`, `CartRoute`, `CheckoutRoute`, `ConfirmationRoute`, `AdminRoute`) e o motor de preço (`src/lib/pricing.ts`) sem alteração de contrato.
- Painel admin (`AdminOperations.tsx`, `.admin*` CSS) fora do escopo de redesign — só recebe tokens compartilhados por herança do CSS, exceto correções de correção direta causadas pela mudança de regra de negócio (rótulo "Entrega" no card de produção).
- Motion respeita `prefers-reduced-motion` (via `useReducedMotion()` do Framer Motion e a media query global já existente em `src/polish.css`).
- Fontes: manter DM Serif Display (títulos) e Nunito Sans (interface), já carregadas em `index.html` — não adicionar fontes novas.
- Ícones: manter o alias `lucide-react` → `src/icons.tsx` já configurado em `vite.config.ts`/`tsconfig.json` — importar de `"lucide-react"` funciona de qualquer arquivo do projeto.

---

### Task 1: Corrigir regra de negócio — remover entrega da empresa, adicionar Uber Moto

**Files:**
- Modify: `server.ts:28-29` (dados da empresa), `server.ts:104,108,111-113,123-124` (validação e criação de pedido)
- Modify: `src/App.tsx` (tipos `Business`/`Order`, componente `Checkout`, componente `Totals`, `Cart`, `Confirmation`)
- Modify: `src/AdminOperations.tsx:55` (rótulo do card de produção)
- Modify: `tests/routing_smoke.py:40-44`

**Interfaces:**
- Produces: `fulfillmentType` aceito pelo servidor passa a ser `"RETIRADA" | "UBER_MOTO"` (era `"RETIRADA" | "ENTREGA"`). `Order`/`Business` (tipos em `App.tsx`) deixam de ter o campo `deliveryFee`/`deliveryEnabled`. `Totals` (componente em `App.tsx`) passa a aceitar só `{ subtotal: number; discount: number }` (sem `deliveryFee`).

- [ ] **Step 1: Atualizar dados de negócio e validação no servidor**

Em `server.ts`, linha 28-29, remover `deliveryEnabled`/`deliveryFee`:

```ts
    phone: "", whatsapp: "", address: "", hours: "", instagram: "", pickupEnabled: true,
    paymentMethods: ["PIX", "DINHEIRO", "A_COMBINAR"],
```

Linha 104 (filtro de campos privados na resposta pública de pedido), remover `deliveryAddress`, `reference` do destructure:

```ts
    const { customerPhone, customerNotes, internalNotes, ...safe } = order;
```

Linhas 108-124 (criação de pedido), substituir todo o bloco por:

```ts
    const { items, customerName, customerPhone, fulfillmentType, customerNotes, paymentMethod, changeFor } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0 || items.length > 30) return res.status(400).json({ error: "O pedido precisa ter pelo menos um item." });
    if (!validText(customerName, 100) || !validText(customerPhone, 30)) return res.status(400).json({ error: "Informe nome e telefone." });
    if (!["RETIRADA", "UBER_MOTO"].includes(fulfillmentType) || !["PIX", "DINHEIRO", "A_COMBINAR"].includes(paymentMethod)) return res.status(400).json({ error: "Recebimento ou pagamento inválido." });
    const store = await loadStore(); const business = store.business as { pickupEnabled?: boolean };
    if (fulfillmentType === "RETIRADA" && !business.pickupEnabled) return res.status(400).json({ error: "Retirada indisponível no momento." });
    const orderItems = [] as Array<Record<string, unknown>>; let subtotal = 0; let discount = 0;
    const totalQuantity = items.reduce((sum: number, item: any) => sum + Number(item?.quantity || 0), 0);
    for (const item of items) {
      const quantity = Number(item?.quantity); const product = store.products.find(p => p.id === item?.productId && p.isActive && p.isAvailable);
      if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) return res.status(400).json({ error: "Há um produto indisponível ou uma quantidade inválida." });
      const price = calculateLinePrice(product, quantity, totalQuantity); subtotal += price.total; discount += price.discount;
      orderItems.push({ productId: product.id, productName: product.name, unitPrice: price.unitPrice, quantity, totalPrice: price.total });
    }
    const order = { id: crypto.randomUUID(), publicCode: publicCode(), status: "NOVO", fulfillmentType, paymentMethod, subtotal, discount, total: subtotal, customerName: customerName.trim(), customerPhone: customerPhone.trim(), customerNotes: sanitizeOptionalText(customerNotes), internalNotes: "", changeFor: sanitizeOptionalText(changeFor), items: orderItems, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    store.orders.unshift(order); await saveStore(store); res.status(201).json(order);
```

- [ ] **Step 2: Atualizar tipos e componentes em `src/App.tsx`**

No tipo `Business` (linha 10), remover `deliveryEnabled: boolean;` e `deliveryFee: number;`:

```ts
type Business = { name: string; tagline: string; description: string; phone: string; whatsapp: string; address: string; hours: string; instagram: string; pickupEnabled: boolean; paymentMethods: string[]; receivedMessage: string; availabilityNotice: string; isDemo: boolean };
```

No tipo `Order` (linha 12), remover `deliveryFee: number;`:

```ts
type Order = { id: string; publicCode: string; status: string; subtotal: number; discount: number; total: number; items: { productName: string; quantity: number; unitPrice: number; totalPrice: number }[]; createdAt: string; fulfillmentType: string; paymentMethod: string };
```

Substituir o componente `Totals` inteiro:

```ts
function Totals({ subtotal, discount }: { subtotal: number; discount: number }) { return <div className="totals"><p><span>Subtotal</span><b>{formatCurrency(subtotal + discount)}</b></p>{discount > 0 && <p className="saving"><span>Economia</span><b>− {formatCurrency(discount)}</b></p>}<p className="total"><span>Total</span><b>{formatCurrency(subtotal)}</b></p></div> }
```

No componente `Cart`, trocar `<Totals subtotal={subtotal} discount={discount} deliveryFee={0} />` por:

```tsx
<Totals subtotal={subtotal} discount={discount} />
```

Substituir o componente `Checkout` inteiro:

```tsx
function Checkout({ business, lines, summary, onBack, onDone }: { business: Business; lines: CartLine[]; summary: { subtotal: number; discount: number }; onBack: () => void; onDone: (order: Order) => void }) {
  const [fulfillment, setFulfillment] = useState(business.pickupEnabled ? "RETIRADA" : "UBER_MOTO");
  const [payment, setPayment] = useState("PIX"); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setLoading(true); setError(""); const form = new FormData(event.currentTarget); try { const created = await api<Order>("/api/public/orders", { method: "POST", body: JSON.stringify({ items: lines.map(l => ({ productId: l.product.id, quantity: l.quantity })), customerName: form.get("name"), customerPhone: form.get("phone"), fulfillmentType: fulfillment, customerNotes: form.get("notes"), paymentMethod: payment, changeFor: form.get("change") }) }); onDone(created); } catch (e) { setError(e instanceof Error ? e.message : "Erro ao criar pedido."); } finally { setLoading(false); } };
  return <section className="section page checkout-page"><Back onClick={onBack} /><p className="eyebrow">FINALIZAR PEDIDO</p><h1>Para quem é essa delícia?</h1><p className="subtle">Só pedimos o necessário para preparar seu pedido com cuidado.</p><form className="checkout-form" onSubmit={submit}><label>Seu nome<input required name="name" autoComplete="name" maxLength={100} placeholder="Ex.: Maria Silva" /></label><label>Seu WhatsApp<input required name="phone" type="tel" autoComplete="tel" inputMode="tel" maxLength={30} placeholder="(85) 9 0000-0000" /></label><fieldset><legend>Como prefere retirar?</legend><div className="choice-row">{business.pickupEnabled && <button type="button" aria-pressed={fulfillment === "RETIRADA"} className={fulfillment === "RETIRADA" ? "choice active" : "choice"} onClick={() => setFulfillment("RETIRADA")}>Retirada na loja</button>}<button type="button" aria-pressed={fulfillment === "UBER_MOTO"} className={fulfillment === "UBER_MOTO" ? "choice active" : "choice"} onClick={() => setFulfillment("UBER_MOTO")}>Uber Moto (por sua conta)</button></div></fieldset>{fulfillment === "UBER_MOTO" && <p className="cart-nudge">A Brownieria não realiza entregas. Peça seu próprio Uber Moto até {business.address || "o endereço da loja"} — a corrida e o pagamento são por sua conta.</p>}<fieldset><legend>Como você prefere pagar?</legend><div className="choice-row">{business.paymentMethods.map(method => <button type="button" key={method} aria-pressed={payment === method} className={payment === method ? "choice active" : "choice"} onClick={() => setPayment(method)}>{method === "A_COMBINAR" ? "A combinar" : method}</button>)}</div></fieldset>{payment === "DINHEIRO" && <label>Troco para qual valor?<input name="change" autoComplete="off" inputMode="decimal" placeholder="Opcional — ex.: 50" /></label>}<label>Algum detalhe importante?<textarea name="notes" autoComplete="off" maxLength={1000} placeholder="Opcional" /></label><Totals subtotal={summary.subtotal} discount={summary.discount} />{error && <p className="error">{error}</p>}<button className="primary wide" disabled={loading}>{loading ? "Enviando…" : "Confirmar pedido"}</button></form></section>
}
```

No componente `Confirmation`, trocar `<Totals subtotal={order.subtotal} discount={order.discount} deliveryFee={order.deliveryFee} />` por `<Totals subtotal={order.subtotal} discount={order.discount} />`, e trocar o texto de próximos passos:

```tsx
<p>Você escolheu {order.fulfillmentType === "RETIRADA" ? "retirada" : "Uber Moto por sua conta"} e pagamento {order.paymentMethod === "A_COMBINAR" ? "a combinar" : order.paymentMethod}. A equipe confirmará os detalhes em breve.</p>
```

- [ ] **Step 3: Corrigir rótulo no painel admin (consequência direta desta mudança)**

Em `src/AdminOperations.tsx:55`, trocar `{o.fulfillmentType === "RETIRADA" ? "Retirada" : "Entrega"}` por:

```tsx
{o.fulfillmentType === "RETIRADA" ? "Retirada" : "Uber Moto"}
```

- [ ] **Step 4: Atualizar o smoke test de rotas**

Em `tests/routing_smoke.py`, linhas 40-44, substituir:

```py
    # business.pickupEnabled pode deixar "Retirada" pré-selecionado, que tem um bug
    # pré-existente e não relacionado no servidor quando o endereço fica vazio.
    # Selecionamos "Entrega" explicitamente e preenchemos o endereço para evitá-lo.
    page.get_by_role("button", name="Entrega").click()
    page.get_by_label("Onde entregamos?").fill("Rua das Flores, 123, Aldeota")
```

por:

```py
    # A Brownieria não realiza entregas — o checkout oferece só Retirada ou Uber
    # Moto por conta do cliente. Selecionamos Uber Moto explicitamente para
    # exercitar esse fluxo (sem campo de endereço, sem taxa de entrega).
    page.get_by_role("button", name="Uber Moto (por sua conta)").click()
```

- [ ] **Step 5: Rodar a verificação**

Terminal 1: `npm run dev`
Terminal 2:
```bash
python3 tests/routing_smoke.py
```
Expected: imprime `routing smoke: ok` sem asserções falhas.

```bash
npm run lint
```
Expected: sem erros de tipo (o `tsc --noEmit` deve passar; nenhum lugar deve referenciar `deliveryFee`/`deliveryEnabled`/`ENTREGA` que não existam mais).

- [ ] **Step 6: Commit**

```bash
git add server.ts src/App.tsx src/AdminOperations.tsx tests/routing_smoke.py
git commit -m "fix: remove company-run delivery, add self-arranged Uber Moto checkout option"
```

---

### Task 2: Otimizar e converter as imagens placeholder para WebP

**Files:**
- Create: `public/images/brownie-hero-demo.webp`, `public/brand/brownieria-fortal-logo.webp`
- Delete: `public/images/brownie-hero-demo.png`, `public/brand/brownieria-fortal-logo.png`
- Modify: `src/App.tsx:14` (`BrandLogo`), `src/AdminOperations.tsx:27,50,52`, `src/lib/media.ts:2`
- Modify: `tests/media.test.ts:10,14`

**Interfaces:**
- Produces: `productImageSrc()` (`src/lib/media.ts`) continua com a mesma assinatura, só o valor de fallback muda de `/images/brownie-hero-demo.png` para `/images/brownie-hero-demo.webp`.

- [ ] **Step 1: Converter as imagens (comandos já testados nesta sessão)**

```bash
npx --yes sharp-cli@3 -i public/images/brownie-hero-demo.png -o public/images -f webp -q 76
npx --yes sharp-cli@3 -i public/brand/brownieria-fortal-logo.png -o public/brand -f webp -q 85 resize 600
```

Expected: cria `public/images/brownie-hero-demo.webp` (~56KB, era 1,7MB) e `public/brand/brownieria-fortal-logo.webp` (~78KB, era 1,7MB). Confirme com:

```bash
du -h public/images/brownie-hero-demo.webp public/brand/brownieria-fortal-logo.webp
```

- [ ] **Step 2: Remover os PNGs antigos**

```bash
git rm public/images/brownie-hero-demo.png public/brand/brownieria-fortal-logo.png
```

- [ ] **Step 3: Atualizar as referências no código**

`src/lib/media.ts:2`:

```ts
export function productImageSrc(product: { imageUrl?: string }): string {
  return product.imageUrl || "/images/brownie-hero-demo.webp";
}
```

`src/App.tsx:14` (`BrandLogo`):

```tsx
function BrandLogo({ compact = false }: { compact?: boolean }) { return <img className={compact ? "brand-logo compact" : "brand-logo"} src="/brand/brownieria-fortal-logo.webp" alt="Brownieria Fortal" width={220} height={220} />; }
```

`src/AdminOperations.tsx`, as duas ocorrências de `/brand/brownieria-fortal-logo.png` (linhas 27 e 50) trocam para `/brand/brownieria-fortal-logo.webp`; a ocorrência de `/images/brownie-hero-demo.png` (linha 52, fallback de foto do produto no admin) troca para `/images/brownie-hero-demo.webp`.

- [ ] **Step 4: Atualizar o teste unitário de `media.ts`**

Em `tests/media.test.ts`, linhas 10 e 14, trocar as duas ocorrências de `"/images/brownie-hero-demo.png"` por `"/images/brownie-hero-demo.webp"`.

- [ ] **Step 5: Rodar os testes**

```bash
npm test
```
Expected: todos os testes em `tests/*.test.ts` passam, incluindo os dois casos atualizados de `media.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add -A public/images public/brand src/lib/media.ts src/App.tsx src/AdminOperations.tsx tests/media.test.ts
git commit -m "perf: convert placeholder images to compressed WebP (1.7MB -> ~60-80KB each)"
```

---

### Task 3: Camada de design tokens

**Files:**
- Create: `src/tokens.css`
- Modify: `src/main.tsx` (import)
- Modify: `src/index.css` (aplicar tokens em seletores-chave)

**Interfaces:**
- Produces: variáveis CSS `--space-1`..`--space-8`, `--radius-sm/md/lg/xl`, `--shadow-sm/md/lg`, `--text-display/h1/h2/h3/body/small/caption`, disponíveis globalmente (import antes de `index.css`).

- [ ] **Step 1: Criar `src/tokens.css`**

```css
:root {
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 48px;
  --space-8: 64px;

  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-xl: 24px;

  --shadow-sm: 0 2px 8px rgb(63 36 24 / .06);
  --shadow-md: 0 8px 24px rgb(63 36 24 / .10);
  --shadow-lg: 0 16px 40px rgb(63 36 24 / .16);

  --text-display: clamp(2.375rem, 5vw, 3.875rem);
  --text-h1: clamp(1.75rem, 3.4vw, 2.4375rem);
  --text-h2: clamp(1.375rem, 2.4vw, 1.75rem);
  --text-h3: 0.9375rem;
  --text-body: 0.875rem;
  --text-small: 0.8125rem;
  --text-caption: 0.6875rem;
}
```

- [ ] **Step 2: Importar antes de `index.css` em `src/main.tsx`**

```ts
import './tokens.css';
import './index.css';
import './experience.css';
import './admin.css';
import './admin-sprint4.css';
import './polish.css';
```

- [ ] **Step 3: Aplicar os tokens nos seletores mais visíveis de `src/index.css`**

`index.css` é um único arquivo minificado em uma linha; use busca-e-substituição exata destes seis trechos (todos existem literalmente no arquivo hoje):

| Trecho atual | Trecho novo |
| --- | --- |
| `.eyebrow{font-size:11px;font-weight:800;letter-spacing:.12em;color:var(--brand-pink);margin:0 0 10px}` | `.eyebrow{font-size:var(--text-caption);font-weight:800;letter-spacing:.12em;color:var(--brand-pink);margin:0 0 var(--space-2)}` |
| `.hero h1{font-size:clamp(38px,5vw,62px);line-height:.98;margin:0}` | `.hero h1{font-size:var(--text-display);line-height:.98;margin:0}` |
| `.section h1,.admin-content h1{font-size:39px;margin:0 0 8px}` | `.section h1,.admin-content h1{font-size:var(--text-h1);margin:0 0 var(--space-2)}` |
| `.section h2{font-size:28px;margin:0}` | `.section h2{font-size:var(--text-h2);margin:0}` |
| `.product-card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:10px;box-shadow:0 3px 12px #6b40290b}` | `.product-card{background:#fff;border:1px solid var(--line);border-radius:var(--radius-md);padding:var(--space-3);box-shadow:var(--shadow-sm)}` |
| `.section,.admin-content{padding:34px 28px}` | `.section,.admin-content{padding:var(--space-6) var(--space-5)}` |

Nota: a última substituição arredonda 34px/28px para 32px/24px (múltiplos de 8, a escala do próprio Vision Bible) — mudança visual mínima e intencional. O restante dos valores soltos em `index.css`/`experience.css`/`admin.css` fica para uma limpeza futura fora deste redesign (ver relatório final) — migrar cada declaração das ~180 regras existentes não é necessário para atingir o objetivo desta fase e ampliaria o escopo sem benefício visual proporcional.

- [ ] **Step 4: Verificação manual**

```bash
npm run dev
```
Abra `http://localhost:3000`, confirme visualmente que título da Home, títulos de seção e cards de produto não regrediram (tamanhos quase idênticos aos anteriores, cantos levemente mais suaves no card).

- [ ] **Step 5: Rodar o smoke visual**

Terminal 2 (com o dev server rodando):
```bash
python3 tests/visual_smoke.py
```
Expected: nenhuma asserção falha (sem overflow horizontal, elementos-chave presentes).

- [ ] **Step 6: Commit**

```bash
git add src/tokens.css src/main.tsx src/index.css
git commit -m "feat: introduce design token layer (spacing, radius, shadow, type scale)"
```

---

### Task 4: `LoadingSkeleton` — estado de carregamento real

**Files:**
- Create: `src/components/LoadingSkeleton.tsx`
- Modify: `src/App.tsx:28` (`if (!business) return <main className="loading">Carregando cardápio…</main>;`)
- Modify: `src/polish.css` (novas regras de shimmer)

**Interfaces:**
- Produces: `export function LoadingSkeleton(): JSX.Element` — sem props, usado no lugar do texto de carregamento em `App()`.

- [ ] **Step 1: Criar o componente**

```tsx
export function LoadingSkeleton() {
  return (
    <main className="app-shell loading-skeleton" aria-busy="true" aria-label="Carregando cardápio">
      <div className="skeleton-header" />
      <div className="skeleton-hero" />
      <div className="skeleton-row">
        <div className="skeleton-card" />
        <div className="skeleton-card" />
        <div className="skeleton-card" />
      </div>
    </main>
  );
}
```

- [ ] **Step 2: CSS do shimmer em `src/polish.css`**

Adicionar ao final do arquivo:

```css
.loading-skeleton { padding: var(--space-4); }
.skeleton-header, .skeleton-hero, .skeleton-card { border-radius: var(--radius-lg); background: linear-gradient(90deg, var(--brand-cream) 25%, var(--brand-pink-light) 50%, var(--brand-cream) 75%); background-size: 200% 100%; animation: skeleton-shimmer 1.4s ease-in-out infinite; }
.skeleton-header { height: 64px; margin-bottom: var(--space-4); }
.skeleton-hero { height: 285px; margin-bottom: var(--space-4); }
.skeleton-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-4); }
.skeleton-card { height: 220px; }
@keyframes skeleton-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
@media (max-width: 640px) { .skeleton-row { grid-template-columns: repeat(2, 1fr); } }
```

A regra global já existente em `src/polish.css` (`@media (prefers-reduced-motion: reduce) { *, *::before, *::after { ... animation-duration: .01ms !important; } }`) já neutraliza este shimmer para quem prefere menos movimento — nenhuma regra adicional necessária.

- [ ] **Step 3: Usar no lugar do texto de carregamento**

Em `src/App.tsx`, adicionar o import:

```ts
import { LoadingSkeleton } from "./components/LoadingSkeleton";
```

E trocar a linha 28:

```tsx
if (!business) return <LoadingSkeleton />;
```

- [ ] **Step 4: Verificação manual**

```bash
npm run dev
```
Simule carregamento lento no DevTools (Network → Slow 3G) e recarregue `http://localhost:3000` — o skeleton deve aparecer com o shimmer antes do conteúdo real.

- [ ] **Step 5: Rodar o smoke visual**

```bash
python3 tests/visual_smoke.py
```
Expected: sem asserções falhas (o skeleton só aparece antes do primeiro `fetch`, o teste espera `networkidle` antes de suas asserções).

- [ ] **Step 6: Commit**

```bash
git add src/components/LoadingSkeleton.tsx src/App.tsx src/polish.css
git commit -m "feat: add LoadingSkeleton component for initial menu load"
```

---

### Task 5: `QuantitySelector` — eliminar duplicação

**Files:**
- Create: `src/components/QuantitySelector.tsx`
- Modify: `src/App.tsx` (`ProductDetail`, `Cart`)

**Interfaces:**
- Produces: `export function QuantitySelector({ value, onChange, min = 1, size = "default" }: { value: number; onChange: (next: number) => void; min?: number; size?: "default" | "small" }): JSX.Element`

- [ ] **Step 1: Criar o componente**

```tsx
import { Minus, Plus } from "lucide-react";

export function QuantitySelector({ value, onChange, min = 1, size = "default" }: { value: number; onChange: (next: number) => void; min?: number; size?: "default" | "small" }) {
  const iconSize = size === "small" ? 14 : 18;
  return (
    <div className={size === "small" ? "quantity small" : "quantity"}>
      <button type="button" aria-label="Diminuir quantidade" onClick={() => onChange(Math.max(min, value - 1))}><Minus size={iconSize} aria-hidden="true" /></button>
      <b>{value}</b>
      <button type="button" aria-label="Aumentar quantidade" onClick={() => onChange(value + 1)}><Plus size={iconSize} aria-hidden="true" /></button>
    </div>
  );
}
```

- [ ] **Step 2: Usar em `ProductDetail`**

Em `src/App.tsx`, trocar o bloco `<div className="quantity">...</div>` dentro de `ProductDetail` por:

```tsx
<QuantitySelector value={quantity} onChange={setQuantity} min={1} />
```

- [ ] **Step 3: Usar em `Cart`**

Trocar o bloco `<div className="quantity small">...</div>` dentro do `.map` de `Cart` por:

```tsx
<QuantitySelector size="small" value={line.quantity} min={0} onChange={next => onChange(line.product.id, next)} />
```

(`min={0}` preserva o comportamento atual: ao chegar a 0, `onChange` já remove a linha do carrinho, como o `change()` de `App()` já faz hoje.)

- [ ] **Step 4: Adicionar o import em `src/App.tsx`**

```ts
import { QuantitySelector } from "./components/QuantitySelector";
```

Remover apenas `Minus` do import existente de `"lucide-react"` no topo de `App.tsx` (deixa de ser usado neste arquivo). Manter `Plus` — ainda usado no ícone de adicionar do `ProductCard` local, que só será removido de `App.tsx` na Task 6.

- [ ] **Step 5: Verificação manual**

```bash
npm run dev
```
Em `http://localhost:3000/cardapio/brigadeiro`, confirme que os botões +/- da quantidade funcionam e o preço total atualiza. Em `/carrinho` com itens, confirme que diminuir até 0 remove o item.

- [ ] **Step 6: Rodar os smokes**

```bash
python3 tests/routing_smoke.py
python3 tests/aggregate_pricing_smoke.py
```
Expected: ambos passam sem asserção falha.

- [ ] **Step 7: Commit**

```bash
git add src/components/QuantitySelector.tsx src/App.tsx
git commit -m "refactor: extract QuantitySelector, removing duplicated quantity controls"
```

---

### Task 6: `AvailabilityBadge`, `PriceDisplay`/`PromotionCallout` e `ProductCard` com foto grande

**Files:**
- Create: `src/components/AvailabilityBadge.tsx`, `src/components/PriceDisplay.tsx`, `src/components/ProductCard.tsx`
- Modify: `src/App.tsx` (remover a função `ProductCard` local, usar a nova em `Home`/`Menu`, usar `PriceDisplay`/`PromotionCallout` em `ProductDetail`)
- Modify: `src/experience.css:33-36` (`.product-photo`), `src/polish.css` (remover a altura fixa de `.product-photo` no mobile)

**Interfaces:**
- Produces: `export function AvailabilityBadge({ available }: { available: boolean }): JSX.Element`; `export function PriceDisplay({ value, size = "default" }: { value: number; size?: "default" | "large" }): JSX.Element`; `export function PromotionCallout({ promotionalPrice, minimumQuantity, tone = "compact" }: { promotionalPrice: number; minimumQuantity: number; tone?: "compact" | "detailed" }): JSX.Element`; `export function ProductCard({ product, isDay, onClick, onAdd }: { product: PricingProduct & { id: string; name: string; description: string; category: string; imageUrl: string; isAvailable: boolean }; isDay?: boolean; onClick: () => void; onAdd?: () => void }): JSX.Element` (mesma API pública da função que hoje existe em `App.tsx`).

- [ ] **Step 1: `AvailabilityBadge.tsx`**

```tsx
export function AvailabilityBadge({ available }: { available: boolean }) {
  return <span className={available ? "available" : "unavailable"}>{available ? "Disponível hoje" : "Esgotado hoje"}</span>;
}
```

- [ ] **Step 2: `PriceDisplay.tsx`**

```tsx
import { formatCurrency } from "../lib/format";

export function PriceDisplay({ value, size = "default" }: { value: number; size?: "default" | "large" }) {
  return <strong className={size === "large" ? "big-price" : undefined}>{formatCurrency(value)}</strong>;
}

export function PromotionCallout({ promotionalPrice, minimumQuantity, tone = "compact" }: { promotionalPrice: number; minimumQuantity: number; tone?: "compact" | "detailed" }) {
  if (tone === "detailed") {
    return <p className="promo">Quanto mais brownies no pedido — de qualquer sabor —, melhor o preço: {formatCurrency(promotionalPrice)} cada a partir de {minimumQuantity} unidades.</p>;
  }
  return <small className="promo">{formatCurrency(promotionalPrice)} cada a partir de {minimumQuantity} un. no pedido</small>;
}
```

- [ ] **Step 3: `ProductCard.tsx`**

```tsx
import { Plus } from "lucide-react";
import { productImageSrc } from "../lib/media";
import type { PricingProduct } from "../lib/pricing";
import { AvailabilityBadge } from "./AvailabilityBadge";
import { PriceDisplay, PromotionCallout } from "./PriceDisplay";

export type CardProduct = PricingProduct & { id: string; name: string; description: string; category: string; imageUrl: string; isAvailable: boolean };

export function ProductCard({ product, isDay = false, onClick, onAdd }: { product: CardProduct; isDay?: boolean; onClick: () => void; onAdd?: () => void }) {
  const promo = product.promotionalPrice && product.minimumPromotionalQuantity;
  return (
    <article className={`product-card ${!product.isAvailable ? "sold-out" : ""}`}>
      <button type="button" className="product-main" onClick={onClick}>
        <div className="product-photo">
          <img loading="lazy" decoding="async" width={480} height={360} src={productImageSrc(product)} alt={`Imagem demonstrativa de ${product.name}`} />
          {isDay && <span className="day-badge">Brownie do Dia</span>}
        </div>
        <div className="product-copy">
          <p className="product-category">{product.category}</p>
          <h3>{product.name}</h3>
          <p>{product.description}</p>
          {promo && <PromotionCallout promotionalPrice={product.promotionalPrice!} minimumQuantity={product.minimumPromotionalQuantity!} tone="compact" />}
          <PriceDisplay value={product.basePrice} />
        </div>
      </button>
      <div className="product-footer">
        <AvailabilityBadge available={product.isAvailable} />
        {onAdd && (
          <button type="button" disabled={!product.isAvailable} className="add-icon" onClick={onAdd} aria-label={`Adicionar ${product.name}`}>
            {product.isAvailable ? <Plus size={18} aria-hidden="true" /> : "—"}
          </button>
        )}
      </div>
    </article>
  );
}
```

- [ ] **Step 4: Remover a função `ProductCard` local de `src/App.tsx` e importar a nova**

Remover a função `ProductCard` (a linha que começa com `function ProductCard({ product, isDay = false, onClick, onAdd }: ...) { ... }`). Adicionar:

```ts
import { ProductCard } from "./components/ProductCard";
```

Remover `Plus` do import de `"lucide-react"` no topo de `App.tsx` — depois de remover a função `ProductCard` local, este era o último uso de `Plus` neste arquivo (o próprio `ProductCard.tsx` importa `Plus` para si).

`Home` e `Menu` continuam chamando `<ProductCard key={p.id} product={p} .../>` exatamente como hoje — nenhuma mudança nesses dois pontos de uso.

- [ ] **Step 5: Usar `PriceDisplay`/`PromotionCallout` em `ProductDetail`**

Em `ProductDetail`, trocar `<strong className="big-price">{formatCurrency(price.unitPrice)}</strong>` por:

```tsx
<PriceDisplay value={price.unitPrice} size="large" />
```

E trocar `{product.promotionalPrice && <p className="promo">Quanto mais brownies no pedido — de qualquer sabor —, melhor o preço: {formatCurrency(product.promotionalPrice)} cada a partir de {product.minimumPromotionalQuantity} unidades.</p>}` por:

```tsx
{product.promotionalPrice && product.minimumPromotionalQuantity && <PromotionCallout promotionalPrice={product.promotionalPrice} minimumQuantity={product.minimumPromotionalQuantity} tone="detailed" />}
```

Adicionar o import: `import { PriceDisplay, PromotionCallout } from "./components/PriceDisplay";`

- [ ] **Step 6: Foto grande do card — CSS**

Em `src/experience.css`, trocar:

```css
.product-photo { height: 190px; overflow: hidden; border-radius: 10px; position: relative; background: var(--brand-brown-dark); }
```

por:

```css
.product-photo { aspect-ratio: 4 / 3; overflow: hidden; border-radius: var(--radius-md); position: relative; background: var(--brand-brown-dark); }
```

Em `src/polish.css`, remover a regra `.product-photo { height: 150px; }` de dentro do bloco `@media (max-width: 640px) { .product-photo { height: 150px; } .product-hero-photo { height: 300px; } }`, deixando só:

```css
@media (max-width: 640px) { .product-hero-photo { height: 300px; } }
```

(`aspect-ratio` já resolve a altura em qualquer largura — a altura fixa de mobile deixa de ser necessária para o card; `.product-hero-photo` é tratado na Task 7.)

- [ ] **Step 7: Verificação manual**

```bash
npm run dev
```
Em `http://localhost:3000/cardapio`, confirme visualmente que as fotos dos cards estão maiores/proporcionais (4:3) em 360px, 768px e 1440px, sem cortar ou distorcer.

- [ ] **Step 8: Rodar os smokes**

```bash
python3 tests/visual_smoke.py
python3 tests/routing_smoke.py
```
Expected: ambos passam.

- [ ] **Step 9: Commit**

```bash
git add src/components/AvailabilityBadge.tsx src/components/PriceDisplay.tsx src/components/ProductCard.tsx src/App.tsx src/experience.css src/polish.css
git commit -m "feat: extract ProductCard/AvailabilityBadge/PriceDisplay components with larger product photos"
```

---

### Task 7: `HeroMedia` — fotografia grande na Home e no Produto

**Files:**
- Create: `src/components/HeroMedia.tsx`
- Modify: `src/App.tsx` (`Home`, `ProductDetail`)
- Modify: `src/index.css` (`.hero` grid), `src/experience.css:15-18,37-39` (`.hero-photo`, `.product-hero-photo`), `src/polish.css` (media queries)

**Interfaces:**
- Produces: `export function HeroMedia({ src, alt, caption, variant = "home" }: { src: string; alt: string; caption?: string; variant?: "home" | "product" }): JSX.Element`

- [ ] **Step 1: Criar `HeroMedia.tsx`**

```tsx
export function HeroMedia({ src, alt, caption, variant = "home" }: { src: string; alt: string; caption?: string; variant?: "home" | "product" }) {
  const className = variant === "home" ? "hero-photo" : "product-hero-photo";
  return (
    <figure className={className}>
      <img src={src} alt={alt} width={variant === "home" ? 900 : 960} height={variant === "home" ? 700 : 720} loading="eager" decoding="async" />
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
```

- [ ] **Step 2: Usar em `Home`**

Em `src/App.tsx`, dentro de `Home`, trocar:

```tsx
<figure className="hero-photo"><img src={productImageSrc(day ?? {})} alt="Foto demonstrativa de brownie de chocolate com recheio cremoso" /><figcaption>Imagem demonstrativa — aguardando foto oficial</figcaption></figure>
```

por:

```tsx
<HeroMedia src={productImageSrc(day ?? {})} alt="Foto demonstrativa de brownie de chocolate com recheio cremoso" caption="Imagem demonstrativa — aguardando foto oficial" variant="home" />
```

- [ ] **Step 3: Usar em `ProductDetail`**

Trocar:

```tsx
<figure className="product-hero-photo"><img src={productImageSrc(product)} alt={`Imagem demonstrativa de ${product.name}`} /><figcaption>Imagem demonstrativa — aguardando foto oficial</figcaption></figure>
```

por:

```tsx
<HeroMedia src={productImageSrc(product)} alt={`Imagem demonstrativa de ${product.name}`} caption="Imagem demonstrativa — aguardando foto oficial" variant="product" />
```

Adicionar o import: `import { HeroMedia } from "./components/HeroMedia";`

- [ ] **Step 4: Aumentar a foto — CSS**

Em `src/index.css`, trocar o trecho `grid-template-columns:1.15fr .85fr` (dentro da regra `.hero{...}`) por `grid-template-columns:1fr 1.1fr` — a foto passa a ocupar mais espaço que o texto, como pede o Vision Bible ("fotografia ocupa aproximadamente metade da composição desktop").

Em `src/experience.css`, trocar:

```css
.hero-photo { height: 285px; margin: 0; min-width: 0; border-radius: 18px; overflow: hidden; position: relative; background: var(--brand-brown-dark); }
```

por:

```css
.hero-photo { height: clamp(320px, 42vw, 560px); margin: 0; min-width: 0; border-radius: var(--radius-lg); overflow: hidden; position: relative; background: var(--brand-brown-dark); }
```

- [ ] **Step 5: Verificação manual**

```bash
npm run dev
```
Confirme em `http://localhost:3000` (Home) que a foto do hero ocupa proporção maior da composição em 1440px e 1024px, e que em 360/390px ainda ocupa a largura toda sem overflow.

- [ ] **Step 6: Rodar os smokes**

```bash
python3 tests/visual_smoke.py
python3 tests/routing_smoke.py
```
Expected: ambos passam, sem overflow horizontal em nenhuma das larguras testadas (360–1440px).

- [ ] **Step 7: Commit**

```bash
git add src/components/HeroMedia.tsx src/App.tsx src/index.css src/experience.css
git commit -m "feat: extract HeroMedia component and enlarge hero/product photography"
```

---

### Task 8: `FloatingCartButton` — carrinho sempre acessível durante o scroll

**Files:**
- Create: `src/components/FloatingCartButton.tsx`
- Modify: `src/App.tsx` (`App()`)
- Modify: `src/experience.css:10` (`.public-header`)

**Interfaces:**
- Produces: `export function FloatingCartButton({ itemCount, onClick }: { itemCount: number; onClick: () => void }): JSX.Element`

- [ ] **Step 1: Criar o componente**

```tsx
import { ShoppingBag } from "lucide-react";

export function FloatingCartButton({ itemCount, onClick }: { itemCount: number; onClick: () => void }) {
  return (
    <button type="button" className="cart-button" onClick={onClick} aria-label="Abrir pedido">
      <ShoppingBag size={19} aria-hidden="true" />
      {itemCount > 0 && <b>{itemCount}</b>}
    </button>
  );
}
```

- [ ] **Step 2: Usar em `App()`**

Trocar o bloco `<button className="cart-button" onClick={() => navigate("/carrinho")} aria-label="Abrir pedido"><ShoppingBag size={19} aria-hidden="true" />{cart.length > 0 && <b>{cart.reduce((n, l) => n + l.quantity, 0)}</b>}</button>` por:

```tsx
<FloatingCartButton itemCount={cart.reduce((n, l) => n + l.quantity, 0)} onClick={() => navigate("/carrinho")} />
```

Adicionar o import: `import { FloatingCartButton } from "./components/FloatingCartButton";`

- [ ] **Step 3: Header fixo durante o scroll — CSS**

Em `src/experience.css`, trocar:

```css
.public-header { height: 118px; padding: 10px 28px; background: var(--brand-cream); border-bottom: 1px solid var(--line); }
```

por:

```css
.public-header { height: 118px; padding: 10px 28px; background: var(--brand-cream); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 20; }
```

Isso mantém logo e botão do carrinho visíveis durante o scroll no Cardápio e no Produto, sem duplicar um segundo botão flutuante — o header inteiro passa a ser o elemento persistente, com o carrinho sempre acessível dentro dele.

- [ ] **Step 4: Verificação manual**

```bash
npm run dev
```
Em `http://localhost:3000/cardapio`, role a página para baixo e confirme que o header (com o botão do carrinho) permanece visível no topo.

- [ ] **Step 5: Rodar os smokes**

```bash
python3 tests/visual_smoke.py
python3 tests/routing_smoke.py
```
Expected: ambos passam.

- [ ] **Step 6: Commit**

```bash
git add src/components/FloatingCartButton.tsx src/App.tsx src/experience.css
git commit -m "feat: extract FloatingCartButton and make public header sticky during scroll"
```

---

### Task 9: `ConfirmDialog` — diálogo de confirmação reutilizável

**Files:**
- Create: `src/components/ConfirmDialog.tsx`
- Modify: `src/App.tsx` (`Cart`)

**Interfaces:**
- Produces: `export function ConfirmDialog({ question, confirmLabel, onConfirm, onCancel }: { question: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void }): JSX.Element`

- [ ] **Step 1: Criar o componente**

```tsx
export function ConfirmDialog({ question, confirmLabel, onConfirm, onCancel }: { question: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <p className="clear-confirm">
      <span>{question}</span>
      <button type="button" className="link-danger" onClick={onConfirm}>{confirmLabel}</button>
      <button type="button" className="text-button" onClick={onCancel}>Cancelar</button>
    </p>
  );
}
```

- [ ] **Step 2: Usar em `Cart`**

Trocar:

```tsx
{confirmingClear ? <p className="clear-confirm"><span>Remover todos os itens?</span><button className="link-danger" onClick={() => { lines.forEach(l => onChange(l.product.id, 0)); setConfirmingClear(false); }}>Sim, limpar</button><button className="text-button" onClick={() => setConfirmingClear(false)}>Cancelar</button></p> : <button className="link-danger" onClick={() => setConfirmingClear(true)}>Limpar pedido</button>}
```

por:

```tsx
{confirmingClear
  ? <ConfirmDialog question="Remover todos os itens?" confirmLabel="Sim, limpar" onConfirm={() => { lines.forEach(l => onChange(l.product.id, 0)); setConfirmingClear(false); }} onCancel={() => setConfirmingClear(false)} />
  : <button className="link-danger" onClick={() => setConfirmingClear(true)}>Limpar pedido</button>}
```

Adicionar o import: `import { ConfirmDialog } from "./components/ConfirmDialog";`

- [ ] **Step 3: Verificação manual**

```bash
npm run dev
```
Em `http://localhost:3000/carrinho` com itens no carrinho, clique "Limpar pedido", confirme que o diálogo aparece e que "Sim, limpar" esvazia o carrinho.

- [ ] **Step 4: Rodar o smoke de rotas**

```bash
python3 tests/routing_smoke.py
```
Expected: passa sem asserção falha.

- [ ] **Step 5: Commit**

```bash
git add src/components/ConfirmDialog.tsx src/App.tsx
git commit -m "refactor: extract reusable ConfirmDialog from Cart's clear-order confirmation"
```

---

### Task 10: Instalar Framer Motion e adicionar transição de rota

**Files:**
- Modify: `package.json` (nova dependência)
- Modify: `src/App.tsx` (`App()`)

**Interfaces:**
- Consumes: `AnimatePresence`, `motion`, `useReducedMotion` de `"framer-motion"`.

- [ ] **Step 1: Instalar a dependência**

```bash
npm install framer-motion@^12.42.2
```

Expected: `package.json` ganha `"framer-motion": "^12.42.2"` em `dependencies`; `npm ls framer-motion` mostra a versão instalada sem erro de peer dependency (React 19 é suportado pelo framer-motion 12.x).

- [ ] **Step 2: Transição de rota em `App()`**

Em `src/App.tsx`, adicionar o import:

```ts
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
```

Dentro de `App()`, adicionar (junto às outras variáveis do componente, antes do `return`):

```ts
const location = useLocation();
const prefersReducedMotion = useReducedMotion();
```

(`useLocation` já está importado de `"react-router-dom"` na primeira linha do arquivo — só falta chamá-lo aqui, já que hoje só é usado dentro de `ConfirmationRoute`.)

Trocar o `<Outlet context={context} />` final por:

```tsx
<AnimatePresence mode="wait">
  <motion.div key={location.pathname} initial={{ opacity: 0, y: prefersReducedMotion ? 0 : 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
    <Outlet context={context} />
  </motion.div>
</AnimatePresence>
```

- [ ] **Step 3: Verificação manual**

```bash
npm run dev
```
Navegue entre Home → Cardápio → Produto → Carrinho e confirme uma transição suave de fade/slide entre as telas, sem quebrar o layout.

Ative "Reduzir movimento" nas preferências do sistema operacional (ou emule via DevTools → Rendering → "Emulate CSS media feature prefers-reduced-motion") e confirme que a transição deixa de deslocar verticalmente (só o fade permanece, por causa da media query global).

- [ ] **Step 4: Rodar os smokes**

```bash
python3 tests/routing_smoke.py
python3 tests/visual_smoke.py
```
Expected: ambos passam — a navegação entre rotas continua funcionando com a transição animada.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/App.tsx
git commit -m "feat: add Framer Motion route transitions"
```

---

### Task 11: Microinterações — stagger no cardápio, hover/tap nos cards, badge do carrinho

**Files:**
- Modify: `src/App.tsx` (`Menu`)
- Modify: `src/components/ProductCard.tsx`
- Modify: `src/components/FloatingCartButton.tsx`

**Interfaces:**
- Nenhuma interface pública muda — só comportamento visual interno dos componentes já criados nas Tasks 6 e 8.

- [ ] **Step 1: Stagger dos cards no Cardápio**

Em `src/App.tsx`, adicionar o import: `import { motion, useReducedMotion } from "framer-motion";`

Dentro de `Menu`, adicionar antes do `return`:

```ts
const prefersReducedMotion = useReducedMotion();
const gridVariants = { hidden: {}, show: { transition: { staggerChildren: prefersReducedMotion ? 0 : 0.05 } } };
const cardVariants = { hidden: { opacity: 0, y: prefersReducedMotion ? 0 : 16 }, show: { opacity: 1, y: 0 } };
```

Trocar `<div className="product-grid menu-grid">{ordered.map(p => <ProductCard key={p.id} product={p} isDay={p.slug === "brigadeiro"} onClick={() => onProduct(p)} onAdd={() => onAdd(p)} />)}</div>` por:

```tsx
<motion.div className="product-grid menu-grid" variants={gridVariants} initial="hidden" animate="show">
  {ordered.map(p => (
    <motion.div variants={cardVariants} key={p.id}>
      <ProductCard product={p} isDay={p.slug === "brigadeiro"} onClick={() => onProduct(p)} onAdd={() => onAdd(p)} />
    </motion.div>
  ))}
</motion.div>
```

- [ ] **Step 2: Hover/tap no `ProductCard`**

Em `src/components/ProductCard.tsx`, adicionar o import: `import { motion } from "framer-motion";`

Trocar a tag raiz `<article className={...}>` por `<motion.article className={...} whileHover={{ y: -4 }} whileTap={{ scale: 0.98 }} transition={{ duration: 0.15 }}>` e a tag de fechamento correspondente `</article>` por `</motion.article>`.

- [ ] **Step 3: "Pop" no badge do carrinho**

Em `src/components/FloatingCartButton.tsx`, trocar o conteúdo por:

```tsx
import { AnimatePresence, motion } from "framer-motion";
import { ShoppingBag } from "lucide-react";

export function FloatingCartButton({ itemCount, onClick }: { itemCount: number; onClick: () => void }) {
  return (
    <button type="button" className="cart-button" onClick={onClick} aria-label="Abrir pedido">
      <ShoppingBag size={19} aria-hidden="true" />
      <AnimatePresence>
        {itemCount > 0 && (
          <motion.b key={itemCount} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={{ duration: 0.18 }}>
            {itemCount}
          </motion.b>
        )}
      </AnimatePresence>
    </button>
  );
}
```

(a `key={itemCount}` faz o badge "pipocar" a cada mudança de quantidade, não só ao aparecer/desaparecer.)

- [ ] **Step 4: Verificação manual**

```bash
npm run dev
```
Em `http://localhost:3000/cardapio`, confirme a entrada em cascata dos cards; passe o mouse sobre um card e confirme a leve elevação; adicione itens ao carrinho e confirme que o número no botão do carrinho "pipoca" a cada clique.

- [ ] **Step 5: Rodar os smokes**

```bash
python3 tests/routing_smoke.py
python3 tests/visual_smoke.py
```
Expected: ambos passam.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/components/ProductCard.tsx src/components/FloatingCartButton.tsx
git commit -m "feat: add stagger reveal, card hover/tap, and cart badge pop motion"
```

---

### Task 12: Verificação final completa

**Files:**
- Nenhum arquivo novo — só execução de verificação.

- [ ] **Step 1: Tipos e testes unitários**

```bash
npm run lint
npm test
```
Expected: ambos sem erro.

- [ ] **Step 2: Build de produção**

```bash
npm run build
```
Expected: build conclui sem erro (confirma que nenhum import quebrado ou tipo incorreto passou despercebido pelo `tsc --noEmit` do lint, já que o build do Vite também type-checa via esbuild/rollup plugins).

- [ ] **Step 3: Todos os smoke tests Python**

Terminal 1: `npm run dev`
Terminal 2:
```bash
python3 tests/routing_smoke.py
python3 tests/visual_smoke.py
python3 tests/aggregate_pricing_smoke.py
python3 tests/admin_product_editor_smoke.py
```
Expected: todos passam.

- [ ] **Step 4: Checagem manual multi-viewport**

Em `http://localhost:3000`, testar em 360, 390, 768, 1024 e 1440px (DevTools → Toggle device toolbar → Responsive):
- Sem overflow horizontal em nenhuma largura.
- Todos os alvos de toque (botões, ícones) com pelo menos 44×44px.
- Fluxo completo Home → Cardápio → Produto → Carrinho → Checkout (Retirada e Uber Moto) → Confirmação, sem erros no console.

- [ ] **Step 5: Checagem de contraste (P3 da auditoria)**

Usar as DevTools do Chrome (inspecionar elemento → aba "Accessibility" → contraste) nos textos que usam `--muted` (`#78655d`) e no rosa da marca (`#e66fa2`) sobre fundo branco/creme, nos tamanhos pequenos (10-13px) usados em `.eyebrow`, `.product-category`, `.subtle`. Documentar no relatório final se algum caso ficar abaixo de 4.5:1 (texto normal) ou 3:1 (texto grande/negrito ≥14px bold) — se sim, ajustar `--muted` em `src/index.css` para um tom mais escuro que ainda combine com a paleta.

- [ ] **Step 6: Commit final (se a Step 5 exigir ajuste)**

Só necessário se o Step 5 encontrar um caso reprovado:

```bash
git add src/index.css
git commit -m "fix: darken --muted for WCAG AA contrast on small text"
```

---

## Autorevisão do plano

- **Cobertura do spec:** tokens (Task 3), os 8 componentes nomeados no spec (Tasks 4–9), fotografia grande + otimização (Tasks 2, 6, 7), correção Uber Moto (Task 1), Framer Motion (Tasks 10–11), verificação (Task 12) — todas as seções do spec têm task correspondente.
- **Placeholders:** nenhum "TBD"; todo código de cada step é completo e foi verificado contra o conteúdo real dos arquivos nesta sessão (inclusive os comandos de compressão de imagem, testados e com tamanhos finais reais).
- **Consistência de tipos:** `CardProduct` (Task 6) é compatível com o tipo `Product` já usado em `App.tsx` (mesmos campos lidos); `Business`/`Order`/`Totals` (Task 1) têm todos os call sites atualizados juntos na mesma task, evitando um estado intermediário quebrado.
- **Escopo:** painel admin recebe só a correção de rótulo estritamente necessária (Task 1, Step 3) e os tokens compartilhados por herança de CSS (Task 3) — nenhuma task redesenha seu layout.
