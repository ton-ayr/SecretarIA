# SecretárIA — Arquitetura

Como o sistema funciona e por quê. Publicação e integrações ficam em
[`OPERACAO.md`](OPERACAO.md). Os comentários do código citam estas seções pelo
número (§3, §8, §16…): ao reorganizar, atualize as referências.

## 1. Visão geral

```
                 ┌──────────────────────────────── Cloudflare ────────────────────────────────┐
 Cliente final   │                                                                            │
 (WhatsApp) ─────┼──► Meta Cloud API ──webhook──► Worker "bot" (Hono, público)                │
     ▲           │                                   │  valida assinatura, acha a empresa     │
     │           │                                   ▼                                        │
     │           │                          Durable Object "Conversation"                     │
     │           │                          (1 por número + contato)                          │
     │           │                          fila curta, agrupamento, limite por hora          │
     │           │                                   │                                        │
     │           │              ┌────────────────────┼──────────────────────┐                 │
     │           │              ▼                    ▼                      ▼                 │
     │           │        Motor de conversa      D1 (SQLite)         Notificador              │
     │           │        (código puro)          dados de todas      (Telegram, 2 vias)       │
     │           │              │                as empresas               ▲ │               │
     │           │              ▼                    ▲                      │ ▼               │
     │           │        LLMProvider ──► Groq ──► Workers AI (reserva)   Dono do negócio     │
     │           │        Transcriber ──► Groq Whisper ──► Workers AI                         │
     │           │                                   │                                        │
     └───────────┼──── Cloud API (envio) ◄───────────┘                                        │
                 │                                                                            │
                 │  Cron Triggers ──► lembretes/Google (15 min), manutenção (1 h), LGPD (dia) │
                 │                                                                            │
 Operador ───────┼──► Cloudflare Access ──► Worker "admin" (Hono JSX + htmx) ──► D1           │
                 │                              └─ RPC (service binding) ──► bot: AdminRpc    │
                 └────────────────────────────────────────────────────────────────────────────┘
```

**Por que dois Workers:** no domínio `workers.dev`, o Cloudflare Access protege
o endereço inteiro de um Worker, não um caminho. O webhook precisa ser público
(a Meta precisa alcançá-lo) e o painel precisa ser fechado, então cada um fica
num Worker. Os dois usam o mesmo banco D1 e o mesmo código compartilhado. Com
domínio próprio, daria para juntá-los e usar o Access por caminho.

## 2. Componentes

| Componente | Papel | Observações |
|---|---|---|
| `src/core/` | Motor de conversa: monta o prompt, controla o contexto, executa ferramentas e aplica as regras de passagem para humano e de agendamento | Não depende da Cloudflare: é testado em Node puro e usado pelo simulador |
| `src/ports/` | Interfaces: `LLMProvider`, `Transcriber`, `WhatsAppSender`, `HandoffNotifier`, `ExternalCalendar`, `Repo`, `Clock`, `Logger` | O motor só conhece essas interfaces |
| `src/adapters/` | Implementações reais: OpenAI-compatível (Groq e Workers AI), cadeia de reserva, Meta Cloud API, Telegram, Google Agenda, repositório D1 | Cada integração externa fica isolada aqui |
| `src/bot/` | Worker público: webhooks, Durable Objects `Conversation` e `TestChat`, crons, RPC do painel (`AdminRpc`) | |
| `src/admin/` | Worker do painel (HTML no servidor, sem build de front-end) | Ver §2.1 |
| `src/shared/` | Criptografia, assinatura, logs, datas e fuso, dinheiro, telefone, IDs | |
| `migrations/` | SQL do D1, numerado e versionado | `wrangler d1 migrations` |
| `scripts/` | Simulador de terminal, segredos, deploy, Meta, Telegram, Google, LGPD e checagem do repositório público | |
| `evals/` | Conversas de avaliação e o executor | Regras determinísticas, sem IA como juiz |

### 2.1 Painel

- **Worker `secretaria-admin`** (`wrangler.admin.jsonc`, `src/admin/`): HTML
  no servidor com Hono JSX e CSS próprio (claro e escuro, funciona no
  celular). htmx copiado no repositório (sem CDN), usado no chat de teste e no
  botão "Testar" da agenda.
- **Telas:** início com números do mês e lista de empresas; por empresa, menu
  lateral em três grupos: Configuração (visão geral, dados, atendente,
  serviços, profissionais, horários, folgas, agenda), Canais (WhatsApp, equipe
  no Telegram) e Operação (testar atendente, conversas, medidor); contas Meta.
- **Fluxo de cadastro:** "Nova empresa" cria a empresa, o **número simulador**
  (`phone_numbers.kind = 'test'`, `meta_phone_number_id = sim-<id>`), o
  atendente e as regras padrão. A visão geral mostra 7 passos obrigatórios
  (atendente, serviços, profissionais, horários, teste, número do WhatsApp,
  equipe) e 2 opcionais (agenda Google, lembretes); a lista de empresas usa a
  mesma contagem. "Testado" vem do medidor (não volta a pendente depois do
  "Limpar teste").
- **Sem segredos de integração.** Lê e grava o D1 pelo `D1AdminRepo` (escopo
  por empresa, com o mesmo teste de `tenant_id`). O que precisa de segredo
  (token da Meta, chave do Google, Telegram, IA) passa pelo bot, por **RPC**
  num service binding (`BOT` → named entrypoint `AdminRpc`, sem endereço
  público): chat de teste, "Limpar teste", reativar bot, apagar contato,
  gravar token da Meta (cifrado no bot), listar números da conta Meta, testar
  a agenda Google, @ do bot do Telegram.
- **Atendente da empresa:** um por empresa (o primeiro criado); vale para
  todos os números dela. O carregamento do turno prefere o atendente do
  próprio número, se houver, e confere que o número é da empresa.
- **Chat de teste:** `TestChatDO` (Durable Object do bot) roda o mesmo motor
  pelo número simulador, contato `teste` ("Cliente Teste"): nada sai pelo
  WhatsApp, a agenda Google é só lida e a equipe "é avisada" de mentira.
  Horários marcados ocupam a agenda até "Limpar teste".
- **Número do WhatsApp:** o painel lista os números da conta Meta pela Graph
  API e confere que o escolhido é da conta antes de gravar.
- **Texto para pessoas:** o toque numa opção é gravado como "título (ref)"
  para a IA; painel e Telegram mostram só o título (`stripReplyRef`).

## 3. Caminho de uma mensagem

1. **Meta → `POST /webhook`** no Worker bot.
2. **Valida `X-Hub-Signature-256`.** Calcula o HMAC-SHA256 do corpo *bruto*
   com o App Secret e compara em tempo constante. Assinatura inválida: responde
   401 e grava um log sem dados pessoais.
