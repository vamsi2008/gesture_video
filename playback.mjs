export class PlaybackController {
  constructor(media, report = () => {}, now = () => performance.now()) { this.media = media; this.report = report; this.now = now; this.mode = 'NORMAL'; this.until = 0; this.blocked = false; this.originalPlaying = false; }
  ready() { return !!this.media.src && Number.isFinite(this.media.duration) && this.media.duration > 0; }
  async apply(action) {
    if (action === 'RESTORE') { this.blocked = false; return this.restore(); }
    if (!this.ready()) return;
    const m = this.media;
    if (action === 'PLAY' || action === 'PAUSE') {
      this.mode = 'NORMAL'; this.blocked = false; m.playbackRate = 1;
      if (action === 'PLAY') { if (m.currentTime >= m.duration - .05) m.currentTime = 0; await m.play(); } else m.pause();
    } else if (['FORWARD', 'REWIND'].includes(action) && !this.blocked) {
      const now = this.now();
      if (this.mode === 'NORMAL') this.originalPlaying = !m.paused;
      if (this.mode !== action) {
        if (action === 'FORWARD') { m.playbackRate = 2; await m.play(); }
        else { m.playbackRate = 1; m.pause(); this.target = m.currentTime; this.last = now; }
      }
      this.mode = action; this.until = now + 1500;
    }
    this.report();
  }
  async restore() {
    if (this.mode === 'NORMAL') return;
    this.mode = 'NORMAL'; this.media.playbackRate = 1;
    if (this.originalPlaying && !this.media.ended) await this.media.play(); else this.media.pause();
    this.report();
  }
  async tick() {
    const now = this.now();
    if (this.mode !== 'NORMAL' && now > this.until) return this.restore();
    if (this.mode === 'REWIND') {
      this.target = Math.max(0, this.target - Math.min(.6, Math.max(0, (now - this.last) / 1000)) * 2); this.last = now;
      if (!this.media.seeking) this.media.currentTime = this.target;
      if (this.target <= 0) { this.originalPlaying = false; await this.restore(); this.blocked = true; }
    }
  }
  stop() { this.mode = 'NORMAL'; this.media.playbackRate = 1; this.media.pause(); this.blocked = false; this.report(); }
  ended() { this.mode = 'NORMAL'; this.media.playbackRate = 1; this.blocked = true; this.report(); }
}
