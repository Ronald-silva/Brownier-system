# Sprint 5 — Business Validation & Demo Kit

**Produto avaliado:** MVP Brownieria Fortal  
**Objetivo da apresentação:** obter validação para uma operação-piloto. A conversa não deve ser sobre “comprar software”; deve ser sobre reduzir desencontro entre cardápio, atendimento e produção, mantendo o pedido organizado.

> **Regra de demonstração:** preços, pedidos, fotos e dados deste documento são um cenário de demonstração. Devem ser confirmados e substituídos pelos dados reais antes de uso comercial.

## 1. Resumo executivo do produto

O MVP é uma vitrine móvel de pedidos para brownies artesanais e um painel operacional simples para a equipe. O cliente vê sabores disponíveis, preço e promoção, monta o pedido e informa apenas os dados necessários para retirada ou entrega. A equipe recebe o pedido já estruturado, atualiza seu status e altera disponibilidade, promoções e informações comerciais sem depender de alteração no código.

**Transformação proposta:** sair de um processo em que o pedido chega espalhado em mensagens e a disponibilidade precisa ser explicada manualmente, para um fluxo em que o cliente se autoatende na escolha e a equipe entra para confirmar, produzir e entregar.

### Problema que resolve

- Cardápio, preço e disponibilidade deixam de depender de respostas repetidas.
- O pedido chega com itens, quantidades, total, contato, modalidade de recebimento, pagamento e observação no mesmo registro.
- A produção deixa de procurar informações em conversas e passa a trabalhar com uma fila de pedidos.
- Um sabor esgotado pode ser retirado do fluxo de compra com um toque, reduzindo frustração e retrabalho.

### Economia de tempo e atendimentos: hipótese a validar no piloto

Não há ainda medição real no MVP; portanto, os números abaixo são hipóteses de negócio, não promessa.

| Indicador | Processo por conversa (hipótese) | Com pedido estruturado (hipótese) | Ganho potencial |
| --- | ---: | ---: | ---: |
| Triagem de um pedido simples | 5–8 min | 1–3 min para conferir e confirmar | 3–5 min/pedido |
| Interações para preço, sabores e disponibilidade | 3–6 mensagens/pedido | 0–2, quando houver exceção | 2–4 interações evitadas |
| Alterar um sabor esgotado | Mensagens repetidas até atualização manual | 1 toque no painel | redução imediata de oferta incorreta |
| Localizar pedido para produção | busca em conversas | lista de pedidos/produção | segundos, em vez de minutos |

Num dia ilustrativo de **15 pedidos**, se cada um exigir 3 minutos a menos de triagem, a equipe recupera **cerca de 45 minutos**. Isso não elimina o atendimento humano: elimina a coleta repetitiva de informações e deixa o humano para confirmação, exceções e relacionamento.

### Tarefas que ficam mais rápidas

- Consultar sabores disponíveis e preços.
- Aplicar promoção por quantidade de forma consistente.
- Registrar nome, telefone, endereço e observação sem transcrição manual.
- Separar pedidos novos, em preparo e concluídos.
- Marcar sabores esgotados e definir o Brownie do Dia.
- Atualizar informações básicas, como horário e endereço.

### Riscos operacionais reduzidos

- Vender sabor que já acabou.
- Cobrar preço ou promoção diferente do divulgado.
- Perder detalhes de endereço, retirada, forma de pagamento ou observação.
- Preparar pedido errado por leitura apressada de conversa.
- Perder pedido em dias de maior movimento.

### Onde está o valor financeiro

- Mais pedidos podem ser concluídos quando o cliente encontra informação e total sem esperar resposta.
- Promoção por quantidade incentiva aumento de itens por pedido; a margem deve ser validada antes de ativá-la.
- Menos tempo de atendimento libera a equipe para produção, qualidade e venda presencial.
- Menos erro e retrabalho protege receita e reputação.

O MVP **não prova** aumento de vendas por si só. Ele cria condições para medir se conversão, ticket e eficiência melhoram após a operação começar.

## 2. Análise de valor por funcionalidade existente

