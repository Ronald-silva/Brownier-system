# Incidente: SHOW_MENU repetido pelo LLM — logging de causa raiz + guarda estrutural

**Data:** 2026-08-01
**Escopo:** um cliente real recebeu `SHOW_MENU` (mensagem `MENU_READY`) duas vezes seguidas da NVIDIA para mensagens que não pediam o cardápio, sem o pedido ser processado. Carrinho ficou vazio, venda perdida.
**Método:** confirmação via dado de produção (Postgres), leitura do fluxo completo de `llm-interpreter.ts` → `text-conversation.service.ts` → `conversation.engine.ts`.

---

## 1. Estado inicial verificado

- Sessão do cliente estava íntegra (`BROWSING_MENU`, sem regressão de step).
- Mensagens do cliente: "quero 5 prestígio, 5 doce de leite, 10 de ninho, quanto fica?" e, na sequência, provavelmente algo sobre retirada ("posso pegar agora?").
- A NVIDIA devolveu `{status: "MATCHED", actions: [{type: "SHOW_MENU"}]}` nas duas vezes, em vez de `ADD_ITEM`/pergunta factual.
- **Não existia** filtro de `confidence` entre a decisão do modelo e a execução da ação: `MATCHED` sempre executa, mesmo com `confidence: "LOW"` — esse campo só influenciava `response-strategy-policy.ts` (TEMPLATE vs. VERBALIZE), nunca decidia se a ação era executada.
- Não existe módulo de observabilidade estruturada no projeto (nenhum logger central); `console.error`/`console.log` pontual (ex.: `src/integrations/evolution-go.ts`) já é o padrão existente, capturado pelo Railway.

## 2. Diagnóstico

**Causa raiz real** (por que o modelo escolheu `SHOW_MENU` para essas mensagens especificamente) **ainda não está confirmada** — é exatamente o que a Parte A (logging temporário) foi desenhada para revelar no próximo caso real, sem expor texto do cliente. Hipóteses não verificadas: prompt ambíguo diante de pedidos multi-item complexos, o modelo tratando "quanto fica" como pedido de preço/cardápio, ou o modelo perdendo contexto entre turnos (sem `shortHistory` habilitado nesta sessão).

**Causa raiz do *sintoma* (reenvio idêntico sem progresso)**: a arquitetura não tinha nenhuma memória de "o que já foi dito" — cada turno decide e executa de forma independente, sem checar se o resultado repete o turno anterior sem nenhum progresso. Isso é o que a Parte B mitiga.

## 3. Decisões tomadas

### Parte A — logging temporário (`src/agent/llm-interpreter.ts`)
Loga, só quando `status === "MATCHED"` e uma das ações é `SHOW_MENU`: `status`, tipos de ação, `intent` (se houver) e `confidence` (se houver) — via `console.warn(JSON.stringify(...))`, sem dependência nova. Nunca loga texto do cliente, `contactId` ou sessão. Marcado explicitamente como temporário no código, para remoção ou promoção a observabilidade permanente após confirmação do padrão com dados reais.

### Parte B — guarda de repetição (`src/agent/text-conversation.service.ts`, `src/agent/session.types.ts`)
- Novo campo opcional `AgentSession.lastMessageKey` (aditivo, JSONB no Postgres — sem migração; sessões antigas sem o campo continuam válidas).
- `recordLastMessageKey()`: grava o `messageKey` da última mensagem efetivamente enviada nesta sessão, como última operação de cada turno, ainda dentro do lock por `sessionKey` (nunca depois de liberá-lo, para não haver corrida entre turnos concorrentes).
- Guarda propriamente dita: se o LLM decide `SHOW_MENU` como ação única, a última mensagem enviada nesta sessão já foi `MENU_READY`, e o step já é `BROWSING_MENU`/`BUILDING_ORDER` (ou seja, o cardápio já tinha sido mostrado de fato, sem regressão), o `llmOutcome` é reduzido a `NOT_UNDERSTOOD` *antes* de qualquer branch de execução — reaproveitando 100% do caminho de incompreensão já existente (incrementa `misunderstandingCount`, pode disparar handoff automático). Só se aplica à ação vinda do LLM: `SHOW_MENU` determinístico (interpretador determinístico ou atalho factual por palavra-chave como "cardápio") não passa por este código e continua idêntico.

## 4. Risco conhecido e não resolvido nesta sessão

`lastMessageKey` é gravado a cada turno com mensagem real enviada (não só em `SHOW_MENU`), o que é necessário para o campo refletir com precisão "a última coisa dita" — mas isso significa uma chamada extra de persistência (`sessionStore.update`) por turno, existente mesmo quando a guarda não dispara. Aceito como custo do rastreamento correto; documentado no teste que antes verificava exatamente 1 chamada de update (agora 2).

A guarda cobre apenas `MENU_READY` (por instrução explícita: não generalizar sem necessidade). Se o mesmo padrão de repetição aparecer com outra `messageKey` "sem progresso", decidir separadamente se estende a lista pequena de chaves cobertas.

**Isto é uma mitigação de sintoma, não uma correção da causa raiz.** A causa raiz (por que o modelo decidiu `SHOW_MENU` para aquelas mensagens específicas) permanece desconhecida até o próximo caso real com o logging da Parte A ativo.
