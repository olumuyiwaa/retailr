import type { Mail } from "./mail.service";

/** Every value that came from a person (names, notes, addresses) goes through this before it lands in HTML. */
export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const shell = (title: string, body: string) =>
  `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:Arial,Helvetica,sans-serif;color:#1d2939"><div style="max-width:560px;margin:0 auto;padding:24px"><div style="background:#fff;border-radius:12px;padding:28px"><h2 style="margin:0 0 16px;font-size:20px">${esc(title)}</h2>${body}</div><p style="font-size:12px;color:#98a2b3;text-align:center;margin-top:16px">Sent by Retailr</p></div></body></html>`;
const button = (url: string, label: string) => `<p style="margin:24px 0"><a href="${esc(url)}" style="background:#465fff;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">${esc(label)}</a></p>`;
export const money = (n: number, currency: string) => {
  const sym: Record<string, string> = { NGN: "₦", GHS: "GH₵", KES: "KSh", USD: "$" };
  return `${sym[currency] ?? ""}${n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
};

export const teamInviteMail = (to: string, o: { name: string; business: string; inviter: string; role: string; link: string; days: number }): Mail => ({
  to,
  subject: `${o.inviter} invited you to ${o.business} on Retailr`,
  text: `Hi ${o.name},\n\n${o.inviter} invited you to help run ${o.business} on Retailr as ${o.role}.\n\nAccept the invite and choose a password:\n${o.link}\n\nThis link works for ${o.days} days.`,
  html: shell(`Join ${o.business}`, `<p>Hi ${esc(o.name)},</p><p>${esc(o.inviter)} invited you to help run <b>${esc(o.business)}</b> on Retailr as ${esc(o.role)}.</p>${button(o.link, "Accept the invite")}<p style="font-size:13px;color:#667085">This link works for ${o.days} days.</p>`),
});

export interface ReceiptOrder { number: string; placedAt: Date; customerName: string; items: { name: string; qty: number; price: number }[]; subtotal: number; discount: number; total: number; paymentStatus: string; shippingAddress?: string | null }
export const receiptMail = (to: string, o: { business: string; currency: string; order: ReceiptOrder; viewUrl?: string }): Mail => {
  const r = o.order, c = o.currency;
  const lines = r.items.map((i) => `${i.qty} x ${i.name}  ${money(i.qty * i.price, c)}`).join("\n");
  return {
    to,
    subject: `Your receipt from ${o.business} (${r.number})`,
    text: `Hi ${r.customerName},\n\nThank you for your order ${r.number} from ${o.business}.\n\n${lines}\n${r.discount > 0 ? `Discount  -${money(r.discount, c)}\n` : ""}Total  ${money(r.total, c)}\nPayment: ${r.paymentStatus}${r.shippingAddress ? `\nDelivery to: ${r.shippingAddress}` : ""}${o.viewUrl ? `\n\nView your order: ${o.viewUrl}` : ""}`,
    html: shell(`Receipt ${r.number}`, `<p>Hi ${esc(r.customerName)}, thank you for your order from <b>${esc(o.business)}</b>.</p><table style="width:100%;border-collapse:collapse;font-size:14px">${r.items.map((i) => `<tr><td style="padding:6px 0">${esc(i.qty)} × ${esc(i.name)}</td><td style="text-align:right">${esc(money(i.qty * i.price, c))}</td></tr>`).join("")}${r.discount > 0 ? `<tr><td style="padding:6px 0">Discount</td><td style="text-align:right">−${esc(money(r.discount, c))}</td></tr>` : ""}<tr><td style="padding:10px 0;border-top:1px solid #eaecf0"><b>Total</b></td><td style="text-align:right;border-top:1px solid #eaecf0"><b>${esc(money(r.total, c))}</b></td></tr></table><p style="font-size:13px;color:#667085">Payment: ${esc(r.paymentStatus)}${r.shippingAddress ? `<br>Delivery to: ${esc(r.shippingAddress)}` : ""}</p>${o.viewUrl ? button(o.viewUrl, "View your order") : ""}`),
  };
};

/** The merchant's own text, with {{first_name}} and {{store}} filled in for this customer. */
export const fillTemplate = (body: string, v: { first_name: string; store: string }) =>
  body.replace(/\{\{\s*first_name\s*\}\}/gi, () => v.first_name).replace(/\{\{\s*store\s*\}\}/gi, () => v.store);

export const customerMessageMail = (to: string, o: { subject: string; body: string; store: string }): Mail => ({
  to,
  subject: o.subject,
  text: `${o.body}\n\n—\nYou're receiving this because you've shopped at ${o.store}.`,
  html: shell(o.subject, `<div style="white-space:pre-wrap;font-size:15px;line-height:1.5">${esc(o.body)}</div><p style="font-size:12px;color:#98a2b3;margin-top:24px">You're receiving this because you've shopped at ${esc(o.store)}.</p>`),
});

export const paymentFailedMail = (to: string, o: { name: string; business: string; plan: string; link: string }): Mail => ({
  to, subject: `We couldn't renew ${o.business} on Retailr`,
  text: `Hi ${o.name},\n\nWe couldn't take payment for the ${o.plan} plan. Update your payment method to keep your store online:\n${o.link}`,
  html: shell("Payment didn't go through", `<p>Hi ${esc(o.name)},</p><p>We couldn't take payment for the <b>${esc(o.plan)}</b> plan on ${esc(o.business)}. Update your payment method to keep your store online.</p>${button(o.link, "Update payment method")}`),
});

export const trialEndingMail = (to: string, o: { name: string; business: string; days: number; link: string }): Mail => ({
  to, subject: `Your Retailr trial ends in ${o.days} day${o.days === 1 ? "" : "s"}`,
  text: `Hi ${o.name},\n\nThe trial for ${o.business} ends in ${o.days} day${o.days === 1 ? "" : "s"}. Add a payment method to keep selling:\n${o.link}`,
  html: shell("Your trial is ending", `<p>Hi ${esc(o.name)},</p><p>The trial for <b>${esc(o.business)}</b> ends in ${o.days} day${o.days === 1 ? "" : "s"}. Add a payment method to keep selling.</p>${button(o.link, "Choose a plan")}`),
});

export const subscriptionPaidMail = (to: string, o: { name: string; business: string; plan: string; amount: string; nextDate: string }): Mail => ({
  to, subject: `Payment received for ${o.business}`,
  text: `Hi ${o.name},\n\nThanks, we received ${o.amount} for the ${o.plan} plan. Your next renewal is ${o.nextDate}.`,
  html: shell("Payment received", `<p>Hi ${esc(o.name)},</p><p>Thanks, we received <b>${esc(o.amount)}</b> for the <b>${esc(o.plan)}</b> plan. Your next renewal is ${esc(o.nextDate)}.</p>`),
});
