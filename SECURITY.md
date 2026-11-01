# Segurança

## Como relatar uma falha

Não abra uma issue pública. Use o relato privado do GitHub: aba **Security** →
**Report a vulnerability**.

Inclua o que for possível: o que acontece, como reproduzir e qual o impacto.
A resposta inicial vem em até 7 dias.

## O que está no escopo

- Vazamento de dados entre empresas.
- Acesso ao painel sem autorização.
- Webhooks aceitos sem assinatura válida.
- Exposição de dados de clientes ou de tokens.
- Ações que a IA consiga executar fora das regras do servidor.

Só a versão mais recente do `main` recebe correções.

## O que não testar

Não teste contra sistemas em produção, números de WhatsApp ou contas de
terceiros. Rode o projeto na sua máquina (veja o [README](README.md)).
