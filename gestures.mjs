const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function angle(a, b, c) {
  const ab = { x: a.x - b.x, y: a.y - b.y }, cb = { x: c.x - b.x, y: c.y - b.y };
  return Math.acos(Math.max(-1, Math.min(1, (ab.x * cb.x + ab.y * cb.y) / (Math.hypot(ab.x, ab.y) * Math.hypot(cb.x, cb.y) || 1)))) * 180 / Math.PI;
}
export function classifyHand(p, mirrored = true) {
  if (!p || p.length !== 21) return 'NONE';
  const scale = distance(p[0], p[9]); if (scale < 0.04) return 'NONE';
  const extended = [5, 9, 13, 17].map(i => angle(p[i], p[i + 1], p[i + 3]) > 155 && distance(p[i + 3], p[0]) > distance(p[i + 1], p[0]) * 1.15);
  const thumbOut = angle(p[1], p[2], p[4]) > 145 && distance(p[4], p[5]) > scale * 0.6;
  if (extended[0] && !extended[1] && !extended[2] && !extended[3] && !thumbOut && p[8].y < p[5].y - scale * 0.3) return 'PAUSE';
  if (extended[0] && extended[1] && !extended[2] && !extended[3] && !thumbOut && p[8].y < p[5].y - scale * 0.3 && p[12].y < p[9].y - scale * 0.3) return 'PLAY';
  if (extended.every(v => !v) && thumbOut) {
    const dx = (p[4].x - p[2].x) * (mirrored ? -1 : 1), dy = p[4].y - p[2].y;
    if (Math.abs(dx) > scale * 0.45 && Math.abs(dx) > Math.abs(dy) * 1.5) return dx > 0 ? 'FORWARD' : 'REWIND';
  }
  return 'NONE';
}
export class GestureGate {
  constructor(holdMs = 400) { this.holdMs = holdMs; this.reset(); }
  reset() { this.candidate = 'NONE'; this.since = 0; this.active = 'NONE'; this.lastSend = 0; }
  update(raw, now) {
    if (raw !== this.candidate) { this.candidate = raw; this.since = now; }
    if (raw === 'NONE') {
      if (['FORWARD', 'REWIND'].includes(this.active)) { this.active = 'NONE'; return 'RESTORE'; }
      this.active = 'NONE'; return null;
    }
    if (raw !== this.active && ['FORWARD', 'REWIND'].includes(this.active)) { this.active = 'NONE'; return 'RESTORE'; }
    if (now - this.since < this.holdMs) return null;
    if (raw !== this.active || (['FORWARD', 'REWIND'].includes(raw) && now - this.lastSend >= 250)) {
      this.active = raw; this.lastSend = now; return raw;
    }
    return null;
  }
}
