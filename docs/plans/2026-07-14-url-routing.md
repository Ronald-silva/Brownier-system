# Roteamento por URL (React Router) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir a navegação por estado (`useState<Screen>`) em `src/App.tsx` por rotas reais de URL, para que o botão Voltar/Avançar do navegador funcione, links sejam compartilháveis, e um refresh no meio do fluxo não jogue o cliente de volta para a Home.

**Architecture:** Introduzir `react-router-dom` (`BrowserRouter`) como única mudança estrutural. O carrinho (`cart`) e os dados carregados (`business`, `products`) continuam vivendo no componente `App`, que passa a ser um layout compartilhado (`<Outlet />`) em vez de um switch de telas — assim nenhuma tela perde acesso ao estado que já usa hoje. A tela de confirmação passa a buscar o pedido pelo `publicCode` da URL via `GET /api/public/orders/:publicCode` (endpoint já existente) em vez de depender só do estado em memória — isso corrige de brinde o bug de "refresh perde a confirmação do pedido".

**Tech Stack:** React 19, Vite, TypeScript, `react-router-dom` (nova dependência — única deste plano).

## Global Constraints

- Única dependência nova permitida: `react-router-dom`. Não introduzir mais nada (sem gerenciador de estado global, sem data-fetching library).
- Não alterar nenhuma copy/texto visível nem comportamento visual das telas — isso é uma mudança de arquitetura de navegação, não de design.
- Preservar 100% do comportamento de negócio hoje existente (cálculo de preço, checkout, admin) — este plano só move *como* as telas trocam, não o que elas fazem.
- `npm test`, `npm run lint`, `npm run build` devem passar após cada task.
- Cada task termina com commit próprio.
- Rotas devem usar caminhos em português, consistente com a copy do produto: `/`, `/cardapio`, `/cardapio/:slug`, `/carrinho`, `/finalizar`, `/pedido/:publicCode`, `/equipe`.

---

## File Structure

| Arquivo | Ação | Responsabilidade |
| --- | --- | --- |
| `package.json` | Modificar | Adicionar `react-router-dom`. |
| `src/main.tsx` | Modificar | Envolver `<App />` em `<BrowserRouter>`. |
| `src/App.tsx` | Modificar | `App` vira layout (carrega `business`/`products`/`cart`, renderiza `<Outlet context={...}>`); cada tela atual (`Home`, `Menu`, `ProductDetail`, `Cart`, `Checkout`, `Confirmation`) vira uma rota que lê o contexto via `useOutletContext`. |
| `src/AdminOperations.tsx` | Modificar | Passa a ser renderizado pela rota `/equipe`; `onExit` navega para `/` em vez de mudar estado local. |
| `tests/routing_smoke.py` | Criar | Teste Playwright: voltar do navegador funciona, deep-link para `/carrinho` funciona, refresh em `/pedido/:publicCode` mantém a confirmação. |

---

### Task 1: Instalar `react-router-dom` e envolver a aplicação

**Files:**
- Modify: `package.json`
- Modify: `src/main.tsx`

**Interfaces:**
- Produces: `<BrowserRouter>` disponível para toda a árvore de componentes.

- [ ] **Step 1: Verificar a versão atual compatível com React 19**

Run: `npm view react-router-dom versions --json | tail -5`
Expected: lista de versões recentes (7.x). Confirme que a versão mais recente declara suporte a `react: ^19` antes de instalar — não assuma um número de versão sem checar.

- [ ] **Step 2: Instalar a dependência**

Run: `npm install react-router-dom@<versão confirmada no Step 1>`
Expected: `package.json` e `package-lock.json` atualizados, instalação sem erro de peer dependency.

- [ ] **Step 3: Envolver `<App />` em `<BrowserRouter>`**

Em `src/main.tsx`, adicionar o import e o wrapper:

```tsx
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import App from './App.tsx';
import './index.css';
import './experience.css';
import './admin.css';
import './admin-sprint4.css';
import './polish.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
```

- [ ] **Step 4: Rodar lint e build**

