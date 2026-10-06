export interface OtpSender { readonly kind: 'msg91' | 'console'; send(mobileE164: string, code: string): Promise<void> }

/** MSG91 Flow API (DLT template). The OTP is only ever sent to the phone — never returned by the API. */
export class Msg91OtpSender implements OtpSender {
  readonly kind = 'msg91' as const;
  constructor(private authKey: string, private templateId: string, private otpVar = 'otp', private fetchImpl: typeof fetch = fetch,
              private url = 'https://control.msg91.com/api/v5/flow') {}
  async send(mobileE164: string, code: string): Promise<void> {
    const mobiles = mobileE164.replace(/^\+/, '');
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10_000);
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST', signal: ctl.signal,
        headers: { authkey: this.authKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ template_id: this.templateId, short_url: '0', recipients: [{ mobiles, [this.otpVar]: code }] }),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok || body?.type !== 'success') throw new Error(`MSG91 send failed (HTTP ${res.status}${body?.message ? ': ' + body.message : ''})`);
    } finally { clearTimeout(t); }
  }
}

/** Development / test only. Refused by config validation when NODE_ENV=production. Never echoes the code in API responses. */
export class ConsoleOtpSender implements OtpSender {
  readonly kind = 'console' as const;
  private last = new Map<string, string>();
  constructor(private log: (msg: string) => void = m => console.log(m)) {}
  async send(mobileE164: string, code: string) { this.last.set(mobileE164, code); this.log(`[DEV OTP — not for production] ${mobileE164}: ${code}`); }
  /** Test hook: read the last code "delivered" to a phone. */
  lastCode(mobileE164: string) { return this.last.get(mobileE164) ?? null; }
}
