// Dinheiro sempre em centavos (inteiro). Formatação só na borda.

export function formatBRL(cents: number): string {
  const reais = Math.floor(cents / 100);
  const centavos = String(cents % 100).padStart(2, '0');
  const milhar = String(reais).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `R$ ${milhar},${centavos}`;
}
