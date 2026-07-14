# Correção de Inconsistências do MVP Brownies Fortal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminar todas as inconsistências reais encontradas na auditoria do grafo de conhecimento (`.graphify/GRAPH_REPORT.md`) e na leitura completa do código-fonte e da documentação — dois bugs funcionais reproduzíveis, uma implementação de admin morta e divergente, três violações de DRY/consistência estrutural, e dois itens de limpeza.

**Architecture:** Nenhuma mudança arquitetural. As correções seguem o padrão já estabelecido pelo próprio projeto (`src/lib/pricing.ts` como módulo compartilhado entre cliente e servidor) para eliminar duplicação de dados/lógica que já causou um bug real (status de pedido). Mudanças são cirúrgicas, arquivo por arquivo, com verificação via `npm test`, `npm run lint` e `npm run build` — os mesmos comandos já exigidos pelo checklist de "Qualidade técnica mínima" em `docs/SPRINT_5_BUSINESS_VALIDATION_DEMO_KIT.md`.

**Tech Stack:** TypeScript, Express, React 19, Vite, node:test (test runner nativo).

## Global Constraints

- Não introduzir novas dependências (sem frameworks de teste de componente, sem libs de upload) — o projeto já tem convenção própria: funções puras testadas com `node:test` (`tests/pricing.test.ts`) e fluxo completo verificado com Playwright (`tests/visual_smoke.py`).
- Não alterar comportamento visual/copy da interface pública — todas as strings de UI (pt-BR, tom de voz definido em `docs/PRODUCT_VISION_EXPERIENCE_BIBLE.md` §7) permanecem exatamente como estão.
- `npm test`, `npm run lint` e `npm run build` devem passar após cada task.
- Nunca commitar `data/brownies-fortal.demo.json` (já ignorado via `.gitignore`).
- Cada task termina com commit próprio.

---

## File Structure

| Arquivo | Ação | Responsabilidade |
| --- | --- | --- |
| `src/lib/orderStatuses.ts` | Criar | Única fonte de verdade para os status válidos de pedido (elimina a divergência de grafia entre frontend e backend). |
| `tests/orderStatuses.test.ts` | Criar | Regressão: garante que `ORDER_STATUSES` contém a grafia correta e não a antiga com erro de digitação. |
| `server.ts` | Modificar | Importar `ORDER_STATUSES` em vez de array local; aplicar limite de corpo JSON maior apenas nas rotas admin de produto (upload de foto). |
| `src/AdminOperations.tsx` | Modificar | Importar `ORDER_STATUSES` em vez de array local `statuses`. |
| `src/App.tsx` | Modificar | Remover implementação morta do painel admin (`Admin`, `Metric`, `ProductEditor`, `SettingsEditor`) e imports de ícones não usados; usar `productImageSrc()` em vez de caminho fixo da imagem demo; usar `formatCurrency()` compartilhado em vez de `money()` local. |
| `src/lib/media.ts` | Criar | Função pura `productImageSrc()` — resolve a imagem exibida a partir de `product.imageUrl`, com fallback para a imagem demo. |
| `tests/media.test.ts` | Criar | Regressão: garante que `productImageSrc()` retorna `imageUrl` quando presente e o fallback quando ausente/vazio. |
| `src/lib/format.ts` | Criar | Função pura `formatCurrency()` — formatação BRL compartilhada (elimina duplicação entre `App.tsx` e `AdminOperations.tsx`). |
| `tests/format.test.ts` | Criar | Regressão: garante a formatação BRL esperada. |
| `tsconfig.json` | Modificar | Remover `"exclude": ["server.ts"]` para que o type-check cubra o backend. |
| `api/` | Remover | Diretório vazio (`api/pix/status`), resquício de integração de pagamento nunca iniciada; contradiz o README ("Não há credenciais de pagamento... no MVP"). |
| `metadata.json` | Modificar | Corrigir `"name"` para refletir o produto real em vez de um nome de template genérico. |

---

### Task 1: Fonte única de verdade para status de pedido (corrige o bug de grafia)