3. **Interpreta o corpo.** Eventos de *status* (enviado, entregue, lido, falhou)
   só atualizam o medidor. Eventos de *mensagem* seguem para o próximo passo.
4. **Identifica a empresa** pelo `phone_number_id`, em `phone_numbers` (cache
   de 1 minuto em memória, só para número encontrado). Número desconhecido:
   ignora e grava log.
5. **Entrega ao Durable Object** com chave `phone_number_id:wa_id`. O Worker
   espera essa entrega terminar, o que leva poucos milissegundos, e **só então
   responde 200**. Se a entrega falhar, responde 500 e a própria Meta reenvia.
   Assim nenhuma mensagem se perde, sem depender do `waitUntil`.
6. **Dentro do Durable Object, ao receber (`enqueue`):**
   - **Idempotência:** grava o ID da mensagem com
     `INSERT OR IGNORE INTO seen` no SQLite do próprio objeto. Se o ID já
     existia, é reentrega, e a mensagem é descartada. O objeto processa uma
     coisa por vez, então não há condição de corrida.
   - **Limite por contato:** padrão de 30 mensagens por hora. Ao passar do
     limite, o bot avisa uma vez e ignora as mensagens até a hora virar.
   - **Agrupamento:** guarda a mensagem no `inbox` e agenda um alarme para
     daqui a 5 s. Cada nova mensagem empurra o alarme, até no máximo 20 s
     contados da primeira.
   - **Lida e "digitando…":** se a conversa não está pausada nem acima do
     limite, marca a mensagem como lida e liga o indicador de digitação, numa
     única chamada à Cloud API. O indicador some quando o bot responde ou após
     25 s. A Meta pede que ele só seja usado quando haverá resposta.
7. **No alarme do Durable Object (`alarm`), processa o turno:**
   1. Pega as mensagens pendentes. Se uma execução anterior caiu no meio do
      envio (turno em `sending`), não reenvia: é melhor não duplicar mensagem
      ao cliente.
   2. **Áudio vira texto:** baixa a mídia da Meta, lê a duração do próprio
      arquivo OGG (sem decodificar) e recusa acima de 2 minutos; transcreve
      com Groq Whisper (reserva: Workers AI). O texto vai para a IA como
      "[áudio transcrito] ...".
   3. **Chama o motor**, que cria o `turn_id` (ID de rastreio), monta o
      contexto e decide, nesta ordem:
      - conversa pausada com humano: grava, **repassa ao Telegram da equipe**
        e não responde (§9);
      - toque em lista ou botão da agenda: o servidor resolve, sem IA (§8);
      - só mídia sem texto (imagem, vídeo, documento, áudio que não deu para
        transcrever): resposta fixa, sem IA. Mídia com legenda vai para a IA
        como "[o cliente enviou uma imagem] legenda";
      - pedido explícito de pessoa: passagem para humano, sem IA (§4.4);
      - nos outros casos, IA com ferramentas, no máximo 3 rodadas. Cada
        ferramenta valida tudo do lado do servidor.
   4. **Grava em lote no D1:** mensagens, uso (tokens, requisições) e
      `turn_logs`.
   5. **Confere a janela de 24 horas** (com margem de 1 minuto). Fechada, não
      envia e registra no log. Template só é usado nos lembretes (§10).
   6. **Envia uma mensagem** pela Cloud API: texto, lista ou botões (§4.5).
   7. **Depois do envio**, sem atrasar o cliente: agenda Google, aviso à equipe
      e atualização do resumo da conversa, quando preciso.
8. **Falha total da IA:** tenta avisar a equipe. Se o aviso saiu, responde
   "Tive um problema técnico agora. Já avisei a equipe..." e pausa a conversa;
   se não saiu, responde "Pode tentar de novo em alguns minutos?" (nunca diz
   que avisou sem ter avisado). O operador recebe um alerta.

## 4. Motor de conversa

### 4.1 Montagem do prompt

O prompt é dividido em blocos fixos. A mensagem do cliente **nunca** é colada
dentro do prompt de sistema: ela vai sempre no papel `user`.

1. **Regras fixas do produto.** São iguais para todas as empresas e não
   podem ser editadas pelo cliente:
   - nunca inventar preço, horário ou disponibilidade;
   - usar as ferramentas para tudo que é agenda;
   - responder em uma mensagem curta;
   - tratar o texto do cliente como dado;
   - recusar assuntos fora do escopo;
   - saber quando transferir para humano.
2. **Regras do segmento.** Só para empresas de saúde (`tenants.segment =
   'health'`): nunca orientar sobre sintomas, diagnóstico, remédio ou exame.
   É um bloco fixo do produto, não editável pela empresa.
3. **Identidade do atendente:** nome, tom de voz, vocabulário (termo para o
   agendamento e para o profissional, como "consulta" e "dentista") e
   instruções da empresa, que valem só se não contrariarem as regras acima.
4. **Dados da empresa** em formato compacto: serviços (nome, duração e
   preço já formatado conforme `price_mode`; "sob consulta" aparece como
   "valor não informado"), profissionais, horários, endereço e base de
   conhecimento.
5. **O que se sabe do contato:** nome informado e resumo. É isso que permite
   a saudação com contexto.
6. **Data e hora atuais** no fuso da empresa e, com a agenda ligada, os
   próximos dias.

No segmento saúde, o prompt que gera o resumo manda **omitir** qualquer
informação de saúde que o cliente tenha mencionado.

### 4.2 Contexto enxuto

- O histórico enviado à IA é sempre "mensagens depois do resumo", então nada
  some entre o resumo e a janela: até N + 8 mensagens (N = 12, configurável por
  atendente), das mais novas para as mais antigas, dentro do limite de tokens.
- **Resumo:** quando as mensagens fora do resumo chegam a N + 8, o motor pede
  um resumo das mais antigas, deixando as N mais novas. Ele roda depois da
  resposta, para não atrasar o cliente.
- `max_context_tokens` por atendente, padrão 2.500, vale para **histórico +
  mensagens novas**. O prompt de sistema tem tamanho limitado pelo cadastro. Os
  tokens são estimados por caracteres (3,5 por token): **não** há tokenizador
  no Worker, pesado demais para o limite de 10 ms de CPU.
- Se passar do limite, cortam-se primeiro as mensagens mais antigas.
- O nome do perfil do WhatsApp é escolhido pelo cliente: entra no prompt
  só depois de higienizado (letras, espaços e pontuação de nome, até 40
  caracteres).
- A base de conhecimento tem limite de 4.000 caracteres no cadastro.

### 4.3 Ferramentas (chamadas de função)

