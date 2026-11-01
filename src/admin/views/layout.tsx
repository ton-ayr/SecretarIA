import type { Context } from 'hono';
import { html } from 'hono/html';
import type { Child, FC, PropsWithChildren } from 'hono/jsx';
import type { FormValues } from '../forms.ts';

// Layout e componentes de formulário do painel. Todo texto do usuário passa
// pelo escape automático do JSX (nada de HTML cru com dado de fora).

export interface PageProps {
  title: string;
  email: string;
  tenant?: { id: string; name: string } | undefined;
  tab?: TenantTab | undefined;
  flash?: Flash | null | undefined;
  /** Frase curta sob o título. */
  intro?: string | undefined;
  /** Item ativo do menu do topo. */
  nav?: 'tenants' | 'meta' | undefined;
}

export interface Flash {
  kind: 'ok' | 'error';
  text: string;
}

/** Mensagens curtas depois de salvar (?ok=codigo). */
export const FLASH: Record<string, string> = {
  saved: 'Salvo.',
  created: 'Empresa criada. Siga os passos abaixo para deixar o atendente pronto.',
  removed: 'Removido.',
  resumed: 'Bot reativado nesta conversa.',
  erased: 'Dados do contato apagados.',
  'test-cleared': 'Teste limpo: a conversa e os horários marcados no teste foram apagados.',
  'token-saved': 'Token gravado (cifrado). Ele não aparece mais aqui.',
  'phone-added': 'Número ligado à empresa.',
};

export function flashFrom(query: string | undefined): Flash | null {
  const text = query ? FLASH[query] : undefined;
  return text ? { kind: 'ok', text } : null;
}

export type TenantTab =
  | 'overview'
  | 'settings'
  | 'agent'
  | 'services'
  | 'professionals'
  | 'hours'
  | 'timeoff'
  | 'calendar'
  | 'whatsapp'
  | 'team'
  | 'conversations'
  | 'usage'
  | 'test';

/** Menu da empresa, agrupado na ordem do cadastro. */
const NAV: Array<[string, Array<[TenantTab, string, string]>]> = [
  [
    'Configuração',
    [
      ['overview', 'Visão geral', ''],
      ['settings', 'Dados', '/dados'],
      ['agent', 'Atendente', '/atendente'],
      ['services', 'Serviços', '/servicos'],
      ['professionals', 'Profissionais', '/profissionais'],
      ['hours', 'Horários', '/horarios'],
      ['timeoff', 'Folgas', '/folgas'],
      ['calendar', 'Agenda', '/agenda'],
    ],
  ],
  [
    'Canais',
    [
      ['whatsapp', 'WhatsApp', '/whatsapp'],
      ['team', 'Equipe (Telegram)', '/equipe'],
    ],
  ],
  [
    'Operação',
    [
      ['test', 'Testar atendente', '/testar'],
      ['conversations', 'Conversas', '/conversas'],
      ['usage', 'Medidor', '/medidor'],
    ],
  ],
];

const TopBar: FC<{ email: string; nav: 'tenants' | 'meta' }> = ({ email, nav }) => (
  <header class="topbar">
    <div class="topbar-inner">
      <a class="brand" href="/">
        <span class="logo" aria-hidden="true">
          S
        </span>
        <span>
          SecretárIA <span class="brand-sub">· Painel</span>
        </span>
      </a>
      <nav class="mainnav" aria-label="Principal">
        <a href="/" aria-current={nav === 'tenants' ? 'page' : undefined}>
          Empresas
        </a>
        <a href="/meta" aria-current={nav === 'meta' ? 'page' : undefined}>
          Contas Meta
        </a>
      </nav>
      <span class="who" title={email}>
        {email}
      </span>
    </div>
  </header>
);

const FlashBox: FC<{ flash?: Flash | null | undefined }> = ({ flash }) =>
  flash ? (
    <div class={flash.kind === 'error' ? 'flash error' : 'flash'} role={flash.kind === 'error' ? 'alert' : 'status'}>
      {flash.text}
    </div>
  ) : null;

