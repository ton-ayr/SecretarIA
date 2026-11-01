# SecretárIA — Operação

Como publicar, ligar as integrações e cadastrar empresas.
Para rodar na sua máquina, veja o [README](../README.md#como-rodar). Como o
sistema funciona está em [`ARQUITETURA.md`](ARQUITETURA.md).

## 1. Publicar na Cloudflare

Tudo sai do `.dev.vars`, que fica fora do git. Copie o `.dev.vars.example`,
preencha o que as integrações abaixo pedem e rode:

```bash
npm run secrets -- gerar              # cria as chaves aleatórias que faltam
npm run secrets -- conferir           # mostra o que falta, sem exibir valores

npx wrangler login
npx wrangler d1 create secretaria     # basta o nome: se oferecer gravar o ID na configuração, responda não
npm run db:migrate:remote
npm run secrets -- enviar             # segredos do bot
npm run deploy:bot                    # sempre antes do painel
npm run deploy:admin
npm run secrets -- enviar-admin       # e-mails que podem entrar no painel
```

`WORKERSAI_ACCOUNT_ID`, `PUBLIC_BASE_URL`, `ACCESS_TEAM_DOMAIN` e `ACCESS_AUD`
identificam a conta: `npm run deploy:*` os leva junto, sem passar pelo git.

Nas atualizações, rode `npm run db:migrate:remote` (se houver migration nova),
`npm run deploy:bot` e `npm run deploy:admin`, nessa ordem.

## 2. Integrações

Depois de mudar um segredo no `.dev.vars`, envie de novo com
`npm run secrets -- enviar`.

### IA

1. **Groq:** crie a chave em `console.groq.com` e preencha `GROQ_API_KEY`.
   Ative o *Zero Data Retention* em Data Controls.
2. **Workers AI (reserva):** crie um token de API da Cloudflare com acesso ao
   Workers AI e preencha `WORKERSAI_API_KEY` e `WORKERSAI_ACCOUNT_ID`.

### WhatsApp (Meta)

1. Crie o portfólio empresarial e inicie a verificação da empresa, que pode
   levar dias.
2. Crie um app de desenvolvedor com o produto WhatsApp e copie a chave secreta
   para `META_APP_SECRET`.
3. Crie um *System User* com token permanente e preencha `META_ACCESS_TOKEN`.
   Esse token fica só no `.dev.vars`: ele vai cifrado para o banco.
4. Grave a conta pelo painel (Contas Meta) ou com
   `npm run meta -- conta --waba <WABA_ID> --remote`.
5. Cadastre o webhook, pelo painel da Meta ou pela Graph API
   ([ARQUITETURA §16](ARQUITETURA.md#16-integrações-externas)):
   - URL: `https://secretaria-bot.<seu-subdominio>.workers.dev/webhook`
   - token de verificação: o valor de `META_VERIFY_TOKEN`
   - campo: `messages`
   - assine o app na conta: `POST /{waba-id}/subscribed_apps`
6. Ligue o número à empresa na aba **WhatsApp** do painel. No número de teste
   da Meta, cadastre antes os números de destino.

### Telegram

1. Crie o bot no **@BotFather**, preencha `TELEGRAM_BOT_TOKEN` e envie os
   segredos.
2. Aponte o webhook do bot para o Worker:
   `npm run telegram -- configurar --url https://secretaria-bot.<seu-subdominio>.workers.dev`
3. Receba os alertas do operador: rode `npm run telegram -- operador --remote`
   e abra o link no seu Telegram.
4. Vincule a equipe de cada empresa na aba **Equipe** do painel. Cada pessoa
   abre o próprio link, de uso único, válido por 24 horas.

### Painel (Cloudflare Access)

1. Ative o Zero Trust na conta Cloudflare. O cadastro pede uma forma de
   pagamento.
2. Depois do primeiro deploy do painel, abra a aba **Access** do Worker
   `secretaria-admin` → "Protect this Worker behind Access" → todo o tráfego.
   Na política, use "Manage access" › regra "Emails": a opção "Email domain"
   espera um domínio, não um e-mail.
3. Preencha `ACCESS_TEAM_DOMAIN` (ex.: `minha-equipe.cloudflareaccess.com`) e
   `ACCESS_AUD` (a tag AUD da aplicação) e rode `npm run deploy:admin`. Com
   `ACCESS_AUD` vazio, o log `admin_access_config_missing` mostra a tag.
4. Preencha `ADMIN_EMAILS` e rode `npm run secrets -- enviar-admin`. Vazio,
   ninguém entra.

### Google Agenda (opcional)

1. No Google Cloud, crie um projeto, ative a Google Calendar API, crie uma
   conta de serviço e baixe a chave JSON.
2. Rode `npm run google -- chave <arquivo.json>`, envie os segredos e guarde o
   arquivo fora da pasta do projeto.
3. Compartilhe a agenda com o e-mail da conta de serviço, com a permissão
   "Fazer alterações nos eventos".
4. Conecte na aba **Agenda** do painel, que só liga se conseguir ler e escrever.

### Lembretes pelo WhatsApp (opcional)

1. Ligue por empresa, na aba **Dados** do painel.
2. Para enviar fora da janela de 24 horas, crie na Meta o template
   `lembrete_agendamento` (pt_BR, com botões de resposta rápida Confirmar,
   Remarcar e Cancelar) e preencha `REMINDER_TEMPLATE` no `wrangler.jsonc`. O
   corpo é o de `reminderTemplate`, em `src/core/reminders.ts`:

   ```
   Olá, {{1}}! Lembrete do seu horário em {{2}}: {{3}}, {{4}}. Podemos confirmar?
   ```

## 3. Cadastrar uma empresa

No painel, **+ Nova empresa** cria a empresa, o atendente e um número
simulador. A **Visão geral** guia os 7 passos: atendente, serviços,
profissionais, horários, teste no chat, número do WhatsApp e equipe no
Telegram. Empresa de saúde: escolha o segmento "Saúde" para ligar as regras
extras de proteção.

## 4. Pedidos de exclusão (LGPD)

Use o botão **Apagar dados do contato** na conversa, no painel, que apaga na
hora. Pelo terminal, o pedido é atendido em até 1 hora:

```bash
npm run lgpd:apagar -- --empresa <id> --telefone <55DDDNUM> --remote
```