| Ferramenta | O que faz |
|---|---|
| `transfer_to_human(motivo, resumo)` | Pausa a conversa e avisa a equipe. Com a agenda ligada, o motivo `agendamento` sai da lista |
| `check_availability(servico, data, profissional?, hora?, nome_cliente?)` | O servidor manda ao cliente até 6 horários livres (perto da hora, se veio) |
| `book(ref? \| servico, data, hora, profissional?, nome_cliente?)` | Marca; o servidor confere de novo se está livre e confirma ao cliente. Sem nome conhecido (nem do perfil), devolve `nome_necessario` para a IA perguntar |
| `save_customer_name(nome)` | Guarda o nome que o cliente disse ou corrigiu em `contacts.display_name`, quando nenhuma outra ferramenta vai levá-lo em `nome_cliente` |
| `list_my_appointments()` | O servidor mostra os horários futuros do contato, com código |
| `reschedule(codigo, ref? \| data, hora, profissional?)` | Remarca numa operação atômica (mantém o profissional se não vier outro) |
| `cancel(codigo)` | Cancela |

Serviço e profissional vão por nome (o servidor resolve, aceitando o título
"Barbeiro Zé"); data, com as palavras do cliente (§8). Em caso de sucesso, as
ferramentas da agenda devolvem a resposta final ao cliente, e o turno termina
ali. Em erro (serviço ambíguo, nome faltando), devolvem o motivo à IA, que
pergunta ao cliente.

`tenant_id` e `contact_id` **vêm do contexto do servidor e nunca dos
argumentos da IA.** Uma ferramenta só enxerga dados da empresa e do contato
do turno atual. Os nomes das ferramentas ficam em inglês, como o resto do
código, e as descrições enviadas à IA ficam em português.

### 4.4 Passagem para humano: dois gatilhos

- **A IA decide**, chamando `transfer_to_human`. Cobre pedido do cliente,
  falta de informação e assunto sensível.
- **Rede de segurança determinística:** expressões como "falar com
  atendente", "falar com humano" ou "pessoa de verdade" disparam a
  transferência **antes** de chamar a IA (sem gastar tokens).
- A resposta ao cliente é sempre **texto fixo do servidor**, e só diz que a
  equipe foi avisada se o aviso saiu de verdade para pelo menos um canal.
  Quando a IA chama a ferramenta, o turno termina ali (não há segunda
  chamada à IA). Motivos: `pedido_do_cliente`, `nao_sei_responder`,
  `assunto_sensivel` e `agendamento`.
- **Agenda desligada** (`PUBLIC_BASE_URL` vazio): as ferramentas de agenda não
  existem, e pedido para marcar, remarcar ou cancelar vai para a equipe
  (motivo `agendamento`), com o texto "Passei seu pedido para a equipe, que vai
  combinar o horário com você".
- Empresa **sem Telegram vinculado**: a ferramenta nem é oferecida à IA; o
  pedido de pessoa recebe "No momento não consigo chamar a equipe por aqui"
  e o operador recebe um alerta.

### 4.5 Formato da resposta: texto, lista ou botões

O motor devolve `Reply = { text, options?, listButton?, buttons? }`. A IA
escreve só o `text` das respostas de conversa. Lista e botões são sempre do
servidor:

- **Ferramentas de agenda devolvem a resposta pronta** (horários,
  confirmação, remarcação, cancelamento) e o turno termina ali, sem nova
  chamada à IA (§8). A lista de horários traz o preço do serviço no texto.
- **Lista interativa:** até 6 linhas (limite da Meta: 10), título até 24
  caracteres ("qua 14/10 · 10:00"), descrição até 72 ("com Barbeiro Zé"),
  `id` = referência do horário (`slot|serviço|profissional|início`).
- **Botões:** até 3, título até 20 (ex.: "📅 Salvar na agenda").
- **Toque:** chega com `replyId`; os da agenda são resolvidos pelo servidor,
  sem IA (§8). A mensagem fica gravada como "título (replyId)" para a IA ver a
  referência nos turnos seguintes; pessoas veem só o título.
- O texto continua valendo: o cliente pode digitar "pode ser às 16h".
- Se lista ou botões falharem na validação dos limites, sai só o texto.
  Continua sendo uma mensagem por turno.

## 5. IA: provedores e resiliência

- **`LLMProvider`** é uma interface única:
  `chat({ messages, tools, maxOutputTokens, timeoutMs })` devolve
  `{ content, toolCalls, usage, provider, model, attempts }`.
- **Adaptador OpenAI-compatível:** serve para a Groq e para o Workers AI. Só
  mudam a URL, a chave e o modelo.
- **Cadeia de reserva**, configurada no `wrangler.jsonc` (entrada sem chave é
  ignorada):
  ```
  LLM_CHAIN = "groq:openai/gpt-oss-120b,groq:openai/gpt-oss-20b,workersai:@cf/openai/gpt-oss-120b"
  STT_CHAIN = "groq:whisper-large-v3-turbo,workersai:@cf/openai/whisper-large-v3-turbo"
  ```
- **Dois modelos da Groq antes do Workers AI:** na Groq, a cota é separada por
  modelo. Trocar de modelo dentro dela dobra a capacidade antes de cair num
  modelo mais lento.
- **Regras de tentativa:**
  - Timeout de 20 s por tentativa e orçamento de 45 s por chamada à cadeia.
  - Erro 5xx, timeout ou falha de rede: até 2 novas tentativas, com espera de
    1 s e depois 3 s, mais uma pequena variação aleatória.
  - Erro **429** (cota estourada): pula **direto** para o próximo provedor e
    marca aquele como "esgotado" (pelo `retry-after` ou por 5 minutos).
  - Erro 4xx diferente de 429: não tenta de novo, porque é erro do nosso
    lado. Passa ao próximo provedor.
- Todo provedor usado fica registrado em `turn_logs` e no medidor.

## 6. Modelo de dados (D1)

Convenções: IDs em texto (ULID), datas em **UTC** (ISO 8601), dinheiro em
**centavos** (inteiro), fuso por empresa. **Toda tabela de negócio tem
`tenant_id`.** As colunas estão em [`migrations/`](../migrations); aqui fica o
que não é óbvio lendo o SQL.

