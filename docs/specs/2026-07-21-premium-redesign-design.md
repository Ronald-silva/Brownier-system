# Redesign Premium da vitrine pública — Design

## Contexto e motivação

O objetivo desta fase é elevar o nível visual da vitrine pública (Home, Cardápio, Produto, Carrinho, Checkout, Confirmação) a um padrão comparável a apps modernos de alimentação — sem adicionar novas funcionalidades de produto. Prioridades explícitas do pedido: UX, UI, responsividade, design system, motion e consistência visual; mobile-first, muito espaço em branco, fotografias grandes, tipografia elegante, botões modernos, cards sofisticados, microinterações suaves, alto contraste e excelente legibilidade.

Uma auditoria completa da interface atual (ver seção "Auditoria" abaixo) encontrou que `docs/PRODUCT_VISION_EXPERIENCE_BIBLE.md` já descreve, na Seção 9 e 10, praticamente a direção de arte e o design system que este pedido busca — mas nunca foi implementado: só cor está tokenizada em CSS, os componentes reutilizáveis que o próprio Vision Bible nomeia (`HeroMedia`, `AvailabilityBadge`, `PriceDisplay`, `QuantitySelector`, `FloatingCartButton`, `LoadingSkeleton`, `ConfirmDialog` etc.) nunca foram extraídos — tudo é JSX bespoke dentro de `src/App.tsx`, com duplicação real (o seletor de quantidade existe quase idêntico em `Cart` e `ProductDetail`).

A auditoria também encontrou um problema que não é de design, e sim de regra de negócio: o checkout hoje oferece "Entrega" feita pela própria empresa (`fulfillmentType: "ENTREGA"`, `business.deliveryEnabled`, `business.deliveryFee`), o que contradiz a regra confirmada nesta conversa: a Brownieria não realiza entregas — só Retirada na loja ou Uber Moto contratado pelo próprio cliente. Esta correção está incluída no escopo porque o checkout é uma das telas do redesign e não pode ser redesenhado mantendo uma opção que não deveria existir.

## Auditoria — problemas encontrados, por prioridade

**P0 — regra de negócio incorreta (bug, não preferência de design):**
- Checkout oferece entrega feita pela empresa (`ENTREGA`/`deliveryFee`), proibido pela regra atual do negócio.

**P1 — bloqueadores diretos do objetivo "premium":**
- Todos os 6 sabores usam o mesmo placeholder genérico de 1,7MB (`brownie-hero-demo.png`); nenhuma foto própria por sabor ainda.
- Imagens não otimizadas: PNGs de ~1,7MB sem responsive/srcset, sem `width`/`height` (risco de CLS), sem lazy-loading consistente.
- Fotos de produto pequenas (145–190px de altura no card) e descrição cortada em 2 linhas a 12px — oposto de "muito espaço em branco" e "fotografias grandes".
- Tipografia sem escala: tamanhos soltos em px (39/28/15/12/11/10/9) espalhados pelos arquivos CSS, sem relação sistemática entre si.
- Espaçamento sem tokens: só cor está em `:root`; o ritmo de 8px que o próprio Vision Bible pede não está implementado como variável.
- Motion mínimo: só hover de cor, `translateY(1px)` no clique e leve zoom de imagem; não há skeleton de carregamento (hoje é texto "Carregando cardápio…") nem transição de entrada/rota.

**P2 — dívida de arquitetura que encarece manter o design system:**
- Componentes que o Vision Bible já nomeia nunca foram extraídos; JSX bespoke por tela em `App.tsx`, com duplicação (seletor de quantidade 2x).
- CSS escrito desktop-first com overrides em `max-width`, em vez de mobile-first genuíno com `min-width`.

**P3 — verificar, não necessariamente corrigir:**
- Contraste de texto secundário (`--muted #78655d`) e rosa (`#e66fa2`) em tamanhos pequenos (10–11px) precisa de checagem formal AA antes de declarar "alto contraste" resolvido.