| Funcionalidade | Problema resolvido | Valor para o cliente | Valor para proprietário/equipe | Frequência | Importância | Recomendação |
| --- | --- | --- | --- | --- | --- | --- |
| Home/vitrine | Link frio ou cardápio pouco atraente | Entende a proposta e encontra uma ação clara | Fortalece marca e concentra tráfego | Toda visita | Alta | Manter; trocar imagem demonstrativa por fotos reais. |
| Cardápio dinâmico | Perguntas recorrentes sobre sabores e preços | Decide sem esperar resposta | Menos consultas repetidas | Toda compra | Crítica | Manter simples, com no máximo categorias realmente usadas. |
| Disponibilidade/esgotado | Oferta desatualizada | Não perde tempo escolhendo algo indisponível | Evita desculpas, cancelamentos e retrabalho | Diário | Crítica | Manter; criar rotina de abertura e encerramento. |
| Brownie do Dia | Dificuldade de destacar produção do dia | Escolha rápida e sensação de novidade | Ajuda a direcionar demanda | Diário/semanal | Média-alta | Manter somente se a equipe atualizar de verdade. |
| Detalhe do produto, ingredientes e alergênicos | Insegurança sobre composição | Mais confiança para decidir | Menos dúvidas e menor risco de informação omissa | Por produto | Alta | Validar informações reais antes de publicar. |
| Carrinho e ajuste de quantidade | Pedido informal/ambíguo | Controle visual do pedido e total | Menos erros de transcrição | Toda compra | Crítica | Manter. |
| Promoção por quantidade | Cálculo manual e incentivo fraco a caixa maior | Regra transparente e desconto automático | Ajuda ticket médio, se margem suportar | Parte das compras | Alta | Limitar a 1–2 regras fáceis de explicar; não criar muitas condições. |
| Checkout estruturado | Dados chegam incompletos em mensagens | Menos idas e voltas; confirmação do total | Pedido pronto para confirmar/produzir | Toda compra | Crítica | Manter campos essenciais; não adicionar fricção. |
| Código público do pedido | Dificuldade de referência | Identifica o pedido | Facilita conferência e suporte | Toda compra | Média | Manter; explicar que é referência, não rastreio em tempo real. |
| Lista de pedidos e status | Conversas dispersas | Recebe expectativa de confirmação | Organiza fila e passagem entre pessoas | Diário | Crítica | Manter apenas estados que a equipe realmente usa. |
| Modo Produção | Produção precisa montar pedido a partir do atendimento | — | Cartões grandes com itens, modalidade e observações | Em dias de operação | Alta | Manter; usar numa tela/telefone dedicado na bancada. |
| Painel de sabores e fotos | Dependência de terceiro para pequenas alterações | Cardápio mais confiável | Autonomia operacional | Diário/semanal | Crítica | Manter; treinar uma pessoa titular e uma reserva. |
| Painel de promoções | Promoção fica informal/inconsistente | Oferta clara | Controle comercial | Semanal/campanha | Média | Simplificar para duas promoções ativas no máximo no piloto. |
| Ajustes da empresa | Informações de contato divergentes | Sabe como receber/contatar | Evita atendimento por dados errados | Esporádica | Alta | Preencher e revisar antes de divulgar. |

### Simplificações recomendadas

1. **Duas promoções no máximo.** Muitas regras trocam ganho de ticket por dúvida e margem difícil de acompanhar.
2. **Uma pessoa responsável pelo cardápio por turno.** Sem dono, “atualização em um toque” vira cardápio desatualizado em um toque.
3. **Usar somente status operacionais combinados.** Sugestão no piloto: Novo → Confirmado → Em preparo → Pronto/Em rota → Concluído. Não é preciso explicar todos ao cliente.
4. **Não apresentar “em breve” como funcionalidade atual.** Caixas prontas, fidelidade, IA, WhatsApp e pagamento online pertencem ao roadmap.

## 3. Cenário completo e realista para a demonstração

### Cardápio do dia

| Sabor | Preço unitário | Situação |
| --- | ---: | --- |
| Brownie Tradicional | R$ 7,00 | Disponível; promoção: 4 unidades por R$ 6,00 cada |
| Brownie de Brigadeiro | R$ 8,00 | **Brownie do Dia**; promoção: 4 unidades por R$ 6,00 cada |
| Brownie de Ninho | R$ 8,00 | Disponível |
| Brownie de Doce de Leite | R$ 8,50 | Disponível |
| Brownie de Prestígio | R$ 8,50 | **Esgotado hoje** |
| Brownie de Oreo | R$ 8,50 | **Esgotado hoje** |