| Tabela | Para quê | Observações |
|---|---|---|
| `tenants` | Empresas | `segment` (`general` ou `health`), fuso, retenção, lembretes e agenda Google |
| `meta_accounts` | Contas Meta do operador | Token cifrado (`access_token_enc`, `key_version`) |
| `phone_numbers` | Números de cada empresa | `meta_phone_number_id` é o ID do webhook; nas outras tabelas, `phone_number_id` aponta para `phone_numbers.id`. `kind`: `whatsapp` ou `test` (simulador) |
| `agents` | Atendente | O primeiro da empresa vale para todos os números dela (§2.1) |
| `professionals`, `services`, `professional_services` | Catálogo | `price_mode`: `fixed`, `from` ou `on_request`; `buffer_min`: intervalo depois do serviço; `google_calendar_id`: agenda própria do profissional |
| `business_hours`, `time_off` | Horários e folgas | `professional_id` nulo = vale para a casa |
| `scheduling_rules` | Regras da agenda | Sem linha, valem os padrões (§8) |
| `contacts` | Clientes | Único por empresa + `wa_id`; `display_name` é o nome que o cliente informou |
| `conversations` | Conversas | Única por número + contato; `status` (`bot` ou `human`), `paused_until`, `summary`, `summarized_until` |
| `messages` | Mensagens | `wa_message_id` único; status da Meta (`delivered_at`, `failed_code`, `billed_category`) |
| `appointments` | Agendamentos | `block_ends_at`: fim + intervalo (o que ocupa a agenda); `code`: 6 caracteres, único por empresa; `calendar_token`: chave do link "Salvar na agenda"; `calendar_sync`: estado no Google |
| `handoffs` | Passagens para humano | Sem texto de conversa |
| `notification_channels` | Canais da equipe | `target_enc`: chat cifrado (AES-GCM); `target_ref`: HMAC do chat para busca |
| `telegram_relays` | Mensagem do Telegram ↔ conversa | Chave: `chat_ref` + `tg_message_id` |
| `erasure_requests` | Pedidos de exclusão | Vêm do terminal e são atendidos pelo cron |
| `ops_settings` | Dados do operador | Sem `tenant_id`: chat cifrado dos alertas, link de vínculo, controle de repetição |
| `usage_monthly` | Medidor | Por número e mês. O status reentregue pela Meta não conta duas vezes: só soma quando a coluna da mensagem muda (NULL → valor) |
| `turn_logs` | Rastreio de turnos | Sem texto e sem telefone |
| `llm_daily_usage` | Uso diário da IA | Sem `tenant_id`: a cota é da conta |

**Estado dentro do Durable Object** (SQLite do próprio objeto, temporário):
`inbox` (mensagens esperando o agrupamento, com `media_id` e `mime` do áudio e
`reply_id` da opção tocada), `seen` (IDs já recebidos, por 7 dias), `rate`
(contador por hora) e `state` (rota, envio em andamento e `paused_until`).
Objetos antigos ganham as colunas novas sozinhos (`PRAGMA table_info` +
`ALTER TABLE`).

## 7. Isolamento entre empresas

- **Repositório com escopo:** `repo.forTenant(tenantId)` devolve um objeto em
  que toda consulta já inclui `WHERE tenant_id = ?`. Sem empresa, só os pontos
  de entrada (número da Meta, link da agenda, mensagens do Telegram) e as
  tabelas do operador.
- **Teste automático** que percorre o SQL do repositório (bot e painel) e
  falha se alguma consulta a tabela de negócio não tiver `tenant_id`. As
  únicas consultas que cruzam empresas são listadas e testadas: entrada do
  bot, cron (lembretes, agenda, pedidos de exclusão), monitoramento (só
  leitura) e a visão do operador no painel (só leitura).
- **Teste de vazamento:** com duas empresas no banco, nenhuma ferramenta ou
  consulta da empresa A retorna dado da B.
- As ferramentas recebem `tenant_id` só do contexto do servidor (§4.3).

## 8. Agendamento

**Quem faz o quê.** A IA só escolhe a ferramenta e passa os argumentos.
Todo texto de agenda que o cliente lê (horários, confirmação, remarcação,
cancelamento, link) é montado pelo servidor e encerra o turno, sem nova
chamada à IA. Código em `src/core/scheduling.ts`.

**Toques** (lista ou botão) chegam com `replyId` e são resolvidos sem IA:

| replyId | O que faz |
|---|---|
| `slot\|serviço\|profissional\|início` | marca (confere de novo se está livre); sem nome do cliente, vai para a IA perguntar |
| `day\|serviço\|profissional\|AAAA-MM-DD` | mostra os horários do dia |
| `cal\|CÓDIGO` | manda o link "Salvar na agenda" |
| `rem\|CÓDIGO` | pede lembrete (só com lembretes ligados) |
| `confirm\|CÓDIGO` / `cancel\|CÓDIGO` / `skip\|CÓDIGO` | confirma / cancela / encerra |
| `resched\|CÓDIGO` | vai para a IA, que pergunta o novo dia |

Um código de outro cliente não é encontrado: a busca filtra por `contact_id`.
Toda referência é revalidada: serviço e profissional precisam ser da empresa e
o horário precisa estar livre na hora de marcar.

**Datas.** A IA manda o dia com as palavras do cliente ("amanhã", "quarta",
"próxima quarta", "dia 15", "15/10") e o servidor converte, no fuso da
empresa. Nos evals, a IA errou o dia da semana quando fazia a conta sozinha.
O prompt traz "Próximos dias" só para ela citar datas certas.

**Disponibilidade** para um serviço numa data, calculada no fuso da empresa:

1. Parte do horário de funcionamento do profissional (ou da casa, se ele não
   tiver horário próprio).
2. Tira folgas e bloqueios (`time_off`).
3. Tira agendamentos com status `booked` ou `confirmed`, incluindo o intervalo
   depois de cada um.
4. Tira os ocupados da agenda Google, se conectada.
5. Nos intervalos que sobram, gera horários a cada `slot_step_min` onde cabem a
   duração do serviço e o intervalo depois dele (`buffer_min`).
6. Aplica a antecedência mínima e o limite de dias à frente.
7. Devolve até `max_options` opções: espalhadas ao longo do dia ou, se o
   cliente disse uma hora, as mais próximas dela ("Às 10:00 não tenho vaga."
   quando a hora pedida não está livre). Sem vaga no dia, oferece em botões
   os próximos 3 dias com horário.

Padrões por empresa (`scheduling_rules`): passo de 15 minutos, antecedência de
60 minutos, 30 dias à frente e 6 opções.

Com "sem preferência", o servidor escolhe o primeiro profissional apto que
estiver livre.

**Sem marcação dupla:** a inserção é condicional, numa única instrução SQL.
Se dois clientes tentarem o mesmo horário ao mesmo tempo, só um consegue.

```sql
INSERT INTO appointments (...)
SELECT ?, ?, ... WHERE NOT EXISTS (
  SELECT 1 FROM appointments
  WHERE tenant_id = ? AND professional_id = ?
    AND status IN ('booked','confirmed')
    AND starts_at < ?novo_fim_com_intervalo AND block_ends_at > ?novo_inicio)
```

