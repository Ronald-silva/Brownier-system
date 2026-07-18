# Preço por quantidade agregada + cardápio real — Design

## Contexto e motivação

O dono da Brownieria Fortal (Mateus) enviou, via WhatsApp, a regra de preço real e a lista de sabores disponíveis:

> Valor por unidade: A partir de 20 unidades — R$ 3,00. Abaixo de 20 unidades — R$ 5,00.
> Sabores disponíveis: Ninho, Brigadeiro, Oreo, Prestígio, Ovomaltine, Doce de Leite.

Confirmado com o dono do negócio: o desconto de 20+ unidades vale pela **soma de todos os brownies do pedido**, independente da combinação de sabores — não por sabor individual. O motor de preço atual (`src/lib/pricing.ts`) só verifica a quantidade de uma linha isolada contra o mínimo promocional daquele produto, então não suporta essa regra hoje. Este documento cobre a mudança no motor de preço (server-side, autoritativo) e nos pontos da interface que exibem preço, além da atualização dos dados de demonstração para o cardápio real.

## Escopo

**Dentro do escopo:**
- `calculateLinePrice` passa a considerar a quantidade agregada do pedido (todos os itens, todos os sabores) para decidir se o preço promocional se aplica — não mais a quantidade da linha isolada.
- Atualizar todos os pontos que chamam `calculateLinePrice`: resumo do carrinho, cada linha do carrinho, a dica de "faltam X para o desconto", a página de detalhe do produto (considerando o carrinho atual), e a validação de preço no servidor.
- Atualizar os dados de demonstração (`server.ts`, `demoStore`) para os 6 sabores reais e o preço real (R$ 5,00 base, R$ 3,00 promocional a partir de 20 unidades, uniforme em todos os sabores).
- Atualizar `tests/pricing.test.ts` para cobrir o novo comportamento agregado.

**Fora do escopo (não tocar nesta mudança):**
- Painel admin (editor de sabores, toggle de disponibilidade) — já existe e continua funcionando sem mudanças; o admin pode ajustar `promotionalPrice`/`minimumPromotionalQuantity` por sabor pela aba Promoções já existente, se algum dia a regra deixar de ser uniforme.
- Fotos dos sabores — continuam demonstrativas; não fazem parte deste pedido.
- Informações de contato/horário da empresa — não foram enviadas, permanecem como estão.
- Nenhuma configuração nova de "regra de preço global" — decisão consciente abaixo.

## Decisão de arquitetura: não criar um campo de preço "global"

A regra de preço do Mateus é, hoje, a mesma para todos os sabores. Uma alternativa de design seria mover `promotionalPrice`/`minimumPromotionalQuantity` do produto para a empresa (`business`), como uma regra única. Optamos por **não fazer isso agora**:

- O modelo atual (campo por produto) já existe, já tem UI no admin (aba Promoções), e já é usado em produção — mudar o modelo de dados exigiria migração e uma nova tela.
- Preserva a flexibilidade de, no futuro, um sabor ter uma promoção diferente (ex.: sabor sazonal com desconto próprio) sem precisar reintroduzir esse conceito depois.
- O único ajuste necessário é a **lógica de agregação** (somar a quantidade do pedido inteiro, não da linha) — isso é uma mudança no motor de cálculo, não no modelo de dados.

Custo dessa decisão: o admin precisa lembrar de manter `promotionalPrice`/`minimumPromotionalQuantity` iguais em todos os sabores manualmente (a aba Promoções já existente permite isso, sabor por sabor). Aceitável dado que a regra muda raramente.

## Mudança no motor de preço

`src/lib/pricing.ts`, assinatura atual:

```ts
export function calculateLinePrice(product: PricingProduct, quantity: number)
```

Nova assinatura (terceiro parâmetro **obrigatório**, sem valor padrão — de propósito, para que o TypeScript force a atualização de qualquer chamador esquecido em vez de silenciosamente manter o comportamento antigo):

```ts
export function calculateLinePrice(product: PricingProduct, quantity: number, totalQuantity: number)
```

