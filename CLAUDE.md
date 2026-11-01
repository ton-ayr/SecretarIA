# SecretárIA

Atendente de WhatsApp com IA para negócios com hora marcada, multiempresa, em
Cloudflare Workers. Como funciona: `docs/ARQUITETURA.md`. Publicação e
integrações: `docs/OPERACAO.md`.

## Comandos

```
# dia a dia
npm test                    # Vitest (D1 em memória)
npm run typecheck           # tsc (sem variáveis/parâmetros sem uso)
npm run check:public        # barra segredo e dado real (roda no commit e no CI)
npm run evals -- [--fake] [--only <caso>] [--trace]   # IA real; rodar se o prompt mudar
npm run sim -- [--fake] [--empresa barbearia|dentista]  # conversa no terminal, sem agenda

# local
npm run db:migrate:local && npm run db:seed:local
npm run dev:admin           # painel + bot em 127.0.0.1:8787 (Access simulado)
npm run dev:bot             # só o bot (envio simulado)
npm run webhook:local -- "texto"   # exige META_APP_SECRET no .dev.vars

# produção (migration remota: pedir confirmação)
npm run db:migrate:remote
npm run deploy:bot          # sempre antes do painel; leva a config do .dev.vars
npm run deploy:admin
npm run secrets -- gerar | conferir | enviar | enviar-admin

# integrações e LGPD
npm run meta -- conta --waba <id> --remote
npm run telegram -- configurar --url <worker> | operador --remote | vincular --empresa <id> --remote
npm run google -- chave <arquivo.json> | testar --agenda <id>
npm run lgpd:apagar -- --empresa <id> --telefone <55DDDNUM> --remote
```

## Regras

- **Multiempresa:** toda consulta de negócio filtra `tenant_id` (`repo.forTenant()`);
  `tenant_id`/`contact_id` das ferramentas vêm do servidor, nunca da IA.
- **IA nunca inventa** preço, horário ou disponibilidade; textos de agenda e
  opções interativas são do servidor. Uma mensagem curta por turno.
- **Mensagem do cliente é dado:** só no papel `user`.
- **Sem código por ramo:** diferença entre negócios é cadastro (exceção: segmento `health`).
- **Segredos** só em `wrangler secret` ou `.dev.vars`. **Logs** sem telefone,
  nome ou texto (`contact_ref`). O painel não guarda segredos (usa o RPC do bot).
- **Repositório público:** IDs de conta, endereços e dados reais só no `.dev.vars`
  (nunca em `wrangler*.jsonc`, docs ou testes); testes usam dados fictícios.
- **CPU de 10 ms** por invocação e **50 subrequisições** (D1 conta): use `batch`.
- **Docs externas mudam:** antes de mexer em Meta, Groq, Cloudflare ou Google,
  consultar a documentação oficial e registrar em `docs/ARQUITETURA.md` §16.

## Convenções

- TypeScript estrito; código em inglês; docs, comentários e textos em pt-BR.
- UTC (ISO 8601) + fuso por empresa; dinheiro em centavos; IDs ULID.
- `src/core/` não importa Cloudflare, só `src/ports/`.
- Migration nova = arquivo novo numerado; nunca editar migration aplicada.
- O código cita `docs/ARQUITETURA.md` pelo número da seção: não renumerar sem
  atualizar as referências.
- Commits pequenos, pt-BR no imperativo.