A mesma instrução também confere `time_off`. Se `changes = 0`, o horário
acabou de ser ocupado e o cliente recebe "Esse horário não está disponível"
com as opções mais próximas. **Remarcar** = inserir o novo horário e cancelar
o antigo no mesmo `batch` do D1, que é uma transação: ou as duas coisas
acontecem, ou nenhuma.

**Agenda Google da empresa** (opcional; por empresa ou por profissional).
Conta de serviço do Google (JWT RS256 assinado com WebCrypto, escopo
`calendar.events`). O dono compartilha a agenda com o e-mail da conta de
serviço, com a permissão "Fazer alterações nos eventos".

- *Leitura:* `events.list` no período. Eventos "ocupado" bloqueiam horários;
  ficam de fora os marcados como "disponível", os cancelados e os criados
  pelo próprio sistema (`extendedProperties.private.secretaria = 1`). Se o
  Google falhar, a marcação segue só com o banco (fica no log).
- *Escrita:* depois de responder ao cliente, cria ou atualiza o evento com ID
  fixo (`sa` + hex do ID do agendamento; PUT e, se 404, POST) e apaga no
  cancelamento. Falha vira `calendar_sync = 'failed'` e o cron tenta de novo
  (até 5 vezes).

**Agenda do cliente ("Salvar na agenda").** Depois de marcar, o botão
"📅 Salvar na agenda" manda o link `PUBLIC_BASE_URL/a/<token>` (token
aleatório de 22 caracteres, ~130 bits, um por agendamento):

- Android: redireciona para o Google Agenda com o evento preenchido
  (`calendar.google.com/calendar/render?action=TEMPLATE`).
- iPhone: devolve um `.ics` (o Calendário oferece "Adicionar"), com
  alarmes 1 dia e 1 hora antes.
- Outros: página com as duas opções; `/a/<token>/ics` baixa o arquivo.
- Cabeçalhos `no-store`, `no-referrer`, `noindex` e CSP sem script.
  Cancelado responde 410; token inválido, 404 (sem consultar o banco).

**Aviso à equipe:** marcação, remarcação e cancelamento vão para o Telegram
da empresa (📅 / 🔁 / ❌), sem o botão "Devolver ao bot".

## 9. Passagem para humano

1. Envia o aviso pelo `HandoffNotifier` (Telegram) com nome, telefone, motivo,
   resumo curto e últimas mensagens, mais um botão **"Devolver ao bot"**. Grava
   em `telegram_relays` o ID da mensagem do Telegram ligado à conversa.
2. Se o aviso saiu para pelo menos um canal, grava `conversations.status =
   'human'` e `paused_until = agora + handoff_resume_hours` (12 horas, por
   padrão) e diz ao cliente que a equipe vai responder em breve. Se não saiu, o
   bot segue atendendo e responde que não consegue chamar a equipe (§4.4).
