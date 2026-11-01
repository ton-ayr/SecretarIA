# Licenças de terceiros

O SecretárIA é distribuído sob a licença em [`LICENSE.md`](LICENSE.md). Estes
componentes de terceiros têm licença própria.

## Copiado neste repositório

| Componente | Arquivo | Licença |
|---|---|---|
| [htmx](https://htmx.org) 2.0.11 | `src/admin/public/htmx.min.js` | Zero-Clause BSD |

## Incluído nos Workers publicados

| Componente | Licença |
|---|---|
| [Hono](https://hono.dev) | MIT |

## Só para desenvolvimento

As ferramentas de desenvolvimento (Wrangler, Vitest, TypeScript, tsx e o que
elas instalam) não fazem parte do código publicado. A maioria é MIT, Apache-2.0,
ISC ou BSD. Algumas instalam binários opcionais sob LGPL-3.0 (libvips, pelo
`sharp`) e MPL-2.0 (`lightningcss`), que não são modificados nem distribuídos
por este projeto.

A lista completa, com versões, está em `package-lock.json`. Dependências novas
passam pela lista de licenças permitidas no CI.
