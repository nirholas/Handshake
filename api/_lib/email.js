// Transactional email via Resend. All sends are fire-and-forget — never await
// them on the critical path. Import sendEmail and call without await.
//
// Required env: RESEND_API_KEY, EMAIL_FROM (e.g. "three.ws <notifications@three.ws>")
// Optional env: EMAIL_REPLY_TO, APP_ORIGIN

import { Resend } from 'resend';
import { captureException } from './sentry.js';

let _client = null;
function client() {
	if (!_client) _client = new Resend(process.env.RESEND_API_KEY);
	return _client;
}

const FROM    = process.env.EMAIL_FROM     || 'three.ws <notifications@three.ws>';
const REPLY   = process.env.EMAIL_REPLY_TO || 'support@three.ws';
const APP_URL = process.env.APP_ORIGIN    || 'https://three.ws';

// ─── Payload builder ──────────────────────────────────────────────────────────
// Pure function — builds the exact object passed to Resend's emails.send.
// Exported so tests can assert the payload without mocking the Resend SDK.

export function buildPayload({ to, subject, html, text }) {
	return {
		from: FROM,
		...(REPLY ? { replyTo: REPLY } : {}),
		to,
		subject,
		html,
		text,
	};
}

// ─── Low-level send ───────────────────────────────────────────────────────────
// Returns { skipped: true, reason: 'missing_api_key' } when RESEND_API_KEY is
// unset (dev / preview deploys). Returns the Resend SDK response on success.
// Throws on transport failure — fire-and-forget callers must .catch().

export async function sendEmail({ to, subject, html, text }) {
	if (!process.env.RESEND_API_KEY) {
		return { skipped: true, reason: 'missing_api_key' };
	}
	const payload = buildPayload({ to, subject, html, text });
	try {
		return await client().emails.send(payload);
	} catch (err) {
		console.error('[email] send failed', err?.message);
		captureException(err, { to, subject });
		throw err;
	}
}

// ─── Renderers ────────────────────────────────────────────────────────────────
// Each returns { subject, html, text }. Exposed so tests can assert the
// rendered content directly without going through the send path.

export function renderWelcome({ displayName }) {
	const name = displayName || 'there';
	return {
		subject: 'Welcome to three.ws',
		html: welcomeHtml(name),
		text: welcomeText(name),
	};
}

export function renderVerify({ code, expiresInMinutes = 30 }) {
	return {
		subject: `${code} — verify your email`,
		html: verifyHtml(code, expiresInMinutes),
		text: verifyText(code, expiresInMinutes),
	};
}

export function renderPasswordReset({ resetUrl, expiresInMinutes = 60 }) {
	return {
		subject: 'Reset your three.ws password',
		html: resetHtml(resetUrl, expiresInMinutes),
		text: resetText(resetUrl, expiresInMinutes),
	};
}

export function renderSubscriptionConfirm({ plan, chain, txId }) {
	return {
		subject: `three.ws ${capitalize(plan)} plan activated`,
		html: subscriptionHtml(plan, chain, txId),
		text: subscriptionText(plan, chain, txId),
	};
}

export function renderPurchaseReceipt({ skillName, agentName, agentUrl, amount, currency, date, txUrl, txId }) {
	return {
		subject: `Your three.ws receipt — ${skillName}`,
		html: purchaseReceiptHtml({ skillName, agentName, agentUrl, amount, currency, date, txUrl, txId }),
		text: purchaseReceiptText({ skillName, agentName, agentUrl, amount, currency, date, txUrl, txId }),
	};
}

export function renderSaleNotification({ skillName, agentName, agentUrl, netAmount, currency, buyerHandle, date, txUrl, txId }) {
	return {
		subject: `You made a sale — ${skillName}`,
		html: saleNotificationHtml({ skillName, agentName, agentUrl, netAmount, currency, buyerHandle, date, txUrl, txId }),
		text: saleNotificationText({ skillName, agentName, agentUrl, netAmount, currency, buyerHandle, date, txUrl, txId }),
	};
}