## Escopo

**Dentro do escopo:**
- Vitrine pública completa: Home, Cardápio, Produto, Carrinho, Checkout, Confirmação.
- Camada de design tokens (espaço, raio, tipografia, sombra) somando-se aos tokens de cor já existentes.
- Extração dos componentes reutilizáveis nomeados no Vision Bible que hoje têm duplicação ou benefício claro de reutilização: `HeroMedia`, `ProductCard`, `QuantitySelector`, `PriceDisplay`/`PromotionCallout`, `AvailabilityBadge`, `FloatingCartButton`, `LoadingSkeleton`, `ConfirmDialog`.
- Redesenho de fotografia grande (hero, card, página de produto) usando a imagem demo atual como placeholder dentro dos componentes definitivos.
- Otimização das imagens existentes (compressão, `width`/`height`, `loading="lazy"` fora do hero).
- Correção da regra de negócio: remoção de "Entrega pela empresa" e introdução de "Uber Moto por conta do cliente" (`server.ts`, `App.tsx`, `tests/routing_smoke.py`).
- Microinterações e transições via Framer Motion (nova dependência), respeitando `prefers-reduced-motion`.
- Verificação: `npm run lint`, `npm test`, smoke tests Python, checagem manual em 360/390/768/1024/1440px.

**Fora do escopo (não tocar nesta fase):**
- Painel admin/Equipe: recebe apenas os tokens compartilhados (cor/espaço/raio/tipografia) através dos CSS files existentes, sem redesign de layout ou extração de componentes próprios. Fica para uma fase separada.
- Fotos reais por sabor — dependem do dono do negócio; o placeholder demonstrativo continua em uso.
- Qualquer nova funcionalidade de produto (caixas prontas, quiz de recomendação, IA/WhatsApp, cupons etc.) — fora do pedido desta fase.
- Motor de preço (`src/lib/pricing.ts`) e modelo de dados de produto — não mudam.
- Rotas e `AppContext` (`src/App.tsx`) — mesma superfície de rotas exportadas (`HomeRoute`, `MenuRoute`, `ProductRoute`, `CartRoute`, `CheckoutRoute`, `ConfirmationRoute`, `AdminRoute`) e mesmo formato de contexto; só o conteúdo interno de cada tela muda para usar os novos componentes.

## Decisão de arquitetura: extração seletiva, não reescrita completa

Consideradas três abordagens (apresentadas e discutidas com o usuário): (A) tokens + extração seletiva de componentes; (B) refresh só de CSS sem extrair componentes; (C) reescrita completa com uma tela por arquivo. Optamos por **A**:

- Resolve a dívida real identificada na auditoria (duplicação do seletor de quantidade, ausência de skeleton/estados reutilizáveis) sem exigir reescrever routing ou o contrato de dados.
- Mantém o blast radius sobre os testes existentes (`routing_smoke.py`, `visual_smoke.py`, `aggregate_pricing_smoke.py`) previsível — eles continuam testando os mesmos textos/rotas/fluxos, só precisam de ajuste pontual onde o texto/estrutura de DOM mudar (ex.: botão "Entrega" → "Uber Moto").
- Evita o custo e o risco da Abordagem C (reescrita completa por tela) para um ganho que a extração seletiva já cobre.

## Design tokens (`src/tokens.css`, novo arquivo)

Novo arquivo de tokens, importado antes de `experience.css`/`polish.css`, mantendo os tokens de cor já existentes em `index.css` (`--brand-pink`, `--brand-brown` etc. permanecem onde estão — não duplicar):