**Promoções ativas:** 4 Tradicionais por R$ 24,00; 4 Brigadeiros por R$ 24,00.  
**Coerência temporal:** os pedidos simulados com Prestígio foram feitos antes de o lote acabar; no momento da apresentação, Prestígio e Oreo já estão esgotados. Não invente essa condição se ela não tiver sido configurada na instância de demo.

### Pedidos simulados do dia

Todos os pedidos abaixo são fictícios e devem ser identificados como simulação. A receita é bruta estimada, sem considerar custo de ingredientes, taxa de entrega ou cancelamentos.

| Horário | Código | Pedido | Recebimento | Status | Total |
| --- | --- | --- | --- | --- | ---: |
| 09:12 | BF-7A21 | 2 Tradicionais + 2 Brigadeiros | Retirada · PIX | Concluído | R$ 30,00 |
| 09:40 | BF-4C18 | 4 Tradicionais | Entrega · PIX | Concluído | R$ 24,00 |
| 10:05 | BF-9E32 | 4 Brigadeiros | Retirada · Dinheiro | Concluído | R$ 24,00 |
| 10:28 | BF-2D76 | 2 Ninho + 2 Prestígio | Entrega · PIX | Concluído | R$ 33,00 |
| 11:03 | BF-6B45 | 3 Doce de Leite | Retirada · PIX | Pronto | R$ 25,50 |
| 11:26 | BF-8F90 | 2 Tradicionais + 2 Ninho | Entrega · PIX | Pronto | R$ 30,00 |
| 11:55 | BF-1A63 | 4 Tradicionais + 2 Ninho | Retirada · PIX | Pronto | R$ 40,00 |
| 12:14 | BF-3E29 | 1 Brigadeiro + 1 Doce de Leite + 2 Prestígio | Entrega · A combinar | Pronto | R$ 33,00 |
| 12:42 | BF-5C84 | 3 Brigadeiros | Retirada · PIX | Confirmado | R$ 24,00 |
| 13:10 | BF-7D11 | 4 Tradicionais | Entrega · PIX | Confirmado | R$ 24,00 |
| 13:38 | BF-9A57 | 2 Ninho + 2 Doce de Leite | Retirada · Dinheiro | Novo | R$ 33,00 |
| 14:02 | BF-2F35 | 1 Tradicional + 1 Brigadeiro + 1 Ninho | Entrega · PIX | Novo | R$ 23,00 |
| 14:24 | BF-4B68 | 2 Prestígio + 2 Doce de Leite | Retirada · PIX | Novo | R$ 34,00 |
| 14:51 | BF-6E03 | 4 Brigadeiros | Entrega · PIX | **Em preparo** | R$ 24,00 |
| 15:08 | BF-8C72 | 2 Tradicionais + 2 Prestígio | Retirada · PIX | **Em preparo** | R$ 31,00 |

Para cumprir a visualização de **3 pedidos em preparo**, use BF-9A57 temporariamente como “Em preparo” na tela Produção; ele deixa de contar como “Novo”. Dessa forma: **15 pedidos, 3 em preparo, 4 concluídos, 4 prontos, 2 confirmados e 2 novos**. Há **59 brownies** no total.

**Receita bruta estimada:** **R$ 432,50**  
**Ticket médio estimado:** **R$ 28,83**  
**Pedidos concluídos:** 4 | **Fila ativa:** 11

### Como preparar o cenário sem induzir erro

- Informe no início que se trata de um dia simulado, com dados criados para percorrer a operação.
- Use nomes fictícios e telefones de teste; não use dados pessoais reais.
- Antes da reunião, ajuste os pedidos e status no painel de uma instância de demonstração, não na operação real.
- Se os pedidos não puderem ser pré-carregados na instância, faça uma demonstração com dois pedidos de teste ao vivo e use a tabela acima como ilustração operacional. Não simule dados como se fossem vendas reais.

## 4. Fluxo operacional proposto

