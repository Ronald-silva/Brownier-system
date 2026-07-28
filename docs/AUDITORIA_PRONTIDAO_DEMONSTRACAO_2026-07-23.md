# Auditoria de prontidão para demonstração — Brownieria Fortal

Data: 2026-07-23
Escopo: auditoria completa (somente leitura de código; nenhum arquivo de código foi alterado). Interações no app em execução (adicionar ao carrinho, enviar pedidos de teste, alterar configurações no painel) foram necessárias para testar os fluxos e alteram o arquivo de dados de demonstração (`data/brownies-fortal.demo.json`), que já é gitignored e recriável — ver Achado P0-1.

Ambiente testado: `npm run dev` local (`http://localhost:3000`), Chromium headless via Playwright, commit de trabalho atual (branch `master`, working tree com as alterações não commitadas listadas no `git status`).

---

## 1. Veredito geral

**Pronto com ajustes.**

Os fluxos essenciais (compra pública ponta a ponta e operação administrativa) funcionam corretamente, com validações, persistência e tratamento de erro bem construídos. Porém existe **um problema de conteúdo ao vivo, visível agora mesmo no cardápio público**, que precisa ser corrigido antes de qualquer demonstração (Achado P0-1), e alguns pontos de conversão/segurança que valem a pena resolver antes de uma demo real com o proprietário.

## 2. Notas (0–10)

| Área | Nota | Observação curta |
|---|---|---|
| Experiência pública | 8 | Fluxo fluido; header sobrepõe topo do formulário ao rolar |
| Cardápio e produto | 6 | Motor correto, mas há conteúdo de teste "vazado" ao vivo agora (P0-1) |
| Carrinho | 9 | Adicionar/remover/ajustar quantidade e desconto agregado funcionam bem |
| Checkout | 8 | Validações sólidas; mensagem de WhatsApp é um beco sem saída |
| Confirmação | 8 | Sobrevive a reload; copy não distingue Uber Moto de retirada pessoal |
| Painel administrativo | 7 | CRUD e toggles funcionam; falta validação de ordem duplicada e rate limit |
| Pedidos (operação) | 8 | Lista, busca, detalhe e status funcionam; sem filtro por status/data |
| Responsividade | 9 | Zero overflow horizontal em 320/390/768/1280px (32/32 checagens) |
| Acessibilidade básica | 8 | Alt text, aria-label, label, `lang`, foco visível — todos presentes |
| Confiabilidade técnica | 8 | Build/lint/testes/smokes 100% verdes; falha de rede exibe erro em inglês |

## 3. Achados por prioridade

### P0 — impede demonstração ou operação

**P0-1 — O cardápio público está mostrando texto de teste e preço incorreto para "Ovomaltine Crocante" agora mesmo**
- Código: `data/brownies-fortal.demo.json` (dado persistido; gerado por `tests/product_full_edit_smoke.py:18-21`)
- Tela: `/cardapio` (card do produto) e `GET /api/public/menu`
- Passos para reproduzir: abrir `http://localhost:3000/cardapio` e localizar o card "Ovomaltine Crocante".
- Comportamento observado: descrição do produto é literalmente **"Descrição editada via teste de aceite."** e o preço mostrado é **R$ 8,50**, enquanto todos os outros sabores custam R$ 5,00. Confirmado também via `GET /api/public/menu` (`description: "Descrição editada via teste de aceite."`, `basePrice: 8.5`).
- Comportamento esperado: descrição e preço reais do sabor Ovomaltine (conforme o menu enviado pelo Mateus — R$ 5,00, mesma descrição dos demais sabores).
- Impacto: se o proprietário abrir o site agora, verá um texto de teste em português claramente artificial e um preço errado em um produto real. É o tipo de coisa que quebra a confiança logo de cara.
- Recomendação objetiva: antes da demo, corrigir o produto pela aba "Sabores" do painel (nome/descrição/preço reais) **ou** apagar `data/brownies-fortal.demo.json` (o servidor recria os dados-seed limpos no próximo start, conforme já documentado no README). Depois, ver P1-2 sobre por que isso aconteceu.

