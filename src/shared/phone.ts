// Exibição de telefone a partir do wa_id (só dígitos, com DDI).

export function formatWaId(waId: string): string {
  const d = waId.replace(/\D/g, '');
  // Brasil: 55 + DDD + 8 ou 9 dígitos.
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4);
    const rest = d.slice(4);
    const split = rest.length - 4;
    return `+55 ${ddd} ${rest.slice(0, split)}-${rest.slice(split)}`;
  }
  return `+${d}`;
}
