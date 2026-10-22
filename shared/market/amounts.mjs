// UI-only fixed decimal arithmetic. This is not a settlement or signing module.
export function parseDecimal(value, decimals) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match || (match[2]?.length || 0) > decimals || match[1].length > 15) return null;
  return BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt((match[2] || '').padEnd(decimals, '0') || '0');
}
export function formatDecimal(units, decimals) {
  const scale = 10n ** BigInt(decimals);
  const whole = (units / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return whole + (fraction ? '.' + fraction : '');
}
export function quoteLot(quantity, price) {
  const quantityUnits = parseDecimal(quantity, 6);
  const priceUnits = parseDecimal(price, 12);
  if (!quantityUnits || !priceUnits) return {error: 'Enter a positive quantity (up to 6 decimals) and XMR price (up to 12 decimals).'};
  const product = quantityUnits * priceUnits;
  if (product % 1000000n) return {error: 'This total includes a fraction of an XMR atomic unit. Adjust the quantity or price so the total has at most 12 decimal places.'};
  return {quantityUnits, priceUnits, totalUnits: product / 1000000n};
}