### P1 — causa erro relevante ou prejudica conversão

**P1-1 — Cliente é instruído a "falar pelo WhatsApp" mas não existe nenhum contato de WhatsApp visível em lugar nenhum do site público**
- Código: `src/App.tsx:112` (mensagem "Fale com a Brownieria pelo WhatsApp." é texto estático, sem link/telefone); `src/App.tsx:86` (`<footer>` só renderiza `"Brownieria Fortal • demonstração"`, sem telefone/WhatsApp/endereço/Instagram)
- Tela: `/finalizar`, quando não há horários de retirada configurados (era o estado padrão dos dados de demo antes desta auditoria)
- Passos para reproduzir: com `business.pickupSlots` vazio, ir ao carrinho → finalizar pedido → ver a seção "Escolha o horário de retirada".
- Comportamento observado: a mensagem diz para falar pelo WhatsApp, mas nenhuma página pública (Home, Cardápio, Produto, Carrinho, Checkout) exibe telefone, WhatsApp, endereço, horário de funcionamento ou Instagram — mesmo que esses campos existam e sejam editáveis na aba "Ajustes" do admin. Confirmado por busca no DOM: a palavra "whatsapp" só aparece nessa mensagem estática, nunca como link/número real.
- Comportamento esperado: quando `business.whatsapp` estiver preenchido, a mensagem (e idealmente o rodapé) deveria virar um link clicável (`https://wa.me/55...`) com o número real.
- Impacto: em qualquer cenário onde os horários ainda não foram configurados (ex.: logo após o primeiro deploy, ou se o admin esquecer de configurá-los), o cliente fica sem nenhuma forma de contato — perda direta de pedido.
- Recomendação objetiva: renderizar o WhatsApp (e demais dados de contato já coletados em "Ajustes") como link ativo em pelo menos o rodapé e nessa mensagem de fallback.

**P1-2 — Os smoke tests escrevem no mesmo arquivo de dados que alimenta a demonstração ao vivo, sem isolamento nem limpeza**
- Código: `tests/product_full_edit_smoke.py` (e os demais `tests/*_smoke.py`) apontam para `http://localhost:3000`, que usa `data/brownies-fortal.demo.json` (`server.ts:21`) — não há banco/arquivo de teste separado.
- Passos para reproduzir: rodar `python3 tests/product_full_edit_smoke.py` contra o servidor de dev e depois abrir `/cardapio`.
- Comportamento observado: o teste sobrescreve permanentemente nome, descrição e preço de um produto real, e isso fica visível para qualquer visitante até alguém corrigir manualmente. É exatamente a causa do Achado P0-1.
- Comportamento esperado: suíte de smoke tests não deveria deixar rastro em dados que o público (ou o dono do negócio) vê depois.
- Impacto: qualquer execução futura da suíte de smoke tests antes de uma demo pode reintroduzir o mesmo problema sem ninguém perceber.
- Recomendação objetiva: apontar os smoke tests para um `data/*.testing.json` isolado (variável de ambiente `DATA_FILE` ou similar), ou adicionar um passo de teardown que restaura o produto editado. Não é urgente tecnicamente, mas é processo — vale resolver antes do próximo ciclo de testes pré-demo.