3. **Cliente → dono:** enquanto a conversa estiver pausada, cada turno do
   cliente é repassado ao Telegram, com o nome do cliente no cabeçalho, e
   também gera uma linha em `telegram_relays`. Mídia é só avisada ("o
   cliente enviou uma imagem").
4. **Dono → cliente:** o dono usa "responder" em qualquer uma dessas
   mensagens. O Telegram chama `POST /telegram/webhook`. O Worker:
   - confere o cabeçalho `X-Telegram-Bot-Api-Secret-Token`;
   - acha a conversa pela dupla (chat que respondeu, mensagem respondida)
     em `telegram_relays`: um chat de outra empresa nunca chega nela, porque
     os IDs de mensagem do Telegram são por chat;
   - confere se aquele chat continua vinculado à empresa da conversa;
   - entrega o texto ao Durable Object da conversa, que checa a janela de
     24h e envia pela Cloud API, pelo número do negócio;
   - grava a mensagem com `direction = 'out'`, `author = 'human'`, atualiza
     `last_human_msg_at` e estende `paused_until`;
   - confirma ao dono com 👍 na mensagem dele (sem mensagem extra);
   - se a janela de 24h estiver fechada, avisa no Telegram que não foi possível
     entregar.
   - Mensagem do dono sem "responder" recebe uma dica de como usar.
5. **Volta do bot:** o botão "Devolver ao bot" (callback do Telegram; a
   conversa vem da mensagem do botão, não do conteúdo do botão), o prazo
   `paused_until` ou o botão "Reativar o bot" na conversa, no painel. Ao voltar,
   a passagem em aberto ganha `resolved_at`.
6. Só conversas privadas com o bot; grupos do Telegram são ignorados.

Uma conversa com humano é processada pelo mesmo Durable Object, então a
resposta do dono e uma nova mensagem do cliente nunca disputam o mesmo turno.

**Como o dono liga o Telegram:** a aba Equipe do painel (ou `npm run
telegram -- vincular --empresa X --remote`) gera um link `t.me/<bot>?start=<código>`
de uso único, válido por 24 horas. O dono toca no link, o Telegram chama
`POST /telegram/webhook` (protegido pelo cabeçalho de segredo) e o chat fica
salvo, cifrado, para aquela empresa. Cada pessoa da equipe pode ter o seu
canal; todos recebem os avisos. O operador se vincula do mesmo jeito, com
`npm run telegram -- operador` (código `op_...`).

## 10. Lembretes e janela de 24 horas

- Só para empresas com `tenants.reminders_enabled = 1` (padrão 0) e para quem
  pediu no botão "🔔 Lembrete aqui", que só aparece nessas empresas. Se o
  horário está a menos de ~25 horas, o bot não promete lembrete.
- Cron a cada 15 minutos (`src/bot/scheduling-cron.ts`): agendamentos que
  começam entre 23h e 24h15 à frente, marcados há mais de 1 hora, ainda sem
  lembrete. Cada envio é reservado antes (`reminder_sent_at`), então duas
  rodadas não mandam em dobro.
- Janela de 24h aberta: mensagem com os botões **Confirmar**, **Remarcar** e
  **Cancelar**. Fechada: template `REMINDER_TEMPLATE`, com os mesmos botões como
  resposta rápida, **só se configurado**; vazio (padrão) = não envia.
- O toque chega como `interactive` (botão) ou `button` (template), com o
  `replyId`. Confirmar e cancelar não gastam IA; remarcar vai para a IA.
- Erro passageiro (limite, servidor, rede) libera a reserva para a próxima
  rodada; erro definitivo não repete.
- Até 8 lembretes e 3 novas tentativas do Google por rodada, por causa do
  limite de subrequisições (§15).

## 11. Segurança

- **Segredos** só em `wrangler secret`; localmente, em `.dev.vars`, fora do git:
  - `META_APP_SECRET` e `META_VERIFY_TOKEN`;
  - `ENCRYPTION_KEY` e `LOG_HASH_KEY`;
  - `GROQ_API_KEY` e `WORKERSAI_API_KEY`;
  - `TELEGRAM_BOT_TOKEN` e `TELEGRAM_WEBHOOK_SECRET`;
  - `GOOGLE_SERVICE_ACCOUNT`;
  - `ADMIN_EMAILS` (Worker do painel).
- **Token da Meta criptografado no D1** com AES-256-GCM (WebCrypto), IV
  aleatório por registro e `key_version` para permitir troca de chave. Ele fica
  em `META_ACCESS_TOKEN` só na máquina do operador e nunca é segredo do Worker.
- A mesma `ENCRYPTION_KEY` cifra os chats do Telegram e deriva (HKDF) a
  chave do HMAC `target_ref`/`chat_ref`. **Trocar a chave exige migrar**
  tokens e canais; nunca trocar sem esse passo.
- **Repositório público:**
  - IDs da conta (Cloudflare, Access) e endereços ficam fora do git: no
    `.dev.vars` e, em produção, como segredos do Worker (`npm run deploy:*`
    leva junto, na mesma versão). O banco é achado pelo nome, sem
    `database_id`.
  - `npm run check:public` barra tokens, arquivos de segredo, IDs na
    configuração e qualquer valor do `.dev.vars` ou de `PRIVATE_TERMS`. Roda a
    cada commit (`.githooks/`) e no CI, e nunca mostra o valor achado.
  - O CI não usa segredos do projeto nem faz deploy: ações fixadas por SHA e
    token só de leitura nos testes. gitleaks varre o histórico; CodeQL e
    Dependabot olham o código e as dependências.
  - Testes e documentos usam só dados fictícios.
- **Webhooks:** assinatura validada antes de qualquer outra coisa. O
  `GET /webhook` confere o `hub.verify_token`; o do Telegram, o cabeçalho de
  segredo.
- **Painel:**
  - O Cloudflare Access fica na frente do Worker inteiro (aba Access do
    Worker; login por código no e-mail).
  - O código **confere de novo** quem entrou: `ctx.access.getIdentity()`
    ou, como na prática ele vem vazio, o token `Cf-Access-Jwt-Assertion`
    (RS256 com as chaves da equipe, `iss` = `ACCESS_TEAM_DOMAIN`, `aud` =
    `ACCESS_AUD`, prazo). Sem token válido, ninguém entra.
  - O e-mail precisa estar em `ADMIN_EMAILS`. Vazio = ninguém entra. A tela de
    recusa diz o motivo a quem já passou pelo Access.
  - Todo POST confere o cabeçalho `Origin` (CSRF).
  - CSP sem script de fora nem `eval` (`allowEval: false` no htmx), sem
    iframe e sem cache; texto de cliente sempre escapado pelo JSX.
  - Nenhum segredo no painel: tokens e chaves ficam no bot (RPC).
  - Logs do painel sem e-mail nem telefone.
- **Injeção de prompt:**
  - O texto do cliente vai só no papel `user`.
  - As regras fixas mandam ignorar instruções vindas do cliente.
  - O mais importante: **toda ação passa por ferramenta validada no
    servidor.** Mesmo que a IA seja enganada, ela não consegue marcar fora
    do horário, ver outra empresa ou inventar preço numa ação.
- **Uso restrito ao negócio:** a política da Meta proíbe chatbots de IA de uso
  geral na API do WhatsApp (§16), então manter o bot só nos assuntos da empresa
  também é exigência de conformidade.
- **Limite por contato:** 30 mensagens por hora, controlado no Durable Object.

## 12. LGPD e retenção

A empresa cliente é a *controladora* dos dados e a SecretárIA é a *operadora*.
Suboperadores: Cloudflare, Groq, Meta, Telegram (que carrega o texto das
conversas passadas para humano) e Google, quando a agenda está conectada. O
contrato com cada empresa deve dizer isso e, em saúde, tratar de dado sensível.

| Dado | Retenção |
|---|---|
| Mensagens (texto e transcrições) | 7 dias (`message_retention_days`) |
| Áudio original | Não é armazenado; baixado, transcrito e descartado na hora |
| Resumo da conversa e do contato | 12 meses sem contato (`contact_retention_days`) |
| Agendamentos | 12 meses após a data |
| `telegram_relays` | Igual às mensagens (7 dias) |
| `turn_logs` (sem dado pessoal) | 30 dias |
| Workers Logs | 3 dias |

- **Limpeza:** um cron diário apaga o que venceu.
- **Apagar um contato** (`src/core/erasure.ts`): apaga os eventos dele na
  agenda Google da empresa, depois contato, conversas, mensagens,
  agendamentos, avisos, registros de turno e relays numa transação do D1, e
  por fim o estado do Durable Object (`storage.deleteAll()`, que também tira
  o alarme).
  - Botão "Apagar dados do contato" na conversa, no painel (na hora).
  - `npm run lgpd:apagar` registra um pedido (`erasure_requests`); o cron de
    manutenção (de hora em hora) executa.
  - O medidor guarda só números agregados, sem identificar a pessoa, e
    por isso não é apagado.
- **Estado do Durable Object:** sem mensagens há 8 dias (e sem pausa da
  equipe em andamento), o objeto apaga o próprio estado (rota com o
  telefone, IDs vistos, contador).
- **Logs:**
  - nunca telefone, nome nem texto de mensagem;
  - o contato aparece como `contact_ref`, um HMAC do `wa_id` com
    `LOG_HASH_KEY`. Dá para seguir a mesma pessoa nos logs sem saber quem é.
- O aviso no Telegram leva telefone e nome para o dono do negócio, que é o
  controlador dos dados.
- **Segmento saúde:** o resumo omite informação de saúde, o agendamento
  guarda só o serviço e o bot não pergunta sintomas. O texto que o cliente
  escrever por conta própria fica nas mensagens por 7 dias, como qualquer
  outra mensagem.

## 13. Observabilidade

Os logs são JSON estruturados, via `console.log`. Os campos fixos são:
`ts`, `level`, `event`, `turn_id`, `tenant_id`, `phone_number_id`,
`conversation_id`, `contact_ref`, `provider`, `model`, `latency_ms`, `error_code`.

Para reconstruir um turno:

- Workers Logs guarda os logs por até 3 dias.
- `turn_logs` no D1 guarda por 30 dias as etapas do turno (contexto, prompt
  com tokens estimados, chamadas à IA, ferramentas), com duração e resultado.

**Alertas ao operador** (Telegram, no máximo 1 por tipo por hora, sem dado de
cliente): cota da IA em 70%, IA falhando em todos os provedores, cliente
pedindo a equipe numa empresa sem Telegram vinculado, token da Meta recusado e
número acima do limite de mensagens cobradas no mês.

## 14. Medidor de uso

- `usage_monthly` é atualizada a cada turno com `UPSERT`.
- O status de entrega da Meta traz `pricing.billable` e a categoria: mensagens
  de serviço cobradas vão para `service_billed`; templates, para a coluna da
  categoria. Cada mensagem conta uma vez só.
- O custo estimado da IA e da transcrição usa a tabela de `src/core/pricing.ts`.
- O painel mostra, por número e mês: recebidas, respostas, entregues e falhas,
  cobradas pela Meta (com `META_PRICE_BRL_MILLI`) e IA (requisições, tokens,
  áudio e custo estimado).
- Quando um número passa de `META_BILLED_ALERT` (800) mensagens cobradas no
  mês, o operador recebe um alerta, uma vez por número por mês (cron de hora em
  hora).
- **Alerta de cota (70%):** cada chamada à IA soma requisições e tokens do dia
  em `llm_daily_usage`, por modelo. Os limites ficam em `LLM_DAILY_LIMITS`.
  Quando um deles passa de 70% e `alert_sent_at` está vazio, o operador recebe
  um aviso e o campo é preenchido: no máximo um por modelo por dia.
- Ao esgotar toda a cadeia de IA, vale a contingência do §3: pausa e aviso à
  equipe.

## 15. Limites que moldam o código

| Recurso | Limite | Consequência |
|---|---|---|
| CPU do Worker | 10 ms por invocação | Sem tokenizador nem hash de senha, JSON pequeno. O webhook usa de 3 a 9 ms. Se aparecer "Exceeded CPU" (erro 1102), separar o Durable Object num Worker próprio |
| CPU do Durable Object | 30 s por requisição ou alarme | O turno com IA roda aqui (de 8 a 20 ms medidos) |
| Subrequisições | 50 por invocação; consulta ao D1 conta | Consultas em `batch`. Por rodada de cron: 8 lembretes, 3 sincronizações do Google e 3 exclusões |
| Consultas ao D1 | 50 por invocação | Vale para cada instrução de um `batch` |
| Requisições ao Worker | 100 mil por dia | Cada mensagem gera ~4 chamadas (webhook + 3 status) |
| Cron Triggers | 5 por conta | 3 em uso: limpeza diária, manutenção de hora em hora e lembretes a cada 15 min |
| Variável ou segredo | 5 KB, 64 por Worker | A chave do Google guarda só e-mail e chave privada |
| Groq, por modelo `gpt-oss` | 30 req/min, 1 mil req/dia, 8 mil tokens/min, 200 mil tokens/dia | Ao bater o limite (429), a cadeia pula para o próximo |
| Groq Whisper | 2 mil req/dia, 28.800 s de áudio/dia | Reserva no Workers AI |
| Workers AI | 10 mil neurônios por dia | Ao passar, as chamadas falham |
| Google Calendar | 10 mil req/min por projeto, 600/min por usuário, 1 milhão/dia | Folga grande |
| Telegram | ~1 mensagem/s por chat, ~30/s no total | Acima disso, 429 |

## 16. Integrações externas

O que foi conferido na documentação oficial e em testes reais, e em que o
código se apoia. Essas documentações mudam: antes de mexer numa integração,
confira de novo e atualize a linha (com a data).

### Meta

| Assunto | O que vale | Verificado | Fonte |
|---|---|---|---|
| Webhook | Corpo em `entry[].changes[]` (`field: "messages"`), com `value.metadata.phone_number_id`, `contacts[]`, `messages[]` e `statuses[]`. Assinatura: `X-Hub-Signature-256: sha256=<HMAC-SHA256 do corpo com o App Secret>`. Verificação: `hub.mode=subscribe`, `hub.verify_token`, devolver `hub.challenge`. Falhas são reenviadas por até **36 horas** | 2026-10-03 | developers.facebook.com/docs/graph-api/webhooks/getting-started · /whatsapp/cloud-api/webhooks/components |
| Status de entrega | `sent`, `delivered`, `read`, `failed` (e `played`). `errors[].code` só no `failed`. `pricing` (`billable`, `category`, `type`) vem no `sent` e em um entre `delivered` e `read` | 2026-10-03 | developers.facebook.com/docs/whatsapp/cloud-api/webhooks/reference/messages/status |
| Cobrança | Desde 01/10/2026, toda mensagem que não é template é cobrada, por isso o medidor conta `service_billed` | 2026-10-03 | developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages |
| Envio de texto | `text.body` até 4.096 caracteres; a resposta traz `messages[0].id` (wamid). Os códigos de erro de `src/adapters/whatsapp-cloud.ts` ainda não foram confirmados na lista oficial | 2026-10-03 | developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages |
| Lida e digitando | `POST /<PHONE_NUMBER_ID>/messages` com `status: "read"`, `message_id` e `typing_indicator: {type: "text"}`. Some ao responder ou após 25 s. Usar só se houver resposta | 2026-10-02 | developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators |
| Lista interativa | Até 10 linhas no total; botão ≤ 20 caracteres, título ≤ 24, descrição ≤ 72 | 2026-10-02 | developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-list-messages |
| Botões de resposta | Até 3, título ≤ 20, corpo ≤ 1.024. A resposta chega como `interactive.button_reply` | 2026-10-02 | developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-reply-buttons-messages |
| Download de mídia | `GET /{media-id}` devolve `url`, `mime_type`, `file_size`; a URL vence em **5 minutos** e o download exige o mesmo token. Áudio até 16 MB. O webhook não informa a duração | 2026-10-03 | developers.facebook.com/docs/whatsapp/cloud-api/reference/media |
| Graph API | Versão v26.0, sem mudança para o WhatsApp em relação à v25.0 | 2026-10-03 | developers.facebook.com/docs/graph-api/changelog/version26.0 |
| Cadastro do webhook | Também sai pela Graph API: `POST /{app-id}/subscriptions` (`object=whatsapp_business_account`, `callback_url`, `verify_token`, `fields=messages`, token de app). E é preciso assinar o app na conta: `POST /{waba-id}/subscribed_apps` | 2026-10-03 | Teste real |
| Números da conta | `GET /<WABA_ID>/phone_numbers` lista `id`, `display_phone_number`, `verified_name`, `quality_rating` | 2026-10-04 | developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers |
| Política de IA | Desde 15/01/2026, provedores de IA de uso geral são proibidos; atendimento de um negócio é permitido. Fonte secundária: conferir nos termos oficiais | 2026-10-01 | Notícias (TechCrunch, 18/10/2025) |

### Groq

| Assunto | O que vale | Verificado | Fonte |
|---|---|---|---|
| Cabeçalhos de cota | `x-ratelimit-*-requests` medem requisições por dia; `*-tokens`, tokens por minuto. Não há cabeçalho de tokens por dia, por isso a contagem própria (`llm_daily_usage`). `retry-after` só vem no 429 | 2026-10-02 | console.groq.com/docs/rate-limits |
| Raciocínio do gpt-oss | `reasoning_effort` aceita `low`, `medium`, `high`; `include_reasoning: false` omite o texto. O teto `max_completion_tokens` fica em 1.024 por segurança | 2026-10-02 | console.groq.com/docs/reasoning |
| Dados | Não treina com dados da API. Pode guardar registros por até 30 dias para depuração ou abuso. **Zero Data Retention** pode ser ativado no console | 2026-10-01 | console.groq.com/docs/your-data |
| Transcrição | `POST /openai/v1/audio/transcriptions` (multipart). Formatos: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm. **Silêncio vira texto inventado** e `no_speech_prob` veio 0: o sinal usado é trecho terminando depois do fim do áudio | 2026-10-03 | console.groq.com/docs/speech-to-text e teste real |

### Cloudflare

| Assunto | O que vale | Verificado | Fonte |
|---|---|---|---|
| Durable Objects | No plano grátis, só com SQLite. Configuração pelo campo `exports` (`type: durable-object`, `storage: sqlite`), que substitui `migrations` | 2026-10-03 | developers.cloudflare.com/durable-objects/platform/limits · /reference/durable-objects-migrations |
| Alarmes | Um por objeto; `setAlarm` substitui o anterior; se `alarm()` lançar erro, até **6 novas tentativas** com espera exponencial a partir de 2 s | 2026-10-03 | developers.cloudflare.com/durable-objects/api/alarms |
| Apagar estado | `ctx.storage.deleteAll()` apaga SQL e chave-valor; com compatibilidade **2026-02-24 ou depois** também remove o alarme | 2026-10-04 | developers.cloudflare.com/durable-objects/api/sqlite-storage-api |
| D1 | `batch` é transação: se uma instrução falha, a sequência inteira é desfeita. Sem `database_id` na configuração, `wrangler deploy` conecta no banco de mesmo nome e os comandos `d1` acham o banco pelo nome. O ID só é gravado de volta se o Wrangler criar ou conectar o banco em modo interativo; o `check:public` barra esse caso | 2026-11-01 | developers.cloudflare.com/d1/worker-api/d1-database · github.com/cloudflare/workers-sdk |
| Workers AI | `POST /client/v4/accounts/{account_id}/ai/v1/chat/completions` é compatível com OpenAI. Transcrição em `/ai/run/@cf/openai/whisper-large-v3-turbo`, com `vad_filter: true`: sem ele, silêncio virou texto | 2026-10-03 | developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility · /workers-ai/models/whisper-large-v3-turbo |
| Access no Worker | Aba **Access** do Worker → "Protect this Worker behind Access". A documentação diz para ler `ctx.access`, mas ele **veio vazio** em produção: o painel valida o token na mão (`Cf-Access-Jwt-Assertion`, RS256, `/cdn-cgi/access/certs`, `iss`, `aud`, `exp`). As chaves trocam a cada 6 semanas. O `ctx.access` não passa por RPC | 2026-10-06 | developers.cloudflare.com/workers/configuration/cloudflare-access e teste real |
| Service bindings e RPC | Named entrypoint: `export class X extends WorkerEntrypoint`; quem chama declara `services: [{ binding, service, entrypoint }]`. Cada chamada conta como subrequisição | 2026-10-04 | developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings |
| Arquivos estáticos | `assets: { directory }` no wrangler; são servidos sem executar o Worker | 2026-10-04 | developers.cloudflare.com/workers/static-assets |
| Segredos | `wrangler secret bulk` aceita JSON pela entrada padrão. `wrangler deploy --secrets-file` envia segredos na mesma versão do deploy, soma aos existentes e evita o conflito de `secret bulk` com variável de mesmo nome já publicada | 2026-11-01 | `wrangler deploy --help` (4.156) |
| Ferramentas locais | Wrangler 4 traz Miniflare 5, com formato de configuração novo: testes, evals e simulador usam `getPlatformProxy` (API pública) em vez do Miniflare direto | 2026-10-02 | npm |
| Workers Logs | Retenção de 3 dias | 2026-10-01 | developers.cloudflare.com/workers/observability/logs/workers-logs |

### Telegram

| Assunto | O que vale | Verificado | Fonte |
|---|---|---|---|
| Bot API | `sendMessage`: 1 a 4.096 caracteres; HTML aceita só tags listadas e exige trocar `<`, `>` e `&` por entidades. `setWebhook`: `secret_token` enviado em `X-Telegram-Bot-Api-Secret-Token`. Deep link `t.me/<bot>?start=<param>` com até 64 caracteres, recebido como "/start param". Resposta do usuário traz `reply_to_message` | 2026-10-03 | core.telegram.org/bots/api · /bots/features · /bots/faq |

### Google

| Assunto | O que vale | Verificado | Fonte |
|---|---|---|---|
| Calendar API | ID de evento: base32hex (a-v, 0-9), 5 a 1.024 caracteres, único na agenda. `events.insert` aceita o escopo `calendar.events`; `extendedProperties.private` existe | 2026-10-03 | developers.google.com/workspace/calendar/api/guides/quota · /v3/reference/events/insert |
| Link "adicionar à agenda" | `calendar.google.com/calendar/render?action=TEMPLATE&text=&dates=&details=&location=&ctz=` não tem página de referência oficial: é o formato usado pelos botões "Add to Google Calendar" | 2026-10-03 | Uso comum, sem fonte oficial |

### Preços e repositório

| Assunto | O que vale | Verificado | Fonte |
|---|---|---|---|
| Preços do medidor | Os valores ficam em `src/core/pricing.ts` | 2026-10-03 | console.groq.com/docs/models · developers.cloudflare.com/workers-ai/models |
| Ações do GitHub | `gitleaks-action` v3: chave de licença só para organização. `dependency-review-action`: usar `allow-licenses`, porque `deny-licenses` está obsoleta | 2026-11-01 | github.com/gitleaks/gitleaks-action · github.com/actions/dependency-review-action |
| Licença | `LICENSE.md` é o texto oficial `FSL-1.1-MIT.template.md`, só com ano e titular preenchidos | 2026-11-01 | github.com/getsentry/fsl.software |
