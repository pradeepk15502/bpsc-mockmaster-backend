import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps.js';

const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function page(deps: Deps, title: string, body: string) {
  const c = deps.cfg;
  const notice = c.LEGAL_REVIEWED === 'true' ? '' : '<p class="notice">This page is pending legal review and may change before launch.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · BPSC MockMaster</title>
<style>body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:760px;margin:0 auto;padding:24px 16px;color:#1d2433;background:#fff}h1{font-size:1.6rem}h2{font-size:1.15rem;margin-top:1.6em}.notice{background:#fff6e0;border:1px solid #f0d58a;padding:8px 12px;border-radius:6px}nav a{margin-right:12px}footer{margin-top:3em;font-size:.9rem;color:#5a6378}</style></head>
<body><nav><a href="/legal/terms">Terms</a><a href="/legal/privacy">Privacy</a><a href="/legal/refund">Refunds</a><a href="/legal/contact">Contact</a><a href="/legal/delete-account">Delete account</a></nav>
<h1>${esc(title)}</h1>${notice}${body}
<footer>${esc(c.LEGAL_ENTITY_NAME || 'Operator name to be added')} · ${esc(c.BUSINESS_ADDRESS || 'Address to be added')}</footer></body></html>`;
}

export function legalRoutes(app: FastifyInstance, deps: Deps) {
  const c = deps.cfg; const entity = esc(c.LEGAL_ENTITY_NAME || 'the operator of BPSC MockMaster'); const email = esc(c.SUPPORT_EMAIL || 'the support email shown in the app');
  const send = (title: string, body: string) => async (_req: any, reply: any) => reply.type('text/html; charset=utf-8').header('cache-control', 'public, max-age=300').send(page(deps, title, body));

  app.get('/legal/terms', send('Terms & Conditions', `
<p>BPSC MockMaster ("the service") is run by ${entity}. By creating an account or buying a plan you agree to these terms.</p>
<h2>What the service is</h2>
<p>Daily practice mock tests for Bihar teacher-recruitment exams (BPSC TRE and Bihar STET). <strong>We are not affiliated with, endorsed by, or acting for the Bihar Public Service Commission, the Bihar School Examination Board or any government body.</strong></p>
<p>Questions are written with the help of AI and reviewed by our team before they are published. They are practice questions, not official papers. A question is labelled “previous year” only when we hold its source document. Where an exam pattern is described as official, it was checked against an official source document; otherwise it is labelled a practice pattern.</p>
<p>Scores, analysis and suggestions are for practice only. They do not predict or guarantee any result in the real exam. We do not publish ranks or percentiles.</p>
<h2>Your account</h2>
<p>One account is for one person. Do not share your login or the questions. We may suspend accounts used for sharing, scraping or abuse.</p>
<h2>Plans and access</h2>
<p>A plan gives access to one shared daily mock per day for the exam, level/paper, subject and (for TRE) exam language you chose, for the number of days shown at purchase. A plan becomes active only after the payment is confirmed by our payment provider. Each daily mock can be attempted once; a test started before your plan ends can be completed.</p>
<h2>Payments and refunds</h2><p>See the <a href="/legal/refund">Refund & Cancellation Policy</a>.</p>
<h2>Changes and availability</h2>
<p>We may update these terms; the date of change will be shown here. We try to keep the service available but cannot promise it will never be interrupted.</p>
<h2>Contact</h2><p>${email}</p>`));

  app.get('/legal/privacy', send('Privacy Policy', `
<p>This policy explains what personal data ${entity} collects for BPSC MockMaster and how it is used.</p>
<h2>What we collect</h2>
<ul><li>Name, mobile number and (optional) email — to create and secure your account.</li>
<li>Purchases and payment status — to activate your plan. Card, UPI and bank details are handled by Razorpay; we do not receive or store them.</li>
<li>Your answers, time spent per question, results and the explanations you open — to score your tests and show your analysis.</li>
<li>Basic product events (sign-in, mock started/submitted, result viewed) and technical logs (IP address, browser type) — for security and to fix problems.</li></ul>
<p>We do not record keystrokes, mouse movement, screen activity or device fingerprints, and we do not use advertising trackers.</p>
<h2>Who processes data for us</h2>
<ul><li>Razorpay — payments.</li><li>MSG91 — sending sign-in codes by SMS (your mobile number only).</li>
<li>Anthropic (Claude) — helps write practice questions. No student personal data is sent to it.</li><li>Our hosting / database providers — to run the service.</li></ul>
<h2>Cookies</h2><p>We use only the cookies needed to keep you signed in and to protect forms against misuse.</p>
<h2>How long we keep data</h2>
<p>Account and test data are kept while your account is active. When you delete your account we remove your name, mobile, email and other personal details. Payment and invoice records are kept for as long as the law requires.</p>
<h2>Your choices</h2>
<p>You can download your data (Settings → Download my data), correct your details, or <a href="/legal/delete-account">ask us to delete your account</a>.</p>
<h2>Grievance officer</h2><p>${esc(c.GRIEVANCE_OFFICER || 'Name and contact to be added')} · ${email}</p>`));

  app.get('/legal/refund', send('Refund & Cancellation Policy', `
<h2>Before you pay</h2>
<p>We only sell a mock series once its questions are reviewed and ready. If a combination is not ready you will see “Coming soon / Join waitlist” and no payment is taken.</p>
<h2>Charged but plan not active</h2>
<p>A plan activates automatically after your bank confirms the payment — usually within a minute. If money was deducted and your plan is not active within 24 hours, contact us: we will either activate it or refund the full amount.</p>
<h2>Duplicate payments</h2><p>If you were charged twice for the same order, the extra payment is refunded in full.</p>
<h2>Cancellation</h2>
<p>You can ask for a full refund within ${c.REFUND_WINDOW_DAYS} day(s) of purchase if you have not started any mock in that plan. After a refund, access to that plan ends.</p>
<h2>How refunds are paid</h2><p>Refunds go back to the original payment method through Razorpay. Banks usually credit them within 5–7 working days.</p>
<h2>How to ask</h2><p>Use the support form in the app or write to ${email} with your registered mobile number.</p>`));

  app.get('/legal/contact', send('Contact & Support', `
<p>Email: ${email}</p>${c.SUPPORT_PHONE ? `<p>Phone: ${esc(c.SUPPORT_PHONE)}</p>` : ''}
<p>Address: ${esc(c.BUSINESS_ADDRESS || 'to be added')}</p>
<p>You can also use the support form inside the app (it works even if you cannot sign in). We aim to reply within 2 working days.</p>`));

  app.get('/legal/delete-account', send('Delete your account', `
<p>Signed in: open <strong>Settings → Delete my account</strong> and confirm. Not able to sign in: write to ${email} from your registered email, or use the support form with your registered mobile number.</p>
<p>We process requests within 30 days. We remove your name, mobile number, email, waitlist entries and notifications, and end active plans. Payment records that the law requires us to keep are retained without your contact details.</p>`));
}