```text
Abrir o dia → conferir produção e sabores → atualizar disponibilidade/Brownie do Dia
       ↓
Cliente vê cardápio → escolhe → carrinho calcula promoção → envia pedido
       ↓
Equipe confere pedido → confirma → muda status → produz → entrega/retirada → conclui
       ↓
Encerrar o dia → revisar pedidos, receita bruta, esgotados e ajustes para amanhã
```

**Responsabilidade mínima:** quem abre a produção atualiza sabores; quem acompanha pedidos muda status; o proprietário revisa preços/promoções e os indicadores uma vez por semana.

## 5. Roteiro da demonstração — máximo de 10 minutos

| Tempo | Mostrar | Falar | Evitar |
| ---: | --- | --- | --- |
| 0:00–1:00 | Contexto, sem abrir telas ainda | “Hoje o cliente pergunta sabor, preço e disponibilidade; a equipe responde, coleta dados e depois transforma conversa em pedido. A proposta é deixar a escolha organizada antes de a equipe entrar.” | Dizer que WhatsApp será substituído ou prometer economia garantida. |
| 1:00–2:00 | Home em celular | “Aqui a marca apresenta o produto e conduz direto ao cardápio. O objetivo é dar vontade e reduzir a primeira pergunta.” | Discutir cores, código ou detalhes de design. |
| 2:00–3:15 | Cardápio | Mostrar 6 sabores, Brownie do Dia, 1 esgotado e as duas promoções. “O cliente vê a verdade operacional antes de pedir.” | Navegar por todos os sabores. |
| 3:15–4:30 | Produto e carrinho | Adicionar 4 Brigadeiros e mostrar promoção aplicada. “O total e a regra aparecem antes da confirmação.” | Criar pedido longo ou testar campos em excesso. |
| 4:30–5:45 | Checkout e confirmação | Mostrar os campos e a confirmação com código. “A equipe recebe modalidade, pagamento e observação junto com os itens.” | Chamar isto de pagamento online ou rastreio. |
| 5:45–7:00 | Painel: visão Hoje e Pedidos | Mostrar 15 pedidos simulados, receita estimada e filtro/busca. Abrir um pedido em preparo. | Tratar receita estimada como caixa conciliado. |
| 7:00–8:15 | Produção | Mostrar os 3 pedidos em cartões. “A bancada não precisa procurar conversa; vê o que preparar e como entregar.” | Demonstrar todos os status. |
| 8:15–9:00 | Sabores e promoções | Marcar Oreo como esgotado/disponível e mudar Brownie do Dia. “Uma alteração operacional aparece para quem está comprando.” | Alterar preço real ou excluir produto ao vivo. |
| 9:00–10:00 | Próximo passo e visão futura | “O piloto mede adoção e eficiência primeiro. Depois, o canal pode ganhar automação, pagamento e relacionamento.” | Vender IA como capacidade atual ou decidir roadmap sem validar o piloto. |

**Frase de encerramento recomendada:** “A pergunta para o piloto não é se a tela está bonita; é se em quatro semanas ela reduz pedidos incompletos, evita venda de sabor esgotado e permite à equipe gastar mais tempo produzindo e menos tempo coletando dados.”

## 6. Objeções prováveis e respostas honestas