export function renderReferralCommission({ amount, currency, fromHandle, skillName, date }) {
	return {
		subject: `You earned a referral commission`,
		html: referralCommissionHtml({ amount, currency, fromHandle, skillName, date }),
		text: referralCommissionText({ amount, currency, fromHandle, skillName, date }),
	};
}

// ─── Template wrappers ────────────────────────────────────────────────────────

export function sendWelcomeEmail({ to, displayName }) {
	return sendEmail({ to, ...renderWelcome({ displayName }) });
}

export function sendVerificationEmail({ to, code, expiresInMinutes = 30 }) {
	return sendEmail({ to, ...renderVerify({ code, expiresInMinutes }) });
}

export function sendPasswordResetEmail({ to, resetUrl, expiresInMinutes = 60 }) {
	return sendEmail({ to, ...renderPasswordReset({ resetUrl, expiresInMinutes }) });
}

export function sendSubscriptionConfirmEmail({ to, plan, chain, txId }) {
	return sendEmail({ to, ...renderSubscriptionConfirm({ plan, chain, txId }) });
}

export function sendPurchaseReceiptEmail({ to, skillName, agentName, agentUrl, amount, currency, date, txUrl, txId }) {
	return sendEmail({ to, ...renderPurchaseReceipt({ skillName, agentName, agentUrl, amount, currency, date, txUrl, txId }) });
}

export function sendSaleNotificationEmail({ to, skillName, agentName, agentUrl, netAmount, currency, buyerHandle, date, txUrl, txId }) {
	return sendEmail({ to, ...renderSaleNotification({ skillName, agentName, agentUrl, netAmount, currency, buyerHandle, date, txUrl, txId }) });
}

export function sendReferralCommissionEmail({ to, amount, currency, fromHandle, skillName, date }) {
	return sendEmail({ to, ...renderReferralCommission({ amount, currency, fromHandle, skillName, date }) });
}

// An invitation to somebody's household: a role in a real building, sent to an
// email address that may not have a three.ws account behind it yet.
//
// Three things this template does deliberately, all of them because of what the
// link opens:
//
//   1. It names the ROLE and what that role can never do, in the email, not only
//      behind the link. Somebody forwarding an invitation should be able to see
//      that they are handing over a guest seat and not the house.
//   2. It never renders the home's label or the inviter's name as HTML. Both are
//      strings a person typed, and one of them is chosen by whoever set up the
//      home; `esc` is not optional here.
//   3. It says the link works once and when it stops working, because an invite
//      that quietly expires reads as a broken product rather than a policy.
//
// `roleNote` is the sentence that makes a guest seat legible to a person who has
// never used the product. The guest line is the one that matters: it is the
// difference between letting somebody water the plants and letting them open the
// front door.
const HOUSEHOLD_ROLE_NOTE = {
	admin: 'You will be able to control everything in the home, approve unlocking a door, and invite other people. You will not be able to disconnect the home.',
	member: 'You will be able to control everything in the home and approve unlocking a door, the same as anybody who lives there.',
	guest: 'You will be able to control the things you have been given. You will never be able to approve unlocking a door, opening a garage or disarming an alarm.',
	viewer: 'You will be able to watch the things you have been given, and change nothing.',
};

export function renderHouseholdInvite({ homeLabel, role, inviterName, inviteUrl, expiresAt }) {
	const label = homeLabel || 'a home';
	const who = inviterName ? `${inviterName} has` : 'Somebody has';
	const note = HOUSEHOLD_ROLE_NOTE[role] || 'You will be able to reach this home from your three.ws account.';
	const expiry = expiresAt ? new Date(expiresAt).toUTCString() : null;
	return {
		subject: `${who.replace(' has', '')} invited you to ${label} on three.ws`,
		html: householdInviteHtml({ label, role, who, note, inviteUrl, expiry }),
		text: householdInviteText({ label, role, who, note, inviteUrl, expiry }),
	};
}

