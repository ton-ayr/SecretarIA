import type { BusinessHour, Professional, Service } from '../ports/domain.ts';
import { formatBRL } from '../shared/money.ts';
import { formatMinutes, weekdayShort } from '../shared/time.ts';

/** Preço como o cliente deve ouvir. "Sob consulta" nunca mostra número. */
export function formatServicePrice(service: Pick<Service, 'priceMode' | 'priceCents'>): string {
  if (service.priceMode === 'on_request' || service.priceCents === null) {
    return 'valor não informado (passado pela equipe)';
  }
  if (service.priceMode === 'from') return `a partir de ${formatBRL(service.priceCents)}`;
  if (service.priceCents === 0) return 'grátis';
  return formatBRL(service.priceCents);
}

export function professionalLabel(p: Professional): string {
  return p.title ? `${p.title} ${p.name}` : p.name;
}

export function formatServices(services: Service[], professionals: Professional[]): string {
  if (services.length === 0) return '(nenhum serviço cadastrado)';
  const byId = new Map(professionals.map((p) => [p.id, p]));
  return services
    .map((s) => {
      const who = s.professionalIds
        .map((id) => byId.get(id))
        .filter((p): p is Professional => p !== undefined)
        .map(professionalLabel)
        .join(', ');
      const parts = [`- ${s.name}: ${formatServicePrice(s)}`, `${s.durationMin} min`];
      if (who) parts.push(`com ${who}`);
      const line = parts.join(' · ');
      return s.description ? `${line}. ${s.description}` : line;
    })
    .join('\n');
}

/** Horário da casa por dia da semana, começando na segunda. */
export function formatBusinessHours(hours: BusinessHour[]): string {
  const house = hours.filter((h) => h.professionalId === null);
  if (house.length === 0) return '(não cadastrado)';
  const order = [1, 2, 3, 4, 5, 6, 0];
  return order
    .map((wd) => {
      const ranges = house
        .filter((h) => h.weekday === wd)
        .sort((a, b) => a.opensMin - b.opensMin)
        .map((h) => `${formatMinutes(h.opensMin)}–${formatMinutes(h.closesMin)}`);
      return `${weekdayShort(wd)} ${ranges.length ? ranges.join(' e ') : 'fechado'}`;
    })
    .join('; ');
}
