// Ported 1:1 from the prototype so fingerprints / duplicate checks agree.
export function djb2(s: string): string { let h = 5381; s = String(s); for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16).padStart(8, '0'); }
const STOP = ['the', 'which', 'what', 'following', 'with', 'from', 'that', 'this', 'there', 'their', 'into', 'used', 'does', 'have', 'been', 'under', 'about', 'when', 'where', 'many'];
export function words(s: string): string[] { return String(s || '').toLowerCase().replace(/[^a-z0-9/ ]+/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOP.includes(w)); }
export function fingerprintOf(qEn: string, qHi = ''): string {
  const en = String(qEn || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return djb2(en || 'hi:' + String(qHi || '').trim());
}
export function semanticOf(qEn: string, qHi = ''): string {
  const w = words(qEn).filter((x, i, a) => a.indexOf(x) === i).sort().join(' ');
  return djb2(w || 'hi:' + String(qHi || '').trim());
}
export function jaccard(a: string, b: string): number { const A = words(a), B = words(b); if (!A.length || !B.length) return 0; const s = A.filter(w => B.includes(w)).length; return s / new Set(A.concat(B)).size; }
export const pct = (a: number, b: number) => (b ? Math.round((a * 1000) / b) / 10 : 0);
export const r2 = (n: number) => Math.round(n * 100) / 100;
export const triOk = (t: any) => !!(t && t.hi && t.en && t.hl);