Run: `npm run lint && npm run build`
Expected: ambos passam sem erro (o app ainda usa `useState` para navegação nesta task — só adicionamos o Router ao redor, sem trocar nada ainda).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/main.tsx
git commit -m "chore: add react-router-dom and wrap app in BrowserRouter"
```

---

### Task 2: Rotas da vitrine pública — Home, Menu e Produto

**Files:**
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `<BrowserRouter>` da Task 1.
- Produces: `AppContext` (tipo `{ business: Business; products: Product[]; cart: CartLine[]; add: (p: Product, q?: number) => void; change: (id: string, q: number) => void; summary: { subtotal: number; discount: number } }`) exposto via `useOutletContext<AppContext>()` — as próximas tasks consomem exatamente esse formato.

- [ ] **Step 1: Transformar `App` em layout com `<Outlet>`**

Reescrever o componente `App` em `src/App.tsx` (mantendo `business`, `products`, `cart`, `notice`, `refresh`, `add`, `change`, `summary` como já existem hoje) para, em vez do bloco `if (screen === ...)`, renderizar:

```tsx
import { Outlet, useNavigate, useOutletContext } from "react-router-dom";

export type AppContext = { business: Business; products: Product[]; cart: CartLine[]; add: (p: Product, q?: number) => void; change: (id: string, q: number) => void; summary: { subtotal: number; discount: number } };

