export const WXMR = "WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp";
export const SOL = "So11111111111111111111111111111111111111112";
export const SLIPPAGE_BPS = 100;
export const SOL_RESERVE = 5_000_000n; // Network fees / ATA rent, retained for the deposit completion step.
export function units(value, decimals = 12) {
  if (typeof value !== "string" || !/^\d{1,12}(?:\.\d+)?$/.test(value))
    throw Error("Enter a valid positive amount.");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw Error(`Use at most ${decimals} decimal places.`);
  const n =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0"));
  if (n > 18446744073709551615n) throw Error("Amount is too large.");
  return n;
}
export function decimal(raw, decimals = 12) {
  const n = BigInt(raw);
  if (n < 0n) throw Error("Negative amount");
  const v = n.toString().padStart(decimals + 1, "0");
  return `${v.slice(0, -decimals)}.${v.slice(-decimals)}`.replace(/\.?0+$/, "");
}
export function providerDecimal(value, decimals) {
  // Providers sometimes serialize very small numbers using scientific notation.
  const s = String(value);
  if (!/^[0-9]+(?:\.[0-9]+)?(?:e[-+]?[0-9]+)?$/i.test(s))
    throw Error("Invalid provider amount.");
  if (!/[eE]/.test(s)) return decimal(units(s, decimals), decimals);
  const [coefficient, exponent] = s.toLowerCase().split("e"),
    [w, f = ""] = coefficient.split("."),
    shift = Number(exponent) - f.length;
  if (!Number.isSafeInteger(shift) || Math.abs(shift) > 30)
    throw Error("Invalid provider amount.");
  const digits = w + f,
    expanded =
      shift >= 0
        ? digits + "0".repeat(shift)
        : digits.padStart(-shift + 1, "0").slice(0, shift) +
          "." +
          digits.padStart(-shift + 1, "0").slice(shift);
  return decimal(units(expanded, decimals), decimals);
}
export function intentMessage(i) {
  return [
    "XMR20 bridge authorization",
    "This message cannot move funds. A separate transaction requires wallet approval.",
    `Direction: ${i.direction}`,
    `Wallet: ${i.wallet}`,
    `Amount: ${i.amount} ${i.direction === "withdraw" ? "wXMR" : "XMR"}`,
    `Monero ${i.direction === "withdraw" ? "payout" : "refund"} address: ${i.xmrAddress}`,
    `Quote: ${i.quoteId}`,
    `Expires: ${new Date(i.expires).toISOString()}`,
    `Request: ${i.id}`,
  ].join("\n");
}
export const terminalProviderStatuses = [
  "finished",
  "failed",
  "expired",
  "refunded",
];
export function progress(direction, status) {
  const stages =
    direction === "withdraw"
      ? [
          "Awaiting Solana deposit",
          "Confirming SOL deposit",
          "Converting to XMR",
          "Sending native XMR",
          "Provider reports payout complete",
        ]
      : [
          "Awaiting native XMR deposit",
          "Confirming XMR deposit",
          "Converting to SOL",
          "Sending SOL to your wallet",
          "SOL payout reported — finish the wXMR swap",
        ];
  const index = {
    new: 0,
    waiting: 0,
    confirming: 1,
    exchanging: 2,
    sending: 3,
    finished: 4,
  }[status];
  return {
    label:
      index == null
        ? {
            failed: "Exchange failed — contact ChangeNOW",
            expired: "Exchange expired — do not send a new deposit",
            refunded: "Provider reports refund sent",
            refunding: "Refund in progress",
            verifying: "Provider review in progress",
          }[status] || "Provider status unavailable"
        : stages[index],
    index: index ?? -1,
    stages,
    terminal: terminalProviderStatuses.includes(status),
  };
}
