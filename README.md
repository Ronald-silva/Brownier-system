# Brownies Fortal — MVP de pedidos

MVP mobile-first para consulta de sabores, montagem de pedido e operação simples da Brownies Fortal.

> Os sabores, imagens abstratas, preços, promoção e configurações iniciais são demonstrativos. Valide-os com a Brownies Fortal antes de qualquer uso comercial.

## O que está pronto

- Cardápio público dinâmico com disponibilidade e promoção por quantidade.
- Produto, carrinho, checkout e confirmação com código público não sequencial.
- Cálculo de preços e validação do pedido no servidor.
- Painel responsivo para alterar disponibilidade, preço, promoção, produtos, status de pedidos e dados da empresa.
- Endpoints públicos preparados para uma futura ferramenta de agente de IA.

## Executar localmente

```bash
npm ci
npm run dev
```

Abra `http://localhost:3000`. Os dados são criados na primeira execução em `data/brownies-fortal.demo.json`; esse arquivo é ignorado pelo Git e pode ser removido para reiniciar a demonstração.

Para acessar o painel, use **Área da equipe** no rodapé. Em desenvolvimento local, sem `ADMIN_ACCESS_CODE` definido, o código de demonstração é `brownies-demo` — **isso funciona apenas com `NODE_ENV` diferente de `production`**. Para qualquer ambiente publicado (demo pública, produção), defina uma variável forte antes de iniciar o servidor; sem ela — ou com o valor de demonstração — o servidor recusa iniciar em produção:

```bash
ADMIN_ACCESS_CODE=<defina-um-codigo-forte> npm run dev
```

## Variáveis de ambiente

| Variável | Necessária | Uso |
| --- | --- | --- |
| `ADMIN_ACCESS_CODE` | Sim, em produção | Protege as rotas administrativas. Obrigatória e não pode ser `brownies-demo` quando `NODE_ENV=production` — o servidor não inicia caso contrário. Em desenvolvimento, é opcional (fallback `brownies-demo`). |
| `ADMIN_SESSION_TTL_MS` | Não | Duração da sessão administrativa em milissegundos, padrão 4 horas. |
| `ADMIN_LOGIN_WINDOW_MS` | Não | Janela do limite de tentativas de login, padrão 10 minutos (5 tentativas inválidas por IP). |
| `PORT` | Não | Porta do servidor, padrão `3000`. |

Não há credenciais de pagamento, Firebase, WhatsApp ou Evolution no MVP.

## Verificação

```bash
npm test
npm run lint
npm run build
```

## Arquitetura

O Express serve a API e o Vite em desenvolvimento. O catálogo, as configurações e os pedidos são persistidos em JSON para a demonstração local. A regra de preço fica em `src/lib/pricing.ts` e é executada novamente no servidor antes de salvar qualquer pedido; valores enviados pelo navegador são ignorados.

Rotas públicas principais:

- `GET /api/public/menu`
- `GET /api/public/products/:id`
- `GET /api/public/business`
- `GET /api/public/promotions`
- `POST /api/public/orders`
- `GET /api/public/orders/:publicCode`

Rotas sob `/api/admin/*` requerem um token de sessão obtido em `POST /api/admin/login` (header `Authorization: Bearer <token>`) e não devem ser expostas a agentes. O login tem limite de 5 tentativas inválidas por IP a cada 10 minutos.

### Idempotência em `POST /api/public/orders`

O endpoint aceita um cabeçalho opcional:

```
Idempotency-Key: <chave única da operação>
```

- Reenviar a mesma requisição com a mesma chave retorna o pedido já criado (`200`, `Idempotency-Replayed: true`), sem inserir um segundo pedido.
- Reutilizar a mesma chave com dados diferentes (itens, cliente, modalidade, pagamento, endereço etc.) retorna `409`.
- Chaves diferentes sempre criam pedidos diferentes, mesmo com o mesmo conteúdo.
- O cabeçalho é opcional — o frontend atual continua funcionando normalmente sem ele, criando um novo pedido a cada envio (`201`).
- Clientes automatizados (ex.: um futuro agente) devem sempre enviar a chave para evitar pedidos duplicados em caso de reenvio de rede.
- A proteção funciona no processo único do servidor atual; não é uma solução distribuída entre múltiplas instâncias.

Consulte [a preparação de IA e WhatsApp](docs/IA_E_WHATSAPP.md) para os próximos passos.