- **Espaço:** `--space-1: 4px` até `--space-8: 64px` (4/8/12/16/24/32/48/64), substituindo paddings/margins soltos nos 5 arquivos CSS.
- **Raio:** `--radius-sm: 8px`, `--radius-md: 12px`, `--radius-lg: 16px`, `--radius-xl: 24px`.
- **Tipografia:** escala com `clamp()` para `--font-display` (hero h1), `--font-h1`, `--font-h2`, `--font-h3`, `--font-body`, `--font-small`, `--font-caption` — substitui os px soltos (39/28/15/12/11/10/9) mantendo as mesmas fontes já carregadas (DM Serif Display para títulos, Nunito Sans para interface — não adicionar fontes novas).
- **Sombra:** `--shadow-sm/md/lg`, substituindo a sombra hardcoded do `.product-card`.
- **Contraste (P3 da auditoria):** ajustar `--muted` se a checagem AA falhar a 4.5:1 sobre `--white`/`--brand-cream`; decisão tomada durante a implementação, documentada no relatório final, não antes (depende de medir, não de preferência).

## Componentes extraídos (`src/components/`, novo diretório)

| Componente | Substitui | Motivo |
| --- | --- | --- |
| `HeroMedia` | `<figure className="hero-photo">` inline na Home | Foto grande reutilizável (hero, e futuramente outras seções) com proporção/otimização consistente |
| `ProductCard` | função `ProductCard` já existente em `App.tsx` | Refeito para foto dominante (~65% do card), mesma API pública (props `product`, `isDay`, `onClick`, `onAdd`) |
| `QuantitySelector` | os dois blocos `<div className="quantity">` quase idênticos em `Cart` e `ProductDetail` | Elimina duplicação real encontrada na auditoria |
| `PriceDisplay` / `PromotionCallout` | trechos inline de preço/promoção espalhados em `ProductCard`, `ProductDetail`, `Cart` | Um único lugar formata preço + indica promoção, evita divergência de formatação |
| `AvailabilityBadge` | `<span className={available/unavailable}>` inline | Estado visual único para "Disponível hoje"/"Esgotado hoje" |
| `FloatingCartButton` | `.cart-button` fixo só no header | Passa a ficar visível/flutuante durante o scroll no Cardápio e Produto, não só no header, sem duplicar lógica de contagem |
| `LoadingSkeleton` | texto `"Carregando cardápio…"` | Placeholder visual real durante o `fetch` inicial, nomeado no Vision Bible e nunca implementado |
| `ConfirmDialog` | bloco `.clear-confirm` bespoke em `Cart` | Diálogo de confirmação reutilizável (usado hoje só para "limpar pedido", preparado para outros usos futuros sem duplicar) |

Todos os componentes recebem props explícitas (sem acoplamento a `AppContext`), para poderem ser usados/testados isoladamente.

## Fotografia grande

- `HeroMedia`: proporção alvo ~16:10 no desktop, ocupando a maior parte da largura do hero (redução do texto ao lado); em mobile, ocupa a largura total acima do CTA.
- `ProductCard`: foto passa a ocupar a maior parte vertical do card (hoje 145–190px fixos → passa a proporção relativa, ex. `aspect-ratio: 4/3`, crescendo com o card).
- Página de produto (`ProductDetail`): foto quase tela-cheia em mobile (mantendo a legenda "imagem demonstrativa" já existente).
- Placeholder: a imagem demo atual (`/images/brownie-hero-demo.png`) continua sendo usada via `productImageSrc()` (`src/lib/media.ts`, sem mudança de contrato) — quando fotos reais chegarem, troca-se a URL nos dados, sem retrabalho de layout.
- Otimização: comprimir `brownie-hero-demo.png` e `brownieria-fortal-logo.png` (hoje ~1,7MB cada), adicionar `width`/`height` explícitos para evitar CLS, `loading="lazy"` em imagens fora da primeira dobra (hero e primeiro card ficam eager).

## Correção da regra de negócio: Uber Moto