export function sendHouseholdInviteEmail({ to, homeLabel, role, inviterName, inviteUrl, expiresAt }) {
	return sendEmail({ to, ...renderHouseholdInvite({ homeLabel, role, inviterName, inviteUrl, expiresAt }) });
}

// Unattended forge completion: sent only by the server-side finalizer when a
// generation finished after the creator left the page. `creationPath` is the
// site-relative share path (/forge?share=<id>).
export function renderForgeComplete({ prompt, creationPath, previewImageUrl }) {
	const url = `${APP_URL}${creationPath}`;
	const subjectPrompt = prompt ? `"${prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt}"` : 'your model';
	const preview = previewImageUrl
		? `<img src="${esc(previewImageUrl)}" alt="Model preview" style="width:100%;max-width:456px;border-radius:12px;border:1px solid #2a2a36;margin:0 0 16px" />`
		: '';
	return {
		subject: `Your 3D model is ready: ${subjectPrompt}`,
		html: layout('Your 3D model is ready', `
    <p class="brand">three.ws</p>
    <h1>Your 3D model is ready</h1>
    ${prompt ? `<p>Your generation ${esc(subjectPrompt)} finished while you were away. It's saved to your gallery and ready to view, share, or refine.</p>` : `<p>Your 3D generation finished while you were away. It's saved to your gallery and ready to view, share, or refine.</p>`}
    ${preview}
    <a class="btn" href="${esc(url)}">View your model</a>
    <hr>
    <p class="muted">You're getting this because a generation you started on three.ws finished after you left the page. Turn these off any time in your <a href="${APP_URL}/dashboard/" style="color:#6a5cff">notification preferences</a>.</p>
  `),
		text: `Your 3D model is ready\n\n${prompt ? `Your generation ${subjectPrompt} finished while you were away.` : 'Your 3D generation finished while you were away.'} It's saved to your gallery.\n\nView it: ${url}\n\nManage notifications: ${APP_URL}/dashboard/`,
	};
}

export function sendForgeCompleteEmail({ to, prompt, creationPath, previewImageUrl }) {
	return sendEmail({ to, ...renderForgeComplete({ prompt, creationPath, previewImageUrl }) });
}

// Double opt-in newsletter confirmation. Minimal localization (prompt 38) so a
// subscriber confirms in their own language; unknown locales fall back to en.
const NEWSLETTER_I18N = {
	en: { subject: 'Confirm your three.ws subscription', heading: 'Confirm your subscription', body: 'Tap below to confirm you want updates from three.ws — new features, launches, and changelog highlights.', cta: 'Confirm subscription', foot: "If you didn't request this, you can ignore this email." },
	es: { subject: 'Confirma tu suscripción a three.ws', heading: 'Confirma tu suscripción', body: 'Toca abajo para confirmar que quieres novedades de three.ws — nuevas funciones, lanzamientos y cambios destacados.', cta: 'Confirmar suscripción', foot: 'Si no lo solicitaste, puedes ignorar este correo.' },
	fr: { subject: 'Confirmez votre abonnement three.ws', heading: 'Confirmez votre abonnement', body: 'Appuyez ci-dessous pour confirmer que vous souhaitez recevoir les actualités de three.ws — nouvelles fonctionnalités, lancements et nouveautés.', cta: "Confirmer l'abonnement", foot: "Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail." },
	pt: { subject: 'Confirme a sua inscrição na three.ws', heading: 'Confirme a sua inscrição', body: 'Toque abaixo para confirmar que deseja novidades da three.ws — novos recursos, lançamentos e destaques.', cta: 'Confirmar inscrição', foot: 'Se não foi você, pode ignorar este e-mail.' },
	de: { subject: 'Bestätige dein three.ws-Abo', heading: 'Abo bestätigen', body: 'Tippe unten, um zu bestätigen, dass du Updates von three.ws erhalten möchtest — neue Funktionen, Launches und Changelog-Highlights.', cta: 'Abo bestätigen', foot: 'Falls du das nicht angefordert hast, ignoriere diese E-Mail.' },
};