**P1-3 — Código de acesso administrativo padrão é público (está no README) e o endpoint admin não tem limite de tentativas**
- Código: `server.ts:64-68` (`admin()` middleware — sem rate limit) vs. `server.ts:70-76` (`publicRateLimit`, que existe só para rotas públicas); código-fallback `"brownies-demo"` documentado em `README.md`.
- Passos para reproduzir: `curl` repetido em `PUT /api/admin/business` ou `GET /api/admin/bootstrap` com `x-admin-code` incorreto — nunca é bloqueado por volume (testado: 401 correto em toda tentativa errada, mas sem limite de tentativas por IP).
- Comportamento observado: se a aplicação for exposta publicamente (deploy) **sem** definir a variável de ambiente `ADMIN_ACCESS_CODE`, o código de acesso do painel é a string fixa `"brownies-demo"`, já publicada no README/histórico do Git, sem nenhum limite de tentativas de força bruta na API admin.
- Comportamento esperado: em qualquer ambiente acessível pela internet, um código forte e não público deveria ser obrigatório, e o endpoint admin deveria ter o mesmo tipo de limite de tentativas que já existe nas rotas públicas.
- Impacto: **condicional** — só é um risco real se a demo for feita a partir de uma URL publicamente acessível (deploy) em vez de `localhost`. Se a demo for local, o risco é baixo.
- Recomendação objetiva: antes de qualquer deploy público (Vercel ou outro), confirmar que `ADMIN_ACCESS_CODE` está definido com um valor forte nas variáveis de ambiente do ambiente de destino. Adicionar rate limiting ao middleware `admin()` é uma melhoria de segurança recomendada, mas não bloqueia uma demo local.

### P2 — problema perceptível, mas contornável

**P2-1 — Header fixo ("sticky") sobrepõe o topo do primeiro campo do checkout ao rolar a tela**
- Código: `src/experience.css:13` e `:70` (`.public-header { position: sticky; top: 0; height: 108px (mobile) }`)
- Tela: `/finalizar` (e potencialmente outras páginas com conteúdo logo no topo)
- Passos para reproduzir: abrir `/finalizar` em viewport mobile (390×844), rolar ~400px para baixo.
- Comportamento observado: o rótulo "Seu nome" fica coberto pelo header, e o campo de texto aparece cortado pela borda inferior do header fixo (evidência: captura de tela em viewport, não apenas full-page).
- Comportamento esperado: o conteúdo não deveria ficar escondido atrás do header fixo ao rolar.
- Impacto: usuário perde momentaneamente a referência do rótulo do campo; não impede o preenchimento, mas reduz a clareza.
- Recomendação objetiva: adicionar `scroll-margin-top` (ou padding equivalente) ao formulário/primeira seção igual à altura do header.

**P2-2 — Botões "+" de adicionar no grid do cardápio ficam abaixo de 44×44px em 320px de largura**
- Código: `src/index.css` (`.product-footer{display:flex...}` + `.cart-button,.add-icon{width:44px;height:44px;...}` sem `flex-shrink:0`)
- Tela: `/cardapio`, viewport 320px
- Passos para reproduzir: abrir `/cardapio` em 320×900; medir os botões de adicionar (`aria-label` "Adicionar …") via `getBoundingClientRect()`.
- Comportamento observado: largura medida entre 36,4px e 42,5px (altura permanece 44px) — o botão circular de "+" encolhe porque é filho flexível sem `flex-shrink:0` dentro de `.product-footer`, e encolhe mais ainda quando o rótulo vizinho é mais longo (ex.: "Indisponível hoje").
- Comportamento esperado: alvo de toque de pelo menos 44×44px, conforme já aplicado a outros botões via `src/polish.css:4`.
- Impacto: em telefones pequenos (iPhone SE e similares), o botão de adicionar mais usado do app fica ligeiramente abaixo do tamanho recomendado de toque.
- Recomendação objetiva: adicionar `flex-shrink: 0` a `.add-icon`/`.cart-button`.

**P2-3 — Falha total de rede no envio do pedido mostra mensagem em inglês ("Failed to fetch") em vez de texto em pt-BR**
- Código: `src/App.tsx:13` (`api()` — `throw new Error(data.error || "Não foi possível concluir a ação.")`, mas isso só cobre resposta HTTP com corpo; uma falha de `fetch` em si (rede offline) lança o `TypeError` nativo do navegador) e `src/App.tsx:111` (`catch (e) { setError(e instanceof Error ? e.message : "Erro ao criar pedido.") }` usa `e.message` diretamente, sem normalizar para pt-BR)
- Tela: `/finalizar`
- Passos para reproduzir: interceptar `POST /api/public/orders` forçando falha de conexão (`route.abort("failed")`) e clicar em "Confirmar pedido".
- Comportamento observado: mensagem de erro exibida ao cliente é `"Failed to fetch"`, em inglês, quebrando a consistência de idioma do restante da experiência.
- Comportamento esperado: mensagem em português (ex.: "Não foi possível enviar seu pedido. Verifique sua conexão e tente novamente.").
- Impacto: acontece só em falha de rede real (sem servidor alcançável), não em erros normais de validação — cenário raro, mas pode acontecer numa demo com Wi-Fi instável.
- Recomendação objetiva: no `catch`, tratar erros que não vieram de uma resposta HTTP (ex.: `TypeError`) com uma mensagem genérica em português, reservando `e.message` só para erros vindos do próprio servidor.

