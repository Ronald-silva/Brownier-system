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

Para acessar o painel, use **Área da equipe** no rodapé. Em demonstração, o código é `brownies-demo`. Para qualquer ambiente compartilhado, defina uma variável forte:

```bash
ADMIN_ACCESS_CODE=troque-por-um-codigo-forte npm run dev
```

## Variáveis de ambiente

| Variável | Necessária | Uso |
| --- | --- | --- |
| `ADMIN_ACCESS_CODE` | Produção | Protege as rotas administrativas. |
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

Rotas sob `/api/admin/*` requerem `x-admin-code` e não devem ser expostas a agentes.

Consulte [a preparação de IA e WhatsApp](docs/IA_E_WHATSAPP.md) para os próximos passos.
