# Feedback visual ao adicionar ao carrinho — Design

## Contexto e motivação

Hoje, ao tocar em "Adicionar", o usuário quase não percebe que o brownie foi contabilizado no pedido. O contador do carrinho já atualiza (é derivado do estado `cart` em tempo real), mas sem nenhuma microanimação, e o único toast existente (`notice` em `App.tsx`) é compartilhado com mensagens de erro de carregamento — não some sozinho, exige fechamento manual (`×`). Os dois botões de "adicionar" (ícone `+` no card do cardápio, em `ProductCard`, e "Adicionar ao pedido · preço" na página de detalhe, em `ProductDetail`) não dão nenhum feedback próprio no clique.

Objetivo: fechar esse vácuo de feedback seguindo boas práticas de UX (confirmação imediata, discreta, não bloqueante), sem alterar nenhuma outra funcionalidade, layout de outras páginas, ou lógica de preço/carrinho.

## Escopo

**Dentro do escopo** (`src/App.tsx`, `src/polish.css`):
- Botão "Adicionar" do card do cardápio (`ProductCard`, ícone `+`) e da página de detalhe (`ProductDetail`, texto "Adicionar ao pedido"): feedback temporário de ~800ms no próprio botão.
- Contador do carrinho no header: microanimação de scale/pop a cada mudança.
- Novo toast de confirmação, dedicado, que some sozinho.
- `prefers-reduced-motion`: reaproveitar a regra global já existente em `polish.css` (linha 24), que zera `transition-duration`/`animation-duration` — nenhuma regra nova de motion precisa de tratamento especial.

**Fora do escopo:** `Cart`, `Checkout`, `Confirmation`, `AdminOperations.tsx`, lógica de preço/desconto (`src/lib/pricing.ts`), o toast de erro existente (`notice`/`.toast`), qualquer outra página ou layout.

## Decisão de design: toast novo e separado, não reaproveitar `notice`

`notice` (estado existente em `App.tsx`) é usado tanto para a mensagem "X adicionado ao pedido." quanto para erros de carregamento (`refresh().catch(error => setNotice(error.message))`). Fazer esse toast compartilhado sumir sozinho arriscaria esconder um erro real antes do usuário ler. Em vez disso:
- `add()` deixa de escrever em `notice` — evita toast duplicado (o antigo + o novo apareceriam juntos).
- Um novo estado (`addedNotice`) dirige um toast dedicado, só para confirmação de adição, com auto-dismiss.
- O toast de erro (`notice`/`.toast`) permanece exatamente como está: sem alteração de comportamento.

## Comportamento detalhado

**1. Botões "Adicionar" (ambos os pontos):**
- Estado local `justAdded` (boolean) por componente/instância.
- No clique: chama `add()` normalmente (contabilização não depende disso, já é síncrona via `setCart` funcional), liga `justAdded`, agenda `setTimeout` de 800ms para desligar.
- Um novo clique antes dos 800ms acabarem cancela o timeout anterior e agenda um novo — não empilha, não pisca de volta ao estado normal no meio de cliques rápidos.
- Cleanup do timeout no unmount (evita warning de state update pós-unmount).
- Visual: `ProductCard` troca o ícone `Plus` → `Check` (glyph `✓` já existe em `icons.tsx`); `ProductDetail` troca o texto do botão para "✓ Adicionado" (preço e disponibilidade voltam a aparecer depois dos 800ms).
- Nenhum dos dois botões fica desabilitado durante os 800ms — cliques repetidos continuam contabilizando (requisito 5).

**2. Contador do carrinho (header, `.cart-button b`):**
- `<b key={total}>{total}</b>` — mudar a `key` a cada valor força remount do elemento.
- Nova regra CSS: `@keyframes cart-count-pop` + `.cart-button b { animation: cart-count-pop .28s ease; }`, herda o corte de `prefers-reduced-motion` já existente.
- Atualização do número em si já é instantânea (deriva do estado `cart`); isso só adiciona a animação.

**3. Toast de confirmação (novo):**
- Estado `addedNotice: { id: number; text: string } | null` em `App.tsx`.
- `add()` seta `addedNotice` com texto `✓ ${product.name} adicionado ao pedido` a cada chamada (mesmo se for o mesmo produto de novo — `id` único garante que o efeito de auto-dismiss reinicie).
- `useEffect` dispara `setTimeout(2600ms)` para limpar `addedNotice`; cleanup cancela o timeout anterior a cada mudança — cliques rápidos resetam o timer, sem empilhar toasts.
- Render: pílula centralizada (não full-width), `position: fixed`, próxima da base da tela, `role="status"` (leitor de tela anuncia sem roubar foco), sem botão de fechar (some sozinho), não intercepta cliques fora dela.

## Risco identificado

O toast de confirmação fixo na base pode sobrepor brevemente (~2,6s) botões como "Adicionar ao pedido" (`ProductDetail`) ou "Continuar pedido" (`Cart`) quando o usuário está perto do rodapé da tela. Mitigado por ser uma pílula estreita e centralizada (não uma barra full-width) — é o padrão comum de snackbar, e a sobreposição é curta e no cliente **não bloqueia** o toque (só cobre visualmente uma faixa pequena por poucos segundos). Aceito como trade-off razoável; sinalizado ao usuário antes da implementação.

## Testes

Verificação manual via Playwright/browser (webapp-testing) cobrindo: clique único mostra "✓ Adicionado" e volta ao normal; cliques rápidos repetidos continuam somando quantidade corretamente e não duplicam toast; contador anima ao mudar; toast some sozinho sem interação; nenhuma regressão visual nas páginas Cart/Checkout/Confirmation/Admin. `prefers-reduced-motion: reduce` emulado no browser para confirmar ausência de movimento perceptível.