**P2-4 — Editor de produtos aceita "Ordem de exibição" duplicada entre dois sabores, sem aviso**
- Código: aba "Sabores" em `src/AdminOperations.tsx` (campo "Ordem de exibição" sem validação de unicidade)
- Tela: painel `/equipe` → Sabores → Editar
- Passos para reproduzir: hoje mesmo, "Brownie de Ninho" e "Ovomaltine Crocante" têm `displayOrder: 2` simultaneamente (confirmado via `GET /api/admin/bootstrap`), resultado de uma edição anterior salva sem qualquer alerta.
- Comportamento observado: o formulário salva o valor duplicado normalmente, sem mensagem de aviso.
- Comportamento esperado: alertar (ou impedir) quando dois produtos compartilham a mesma ordem, para evitar ambiguidade de exibição.
- Impacto: baixo agora (a lista ainda renderiza de forma determinística), mas confunde o admin ao tentar reordenar o cardápio.
- Recomendação objetiva: validar unicidade no submit do formulário, ou trocar por um controle de arraste (drag-to-reorder) que gerencie os números automaticamente.

**P2-5 — Confirmação do pedido não menciona a "solicitação de Uber Moto" que o cliente escolheu**
- Código: `src/App.tsx:113` (`Você escolheu {order.fulfillmentType === "RETIRADA" ? "retirada" : "entrega"} ...` — não diferencia `pickupMethod` PESSOAL de UBER_MOTO na tela de confirmação; o dado nem é enviado ao backend, ver Nota 1 abaixo)
- Tela: `/pedido/:publicCode`
- Passos para reproduzir: no checkout, escolher "Vou solicitar Uber Moto" e concluir o pedido.
- Comportamento observado: a tela de confirmação só diz "Você escolheu retirada e pagamento X", igual para quem escolheu retirar pessoalmente. Não há lembrete de que o cliente ainda precisa solicitar o Uber Moto por conta própria quando o pedido ficar pronto.
- Comportamento esperado: reforçar na confirmação (não só no formulário) que, para Uber Moto, a ação de chamar o motorista é do cliente.
- Impacto: risco operacional pequeno — cliente pode esquecer que precisa agir depois que o pedido estiver pronto.
- Recomendação objetiva: opcional para a demo; considerar registrar `pickupMethod` no pedido (hoje não é enviado ao backend — só existe no estado local do formulário) e repetir o aviso na confirmação.

### P3 — melhoria opcional

- **P3-1**: botão "← Voltar" mede 40px de altura em todas as páginas e larguras (`.back` não está na lista `min-height:44px` de `src/polish.css:4`, que cobre `.primary, .secondary, .choice, .add-icon, .cart-button, .day-toggle`). Diferença pequena (4px), baixo impacto prático.
- **P3-2**: aba "Pedidos" do admin só tem busca por texto (código/nome/telefone), sem filtro por status ou data. Com 6 pedidos por dia isso não importa; vale revisitar se o volume crescer.
- **P3-3**: `Confirmation`/checkout ainda carregam um ramo de código morto para `fulfillmentType === "ENTREGA"` (`src/App.tsx:113`), de uma época em que a Brownieria fazia entrega própria — hoje só existe retirada. Não causa bug, é só código vestigial.
- **P3-4**: o rodapé público (`src/App.tsx:86`) não expõe telefone/endereço/horário/Instagram mesmo quando preenchidos no admin — parcialmente coberto por P1-1, mas vale pensar num rodapé completo, não só o WhatsApp, quando o negócio tiver esses dados reais.

