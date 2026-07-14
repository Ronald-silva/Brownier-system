# Preparação para IA e WhatsApp

O MVP web é independente do WhatsApp. A integração futura deve chamar exclusivamente a API pública, que consulta a mesma persistência usada pelo cardápio.

## Ferramentas sugeridas ao agente

- `consultarCardapio()` → `GET /api/public/menu`
- `consultarProduto(idOuSlug)` → `GET /api/public/products/:id`
- `consultarPromocoes()` → `GET /api/public/promotions`
- `consultarEmpresa()` → `GET /api/public/business`
- `criarPedido(payload)` → `POST /api/public/orders`
- `consultarStatusPedido(publicCode)` → `GET /api/public/orders/:publicCode`

O agente nunca deve calcular preço, afirmar disponibilidade por conta própria, nem chamar rotas `/api/admin/*`. Ao detectar intenção de compra, deve direcionar para o link do cardápio. Para um fluxo conversacional futuro, o backend pode receber um adaptador autenticado que reutilize a mesma regra de cálculo do servidor.

As rotas de criação e consulta de pedido possuem limite simples por IP e os pedidos usam códigos públicos aleatórios, não IDs sequenciais. Em produção, substituir o armazenamento JSON demonstrativo por banco gerenciado e trocar o limitador em memória por Redis ou equivalente.