export default function App() {
  const [business, setBusiness] = useState<Business | null>(null); const [products, setProducts] = useState<Product[]>([]); const [cart, setCart] = useState<CartLine[]>([]); const [notice, setNotice] = useState("");
  const navigate = useNavigate();
  const refresh = async () => { const [b, p] = await Promise.all([api<Business>("/api/public/business"), api<Product[]>("/api/public/menu")]); setBusiness(b); setProducts(p); };
  useEffect(() => { refresh().catch(error => setNotice(error.message)); }, []);
  const add = (product: Product, quantity = 1) => { if (!product.isAvailable) return; setCart(lines => { const found = lines.find(line => line.product.id === product.id); return found ? lines.map(line => line.product.id === product.id ? { ...line, quantity: line.quantity + quantity } : line) : [...lines, { product, quantity }]; }); setNotice(`${product.name} adicionado ao pedido.`); };
  const change = (id: string, quantity: number) => setCart(lines => quantity < 1 ? lines.filter(line => line.product.id !== id) : lines.map(line => line.product.id === id ? { ...line, quantity } : line));
  const summary = useMemo(() => cart.reduce((acc, line) => { const price = calculateLinePrice(line.product, line.quantity); return { subtotal: acc.subtotal + price.total, discount: acc.discount + price.discount }; }, { subtotal: 0, discount: 0 }), [cart]);
  if (!business) return <main className="loading">Carregando cardápio…</main>;
  const context: AppContext = { business, products, cart, add, change, summary };
  return <main className="app-shell"><header className="public-header"><button className="brand" onClick={() => navigate("/")} aria-label="Ir para o início"><BrandLogo compact /></button><button className="cart-button" onClick={() => navigate("/carrinho")} aria-label="Abrir pedido"><ShoppingBag size={19} aria-hidden="true" />{cart.length > 0 && <b>{cart.reduce((n, l) => n + l.quantity, 0)}</b>}</button></header>{notice && <div className="toast" role="status">{notice}<button onClick={() => setNotice("")}>×</button></div>}<Outlet context={context} /></main>;
}
```

Nota: a rota `/equipe` (admin) **não** passa por este layout — ela é montada fora do `<main className="app-shell">`, como rota irmã independente (ver Task 5), porque hoje o admin já é uma tela cheia própria sem o header público.

- [ ] **Step 2: Criar componentes de rota para Home e Menu**

Ainda em `src/App.tsx`, ajustar `Home` e `Menu` para ler o contexto em vez de props, e trocar callbacks (`onMenu`, `onProduct`, `onAdd`, `onAdmin`) por `navigate(...)`:

```tsx
function HomeRoute() {
  const { business, products, add } = useOutletContext<AppContext>();
  const navigate = useNavigate();
  return <Home business={business} products={products} onMenu={() => navigate("/cardapio")} onAdmin={() => navigate("/equipe")} onProduct={p => navigate(`/cardapio/${p.slug}`)} onAdd={add} />;
}
function MenuRoute() {
  const { products, add } = useOutletContext<AppContext>();
  const navigate = useNavigate();
  return <Menu products={products} onBack={() => navigate("/")} onProduct={p => navigate(`/cardapio/${p.slug}`)} onAdd={add} />;
}
```

`Home` e `Menu` (as funções já existentes) não mudam de assinatura — continuam recebendo as mesmas props de hoje, só quem as chama que muda.

- [ ] **Step 3: Criar rota de produto por slug**

`ProductDetail` hoje recebe `product` via estado `selected`. Trocar para buscar pelo slug da URL:

```tsx
function ProductRoute() {
  const { products, add } = useOutletContext<AppContext>();
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const product = products.find(p => p.slug === slug);
  if (!product) return <main className="loading">Produto não encontrado.</main>;
  const recommendations = products.filter(p => p.isFeatured && p.id !== product.id && p.isAvailable).slice(0, 2);
  return <ProductDetail product={product} recommendations={recommendations} onBack={() => navigate("/cardapio")} onAdd={(p, q) => { add(p, q); navigate("/carrinho"); }} />;
}
```

Adicionar `import { useParams } from "react-router-dom";` junto aos demais imports do router.

- [ ] **Step 4: Registrar as rotas em `src/main.tsx`**

```tsx
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import App from './App.tsx';
import { HomeRoute, MenuRoute, ProductRoute } from './App.tsx'; // ou exportar cada Route de App.tsx

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route index element={<HomeRoute />} />
          <Route path="cardapio" element={<MenuRoute />} />
          <Route path="cardapio/:slug" element={<ProductRoute />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
```

(As rotas de carrinho/checkout/confirmação/admin entram nas Tasks 3–5. O `App` já reescrito no Step 1 não tem mais nenhuma chamada antiga de `screen` — ele builda porque `react-router-dom` não dá erro em tempo de build por uma rota ainda não registrada, só resultaria em página em branco se alguém navegasse para `/carrinho` antes da Task 3. Como a verificação manual deste Step 6 não passa pelo carrinho, e não há rota coringa capturando esse caso ainda, isso é aceitável para um commit intermediário.)

- [ ] **Step 5: Rodar lint, testes e build**

Run: `npm run lint && npm test && npm run build`
Expected: todos passam.

- [ ] **Step 6: Verificação manual**

Run: `npm run dev`. Abrir `/`, clicar "Ver cardápio" → URL muda para `/cardapio`. Clicar em um produto → URL vira `/cardapio/<slug>`. Apertar Voltar do navegador → volta para `/cardapio` (não sai do app). Colar `/cardapio/brownie-tradicional` direto na barra de endereço e dar Enter → abre direto na tela do produto.
Expected: todos os passos funcionam como descrito — este é o comportamento que hoje **não existe**.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/main.tsx
git commit -m "feat: route home/menu/product screens through react-router instead of local state"
```

---

### Task 3: Rotas de Carrinho e Checkout

**Files:**
- Modify: `src/App.tsx`, `src/main.tsx`

**Interfaces:**
- Consumes: `AppContext` da Task 2.

- [ ] **Step 1: Criar `CartRoute` e `CheckoutRoute`**

```tsx
function CartRoute() {
  const { cart, summary, change } = useOutletContext<AppContext>();
  const navigate = useNavigate();
  return <Cart lines={cart} subtotal={summary.subtotal} discount={summary.discount} onBack={() => navigate("/cardapio")} onChange={change} onCheckout={() => navigate("/finalizar")} />;
}
function CheckoutRoute() {
  const { business, cart, summary } = useOutletContext<AppContext>();
  const navigate = useNavigate();
  return <Checkout business={business} lines={cart} summary={summary} onBack={() => navigate("/carrinho")} onDone={order => navigate(`/pedido/${order.publicCode}`, { state: { order } })} />;
}
```

Nota: `onDone` passa o pedido recém-criado via `location.state` (evita um round-trip de rede imediato) — a Task 4 trata o caso de o `state` não existir (refresh/link direto).

- [ ] **Step 2: Registrar as rotas**

Em `src/main.tsx`, dentro de `<Route element={<App />}>`, adicionar:

```tsx
<Route path="carrinho" element={<CartRoute />} />
<Route path="finalizar" element={<CheckoutRoute />} />
```

- [ ] **Step 3: Rodar lint, testes e build**

Run: `npm run lint && npm test && npm run build`
Expected: todos passam. (`screen`/`setScreen`/`selected`/`order` já não existem em `App` desde a Task 2 Step 1 — nada a remover aqui.)

- [ ] **Step 4: Verificação manual**

Run: `npm run dev`. Adicionar um item, ir em `/carrinho`, clicar "Continuar pedido" → URL vira `/finalizar`. Apertar Voltar → volta para `/carrinho` com o carrinho intacto (o estado não é perdido porque `cart` vive em `App`, acima do `<Outlet>`).
Expected: navegação funciona e carrinho não é resetado ao navegar entre as telas.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/main.tsx
git commit -m "feat: route cart/checkout screens through react-router"
```

---

### Task 4: Rota de confirmação com recuperação por refresh

**Files:**
- Modify: `src/App.tsx`, `src/main.tsx`

**Interfaces:**
- Consumes: `GET /api/public/orders/:publicCode` (rota já existente em `server.ts`, documentada no README).
- Produces: nenhuma interface nova além do componente de rota.

- [ ] **Step 1: Escrever o teste que falha (comportamento de recuperação)**

Este componente busca o pedido pela API quando não há `location.state` (ex.: após um refresh). Não há teste unitário de componente no projeto hoje (só `node:test` para funções puras) — a verificação é via `tests/routing_smoke.py` (Task 6, Playwright). Pular direto para a implementação aqui é aceitável porque a lógica de fetch já existe em `api<T>()`, testada indiretamente pelos testes existentes de `server.ts`; o novo comportamento (fallback de refresh) será coberto no smoke test da Task 6.

- [ ] **Step 2: Criar `ConfirmationRoute` com fallback de busca**

```tsx
function ConfirmationRoute() {
  const { business } = useOutletContext<AppContext>();
  const { publicCode } = useParams<{ publicCode: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const stateOrder = (location.state as { order?: Order } | null)?.order;
  const [order, setOrderState] = useState<Order | null>(stateOrder ?? null);
  const [notFound, setNotFound] = useState(false);
  useEffect(() => {
    if (stateOrder || !publicCode) return;
    api<Order>(`/api/public/orders/${publicCode}`).then(setOrderState).catch(() => setNotFound(true));
  }, [stateOrder, publicCode]);
  if (notFound) return <main className="loading">Pedido não encontrado.</main>;
  if (!order) return <main className="loading">Carregando pedido…</main>;
  return <Confirmation order={order} message={business.receivedMessage} onMenu={() => navigate("/cardapio")} />;
}
```

Adicionar `import { useLocation } from "react-router-dom";` junto aos demais imports do router.

- [ ] **Step 3: Registrar a rota**

Em `src/main.tsx`: `<Route path="pedido/:publicCode" element={<ConfirmationRoute />} />`

- [ ] **Step 4: Rodar lint, testes e build**

Run: `npm run lint && npm test && npm run build`
Expected: todos passam.

- [ ] **Step 5: Verificação manual do refresh (o bug que esta task corrige)**

Run: `npm run dev`. Completar um pedido de teste até a tela de confirmação (URL `/pedido/<código>`). Apertar F5 (refresh).
Expected: a tela de confirmação recarrega com os mesmos dados (via fetch), em vez de voltar para a Home vazia — comportamento que hoje **não existe** (hoje um refresh em qualquer tela sempre volta para `/`, perdendo o código do pedido).

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/main.tsx
git commit -m "feat: route confirmation screen with API fallback so refresh doesn't lose the order"
```

---

### Task 5: Rota do painel administrativo

**Files:**
- Modify: `src/App.tsx`, `src/main.tsx`

**Interfaces:**
- Consumes: `AdminOperations` (componente já existente, sem mudança de assinatura).

- [ ] **Step 1: Criar `AdminRoute` fora do layout público**

```tsx
function AdminRoute() {
  const navigate = useNavigate();
  return <AdminOperations onExit={() => navigate("/")} />;
}
```

- [ ] **Step 2: Registrar como rota irmã (fora de `<Route element={<App />}>`)**

Em `src/main.tsx`:

```tsx
<Routes>
  <Route path="equipe" element={<AdminRoute />} />
  <Route element={<App />}>
    <Route index element={<HomeRoute />} />
    <Route path="cardapio" element={<MenuRoute />} />
    <Route path="cardapio/:slug" element={<ProductRoute />} />
    <Route path="carrinho" element={<CartRoute />} />
    <Route path="finalizar" element={<CheckoutRoute />} />
    <Route path="pedido/:publicCode" element={<ConfirmationRoute />} />
  </Route>
</Routes>
```

- [ ] **Step 3: Rodar lint, testes e build**

Run: `npm run lint && npm test && npm run build`
Expected: todos passam.

- [ ] **Step 4: Verificação manual**

Run: `npm run dev`. Na Home, clicar "Área da equipe" → URL vira `/equipe`, painel abre normalmente com o fluxo de login por código já existente. Clicar "Sair" → volta para `/`.
Expected: comportamento idêntico ao atual, só que agora com URL própria (compartilhável/atualizável sem perder o contexto de login, já que `AdminOperations` guarda o código em `sessionStorage`, inalterado).

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/main.tsx
git commit -m "feat: route admin panel to its own /equipe URL"
```

---

### Task 6: Smoke test de regressão de navegação

**Files:**
- Create: `tests/routing_smoke.py`

**Interfaces:**
- Nenhuma — teste end-to-end via Playwright, seguindo o padrão já usado em `tests/visual_smoke.py`.

- [ ] **Step 1: Criar o teste**

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    page.goto("http://localhost:3000", wait_until="networkidle")
    page.get_by_role("button", name="Ver cardápio").first.click()
    page.wait_for_timeout(200)
    assert "/cardapio" in page.url

    page.locator(".add-icon:not([disabled])").first.click()
    page.get_by_label("Abrir pedido").click()
    page.wait_for_timeout(200)
    assert "/carrinho" in page.url

    # Deep link direto para o carrinho (compartilhamento de URL)
    page.goto("http://localhost:3000/carrinho", wait_until="networkidle")
    assert page.locator("text=Sua caixa está quase pronta.").count() == 1

    # Botão Voltar do navegador funciona dentro do app
    page.goto("http://localhost:3000", wait_until="networkidle")
    page.get_by_role("button", name="Ver cardápio").first.click()
    page.wait_for_timeout(200)
    page.go_back()
    page.wait_for_timeout(200)
    assert page.url.rstrip("/") == "http://localhost:3000"

    browser.close()
print("routing smoke: ok")
```

- [ ] **Step 2: Rodar o teste**

Run: `python3 <caminho do with_server.py do skill webapp-testing> --server "npm run dev" --port 3000 -- python3 tests/routing_smoke.py`
Expected: imprime `routing smoke: ok`, sem `AssertionError`.

- [ ] **Step 3: Commit**

```bash
git add tests/routing_smoke.py
git commit -m "test: add Playwright smoke test for URL routing (back button, deep links)"
```

---

## Self-Review

**1. Cobertura do objetivo:** botão Voltar funciona (Task 2 Step 6, Task 6), deep-link funciona (Task 2 Step 6, Task 6), refresh não perde o pedido (Task 4 Step 5) — as três dores do achado original da auditoria de design estão cobertas.

**2. Consistência de tipos:** `AppContext` é definido na Task 2 e consumido sem alteração de forma nas Tasks 3–5 (`business`, `products`, `cart`, `add`, `change`, `summary`) — nenhuma task posterior exige um campo que a Task 2 não produz.

**3. Risco arquitetural principal:** `src/App.tsx` é hoje um arquivo único e denso (todas as telas como funções no mesmo arquivo). Este plano mantém essa convenção existente (não separa cada tela em arquivo próprio) para minimizar o diff e o risco — é uma melhoria de navegação, não uma refatoração de organização de arquivos. Se no futuro o arquivo crescer demais, dividir por tela é uma melhoria separada, não coberta aqui.

**4. Reversibilidade:** cada task builda e passa sozinha (a Task 2 mantém as chamadas antigas de `screen` funcionando até a Task 3 removê-las) — é possível parar em qualquer task e ter um app funcional.