export const Layout: FC<PropsWithChildren<PageProps>> = (p) => (
  <html lang="pt-BR">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <meta name="htmx-config" content='{"allowEval":false,"includeIndicatorStyles":false,"selfRequestsOnly":true}' />
      <title>{`${p.tenant ? `${p.tenant.name} · ` : ''}${p.title} · SecretárIA`}</title>
      <link rel="stylesheet" href="/app.css" />
      <script src="/htmx.min.js" defer></script>
    </head>
    <body>
      <TopBar email={p.email} nav={p.nav ?? 'tenants'} />
      {p.tenant ? (
        <div class="page">
          <div class="tenant-layout">
            <aside class="sidenav">
              <p class="tenant-name">{p.tenant.name}</p>
              <p class="tenant-meta">Empresa</p>
              <nav aria-label="Seções da empresa">
                {NAV.map(([group, items]) => (
                  <div class="navgroup">
                    <p class="navgroup-title">{group}</p>
                    {items.map(([tab, label, path]) => (
                      <a href={`/empresas/${p.tenant!.id}${path}`} aria-current={tab === p.tab ? 'page' : undefined}>
                        {label}
                      </a>
                    ))}
                  </div>
                ))}
              </nav>
            </aside>
            <main>
              <div class="page-head">
                <div>
                  <div class="crumbs">
                    <a href="/">Empresas</a> / {p.tenant.name}
                  </div>
                  <h1>{p.title}</h1>
                  {p.intro ? <p class="muted">{p.intro}</p> : null}
                </div>
              </div>
              <FlashBox flash={p.flash} />
              {p.children}
            </main>
          </div>
        </div>
      ) : (
        <main class="page narrow">
          <FlashBox flash={p.flash} />
          {p.children}
        </main>
      )}
    </body>
  </html>
);

/** Cabeçalho das páginas fora de uma empresa. */
export const PageHead: FC<PropsWithChildren<{ title: string; intro?: string | undefined }>> = (p) => (
  <div class="page-head">
    <div>
      <h1>{p.title}</h1>
      {p.intro ? <p class="muted">{p.intro}</p> : null}
    </div>
    {p.children ? <div class="actions">{p.children}</div> : null}
  </div>
);

/** Responde a página com doctype. */
export function render(c: Context, node: Child, status: 200 | 400 | 403 | 404 | 409 | 422 | 500 = 200) {
  return c.html(html`<!doctype html>${node}`, status);
}

// ---------------------------------------------------------------- formulários

export interface FieldProps {
  name: string;
  label: string;
  values: FormValues;
  errors?: Record<string, string> | undefined;
  hint?: string | undefined;
}

export function value(values: FormValues, name: string): string {
  const v = values[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

const ErrorText: FC<{ errors?: Record<string, string> | undefined; name: string }> = ({ errors, name }) =>
  errors?.[name] ? <div class="field-error">{errors[name]}</div> : null;

const Hint: FC<{ text?: string | undefined }> = ({ text }) => (text ? <span class="hint">{text}</span> : null);

export const TextField: FC<
  FieldProps & { type?: string; placeholder?: string; required?: boolean; inputmode?: 'numeric' | 'decimal' | 'tel' | 'email' }
> = (p) => (
  <div>
    <label for={p.name}>{p.label}</label>
    <input
      id={p.name}
      name={p.name}
      type={p.type ?? 'text'}
      value={value(p.values, p.name)}
      placeholder={p.placeholder}
      required={p.required}
      inputmode={p.inputmode}
      aria-invalid={p.errors?.[p.name] ? 'true' : undefined}
    />
    <Hint text={p.hint} />
    <ErrorText errors={p.errors} name={p.name} />
  </div>
);

export const TextArea: FC<FieldProps & { rows?: number; placeholder?: string }> = (p) => (
  <div>
    <label for={p.name}>{p.label}</label>
    <textarea id={p.name} name={p.name} rows={p.rows ?? 4} placeholder={p.placeholder}>
      {value(p.values, p.name)}
    </textarea>
    <Hint text={p.hint} />
    <ErrorText errors={p.errors} name={p.name} />
  </div>
);

export const SelectField: FC<FieldProps & { options: Array<[string, string]> }> = (p) => (
  <div>
    <label for={p.name}>{p.label}</label>
    <select id={p.name} name={p.name}>
      {p.options.map(([v, label]) => (
        <option value={v} selected={value(p.values, p.name) === v}>
          {label}
        </option>
      ))}
    </select>
    <Hint text={p.hint} />
    <ErrorText errors={p.errors} name={p.name} />
  </div>
);

export const CheckField: FC<{ name: string; label: string; checked: boolean; hint?: string; value?: string }> = (p) => (
  <label class="check">
    <input type="checkbox" name={p.name} value={p.value ?? '1'} checked={p.checked} />
    <span>
      {p.label}
      <Hint text={p.hint} />
    </span>
  </label>
);

export const FormErrors: FC<{ errors?: Record<string, string> | undefined }> = ({ errors }) =>
  errors && Object.keys(errors).length ? (
    <div class="flash error" role="alert">
      Confira os campos marcados.
    </div>
  ) : null;

export const Empty: FC<PropsWithChildren> = ({ children }) => <div class="empty">{children}</div>;
