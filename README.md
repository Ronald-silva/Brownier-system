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

Use [.env.example](.env.example) como referência e mantenha valores reais
somente no `.env` local ou no provedor de deploy.

| Variável | Necessária | Uso |
| --- | --- | --- |
| `ADMIN_ACCESS_CODE` | Sim, em produção | Protege as rotas administrativas. Obrigatória e não pode ser `brownies-demo` quando `NODE_ENV=production` — o servidor não inicia caso contrário. Em desenvolvimento, é opcional (fallback `brownies-demo`). |
| `ADMIN_SESSION_TTL_MS` | Não | Duração da sessão administrativa em milissegundos, padrão 4 horas. |
| `ADMIN_LOGIN_WINDOW_MS` | Não | Janela do limite de tentativas de login, padrão 10 minutos (5 tentativas inválidas por IP). |
| `PORT` | Não | Porta do servidor, padrão `3000`. |
| `BF_STORE_PATH` | Não | Caminho do armazenamento JSON local. |
| `BF_AGENT_MAX_MISUNDERSTANDINGS` | Não | Limite de não compreensões antes do handoff; padrão `3`. |
| `BF_SIMULATOR_DEBUG_CONTEXT` | Não | Inclui contexto de apresentação na saída do simulador. |
| `BF_LLM_MODE` | Não | `DISABLED` (padrão), `OPENAI_FALLBACK` ou `NVIDIA_NEMOTRON`. |
| `OPENAI_*` e limites `BF_LLM_*` | Condicional | Necessários somente em `OPENAI_FALLBACK`. |
| `NVIDIA_*` | Condicional | Necessários/configuráveis somente em `NVIDIA_NEMOTRON`. |

Não há integração com pagamento, Firebase, WhatsApp ou Evolution no MVP.

## Verificação

```bash
npm test
npm run lint
npm run build
```

## Simulador local do agente

Executa ações estruturadas do Conversation Engine pelo terminal, sem IA e sem WhatsApp — só para desenvolvimento local. Lê uma ação JSON por linha do stdin e imprime o resultado (sessão antes/depois, resultado do engine) em JSON por linha no stdout.

```bash
BF_STORE_PATH=/tmp/brownies-sim.json npm run agent:simulate
```

Exemplo de entrada (uma linha):

```json
{"channel": "simulator", "contactId": "cliente-001", "messageId": "msg-001", "action": {"type": "START_CONVERSATION"}}
```

Defina sempre `BF_STORE_PATH` para um arquivo temporário ao experimentar — sem essa variável, o simulador usa o mesmo arquivo de dados que o servidor real (`data/brownies-fortal.demo.json`).

Para inspecionar o contexto público resolvido pela camada de apresentação (nome do produto, opções de pagamento, etc.), rode com `BF_SIMULATOR_DEBUG_CONTEXT=1` — a saída passa a incluir `presentationContext` ao lado de `messages`.

### Interpretador determinístico

Além de receber uma `action` estruturada, o simulador aceita uma segunda forma de entrada com `text` — uma mensagem simples do jeito que um cliente digitaria:

```json
{"channel": "simulator", "contactId": "cliente-1", "messageId": "m1", "text": "oi"}
```

```bash
echo '{"channel":"simulator","contactId":"cliente-1","messageId":"m1","text":"oi"}' |
BF_STORE_PATH=/tmp/brownier-agent.json npm run agent:simulate
```

Antes de chegar ao Conversation Engine, esse texto passa pelo **Deterministic Message Interpreter** (`src/agent/deterministic-interpreter.ts`), que:

- entende comandos globais (menu, cancelar, atendente, voltar, recomeçar) e respostas simples e inequívocas — saudação, seleção de produto por número ou nome exato, nome, telefone, retirada, horário e forma de pagamento;
- decide de forma diferente conforme a etapa atual da sessão (o mesmo texto pode significar coisas diferentes em etapas diferentes);
- não usa IA nem fuzzy matching — apenas comparações exatas contra listas fechadas de frases e padrões estruturais simples (posição no catálogo, "quantidade x posição", nome exato);
- nunca inventa uma opção: pedidos de entrega nunca viram `ENTREGA`, horários e formas de pagamento fora da lista atual nunca são aceitos;
- quando encontra mais de uma interpretação plausível (ex.: dois produtos com nomes que normalizam igual), devolve um resultado `AMBIGUOUS` em vez de escolher a primeira opção;
- quando não reconhece a mensagem com segurança, devolve `NOT_UNDERSTOOD` — é o ponto em que, no futuro, um interpretador por IA entraria, mas essa etapa não implementa isso.

Só uma interpretação `MATCHED` chega ao Conversation Service; `NOT_UNDERSTOOD` e `AMBIGUOUS` nunca chamam o Engine, nunca criam pedido e nunca executam um candidato de `AMBIGUOUS` automaticamente. O que fazer com cada resultado da interpretação é responsabilidade da camada de política descrita a seguir.