- `quantity`: quantidade desta linha específica — usada para calcular `total`/`discount` desta linha, como hoje.
- `totalQuantity`: quantidade agregada do pedido inteiro (soma de todas as linhas/itens) — usada **apenas** para decidir se `totalQuantity >= product.minimumPromotionalQuantity`, substituindo o uso de `quantity` nessa checagem.

## Chamadores atualizados

| Local | `totalQuantity` usado |
| --- | --- |
| `src/App.tsx`, resumo do carrinho (`summary`) | soma de `cart.reduce((s,l) => s + l.quantity, 0)` |
| `src/App.tsx`, cada linha do `Cart` | a mesma soma do carrinho inteiro (todas as linhas, não só a linha sendo exibida) |
| `src/App.tsx`, dica de desconto no `Cart` (`promotionHint`) | idem — e o texto deixa de citar um sabor específico (`"Faltam X brownies de {sabor}..."` → `"Faltam X brownies para aproveitar o preço por quantidade."`), já que a regra agora é por soma do pedido, não por sabor |
| `src/App.tsx`, `ProductDetail` (preço mostrado antes de adicionar) | soma do carrinho atual **mais** a quantidade selecionada naquela página (`cartTotal + quantity`) — confirmado com o usuário: o preço exibido deve já refletir o que acontece ao clicar "Adicionar ao pedido" |
| `server.ts`, criação de pedido | soma de `items.reduce((s,i) => s + Number(i.quantity), 0)` — **autoritativo**: o preço final do pedido sempre é recalculado aqui, valores do navegador são ignorados, como já documentado no README |

`ProductDetail` precisa de acesso ao carrinho atual, que já existe em `AppContext` (exposto via `useOutletContext`) — só precisa ser passado como prop para `ProductDetail`, que hoje não o recebe.

## Dados de demonstração (`server.ts`, `demoStore`)

Substituir a lista de 6 sabores atual pelos 6 sabores reais informados pelo Mateus, todos com `basePrice: 5`, `promotionalPrice: 3`, `minimumPromotionalQuantity: 20`:

- Brigadeiro (mantém — já existe, mantém `isDay: true`)
- Ninho (mantém)
- Oreo (mantém)
- Prestígio (mantém)
- Doce de Leite (mantém)
- Ovomaltine (**novo** — descrição/ingredientes/alergênicos demonstrativos, seguindo o mesmo estilo dos demais, já que o Mateus não enviou esses detalhes)
- "Tradicional" é **removido** — não está na lista enviada.

Isso significa que, quando o arquivo `data/brownies-fortal.demo.json` (gitignorado) for regenerado — ex.: em uma instalação nova, ou se o dono apagar o arquivo local para reiniciar a demonstração — o cardápio inicial já reflete os dados reais, não mais o placeholder genérico.

## Testes

`tests/pricing.test.ts` reescrito para a nova assinatura de três parâmetros, cobrindo:
- Quantidade da linha abaixo do mínimo, mas total do pedido acima → desconto aplicado (o caso que hoje não existe e é o motivo desta mudança).
- Total do pedido abaixo do mínimo → sem desconto, mesmo que a linha isolada já fosse grande.
- Produto sem promoção configurada → preço base sempre, independente do total.

## Autorevisão do spec

- **Placeholders:** nenhum "TBD"; a descrição/ingredientes do sabor novo (Ovomaltine) são explicitamente marcados como demonstrativos, seguindo o padrão já estabelecido pelo README para todo o cardápio.
- **Consistência interna:** todos os cinco chamadores de `calculateLinePrice` (resumo do carrinho, linha do carrinho, dica de desconto, detalhe do produto, servidor) estão listados com a fonte exata de `totalQuantity` de cada um — nenhum lugar que calcula preço foi deixado de fora.
- **Escopo:** focado — não mexe no painel admin, fotos, ou dados de contato da empresa, que não fazem parte do que o Mateus enviou.
- **Ambiguidade resolvida:** a regra de desconto é por soma do pedido (não por sabor) e o preço na página de produto considera o carrinho atual — ambas confirmadas explicitamente com o usuário antes deste documento.