- `server.ts`: `demoStore.business` deixa de ter `deliveryEnabled`/`deliveryFee`; `fulfillmentType` aceito passa a ser `"RETIRADA" | "UBER_MOTO"` (em vez de `"RETIRADA" | "ENTREGA"`). Validação do endpoint de criação de pedido atualizada: `UBER_MOTO` não exige/aceita `deliveryAddress` (o campo é removido do payload esperado para esse fluxo).
- `App.tsx`, `Checkout`: dois botões de recebimento — "Retirada na loja" / "Uber Moto (por sua conta)". Ao selecionar Uber Moto, exibe o endereço da loja (`business.address`) e um texto informativo (“Peça seu Uber Moto até [endereço] — corrida e pagamento por sua conta”), sem campo de endereço do cliente e sem taxa de entrega calculada pela Brownieria. `Totals`/`Confirmation` deixam de exibir linha de "Entrega" (sempre zero agora, mas o componente deixa de precisar dessa lógica).
- `tests/routing_smoke.py`: o trecho que clica "Entrega" e preenche "Onde entregamos?" passa a clicar "Uber Moto (por sua conta)" e não preencher endereço nenhum — ajustado para o novo fluxo, mantendo a cobertura do checkout completo até a confirmação.

## Motion (Framer Motion)

Nova dependência (`framer-motion`), uso restrito a reforçar feedback/hierarquia (princípio #8 do Vision Bible — "movimento só reforça feedback e hierarquia", não decoração):

- Transição entre rotas: fade/slide leve via `AnimatePresence` no layout de `App.tsx`.
- Entrada em stagger dos cards do Cardápio (`Menu`) ao carregar.
- `LoadingSkeleton` como estado de carregamento animado (shimmer sutil).
- Hover/tap em botões e `ProductCard` (leve escala/elevação, substituindo o `translateY(1px)` atual por uma transição administrada pela lib onde já existir Framer Motion no componente; onde não houver, mantém-se o CSS de `polish.css` como está).
- Badge do carrinho (`FloatingCartButton`) com "pop" ao adicionar item.
- Respeita `prefers-reduced-motion` — já existe a query global em `polish.css`; Framer Motion usa `useReducedMotion()` para desativar as animações acima nesse caso.

## Testes e verificação

- `npm run lint` (tsc --noEmit) e `npm test` (unit tests existentes) devem continuar passando sem alteração de comportamento fora do escopo desta mudança.
- `tests/routing_smoke.py`: atualizado conforme a seção "Uber Moto" acima.
- `tests/visual_smoke.py`: continua validando ausência de overflow horizontal em todas as larguras testadas (360–1440px) — crítico dado que o redesign mexe em layout/espaçamento.
- `tests/aggregate_pricing_smoke.py`, `tests/admin_product_editor_smoke.py`: não devem quebrar (motor de preço e admin fora do escopo), mas rodam como regressão.
- Checagem manual: 360, 390, 768, 1024, 1440px (larguras do próprio Vision Bible), sem overflow horizontal, toques ≥44px, `prefers-reduced-motion` respeitado.
- Checagem de contraste AA nos textos pequenos identificados na auditoria (P3), documentada no relatório final.

## Autorevisão do spec

- **Placeholders:** nenhum "TBD"; o ajuste de `--muted` (se necessário) está explicitamente marcado como dependente de medição durante a implementação, não uma decisão em aberto no design.
- **Consistência interna:** a lista de componentes extraídos bate com a lista de problemas P1/P2 da auditoria; a correção de Uber Moto aparece tanto no escopo quanto na seção própria com os três arquivos afetados (`server.ts`, `App.tsx`, `tests/routing_smoke.py`).
- **Escopo:** focado na vitrine pública, conforme decisão do usuário; admin explicitamente fora, com só tokens compartilhados chegando até ele por herança do CSS.
- **Ambiguidade resolvida:** as 4 perguntas de esclarecimento (escopo admin, tratamento de fotografia, biblioteca de motion, formato do fluxo Uber Moto) foram todas respondidas explicitamente pelo usuário antes deste documento e estão refletidas nas seções correspondentes.