**Contexto do bug:** `server.ts:20` define `orderStatuses` com o valor `"SAIU_PARA_ENTEGA"` (faltando o R). `src/AdminOperations.tsx:7` define seu próprio array `statuses` com a grafia correta `"SAIU_PARA_ENTREGA"` e a oferece como opção no `<select>` de status (linha 23 e linha 29 do arquivo). Quando um operador seleciona "SAIU_PARA_ENTREGA" no painel real (`AdminOperations`, a única implementação de admin efetivamente renderizada), o `PUT /api/admin/orders/:id` em `server.ts` rejeita a requisição com `400 { error: "Status inválido." }`, porque `"SAIU_PARA_ENTREGA"` não está na lista `orderStatuses` do servidor. Isso já era um risco documentado em `docs/SPRINT_5_BUSINESS_VALIDATION_DEMO_KIT.md` §11.6 — este task corrige a causa raiz (duas listas hand-typed independentes) em vez de só alinhar a grafia, seguindo o mesmo padrão que o projeto já usa para preço (`src/lib/pricing.ts` compartilhado entre client e server).

**Files:**
- Create: `src/lib/orderStatuses.ts`
- Create: `tests/orderStatuses.test.ts`
- Modify: `server.ts:20`, `server.ts:138` (validação em `PUT /api/admin/orders/:id`)
- Modify: `src/AdminOperations.tsx:7`

**Interfaces:**
- Produces: `export const ORDER_STATUSES: readonly string[]` — array imutável com os 7 status válidos, na ordem `["NOVO", "CONFIRMADO", "EM_PREPARO", "PRONTO", "SAIU_PARA_ENTREGA", "CONCLUIDO", "CANCELADO"]`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/orderStatuses.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { ORDER_STATUSES } from "../src/lib/orderStatuses.ts";

test("contém a grafia correta de SAIU_PARA_ENTREGA", () => {
  assert.ok(ORDER_STATUSES.includes("SAIU_PARA_ENTREGA"));
});

test("não contém a grafia antiga com erro de digitação", () => {
  assert.ok(!ORDER_STATUSES.includes("SAIU_PARA_ENTEGA"));
});