### FUTURO — fora da demonstração atual

- Preparação para agente de IA/WhatsApp já está documentada (`docs/IA_E_WHATSAPP.md`) e é tecnicamente sólida (agente só chama rotas públicas, nunca calcula preço). Ver seção 6.

## 4. Funcionalidades confirmadas como operacionais

Fluxo público (testado ponta a ponta com Playwright):
- Home → Cardápio → Produto → alterar quantidade (+/-) → adicionar ao pedido → adicionar um segundo sabor → abrir carrinho.
- Carrinho: aumentar/diminuir quantidade por linha; remover item (reduzindo quantidade a zero); "Limpar pedido"; aviso "Faltam N brownies para o preço por quantidade" atualiza corretamente (desconto é por total do pedido, não por sabor — confirmado por `tests/aggregate_pricing_smoke.py`, que também passou).
- Checkout: nome e WhatsApp obrigatórios; escolha entre "retirar pessoalmente" e "solicitar Uber Moto" (com aviso de que a Brownieria não entrega); seleção de horário de retirada (obrigatória apenas quando existem horários configurados); métodos de pagamento; campo de observação opcional; total recalculado no servidor.
- Confirmação: código público não sequencial, botão "Copiar código", resumo dos valores, sobrevive a reload de página (busca o pedido pelo `publicCode`).
- Produto/sabor indisponível: card mostra "Indisponível hoje" e desabilita o botão; acesso direto à página do produto indisponível também desabilita corretamente o botão principal ("Indisponível hoje").
- Produto inexistente (`/cardapio/produto-que-nao-existe-xyz`): mostra "Produto não encontrado." sem quebrar a aplicação.
- Carrinho vazio ao acessar `/finalizar` diretamente: formulário aparece normalmente, mas o envio é bloqueado com "O pedido precisa ter pelo menos um item."
- Reload em `/finalizar` com item no carrinho: item permanece (persistência via `sessionStorage`).
- Botão "Voltar" do navegador durante o pedido: navega corretamente entre as telas, sem estado quebrado.
- Duplo clique em "Confirmar pedido": cria exatamente **um** pedido (confirmado consultando a lista de pedidos via API admin), sem duplicação.
- Falha simulada do servidor (HTTP 500) ao confirmar pedido: mensagem de erro exibida, formulário preservado, botão volta a ficar clicável.

Painel administrativo (`/equipe`):
- Login com código errado: mensagem clara "Código de acesso inválido.", sem revelar nenhum dado.
- Login correto: acesso ao dashboard ("Hoje"), abas Sabores/Promoções/Pedidos/Produção/Ajustes.
- Configuração de horários de retirada (Ajustes → Horários de retirada): adicionar múltiplos horários, salvar, **persistir após reload da página admin**, e refletir corretamente no checkout público (radiogroup com os horários configurados) — inclusive bloqueando o envio do pedido se o cliente não escolher um horário quando existem horários cadastrados.
- Pedidos: lista carrega, busca por código/nome/telefone (`aria-label="Buscar pedidos"`), abrir detalhe e alterar status (`NOVO → CONFIRMADO` testado com sucesso, refletido na lista).
- Sabores: alternar disponibilidade de um produto reflete instantaneamente no card do admin **e** no cardápio público (testado com "Doce de Leite": card ganha rótulo "Indisponível hoje", botão de adicionar é desabilitado).
- API admin (`/api/admin/bootstrap`, `/api/admin/business`) corretamente retorna 401 sem o header `x-admin-code` correto — testado diretamente contra a API, não só pela UI.

Responsividade (320 / 390 / 768 / 1280px): **0px de overflow horizontal** em todas as 32 combinações de página × largura testadas (Home, Cardápio, Produto, Carrinho, Checkout, Admin dashboard, Admin pedidos, Admin sabores). Nenhum erro de console JavaScript detectado em nenhuma largura.