function newsletterCopy(locale) {
	const lang = String(locale || 'en').slice(0, 2).toLowerCase();
	return NEWSLETTER_I18N[lang] || NEWSLETTER_I18N.en;
}

export function renderNewsletterConfirm({ confirmUrl, locale }) {
	const t = newsletterCopy(locale);
	return {
		subject: t.subject,
		html: layout(t.subject, `
    <p class="brand">three.ws</p>
    <h1>${esc(t.heading)}</h1>
    <p>${esc(t.body)}</p>
    <a class="btn" href="${esc(confirmUrl)}">${esc(t.cta)}</a>
    <hr>
    <p class="muted">${esc(t.foot)}</p>
  `),
		text: `${t.heading}\n\n${t.body}\n\n${confirmUrl}\n\n${t.foot}`,
	};
}

export function sendNewsletterConfirmEmail({ to, confirmUrl, locale }) {
	return sendEmail({ to, ...renderNewsletterConfirm({ confirmUrl, locale }) });
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────

function layout(title, body) {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;background:#080814;color:#eee;margin:0;padding:32px 16px}
  .card{max-width:520px;margin:0 auto;background:#14141c;border:1px solid #2a2a36;border-radius:16px;padding:36px 32px}
  .brand{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#6a5cff;margin:0 0 20px}
  h1{font-size:22px;margin:0 0 12px;letter-spacing:-.01em}
  p{color:#aaa;line-height:1.6;margin:0 0 16px;font-size:15px}
  .btn{display:inline-block;padding:12px 24px;background:linear-gradient(135deg,#6a5cff,#ff5ca8);color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:15px;margin:8px 0 20px}
  .code{font-family:monospace;font-size:32px;letter-spacing:.15em;color:#fff;background:#0f0f17;border:1px solid #2a2a36;border-radius:8px;padding:12px 20px;display:inline-block;margin:8px 0 20px}
  .muted{color:#555;font-size:13px}
  hr{border:none;border-top:1px solid #2a2a36;margin:24px 0}
</style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
}

function welcomeHtml(name) {
	return layout('Welcome to three.ws', `
    <p class="brand">three.ws</p>
    <h1>Welcome, ${esc(name)}</h1>
    <p>Your account is ready. Start by uploading your first 3D avatar or connecting an on-chain agent identity.</p>
    <a class="btn" href="${APP_URL}/dashboard/">Open Dashboard</a>
    <hr>
    <p class="muted">Questions? Reply to this email and we'll help you out.</p>
  `);
}

function welcomeText(name) {
	return `Welcome to three.ws, ${name}!\n\nYour account is ready. Open your dashboard: ${APP_URL}/dashboard/\n\nQuestions? Reply to this email.`;
}

function verifyHtml(code, mins) {
	return layout('Verify your email', `
    <p class="brand">three.ws</p>
    <h1>Verify your email</h1>
    <p>Enter this code to verify your email address. It expires in ${mins} minutes.</p>
    <div class="code">${esc(code)}</div>
    <p class="muted">If you didn't request this, you can ignore it.</p>
  `);
}

function verifyText(code, mins) {
	return `Your three.ws verification code is: ${code}\n\nExpires in ${mins} minutes.`;
}

function resetHtml(url, mins) {
	return layout('Reset your three.ws password', `
    <p class="brand">three.ws</p>
    <h1>Reset your password</h1>
    <p>Click below to set a new password. This link expires in ${mins} minutes.</p>
    <a class="btn" href="${esc(url)}">Reset password</a>
    <p class="muted">If you didn't request a reset, you can safely ignore this email.</p>
  `);
}

function resetText(url, mins) {
	return `Reset your three.ws password:\n${url}\n\nExpires in ${mins} minutes.`;
}

function subscriptionHtml(plan, chain, txId) {
	return layout(`${capitalize(plan)} plan activated`, `
    <p class="brand">three.ws</p>
    <h1>${capitalize(plan)} plan activated</h1>
    <p>Your <strong>${capitalize(plan)}</strong> subscription is now active on ${capitalize(chain)}.</p>
    ${txId ? `<p class="muted">Transaction: <code>${esc(txId)}</code></p>` : ''}
    <a class="btn" href="${APP_URL}/dashboard/">Go to Dashboard</a>
  `);
}

function householdInviteHtml({ label, role, who, note, inviteUrl, expiry }) {
	return layout(`You have been invited to ${label}`, `
    <p class="brand">three.ws</p>
    <h1>You have been invited to ${esc(label)}</h1>
    <p>${esc(who)} given you access to a home they connected to three.ws, as a <strong>${esc(role)}</strong>.</p>
    <p>${esc(note)}</p>
    <a class="btn" href="${esc(inviteUrl)}">See the invitation</a>
    <p class="muted">The link opens a page that shows exactly what you would be able to do before you accept anything. It works once${expiry ? `, and stops working after ${esc(expiry)}` : ''}.</p>
    <p class="muted">If you were not expecting this, you can ignore it. Nothing happens to your account unless you open the link and accept.</p>
  `);
}

function householdInviteText({ label, role, who, note, inviteUrl, expiry }) {
	return [
		`${who} given you access to ${label} on three.ws, as a ${role}.`,
		'',
		note,
		'',
		`See the invitation: ${inviteUrl}`,
		'',
		`The link works once${expiry ? `, and stops working after ${expiry}` : ''}.`,
		'If you were not expecting this, you can ignore it.',
	].join('\n');
}

function subscriptionText(plan, chain, txId) {
	return `Your three.ws ${plan} plan is now active on ${chain}.\n${txId ? `Transaction: ${txId}\n` : ''}Open dashboard: ${APP_URL}/dashboard/`;
}

// Renders a label/value row used by the receipt + sale templates.
function row(label, value) {
	if (value === null || value === undefined || value === '') return '';
	return `<tr><td style="padding:6px 0;color:#777;font-size:13px">${esc(label)}</td><td style="padding:6px 0;color:#eee;font-size:14px;text-align:right;font-weight:600">${value}</td></tr>`;
}

function purchaseReceiptHtml({ skillName, agentName, agentUrl, amount, currency, date, txUrl, txId }) {
	const txCell = txUrl
		? `<a href="${esc(txUrl)}" style="color:#6a5cff;text-decoration:none">${esc(shortTx(txId))}</a>`
		: (txId ? `<code>${esc(shortTx(txId))}</code>` : '');
	return layout(`Receipt — ${skillName}`, `
    <p class="brand">three.ws</p>
    <h1>Purchase confirmed</h1>
    <p>Thanks for your purchase. Here's your receipt for <strong>${esc(skillName)}</strong>${agentName ? ` from <strong>${esc(agentName)}</strong>` : ''}.</p>
    <table style="width:100%;border-collapse:collapse;margin:8px 0 20px">
      ${row('Skill', esc(skillName))}
      ${agentName ? row('Agent', esc(agentName)) : ''}
      ${row('Amount', `${esc(amount)} ${esc(currency)}`)}
      ${date ? row('Date', esc(date)) : ''}
      ${txCell ? row('Transaction', txCell) : ''}
    </table>
    ${agentUrl ? `<a class="btn" href="${esc(agentUrl)}">View agent</a>` : ''}
    <hr>
    <p class="muted">Keep this email as proof of purchase. Questions? Reply and we'll help.</p>
  `);
}

function purchaseReceiptText({ skillName, agentName, agentUrl, amount, currency, date, txUrl, txId }) {
	return [
		`Purchase confirmed — three.ws`,
		``,
		`Skill: ${skillName}`,
		agentName ? `Agent: ${agentName}` : null,
		`Amount: ${amount} ${currency}`,
		date ? `Date: ${date}` : null,
		txId ? `Transaction: ${txUrl || txId}` : null,
		agentUrl ? `\nView agent: ${agentUrl}` : null,
		``,
		`Keep this email as proof of purchase.`,
	].filter(Boolean).join('\n');
}

function saleNotificationHtml({ skillName, agentName, agentUrl, netAmount, currency, buyerHandle, date, txUrl, txId }) {
	const txCell = txUrl
		? `<a href="${esc(txUrl)}" style="color:#6a5cff;text-decoration:none">${esc(shortTx(txId))}</a>`
		: (txId ? `<code>${esc(shortTx(txId))}</code>` : '');
	return layout(`You made a sale`, `
    <p class="brand">three.ws</p>
    <h1>You made a sale</h1>
    <p>Someone purchased <strong>${esc(skillName)}</strong>${agentName ? ` on <strong>${esc(agentName)}</strong>` : ''}. Your net earnings have been recorded.</p>
    <table style="width:100%;border-collapse:collapse;margin:8px 0 20px">
      ${row('Skill', esc(skillName))}
      ${agentName ? row('Agent', esc(agentName)) : ''}
      ${row('Net earnings', `${esc(netAmount)} ${esc(currency)}`)}
      ${buyerHandle ? row('Buyer', esc(buyerHandle)) : ''}
      ${date ? row('Date', esc(date)) : ''}
      ${txCell ? row('Transaction', txCell) : ''}
    </table>
    <a class="btn" href="${APP_URL}/dashboard/">View earnings</a>
    ${agentUrl ? `<hr><p class="muted">Manage this agent: <a href="${esc(agentUrl)}" style="color:#6a5cff">${esc(agentUrl)}</a></p>` : ''}
  `);
}

function saleNotificationText({ skillName, agentName, agentUrl, netAmount, currency, buyerHandle, date, txUrl, txId }) {
	return [
		`You made a sale — three.ws`,
		``,
		`Skill: ${skillName}`,
		agentName ? `Agent: ${agentName}` : null,
		`Net earnings: ${netAmount} ${currency}`,
		buyerHandle ? `Buyer: ${buyerHandle}` : null,
		date ? `Date: ${date}` : null,
		txId ? `Transaction: ${txUrl || txId}` : null,
		``,
		`View earnings: ${APP_URL}/dashboard/`,
		agentUrl ? `Manage agent: ${agentUrl}` : null,
	].filter(Boolean).join('\n');
}

function referralCommissionHtml({ amount, currency, fromHandle, skillName, date }) {
	return layout(`Referral commission earned`, `
    <p class="brand">three.ws</p>
    <h1>You earned a commission</h1>
    <p>A purchase by ${fromHandle ? `<strong>${esc(fromHandle)}</strong>` : 'someone you referred'} earned you a referral commission.</p>
    <table style="width:100%;border-collapse:collapse;margin:8px 0 20px">
      ${row('Commission', `${esc(amount)} ${esc(currency)}`)}
      ${fromHandle ? row('From', esc(fromHandle)) : ''}
      ${skillName ? row('Skill', esc(skillName)) : ''}
      ${date ? row('Date', esc(date)) : ''}
    </table>
    <a class="btn" href="${APP_URL}/dashboard/">View earnings</a>
    <hr>
    <p class="muted">Keep sharing your referral link to keep earning.</p>
  `);
}

function referralCommissionText({ amount, currency, fromHandle, skillName, date }) {
	return [
		`You earned a referral commission — three.ws`,
		``,
		`Commission: ${amount} ${currency}`,
		fromHandle ? `From: ${fromHandle}` : null,
		skillName ? `Skill: ${skillName}` : null,
		date ? `Date: ${date}` : null,
		``,
		`View earnings: ${APP_URL}/dashboard/`,
	].filter(Boolean).join('\n');
}

function shortTx(tx) {
	const s = String(tx || '');
	return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
}

function esc(s) {
	return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