| Objeção | Resposta recomendada |
| --- | --- |
| “Já uso WhatsApp.” | “O WhatsApp pode continuar como canal de relacionamento. O sistema organiza a escolha e registra o pedido antes da conversa, para reduzir perguntas repetidas e informações perdidas.” |
| “Não tenho tempo para mexer nisso.” | “A rotina proposta é curta: conferir sabores ao abrir, mudar status enquanto produz e revisar uma vez por semana. O piloto deve provar se esse tempo é menor que o atendimento manual que substitui.” |
| “É caro.” | “O valor precisa ser comparado com tempo de atendimento, pedidos perdidos, erros e retrabalho. Antes de discutir escala, o piloto deve medir esses indicadores e mostrar se compensa.” |
| “Meus clientes não vão usar.” | “Nem todos usarão no primeiro dia. O teste é divulgar o link para uma parcela dos clientes e observar quantos concluem sozinhos. O atendimento tradicional continua como apoio.” |
| “Prefiro continuar como está.” | “Manter o processo atual é uma escolha válida. O ponto é verificar, com dados, se hoje há demora, pedidos incompletos ou vendas de itens esgotados que podem ser reduzidos.” |
| “Vou ter que cadastrar tudo toda hora?” | “Não. O cadastro inicial é feito uma vez; no dia a dia a ação principal é disponibilidade. Preços e promoções só mudam quando a operação decidir.” |
| “E se eu acabar um sabor?” | “A equipe marca como esgotado no painel. O cliente deixa de poder adicioná-lo, o que reduz a necessidade de pedir desculpas depois.” |
| “E se o cliente quiser falar comigo?” | “Ele continua podendo falar. O sistema não elimina atendimento humano; entrega uma base de pedido mais completa para a conversa.” |
| “Não sei usar sistema.” | “O treinamento deve ser feito no próprio celular, cobrindo só três tarefas: sabor disponível/esgotado, pedido/status e ajuste básico. Uma pessoa reserva também precisa aprender.” |
| “E se der erro no meio do pedido?” | “Não se deve prometer ausência de erros. Antes do piloto haverá checklist e testes. O canal manual continua como contingência e qualquer falha deve ser registrada para correção.” |
| “Não quero desconto demais.” | “Promoção é configuração comercial, não obrigação. Só deve ser ativada depois de confirmar margem e capacidade; no piloto, duas regras simples bastam.” |
| “Posso usar para entrega e retirada?” | “Sim, o pedido permite ambas as modalidades, desde que os dados operacionais, endereço e taxa sejam configurados corretamente.” |

## 7. Perguntas que o proprietário provavelmente fará — e respostas

1. **O que o cliente faz aqui?** Vê o cardápio atualizado, escolhe itens, confere o total e envia um pedido estruturado.
2. **O pedido chega onde?** No painel da equipe, na lista de pedidos e no modo Produção.
3. **Ainda preciso confirmar o pedido?** Sim. O sistema organiza o pedido; a confirmação humana continua importante para capacidade, pagamento e exceções.
4. **O cliente paga pelo sistema?** Não neste MVP. Ele informa a forma de pagamento; pagamento online é evolução futura.
5. **Isso envia WhatsApp automaticamente?** Não. A integração não está implementada e não deve ser apresentada como ativa.
6. **Posso aceitar retirada e entrega?** Sim, desde que essas opções estejam habilitadas e as informações reais estejam configuradas.
7. **Posso definir taxa de entrega?** Sim, há ajuste de taxa; confirme a política de entrega antes de divulgar.
8. **Posso alterar preço?** Sim, pelo painel. A decisão de preço continua sendo comercial, não do sistema.
9. **Posso criar promoção?** Sim, por quantidade mínima e preço promocional.
10. **Como evitar desconto que tira minha margem?** Validando custo e margem antes de ativar a promoção; use regras simples e revise semanalmente.
11. **Posso marcar sabor esgotado?** Sim, pelo painel de Sabores.
12. **Quanto tempo leva para aparecer para o cliente?** A proposta do painel é refletir a alteração imediatamente; isso deve ser testado no ambiente de uso antes da abertura.
13. **Dá para mudar o Brownie do Dia?** Sim, no painel de Sabores.
14. **Posso colocar foto de cada sabor?** O painel permite enviar foto; a apresentação pública deve ser validada com fotos oficiais antes da divulgação.
15. **As fotos atuais são reais?** Não. O MVP declara que são demonstrativas. Fotos reais são requisito comercial antes do lançamento.
16. **O que acontece se o cliente pedir um sabor que acabou?** Se o painel estiver atualizado, ele não consegue adicionar. Se acabar entre pedido e produção, a equipe precisa contatar o cliente e registrar o aprendizado.
17. **Vejo os pedidos antigos?** Sim, eles ficam na lista de pedidos da instância atual.
18. **Consigo procurar um pedido?** Sim, a lista permite buscar por código, nome ou telefone.
19. **O que significam os status?** Eles mostram onde o pedido está: novo, confirmado, em preparo, pronto/em rota, concluído ou cancelado.
20. **O cliente acompanha status?** O MVP tem código público de pedido, mas não deve ser vendido como rastreio ativo; a comunicação de status precisa ser definida no piloto.
21. **Funciona no celular?** Foi desenhado com prioridade para celular e possui verificação visual em tamanhos móveis e desktop; a validação deve incluir os aparelhos reais da equipe.
22. **Quantas pessoas podem usar?** O MVP tem acesso administrativo por código, não perfis individuais. Para operação pequena, defina responsáveis; controle por usuário é evolução futura.
23. **Meus dados estão seguros?** Há código de acesso e validações básicas. Para operação comercial, o armazenamento demonstrativo e a gestão de acesso precisam evoluir antes de tratar dados em escala.
24. **E se eu perder o código da equipe?** O responsável técnico/administrador pode redefinir a variável de acesso; o código não deve ser compartilhado com clientes.
25. **Posso vender outros produtos?** O painel permite cadastrar produtos, mas o piloto deve começar com brownies para não aumentar complexidade operacional.
26. **Tem relatório de vendas?** Há visão diária de pedidos, receita estimada e ticket médio. Analytics de conversão e relatórios históricos completos são próximos passos.
27. **A receita do painel é lucro?** Não. É receita bruta estimada dos pedidos não cancelados; custo, taxa, desconto e conciliação devem ser avaliados separadamente.
28. **O sistema substitui atendente?** Não. Ele reduz coleta repetitiva e organiza a fila; confirmação, exceções e relacionamento continuam humanos.
29. **Quanto tempo para colocar no ar?** Um piloto bem preparado cabe em quatro semanas, dependendo principalmente de fotos, dados comerciais e disponibilidade da equipe.
30. **Como saber se valeu a pena?** Medindo tempo de resposta, pedidos completos, taxa de conclusão, sabores atualizados, ticket e problemas operacionais antes/depois do piloto.
31. **O que acontece se a internet cair?** O fluxo online depende de conexão. Mantenha o atendimento manual como contingência e atualize o painel assim que voltar.
32. **Podemos testar sem divulgar para todos?** Sim. Comece com link no Instagram, QR code no balcão ou clientes recorrentes e amplie após uma semana de estabilidade.