test("contém exatamente os 7 status esperados, na ordem do fluxo operacional", () => {
  assert.deepEqual(ORDER_STATUSES, ["NOVO", "CONFIRMADO", "EM_PREPARO", "PRONTO", "SAIU_PARA_ENTREGA", "CONCLUIDO", "CANCELADO"]);
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `node --experimental-strip-types --test tests/orderStatuses.test.ts`
Expected: FAIL com `Cannot find module '../src/lib/orderStatuses.ts'`

- [ ] **Step 3: Criar o módulo compartilhado**

Criar `src/lib/orderStatuses.ts`:

```ts
export const ORDER_STATUSES = ["NOVO", "CONFIRMADO", "EM_PREPARO", "PRONTO", "SAIU_PARA_ENTREGA", "CONCLUIDO", "CANCELADO"] as const;
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `node --experimental-strip-types --test tests/orderStatuses.test.ts`
Expected: PASS (3 testes)

- [ ] **Step 5: Usar o módulo compartilhado em `server.ts`**

Em `server.ts`, adicionar o import junto aos demais (linha 6):

```ts
import { ORDER_STATUSES } from "./src/lib/orderStatuses.ts";
```

Substituir a linha 20:

```ts
const orderStatuses = ["NOVO", "CONFIRMADO", "EM_PREPARO", "PRONTO", "SAIU_PARA_ENTEGA", "CONCLUIDO", "CANCELADO"];
```

por:

```ts
const orderStatuses = ORDER_STATUSES;
```

(A variável local `orderStatuses` continua existindo — é usada na validação da linha 138 — apenas passa a apontar para a fonte única de verdade.)

- [ ] **Step 6: Usar o módulo compartilhado em `AdminOperations.tsx`**

Em `src/AdminOperations.tsx`, adicionar o import (linha 1, junto ao import de `react`):

```ts
import { ORDER_STATUSES } from "./lib/orderStatuses";
```

Substituir a linha 7:

```ts
const statuses = ["NOVO", "CONFIRMADO", "EM_PREPARO", "PRONTO", "SAIU_PARA_ENTREGA", "CONCLUIDO", "CANCELADO"];
```

por:

```ts
const statuses = ORDER_STATUSES;
```

- [ ] **Step 7: Rodar toda a suíte de testes**

Run: `npm test`
Expected: PASS (todos os testes existentes + os 3 novos)

- [ ] **Step 8: Rodar o type-check e o build**

Run: `npm run lint && npm run build`
Expected: ambos concluem sem erro.

- [ ] **Step 9: Verificação manual do bug original**

Run: `npm run dev`, abrir `http://localhost:3000`, entrar em "Área da equipe" com o código `brownies-demo`, ir em Pedidos, selecionar qualquer pedido e mudar o status para "SAIU PARA ENTREGA" no `<select>`.
Expected: o status é salvo sem erro `400 Status inválido` (antes da correção, essa ação falhava).

- [ ] **Step 10: Commit**

```bash
git add src/lib/orderStatuses.ts tests/orderStatuses.test.ts server.ts src/AdminOperations.tsx
git commit -m "fix: unify order status list to eliminate SAIU_PARA_ENTEGA typo bug"
```

---

### Task 2: Remover a implementação morta do painel admin em `App.tsx`

**Contexto do bug:** `src/App.tsx` define `Admin()` (linha 48), `Metric()` (linha 55), `ProductEditor()` (linha 56) e `SettingsEditor()` (linha 57) — uma segunda implementação completa de painel administrativo. Nenhuma delas é referenciada em lugar nenhum do fluxo real: `App()` (linha 23) sempre renderiza `<AdminOperations onExit={...} />`, importado de `./AdminOperations` (linha 4). As duas implementações já divergiram — a morta (`Admin`) não tem as abas "Promoções" nem "Produção" que a real (`AdminOperations`) tem. Isso é exatamente o padrão que o grafo de conhecimento sinalizou (nós `money()`, `Metric()`, `Product`, `Order`, `Store` duplicados com o mesmo nome em arquivos diferentes). O risco: alguém editar `Admin()` pensando que é o painel ativo e a mudança nunca aparecer para ninguém.

**Files:**
- Modify: `src/App.tsx:2` (import de ícones), `src/App.tsx:48`, `src/App.tsx:55-57` (remover funções)

**Interfaces:**
- Consumes: nenhuma interface nova — apenas remoção de código não referenciado.
- Produces: nenhuma interface nova.

- [ ] **Step 1: Remover as quatro funções mortas**

Em `src/App.tsx`, apagar as linhas 48 (`function Admin(...) {...}`), 55 (`function Metric(...) {...}`), 56 (`function ProductEditor(...) {...}`) e 57 (`function SettingsEditor(...) {...}`) por completo — as quatro linhas inteiras, do `function` até o `}` final de cada uma.

- [ ] **Step 2: Atualizar o import de ícones (linha 2)**

Substituir:

```ts
import { ArrowLeft, Check, ChevronRight, Clipboard, Coffee, Edit3, Minus, Package, Plus, Settings, ShoppingBag, Trash2 } from "lucide-react";
```

por (removendo `Coffee`, `Edit3`, `Package`, `Settings` e `Trash2`, que só eram usados dentro do código removido, e `Settings` que já não era usado em lugar nenhum):

```ts
import { ArrowLeft, Check, ChevronRight, Clipboard, Minus, Plus, ShoppingBag } from "lucide-react";
```

- [ ] **Step 3: Rodar o type-check**

Run: `npm run lint`
Expected: PASS, sem erros de referência quebrada ou import não usado.

- [ ] **Step 4: Rodar a suíte de testes**

Run: `npm test`
Expected: PASS (nenhum teste depende do código removido).

- [ ] **Step 5: Rodar o build**

Run: `npm run build`
Expected: build concluído sem erro; o bundle gerado deve ficar menor (código morto eliminado).

- [ ] **Step 6: Verificação manual**

Run: `npm run dev`, abrir `http://localhost:3000`, entrar em "Área da equipe" com `brownies-demo`.
Expected: o painel `AdminOperations` (com as abas Hoje/Sabores/Promoções/Pedidos/Produção/Ajustes) continua funcionando normalmente — nada muda na experiência, porque o código removido nunca era exibido.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "refactor: remove dead duplicate admin panel implementation from App.tsx"
```

---

### Task 3: Exibir a foto do produto no cardápio público

**Contexto do bug:** `src/AdminOperations.tsx` permite ao operador enviar uma foto por produto (`uploadPhoto`, linha 15) e grava o resultado em `product.imageUrl`. O próprio painel admin já respeita esse campo (`src/AdminOperations.tsx:20`: `<img src={p.imageUrl || "/images/brownie-hero-demo.png"} .../>`). Porém a vitrine pública em `src/App.tsx` — `Home` (linha 34), `ProductCard` (linha 36), `ProductDetail` (linha 37) e `Cart` (linha 39) — ignora `product.imageUrl` por completo e sempre usa o caminho fixo `/images/brownie-hero-demo.png`. Ou seja: mesmo que o upload funcione, o cliente nunca vê a foto real enviada. Isso mina diretamente o risco #1 apontado em `docs/SPRINT_5_BUSINESS_VALIDATION_DEMO_KIT.md` §11 ("Fotos ainda demonstrativas... é o maior risco de percepção comercial no lançamento").

**Files:**
- Create: `src/lib/media.ts`
- Create: `tests/media.test.ts`
- Modify: `src/App.tsx:34, 36, 37, 39` (usar `productImageSrc()` em vez do caminho fixo)

**Interfaces:**
- Produces: `export function productImageSrc(product: { imageUrl?: string }): string` — retorna `product.imageUrl` quando não vazio, senão `"/images/brownie-hero-demo.png"`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/media.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { productImageSrc } from "../src/lib/media.ts";

test("retorna a imagem enviada quando imageUrl está preenchida", () => {
  assert.equal(productImageSrc({ imageUrl: "data:image/png;base64,AAAA" }), "data:image/png;base64,AAAA");
});

test("retorna a imagem demonstrativa quando imageUrl está ausente", () => {
  assert.equal(productImageSrc({}), "/images/brownie-hero-demo.png");
});

test("retorna a imagem demonstrativa quando imageUrl é string vazia", () => {
  assert.equal(productImageSrc({ imageUrl: "" }), "/images/brownie-hero-demo.png");
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `node --experimental-strip-types --test tests/media.test.ts`
Expected: FAIL com `Cannot find module '../src/lib/media.ts'`

- [ ] **Step 3: Implementar a função**

Criar `src/lib/media.ts`:

```ts
export function productImageSrc(product: { imageUrl?: string }): string {
  return product.imageUrl || "/images/brownie-hero-demo.png";
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `node --experimental-strip-types --test tests/media.test.ts`
Expected: PASS (3 testes)

- [ ] **Step 5: Usar a função em `src/App.tsx`**

Adicionar o import (junto aos demais, após a linha 3):

```ts
import { productImageSrc } from "./lib/media";
```

Em `Home` (linha 34), substituir:

```tsx
<img src="/images/brownie-hero-demo.png" alt="Foto demonstrativa de brownie de chocolate com recheio cremoso" />
```

por:

```tsx
<img src={productImageSrc(day ?? {})} alt="Foto demonstrativa de brownie de chocolate com recheio cremoso" />
```

Em `ProductCard` (linha 36), substituir:

```tsx
<img loading="lazy" decoding="async" src="/images/brownie-hero-demo.png" alt={`Imagem demonstrativa de ${product.name}`} />
```

por:

```tsx
<img loading="lazy" decoding="async" src={productImageSrc(product)} alt={`Imagem demonstrativa de ${product.name}`} />
```

Em `ProductDetail` (linha 37), substituir:

```tsx
<img src="/images/brownie-hero-demo.png" alt={`Imagem demonstrativa de ${product.name}`} />
```

por:

```tsx
<img src={productImageSrc(product)} alt={`Imagem demonstrativa de ${product.name}`} />
```

Em `Cart` (linha 39), dentro do `.map(line => ...)`, substituir:

```tsx
<img src="/images/brownie-hero-demo.png" alt="Imagem demonstrativa" />
```

por:

```tsx
<img src={productImageSrc(line.product)} alt="Imagem demonstrativa" />
```

- [ ] **Step 6: Rodar o type-check, os testes e o build**

Run: `npm run lint && npm test && npm run build`
Expected: os três comandos concluem sem erro.

- [ ] **Step 7: Verificação manual end-to-end**

Run: `npm run dev`. Entrar como admin (`brownies-demo`), aba Sabores, enviar uma imagem pequena (ex.: um PNG de poucos KB) em qualquer sabor. Depois sair do painel e abrir o cardápio público (`Menu`) e o detalhe do produto correspondente.
Expected: a foto enviada aparece no cardápio e no detalhe do produto — não mais o placeholder demonstrativo fixo.

- [ ] **Step 8: Commit**

```bash
git add src/lib/media.ts tests/media.test.ts src/App.tsx
git commit -m "fix: render uploaded product photo on the public storefront instead of hardcoded placeholder"
```

---

### Task 4: Permitir upload de fotos reais sem estourar o limite do corpo da requisição

**Contexto do bug:** `server.ts:79` aplica `express.json({ limit: "64kb" })` a **todas** as rotas da aplicação. `AdminOperations.tsx`'s `uploadPhoto` (linha 15) converte a foto inteira para uma data URL base64 e envia via `PUT /api/admin/products/:id` dentro do corpo JSON. Qualquer foto real de celular (tipicamente centenas de KB a poucos MB) ultrapassa os 64KB e o Express rejeita a requisição antes mesmo de chegar à rota, com erro de corpo grande demais. O limite de 64KB foi dimensionado para as rotas públicas (que só recebem itens de pedido, textos curtos — já validados com `maxLength` em `server.ts`), não para o payload de upload de imagem do admin. A correção aplica um limite maior **apenas** nas duas rotas admin que recebem produto completo (criação e edição), mantendo o limite público restritivo por segurança (rotas públicas não autenticadas não devem aceitar corpos grandes).

**Files:**
- Modify: `server.ts:79, 125, 128, 131`

**Interfaces:**
- Consumes: `express.json` (já importado via `express`, sem novo import).
- Produces: nenhuma interface nova — apenas configuração de middleware por rota.

- [ ] **Step 1: Criar o parser de corpo maior, escopado às rotas de produto admin**

Em `server.ts`, logo após a linha `app.use(express.json({ limit: "64kb" }));` (linha 79), adicionar:

```ts
const adminProductBody = express.json({ limit: "8mb" });
```

- [ ] **Step 2: Aplicar o parser maior nas rotas de criação e edição de produto**

Substituir a linha 125:

```ts
app.post("/api/admin/products", admin, async (req, res) => {
```

por:

```ts
app.post("/api/admin/products", admin, adminProductBody, async (req, res) => {
```

Substituir a linha 131:

```ts
app.put("/api/admin/products/:id", admin, async (req, res) => {
```

por:

```ts
app.put("/api/admin/products/:id", admin, adminProductBody, async (req, res) => {
```

(O `express.json()` global da linha 79 já rodou antes com limite de 64KB e teria rejeitado corpos maiores; como o parser de rota é registrado depois do middleware global mas o Express só aplica o parser cujo `Content-Type` ainda não foi consumido, é necessário mover a leitura do corpo para acontecer apenas no parser de rota nessas duas rotas específicas — ver Step 3.)

- [ ] **Step 3: Excluir as rotas de produto admin do parser JSON global**

Para que o parser de 8MB realmente valha nessas duas rotas (e não seja bloqueado pelo parser global de 64KB que roda primeiro), o parser global da linha 79 precisa pular essas duas rotas. Substituir a linha 79:

```ts
app.use(express.json({ limit: "64kb" }));
```

por:

```ts
app.use((req, res, next) => {
  if (req.path === "/api/admin/products" || req.path.startsWith("/api/admin/products/")) return next();
  express.json({ limit: "64kb" })(req, res, next);
});
```

- [ ] **Step 4: Rodar o type-check e o build**

Run: `npm run lint && npm run build`
Expected: ambos concluem sem erro.

- [ ] **Step 5: Verificação manual do limite antigo (reprodução do bug)**

Com o servidor rodando (`npm run dev`) e um código admin válido, gerar um corpo de teste maior que 64KB e menor que 8MB:

```bash
node -e "console.log(JSON.stringify({name:'teste', basePrice:100, imageUrl:'data:image/png;base64,'+'A'.repeat(100000)}))" > /tmp/photo-payload.json
curl -i -X PUT http://localhost:3000/api/admin/products/demo-tradicional \
  -H "Content-Type: application/json" -H "x-admin-code: brownies-demo" \
  --data-binary @/tmp/photo-payload.json
```

Expected: `HTTP/1.1 200 OK` com o produto atualizado no corpo da resposta (antes da correção, essa mesma chamada retornava `413 Payload Too Large` ou erro de parse).

- [ ] **Step 6: Verificação manual de que o limite público continua restritivo**

```bash
curl -i -X POST http://localhost:3000/api/public/orders \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/photo-payload.json
```

Expected: a requisição continua sendo rejeitada (corpo grande demais para uma rota pública) — o endurecimento de segurança nas rotas públicas não autenticadas permanece intacto.

- [ ] **Step 7: Rodar toda a suíte de testes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server.ts
git commit -m "fix: allow real product photo uploads by scoping a larger JSON body limit to admin product routes"
```

---

### Task 5: Eliminar a duplicação do formatador de moeda

**Contexto:** `money()` é definida de forma idêntica em `src/App.tsx:10` e `src/AdminOperations.tsx:6` (`value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })`). O relatório do grafo de conhecimento já apontou `money()` como um "god node" duplicado — duas funções com o mesmo nome e mesmo corpo em arquivos diferentes, correndo o risco de divergir silenciosamente se alguém ajustar a formatação em um lugar só.

**Files:**
- Create: `src/lib/format.ts`
- Create: `tests/format.test.ts`
- Modify: `src/App.tsx:10` (remover `money` local, importar `formatCurrency`, substituir os usos)
- Modify: `src/AdminOperations.tsx:6` (remover `money` local, importar `formatCurrency`, substituir os usos)

**Interfaces:**
- Produces: `export function formatCurrency(value: number): string` — formata um número em centavos... **não**, os valores já vêm em reais nas chamadas existentes (ex.: `money(product.basePrice)` onde `basePrice` está em centavos de fato — ver nota abaixo). Manter o comportamento exatamente igual ao `money()` atual: recebe o número tal como é passado hoje e aplica `toLocaleString("pt-BR", { style: "currency", currency: "BRL" })` sem nenhuma conversão adicional (a função não deve mudar semântica, só local).

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/format.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { formatCurrency } from "../src/lib/format.ts";

test("formata um valor inteiro como moeda BRL", () => {
  assert.equal(formatCurrency(700), "R$ 700,00");
});

test("formata um valor com centavos como moeda BRL", () => {
  assert.equal(formatCurrency(28.5), "R$ 28,50");
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `node --experimental-strip-types --test tests/format.test.ts`
Expected: FAIL com `Cannot find module '../src/lib/format.ts'`

- [ ] **Step 3: Implementar a função**

Criar `src/lib/format.ts`:

```ts
export function formatCurrency(value: number): string {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `node --experimental-strip-types --test tests/format.test.ts`
Expected: PASS (2 testes). Se o separador exato retornado por `toLocaleString` no ambiente de execução divergir do espaço não separável (` `) usado no teste, ajustar a asserção para o valor realmente retornado nesse ambiente — o importante é fixar o comportamento atual, não uma formatação nova.

- [ ] **Step 5: Usar a função em `src/App.tsx`**

Remover a linha 10 (`const money = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });`).

Adicionar o import (após a linha 3):

```ts
import { formatCurrency } from "./lib/format";
```

Substituir todas as chamadas `money(` por `formatCurrency(` em `src/App.tsx` (ocorrem em `ProductCard`, `ProductDetail`, `Cart`, `Totals`, `Confirmation`, `Admin`-related código já removido na Task 2, e no restante do arquivo).

- [ ] **Step 6: Usar a função em `src/AdminOperations.tsx`**

Remover a linha 6 (`const money = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });`).

Adicionar o import (após a linha 1):

```ts
import { formatCurrency } from "./lib/format";
```

Substituir todas as chamadas `money(` por `formatCurrency(` em `src/AdminOperations.tsx` (ocorrem em `AdminOperations`, `Promotions`, `OrderList`).

- [ ] **Step 7: Rodar o type-check, os testes e o build**

Run: `npm run lint && npm test && npm run build`
Expected: os três comandos concluem sem erro; nenhuma referência a `money(` deve restar em `src/App.tsx` ou `src/AdminOperations.tsx` (`grep -n "money(" src/App.tsx src/AdminOperations.tsx` deve retornar vazio).

- [ ] **Step 8: Verificação manual**

Run: `npm run dev`, abrir o cardápio público e o painel admin.
Expected: todos os preços continuam exibidos no formato `R$ 0,00` exatamente como antes — nenhuma mudança visual.

- [ ] **Step 9: Commit**

```bash
git add src/lib/format.ts tests/format.test.ts src/App.tsx src/AdminOperations.tsx
git commit -m "refactor: extract duplicated BRL currency formatter into shared src/lib/format.ts"
```

---

### Task 6: Incluir `server.ts` no type-check

**Contexto:** `tsconfig.json:29` tem `"exclude": ["server.ts"]`, então `npm run lint` (`tsc --noEmit`) nunca verifica tipos no arquivo que contém toda a lógica de criação de pedido e validação de preço no servidor — exatamente o código que o README descreve como a garantia contra manipulação de preço pelo cliente. Erros de tipo nesse arquivo podem passar despercebidos indefinidamente.

**Files:**
- Modify: `tsconfig.json:29`

**Interfaces:**
- Nenhuma — mudança de configuração apenas.

- [ ] **Step 1: Remover a exclusão**

Em `tsconfig.json`, remover a linha:

```json
  "exclude": ["server.ts"]
```

(incluindo a vírgula pendente da linha anterior, se necessário, para manter o JSON válido — `"compilerOptions": { ... }` passa a ser a última/única chave de nível superior além de nenhuma outra, então remover a linha inteira do `exclude`.)

- [ ] **Step 2: Rodar o type-check e registrar os erros, se houver**

Run: `npm run lint`
Expected: ou passa limpo, ou reporta erros de tipo reais em `server.ts` que estavam escondidos.

- [ ] **Step 3: Corrigir os erros de tipo reportados, se houver**

Se o Step 2 reportar erros, corrigi-los em `server.ts` um a um, preservando o comportamento em tempo de execução (são apenas anotações/asserções de tipo — não alterar lógica de negócio). Repetir `npm run lint` até passar limpo.

- [ ] **Step 4: Rodar a suíte de testes e o build**

Run: `npm test && npm run build`
Expected: ambos passam sem erro.

- [ ] **Step 5: Commit**

```bash
git add tsconfig.json server.ts
git commit -m "chore: include server.ts in type-checking (was silently excluded)"
```

---

### Task 7: Remover o diretório órfão `api/pix/status`

**Contexto:** `api/pix/status/` existe vazio (sem nenhum arquivo dentro), um resquício de uma integração de pagamento PIX que nunca foi iniciada. Isso contradiz a afirmação explícita do `README.md` ("Não há credenciais de pagamento, Firebase, WhatsApp ou Evolution no MVP.") e pode confundir quem explorar a árvore de arquivos — inclusive um agente de IA que assuma que existe algum código de pagamento ali.

**Files:**
- Remove: `api/` (diretório inteiro, incluindo `api/pix/status`)

**Interfaces:**
- Nenhuma.

- [ ] **Step 1: Confirmar que o diretório está de fato vazio antes de remover**

Run: `find api -type f`
Expected: nenhuma saída (nenhum arquivo).

- [ ] **Step 2: Remover o diretório**

```bash
rm -rf api
```

- [ ] **Step 3: Confirmar que nada referencia esse caminho**

Run: `grep -rn "api/pix" --include="*.ts" --include="*.tsx" --include="*.md" --include="*.json" . 2>/dev/null | grep -v node_modules`
Expected: nenhuma saída.

- [ ] **Step 4: Rodar o build**

Run: `npm run build`
Expected: build concluído sem erro (diretório não era usado por nenhuma etapa do build).

- [ ] **Step 5: Commit**

```bash
git add -A api
git commit -m "chore: remove empty orphaned api/pix/status scaffolding"
```

---

### Task 8: Corrigir o nome do produto em `metadata.json`

**Contexto:** `metadata.json` tem `"name": "Gestão Inteligente de Pedidos"` — não corresponde ao nome em nenhum outro lugar do projeto (`package.json` usa `brownies-fortal-mvp`, o README usa "Brownies Fortal", a marca pública exibida usa "Brownieria Fortal"). É resquício de um nome de template genérico.

**Files:**
- Modify: `metadata.json`

**Interfaces:**
- Nenhuma.

- [ ] **Step 1: Atualizar o nome**

Em `metadata.json`, substituir:

```json
  "name": "Gestão Inteligente de Pedidos",
```

por:

```json
  "name": "Brownies Fortal — MVP de Pedidos",
```

- [ ] **Step 2: Confirmar que o JSON continua válido**

Run: `node -e "JSON.parse(require('fs').readFileSync('metadata.json', 'utf8')); console.log('ok')"`
Expected: imprime `ok`.

- [ ] **Step 3: Commit**

```bash
git add metadata.json
git commit -m "chore: fix stale template name in metadata.json"
```

---

## Nota sobre inconsistências de documentação (fora do escopo de código)

Duas inconsistências encontradas são de **documentação/organização**, não de código, e não têm um "fix" de arquivo único — ficam registradas aqui para decisão do dono do produto, não como tasks de engenharia:

1. **README.md nunca menciona "Brownieria Fortal"** — só "Brownies Fortal" — embora a marca pública exibida ao cliente (logo, `demoStore.business.name`, `docs/PRODUCT_VISION_EXPERIENCE_BIBLE.md`) seja "Brownieria Fortal". A explicação (nomes internos vs. marca pública) só existe na linha 3 do Product Vision Bible. Sugestão: adicionar uma linha ao README explicando a distinção, se ela for intencional.
2. **README.md e `docs/IA_E_WHATSAPP.md` descrevem rotas e ferramentas de agente sem referenciar a implementação real em `server.ts`** — nada força a sincronização se a API mudar. Não há correção de código para isso; é um lembrete operacional para quem alterar rotas no futuro (atualizar os dois `.md` manualmente).

---

## Self-Review

**1. Cobertura das inconsistências levantadas na análise:**
- Bug de status (`SAIU_PARA_ENTEGA`) → Task 1. ✅
- Foto do produto não aparece na vitrine → Task 3. ✅
- Upload de foto real provavelmente falha por limite de corpo → Task 4. ✅
- Painel admin morto/divergente em `App.tsx` → Task 2. ✅
- `money()` duplicado → Task 5. ✅
- `server.ts` fora do type-check → Task 6. ✅
- `api/pix/status` órfão → Task 7. ✅
- `metadata.json` com nome de template → Task 8. ✅
- Documentação desconectada do código / naming Brownies vs. Brownieria → registrado na seção "Nota sobre inconsistências de documentação" (decisão de produto, não task de código).

**2. Varredura de placeholders:** nenhum "TBD"/"implementar depois" — todos os steps têm código completo, comandos exatos e saída esperada. Task 6 tem uma ramificação condicional (Step 3 só roda "se houver erros") porque o resultado do type-check em `server.ts` é desconhecido até ser executado; isso é uma dependência real de descoberta, não uma lacuna do plano.

**3. Consistência de tipos/nomes entre tasks:** `ORDER_STATUSES` (Task 1), `productImageSrc` (Task 3), `formatCurrency` (Task 5) são usados com o mesmo nome e assinatura em todas as tasks que os referenciam. Task 5 depende de `src/App.tsx` já estar sem o código morto (Task 2) para que a lista de ocorrências de `money(` a substituir seja a lista final — por isso a ordem das tasks (1→2→3→4→5→6→7→8) deve ser respeitada.

---

Plano completo e salvo em `docs/plans/2026-07-14-inconsistency-remediation.md`. Duas opções de execução:

**1. Subagent-Driven (recomendado)** — dispatco um subagente novo por task, com revisão entre tasks, iteração rápida.

**2. Inline Execution** — executo as tasks nesta sessão, em lote, com checkpoints para revisão.

Qual abordagem você prefere?
