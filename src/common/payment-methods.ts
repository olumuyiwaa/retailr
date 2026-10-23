/** What a business can really offer at checkout: the methods it chose, minus the ones that can't work yet. */
export interface BankAccount {
  bankName: string;
  accountNumber: string;
  accountName: string;
  instructions?: string;
  branch?: string;
  sortCode?: string;
  swiftCode?: string;
  iban?: string;
}

/** Card is a demo until real card payments exist, so it is only offered when the server is in demo mode. */
export const cardAvailable = () => process.env.DEMO_CARD_PAYMENTS === "true";

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The saved bank details if the three required fields are there, otherwise null. */
export function completeBankAccount(raw: unknown): BankAccount | null {
  const a = (raw ?? {}) as Record<string, unknown>;
  const bankName = str(a.bankName), accountNumber = str(a.accountNumber), accountName = str(a.accountName);
  if (!bankName || !accountNumber || !accountName) return null;
  const out: BankAccount = { bankName, accountNumber, accountName };
  for (const k of ["instructions", "branch", "sortCode", "swiftCode", "iban"] as const) if (str(a[k])) out[k] = str(a[k]);
  return out;
}

/** Saved methods filtered to what works right now. Never empty: pay on delivery is the fallback. */
export function effectiveMethods(b: { paymentMethods: string[]; bankAccount?: unknown }): string[] {
  const ok = b.paymentMethods.filter((m) => (m === "card" ? cardAvailable() : m === "bank" ? !!completeBankAccount(b.bankAccount) : true));
  return ok.length ? ok : ["cod"];
}