## 8. Plano simples de implantação — quatro semanas

| Semana | Entregas | Responsável principal | Apoio / critério de saída |
| --- | --- | --- | --- |
| 1. Configuração | Confirmar sabores, preços, promoções, retirada/entrega, taxa, endereço, horário, mensagem e responsáveis | Proprietário | Consultor de implantação organiza checklist; só publicar dados confirmados. |
| 2. Fotos e conteúdo | Fotografar os 6 sabores, selecionar imagens, revisar descrições, ingredientes e alergênicos | Proprietário/produção | Fotógrafo ou pessoa designada; nenhuma imagem demonstrativa deve ir para lançamento comercial. |
| 3. Treinamento | Simular abertura, esgotado, pedido, produção, status e contingência; treinar titular e reserva | Consultor + líder de operação | Cada pessoa executa os 3 fluxos sem ajuda. |
| 4. Operação-piloto | Divulgar para audiência limitada, acompanhar diariamente, registrar dúvidas/erros, revisar métricas | Líder de operação | Reunião de 30 min no fim da semana decide ampliar, ajustar ou pausar. |

### Rotina operacional recomendada

- **Abertura (5–10 min):** conferir estoque de cada sabor, marcar indisponíveis, definir Brownie do Dia e confirmar entrega/retirada.
- **Durante o dia (30–60 s por mudança):** atualizar status e marcar esgotado assim que a produção sinalizar.
- **Fechamento (10 min):** concluir/cancelar pedidos, verificar receita estimada, listar dúvidas e verificar o sabor que mais causou ruptura.
- **Semanal (30 min):** proprietário revisa preço, margem das promoções, ticket médio e problemas recorrentes.

## 9. Métricas de sucesso e como usar