A entrada antiga com `action` continua funcionando sem nenhuma mudança.

### Política de não compreensão (Interpretation Policy)

O **Text Conversation Service** (`src/agent/text-conversation.service.ts`) fica entre o interpretador e o Agent Conversation Service e decide o que fazer com cada resultado da interpretação — o interpretador continua só convertendo texto em `MATCHED`/`NOT_UNDERSTOOD`/`AMBIGUOUS`, nunca decide sozinho o que fazer com isso:

- **`MATCHED`** processado com sucesso pelo Engine zera `misunderstandingCount` — mesmo quando o Engine responde uma validação de domínio (`INVALID_QUANTITY`, `CART_EMPTY`, etc.), pois a intenção foi compreendida. A única exceção é `INVALID_ACTION`: nesse caso o contador é preservado, sem zerar nem incrementar.
- **`NOT_UNDERSTOOD`** e **`AMBIGUOUS`** incrementam `misunderstandingCount` em 1, sem chamar o Engine e sem executar nenhum candidato de `AMBIGUOUS` automaticamente.
- Ao atingir o limite configurado (`maxMisunderstandings`), a política dispara encaminhamento humano automático reaproveitando o fluxo oficial `REQUEST_HUMAN` pelo Conversation Service — o carrinho e os dados já coletados (nome, telefone, retirada, horário, pagamento, observações) são preservados, nenhum pedido é criado, e o contador permanece no valor do limite (não é zerado silenciosamente).
- Enquanto a sessão está em atendimento humano (`underHumanHandoff: true`), mensagens comuns não chamam o interpretador para nada além de checar comandos globais, não incrementam o contador e recebem uma resposta segura informando que o atendimento já foi encaminhado. `RESET_CONVERSATION` (ex.: "recomeçar", "novo pedido") continua funcionando e, ao sair do handoff, a política zera `misunderstandingCount`.
- Mensagens repetidas (mesmo `messageId`) nunca são reinterpretadas nem contam de novo — nem para compreensão, nem para ambiguidade, nem para o handoff automático.
- O limite é configurável via `BF_AGENT_MAX_MISUNDERSTANDINGS` (padrão `3`, entre `1` e `10`); um valor inválido impede a inicialização do simulador em vez de cair silenciosamente no padrão.
- As sessões continuam apenas em memória (`InMemoryAgentSessionStore`) — reiniciar o simulador (ou o processo) descarta toda a política acumulada.

```bash
BF_STORE_PATH=/tmp/brownies-sim.json BF_AGENT_MAX_MISUNDERSTANDINGS=3 npm run agent:simulate
```

Esta etapa não implementa IA nem integração com WhatsApp — apenas a política de contagem/handoff sobre o interpretador determinístico já existente.

### Camada de apresentação do agente

O Conversation Engine devolve só resultado estruturado (`messageKey` + `data` + sessão), sem texto de atendimento. Antes de virar texto, esse resultado passa por duas camadas:

- **Presentation Context Builder** (`src/agent/presentation.ts`) — combina o resultado, a sessão e as Agent Tools para resolver dados públicos que o Engine não carrega em toda transição (nome do negócio, nome do produto pelo `productId`, opções de pagamento e horários de retirada atuais, resumo do carrinho). É a única camada que consulta Tools para fins visuais.
- **Renderer** (`src/agent/renderer.ts`) — usa somente `presentation.context` e o Message Catalog (`src/agent/messages.ts`) para produzir `AgentChatMessage[]`. Não importa Agent Tools nem conhece o domínio.

O simulador chama `buildConversationPresentation()` seguido de `renderConversationPresentation()` após cada `processAction()`.

### Interpretador LLM — infraestrutura

`src/agent/llm-interpreter.ts`, `llm-prompt.ts` e `llm-output-validator.ts` implementam o interpretador por IA opcional, acionado apenas depois de um `NOT_UNDERSTOOD`/`AMBIGUOUS` determinístico em cenários elegíveis (por exemplo, uma mensagem natural mais complexa).

Pontos importantes desta etapa:

- **Providers reais são opcionais.** O runtime usa o SDK `openai` para `OPENAI_FALLBACK` e para o endpoint compatível do NVIDIA NIM/Nemotron em `NVIDIA_NEMOTRON`. `BF_LLM_MODE=DISABLED` é o padrão e não cria provider nem faz chamada externa. Os testes usam clientes fake locais.
- **Toda saída passa por validação local antes de virar ação.** `parseLlmOutput`/`validateLlmOutput` (`src/agent/llm-output-validator.ts`) usam só `JSON.parse` (nunca `eval`/`Function`) e comparam a proposta do provider contra uma allowlist de ações e contra os dados reais de `context` — nada do que o provider afirma é aceito por si só.
- **Somente ações já existentes no contrato real podem ser retornadas** (`AgentConversationAction`), classificadas e restritas por etapa da conversa (ex.: `CONFIRM_ORDER` só é aceito em `AWAITING_CONFIRMATION`, e nunca combinado com outras alterações no mesmo lote).
- **Produtos, horários e formas de pagamento precisam existir no contexto público informado** — `productId`/`productName` só resolvem por correspondência exata (nunca fuzzy, nunca a primeira opção em caso de ambiguidade), `pickupTime` só aceita valores exatamente presentes em `pickupSlots` (com a única normalização seed seguro "19h" → "19:00", quando "19:00" já existe na lista), e `paymentMethod` só aceita o valor canônico de `paymentOptions`. Pedidos de entrega (`ENTREGA`/`DELIVERY`) nunca são aceitos.
- **Nenhuma criação de pedido ocorre nesta camada** — o LLM Interpreter não importa Agent Tools, Orders, Session Store nem calcula preço; ele só produz `AgentConversationAction[]` já validadas, que ainda precisariam passar pelo Conversation Service e pelo Engine (fluxo oficial, inalterado).
- **As variáveis condicionais estão em `.env.example`.** Configure uma chave somente quando escolher explicitamente um dos modos ativos.

### Fallback LLM controlado

O Text Conversation Service pode, opcionalmente, encaminhar uma mensagem ao
LLM Interpreter quando o Deterministic Interpreter não a entende — nunca
antes dele, e nunca para tudo.

- O interpretador determinístico sempre roda primeiro; o LLM só é chamado
  depois de um `NOT_UNDERSTOOD`/`AMBIGUOUS` determinístico.
- O LLM é opcional e desabilitado por padrão (`llmMode: "DISABLED"`). Ativar
  requer injetar explicitamente `llmInterpreter` (ou `interpretWithLlm`) e
  `llmMode: "FALLBACK"` na criação do `TextConversationService`.
- Uma função pura de elegibilidade (`llm-eligibility.ts`) decide, antes de
  qualquer chamada, se a falha determinística é do tipo que vale a pena
  tentar de novo com o LLM — bloqueios de segurança/negócio conhecidos
  (entrega não suportada, pagamento/horário inexistente, handoff ativo,
  texto que parece instrução ou ação JSON crua, menção a IDs internos, texto
  acima do limite configurável) nunca chegam ao LLM.
- A saída do LLM já passa pelo `llm-output-validator.ts` existente antes de
  chegar aqui — esta camada nunca decide sozinha se uma ação é válida.
- Uma única ação `MATCHED` do LLM executa pelo mesmo caminho oficial de uma
  ação determinística (`AgentConversationService` → `Conversation Engine`).
  Um lote de várias ações passa primeiro por um preflight num Session Store
  descartável (`conversation-action-batch.ts`) antes de qualquer execução
  oficial; um lote rejeitado nunca altera a sessão real.
- Limitação conhecida e aceita (não há transação real no Session Store): um
  lote que **passa** no preflight e mesmo assim falha tecnicamente no meio da
  execução oficial (`FAILED`) pode deixar o carrinho parcialmente aplicado —
  as ações anteriores à falha já foram gravadas e não há rollback falso. Nesse
  caso o `messageId` é deixado deliberadamente sem marcação, para que um retry
  da mesma mensagem reexecute o lote em vez de ser descartado como duplicado.
- Erros técnicos do provider (`PROVIDER_ERROR`, incluindo timeout) nunca
  contam como incompreensão: não incrementam `misunderstandingCount`, não
  registram `messageId` (permitindo novo retry) e não disparam handoff.
- O simulador CLI respeita `BF_LLM_MODE`; sem configuração, permanece em
  `DISABLED`. Os modos ativos devem ser configurados deliberadamente e nunca
  são usados por `npm test`.

### Providers e smoke tests

- `OPENAI_FALLBACK` usa OpenAI somente para mensagens elegíveis; `NVIDIA_NEMOTRON`
  usa NVIDIA NIM/Nemotron quando configurado.
- O LLM nunca cria pedidos diretamente nem calcula preços. Toda ação passa pelo
  schema, pelo validador local, pelo Conversation Service e pelas regras do Engine.
- `npm test` não realiza chamadas externas. Os scripts `test:nim`,
  `agent:smoke:openai` e `agent:smoke:nvidia` são manuais e podem fazer rede
  somente com a flag explícita `BF_LLM_LIVE_SMOKE` habilitada.

## Estado atual da infraestrutura

O armazenamento de catálogo e pedidos ainda é JSON local, e as sessões, locks
e limites do agente ainda vivem em memória. Portanto, o sistema não está pronto
para múltiplas réplicas. Railway, Evolution Go e PostgreSQL ainda não estão
integrados; enquanto essa persistência não for substituída, uma única réplica é
necessária inicialmente.

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