Acessibilidade básica: 100% das imagens com `alt`; 100% dos botões só-ícone com `aria-label`; toda página pública tem exatamente um `<h1>` dentro de `<main>`; `lang="pt-BR"` definido; campos de formulário associados a `<label>` (inclusive o campo de código de acesso do admin); estilo de foco visível (`:focus-visible`) definido globalmente.

## 5. Dívidas técnicas que não impedem a demonstração

- Suíte de smoke tests sem isolamento de dados (ver P1-2) — é dívida de processo de teste, não do produto em si.
- Falta de rate limit no middleware `admin()` (ver P1-3) — só urgente se houver deploy público.
- Ordem de exibição de produtos sem validação de unicidade (P2-4).
- Rodapé público minimalista, sem dados de contato completos (P1-1 / P3-4).
- Código morto para fulfillment "ENTREGA" (P3-3).
- Lista de pedidos sem filtro por status/data — hoje o volume é baixo o suficiente para não importar (P3-2).

## 6. Itens necessários antes da integração com WhatsApp e IA

`docs/IA_E_WHATSAPP.md` já define bem o contrato (agente só consome rotas públicas, nunca calcula preço nem acessa `/api/admin/*`). Antes de ativar essa integração, vale resolver:

1. **P1-1 precisa estar resolvido primeiro**: o número de WhatsApp real da Brownieria precisa estar configurado e correto em `business.whatsapp`, já que o agente conversacional dependerá exatamente desse canal.
2. O documento já assinala corretamente que o armazenamento em JSON e o rate limiter em memória (`server.ts:23,70-76`) precisam virar banco gerenciado + limitador persistente (Redis ou equivalente) antes de tráfego de produção — mais importante ainda quando o volume de chamadas pode vir de um agente automatizado, não só de cliques humanos.
3. Reconfirmar o formato de `productImageSrc`/`imageUrl` (per histórico do projeto, fotos reais são armazenadas como base64 inline no JSON): se um agente for citar `GET /api/public/menu` como contexto para IA, payloads com imagem embutida ficam desnecessariamente grandes — vale considerar servir imagens por URL/arquivo antes dessa integração.
4. `Ovomaltine`: descrição/ingredientes/allergens ainda são texto placeholder do sabor original (fora do escopo desta auditoria funcional, mas relevante para qualquer IA que for citar esses dados como fato).

## 7. Lista final

**Corrigir antes da demonstração:**
- P0-1 — corrigir nome/descrição/preço do Ovomaltine (ou resetar `data/brownies-fortal.demo.json`).
- P1-1 — pelo menos preencher o WhatsApp real da Brownieria em Ajustes e, idealmente, torná-lo visível/clicável em algum lugar público antes do cliente ver a mensagem de fallback.
- P1-3 — **se e somente se** a demo for feita a partir de uma URL publicamente acessível (não localhost): confirmar `ADMIN_ACCESS_CODE` definido com valor forte.

**Corrigir depois da demonstração:**
- P1-2 — isolar dados usados pelos smoke tests do arquivo de demonstração real.
- P2-1, P2-2, P2-3, P2-4, P2-5.
- Rate limiting no middleware `admin()` (reforço de segurança, mesmo em uso local/privado).

**Não corrigir agora:**
- P3-1, P3-2, P3-3, P3-4.
- Itens da seção 6 (pré-requisitos de WhatsApp/IA) — fora do escopo da demonstração atual.

---

*Nenhum arquivo de código foi alterado durante esta auditoria. O arquivo de dados de demonstração (`data/brownies-fortal.demo.json`) foi modificado como efeito colateral inevitável de testar os fluxos reais (pedidos de teste foram criados, horários de retirada foram configurados, a disponibilidade de um produto foi alternada e restaurada ao estado original ao final). Recomenda-se apagar esse arquivo antes da demonstração real para começar com dados limpos — ele é recriado automaticamente pelo servidor.*