| Indicador | Definição | Sinal de avanço | Atenção |
| --- | --- | --- | --- |
| Tempo médio de primeira resposta | Tempo entre pedido recebido e confirmação humana | Queda sem aumento de erros | Medir manualmente no piloto; o MVP não cronometra isso sozinho. |
| Pedidos recebidos | Pedidos criados no sistema | Crescimento após divulgação controlada | Separar pedidos de teste. |
| Pedidos concluídos | Pedidos com status Concluído / recebidos | Processo está chegando ao fim | Não confundir concluído com pagamento conciliado. |
| Taxa de conclusão | Concluídos / pedidos recebidos | Identifica adesão e qualidade operacional | Cancelamentos devem ter motivo registrado fora do MVP. |
| Ticket médio | Receita bruta estimada / pedidos não cancelados | Avalia efeito de combos/promoções | Cruzar com margem, não só faturamento. |
| Uso de promoções | Pedidos que atingiram a regra / pedidos | Mostra aceitação de caixa maior | Desconto pode aumentar volume e reduzir margem. |
| Tempo para alterar disponibilidade | Sinal da produção até sabor marcado esgotado | Meta operacional: menos de 2 min | Depende de disciplina, não só da tela. |
| Sabores atualizados | Itens corretos no painel / itens conferidos | Meta: 100% nas auditorias diárias | Auditar 2x/dia no início. |
| Conversão cardápio → pedido | Pedidos / visitantes de cardápio | Avalia clareza e desejo | Requer analytics futuro ou contagem externa. |
| Abandono de carrinho | Carrinhos sem pedido / carrinhos criados | Aponta fricção/preço | Não é medido no MVP atual. |
| Pedidos com retrabalho | Pedidos que exigiram correção / recebidos | Deve cair ao longo do piloto | Registrar em planilha simples de incidentes. |

**Linha de base:** antes da divulgação, medir uma semana do processo atual (atendimentos repetidos, pedidos incompletos, tempo de confirmação, erros). Sem linha de base, a percepção de ganho será opinativa.

## 10. Checklist de demo e de liberação do piloto

### Conteúdo e operação

- [ ] Logo oficial aparece corretamente.
- [ ] Fotos oficiais estão prontas; imagens demonstrativas não serão usadas como se fossem reais.
- [ ] Nome, telefone, WhatsApp, endereço, horário, retirada, entrega e taxa foram confirmados.
- [ ] Os 6 sabores, preços, ingredientes e alergênicos foram validados pela produção.
- [ ] Brownie do Dia está definido e corresponde ao que será produzido.
- [ ] Promoções têm margem aprovada e comunicação simples.
- [ ] Sabores esgotados refletem o estoque real.
- [ ] Cenário de 15 pedidos está identificado como simulado e usa dados fictícios.
- [ ] Há 3 pedidos em preparo e 4 concluídos para a tela de produção.
- [ ] Responsável titular e reserva pelo painel estão definidos.
- [ ] Plano de contingência para internet/atendimento manual está combinado.

### Jornada a validar antes da apresentação

- [ ] Home, cardápio, detalhe, carrinho, checkout e confirmação abrem sem erro.
- [ ] Um pedido de teste pode ser criado com retirada.
- [ ] Um pedido de teste pode ser criado com entrega e endereço.
- [ ] Total e promoções são conferidos com a tabela comercial aprovada.
- [ ] Pedido aparece no painel; status pode ser atualizado.
- [ ] Sabor pode ser marcado como esgotado e deixa de poder ser adicionado.
- [ ] Brownie do Dia pode ser alterado.
- [ ] Tela Produção mostra itens, modalidade e observação de forma legível.
- [ ] Responsividade foi verificada em 360/390 px e em um computador.
- [ ] Não há texto técnico, dados falsos sem rótulo, imagem quebrada ou placeholder exposto ao proprietário.

### Qualidade técnica mínima

- [ ] `npm test` executado com sucesso.
- [ ] `npm run lint` executado com sucesso.
- [ ] `npm run build` executado com sucesso.
- [ ] Verificação visual executada com o servidor em funcionamento.
- [ ] Console do navegador sem erros durante o roteiro.
- [ ] Código administrativo demonstrativo trocado antes de qualquer ambiente compartilhado.

## 11. Riscos e oportunidades que precisam ser tratados com transparência

### Riscos atuais

1. **Fotos ainda demonstrativas.** Para uma confeitaria, imagem é parte central da decisão. É o maior risco de percepção comercial no lançamento.
2. **Informações comerciais vazias por padrão.** Endereço, horário e contatos precisam estar confirmados antes de divulgar o link.
3. **Métricas de funil não são capturadas automaticamente.** Conversão e abandono precisarão de instrumentação futura ou acompanhamento externo no piloto.
4. **Dados são de demonstração em arquivo JSON.** Adequado para MVP/piloto controlado; antes de escalar, é necessário revisar persistência, backup, acesso e privacidade.
5. **Adoção depende de disciplina operacional.** O sistema não corrige estoque se a equipe não marcar o sabor esgotado no momento certo.
6. ~~Status "saiu para entrega" exige teste específico.~~ **Corrigido.** A inconsistência de grafia entre a lista do painel e a validação do servidor foi eliminada com uma fonte única de verdade (`src/lib/orderStatuses.ts`); o status pode ser usado normalmente na demo.
7. **Promoções por produto podem ser difíceis de explicar.** Se a intenção for caixas mistas, a regra atual deve ser validada: ela é aplicada por sabor, não por total de brownies variados.

