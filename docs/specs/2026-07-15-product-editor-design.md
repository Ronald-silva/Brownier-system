# Editor de sabores no painel admin — Design

## Contexto e motivação

O painel administrativo (`src/AdminOperations.tsx`, aba "Sabores") hoje só permite: trocar a foto de um produto, alternar disponibilidade e marcar "Brownie do Dia". Não existe nenhuma forma de editar nome, descrição, categoria, preço-base, ingredientes ou alergênicos, nem de criar um novo sabor ou excluir um existente — mesmo que as rotas `POST`/`PUT`/`DELETE /api/admin/products` já existam no servidor e sejam usadas apenas parcialmente (o `PUT` só recebe patches de disponibilidade/dia/foto). O botão "Novo produto" no painel "Hoje" hoje apenas troca de aba, sem abrir nenhum formulário.

Isso significa que, na prática, o preço e os dados de um sabor só podem ser ajustados editando o arquivo JSON de dados diretamente ou chamando a API manualmente — inviável para o dono do negócio operar sozinho.

Este documento cobre o design de um editor completo de sabor (criar, editar, excluir) e a mudança do toggle de disponibilidade/dia para atualização otimista (feedback instantâneo, sem recarregar a lista inteira a cada clique).

## Escopo

**Dentro do escopo:**
- Editar, por sabor: nome, categoria, preço-base, descrição, ingredientes, alergênicos.
- Criar um novo sabor com os mesmos campos.
- Excluir um sabor existente.
- Tornar otimista o toggle de disponibilidade (`isAvailable`) e de "Brownie do Dia" (`isDay`).

**Fora do escopo (não tocar nesta mudança):**
- Upload de foto (já funciona, fluxo próprio, não muda).
- Preço promocional / quantidade mínima (já editável na aba "Promoções", não muda).
- Campo `isFeatured` ("Destaque") — não tem UI hoje e continua sem UI; não foi pedido.
- `slug` — continua gerado automaticamente pelo servidor a partir do nome; não editável (evita quebrar referências existentes).
- Reordenar sabores (`displayOrder`) — não foi pedido.

## Arquitetura

Tudo permanece em `src/AdminOperations.tsx`, seguindo a convenção já estabelecida no projeto de manter a tela inteira do admin em um único arquivo denso. Nenhum arquivo novo é criado.

**Componente novo:** `ProductEditor`, reutilizado tanto para criar quanto para editar:

```
function ProductEditor({ product, onSave, onCancel, onDelete }: {
  product: Product | null; // null = modo criação
  onSave: (fields: ProductFormFields) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => void; // só passado em modo edição
}): JSX.Element
```

Renderiza um `<form>` com os campos (nome, categoria, preço-base em reais, descrição, ingredientes, alergênicos), pré-preenchido quando `product` não é `null`. Botões: "Cancelar" sempre; "Salvar sabor" (edição) ou "Criar sabor" (criação); "Excluir sabor" só quando `onDelete` está presente, com confirmação inline (mesmo padrão de `.clear-confirm` já usado em "Limpar pedido" no carrinho).

**Padrão de expansão:** cada `<article className="op-product">` existente ganha um `<details>` envolvendo um `<summary>` "Editar" e, dentro, o `<ProductEditor product={p} .../>` quando expandido — reaproveitando as classes CSS `.admin-product details` e `.editor` que já existem no projeto (sobrando de um painel antigo removido na correção de inconsistências anterior) sem precisar de CSS nova.

Um `ProductEditor` adicional (modo criação, `product={null}`) fica no topo da lista, atrás de um botão "+ Novo sabor" que abre/fecha o formulário vazio (mesmo padrão `<details>`). O atalho "Novo produto" no painel "Hoje" passa a fazer `setTab("products")` **e** abrir esse formulário (via um estado simples, ex.: `creatingProduct`, elevado ao componente `AdminOperations`).

## Fluxo de dados

- **Criar:** `POST /api/admin/products` com `{ name, category, basePrice, description, ingredients, allergens }` (preço convertido de reais para centavos: `Math.round(Number(valor) * 100)`, mesma conversão já usada em Promoções). Sucesso → recarrega a lista (`load()`), fecha o formulário, mostra toast "Sabor criado.".
- **Editar:** `PUT /api/admin/products/:id`, reaproveitando a função `product()` já existente (`fetch` + patch), passando os mesmos campos do formulário como patch.
- **Excluir:** `DELETE /api/admin/products/:id` (nova função `deleteProduct(item)` em `AdminOperations`). Sucesso → recarrega a lista, mostra toast "Sabor removido.".
- **Validação client-side (espelha o servidor, não substitui):** `name` obrigatório (`required` no input), `basePrice` não-negativo (`min="0" step=".01"` no input number). O servidor continua sendo a fonte de verdade — se a validação client-side passar mas o servidor rejeitar, mostra a mensagem de erro do servidor via toast, mesmo padrão já usado em `uploadPhoto`/`product()`.

## Toggle otimista (disponibilidade e "Brownie do Dia")

Hoje, `product()` sempre faz `await load()` após o `PUT`, recarregando toda a lista antes de qualquer atualização visual — perceptível como atraso/flicker em cada clique.

Nova função `toggleProductFlag(item, patch, message)`:
1. Atualiza o estado local do `store` imediatamente (otimista) — o card reflete a mudança na hora do clique.
2. Dispara o `PUT` em paralelo.
3. Se a resposta falhar, reverte o estado local para o valor anterior e mostra "Não foi possível salvar. Tente de novo." — mesma mensagem de erro já usada hoje.
4. Se a resposta suceder, não precisa recarregar a lista inteira (o estado otimista já está correto) — evita o `await load()` completo que existe hoje.

Usada pelos botões de disponibilidade e "☆ Dia"; o editor de sabor (criar/editar/excluir) continua usando `load()` após salvar, já que esses casos envolvem mais campos e justificam uma releitura completa.

## Tratamento de erros

- Nome vazio ou preço inválido: bloqueado no client via atributos HTML5 (`required`, `min`), sem round-trip.
- Falha de rede/servidor ao criar/editar/excluir: toast de erro reaproveitando o texto padrão já usado ("Não foi possível salvar. Tente de novo."), formulário permanece aberto com os dados preenchidos (não perde o que o usuário digitou).
- Falha no toggle otimista: reverte o estado local + toast de erro (ver acima).

## Testes

Segue a convenção já estabelecida no projeto: sem testes de componente (não há harness para isso); comportamento verificado via Playwright manual/scripts ad-hoc durante a implementação, e regressão dos testes `node:test` existentes (`npm test`) + `npm run lint` + `npm run build` após cada task do plano de implementação.

## Autorevisão do spec

- **Placeholders:** nenhum "TBD" ou campo vago — todos os campos, rotas e conversões estão explícitos.
- **Consistência interna:** a conversão de preço (reais ↔ centavos) é a mesma em criar/editar, espelhando exatamente o padrão já usado em `Promotions`. O toggle otimista é uma função separada (`toggleProductFlag`) da função de salvar do editor (`product()`/criar/editar), evitando confundir os dois fluxos.
- **Escopo:** focado o suficiente para um único plano de implementação — não inclui upload de foto, promoções, ou reordenação, que já têm fluxo próprio ou não foram pedidos.
- **Ambiguidade:** "editor completo" foi interpretado como nome/categoria/preço-base/descrição/ingredientes/alergênicos, excluindo explicitamente `slug`, `isFeatured` e `displayOrder` — registrado acima em "Fora do escopo" para não gerar dúvida na hora de implementar.