### Oportunidades de maior impacto, sem ampliar o escopo agora

- Fazer sessão curta de fotos reais de corte/recheio para cada sabor.
- Definir rotina de estoque e dono do painel antes de divulgar.
- Usar QR code no balcão e link na bio para testar aquisição com baixo risco.
- Registrar por uma semana, em planilha simples, motivo de cada cancelamento e dúvida recorrente.
- Validar margem e mensagem de apenas duas promoções, preferencialmente fáceis de entender.

## 12. Roadmap de visão futura — não incluído neste MVP

| Fase | Evolução | Valor esperado | Condição para priorizar |
| --- | --- | --- | --- |
| Fase 2 | Assistente no WhatsApp conectado ao cardápio real | Responder dúvidas e encaminhar pedido sem informação inventada | Piloto prova que catálogo e operação estão atualizados. |
| Fase 3 | Pagamento online | Menos atrito na confirmação e conciliação mais clara | Volume e método de pagamento justificam integração. |
| Fase 4 | Programa de fidelidade | Estimular recompra | Base de pedidos e consentimento bem definidos. |
| Fase 5 | CRM e pós-venda | Segmentar clientes e fazer relacionamento relevante | Privacidade, processo e cadência comercial definidos. |
| Fase 6 | Analytics de funil e demanda | Decidir preço, produção e campanhas com dados | Eventos confiáveis e volume suficiente de pedidos. |

**Princípio do roadmap:** crescer junto com a operação, sem colocar automação em cima de um cardápio ou processo que ainda não são consistentes.

## 13. Avaliação executiva e recomendações finais

| Critério | Nota atual | Justificativa | Melhoria de maior impacto para elevar a nota |
| --- | ---: | --- | --- |
| Valor percebido | **7,0/10** | Resolve dores concretas de atendimento e produção, mas ainda depende de prova na rotina. | Fotos reais + piloto com linha de base e resultados de pedidos completos/tempo poupado. |
| Facilidade de implantação | **7,5/10** | O escopo é enxuto, porém dados, fotos e disciplina precisam ser preparados. | Checklist de dados confirmado e treinamento de duas pessoas em fluxos reais. |
| Facilidade de uso | **8,0/10** | Jornada móvel e tarefas operacionais estão diretas. | Teste presencial com proprietário/atendente e ajuste de linguagem/status a partir das dúvidas reais. |
| Potencial comercial | **7,5/10** | Dor comum em negócios de alimentação; proposta é fácil de entender. | Evidência de um piloto: redução de retrabalho, pedidos concluídos e aceitação do link. |
| Escalabilidade | **5,5/10** | A visão é escalável, mas persistência demonstrativa, acesso único e analytics limitam expansão. | Antes de múltiplas operações, evoluir armazenamento, permissões, auditoria e métricas. |
| Potencial de se tornar case de sucesso | **7,0/10** | Pode gerar caso forte se a Brownieria adotar rotina e medir resultados honestamente. | Caso de 4–8 semanas com fotos reais, baseline, métricas e depoimento somente após evidência. |

### Recomendação de decisão

Avançar para um **piloto controlado de quatro semanas**, e não para uma promessa de transformação imediata. A condição de início é simples: informações comerciais reais, fotos reais, duas promoções com margem aprovada e duas pessoas treinadas. A condição de expansão é evidência: pedido completo, disponibilidade atualizada, menos retrabalho e aceitação do canal pelos clientes.

O MVP já oferece uma narrativa comercial coerente: **o cliente escolhe com clareza; a equipe produz com contexto; o proprietário mantém o controle sem virar refém do atendimento repetitivo.** O que falta para torná-lo convincente não é mais funcionalidade: é operação real, conteúdo real e medição honesta.
