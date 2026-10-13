/**
 * Top-down map of the track with a dot per kart (2D canvas, redrawn every frame).
 * The track outline is drawn once into an offscreen canvas and copied each frame.
 */
export class Minimap {
  constructor(canvas, track) {
    this.canvas = canvas;
    this.track = track;
    this.ctx = canvas.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const { clientWidth: w, clientHeight: h } = this.canvas;
    this.canvas.width = Math.max(1, Math.round(w * ratio));
    this.canvas.height = Math.max(1, Math.round(h * ratio));
    this.ratio = ratio;

    // Fit the track's bounds into the canvas, keeping its shape.
    const { minX, maxX, minZ, maxZ } = this.track.bounds;
    const pad = 14 * ratio;
    const scale = Math.min((this.canvas.width - 2 * pad) / (maxX - minX), (this.canvas.height - 2 * pad) / (maxZ - minZ));
    const ox = (this.canvas.width - (maxX - minX) * scale) / 2 - minX * scale;
    const oz = (this.canvas.height - (maxZ - minZ) * scale) / 2 - minZ * scale;
    this.toScreen = (x, z) => [ox + x * scale, oz + z * scale];
    this.scale = scale;
    this.#drawBackground();
  }

  #drawBackground() {
    const bg = document.createElement('canvas');
    bg.width = this.canvas.width;
    bg.height = this.canvas.height;
    const ctx = bg.getContext('2d');
    const path = new Path2D();
    this.track.samples.forEach((p, i) => {
      const [x, y] = this.toScreen(p.x, p.z);
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    });
    path.closePath();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = (this.track.roadHalfWidth * 2 + 6) * this.scale;
    ctx.stroke(path);
    ctx.strokeStyle = '#5b606b';
    ctx.lineWidth = this.track.roadHalfWidth * 2 * this.scale;
    ctx.stroke(path);

    // Finish line.
    const p = this.track.pointAt(0);
    const half = (this.track.roadHalfWidth + 2) * this.scale;
    const [cx, cy] = this.toScreen(p.x, p.z);
    ctx.strokeStyle = '#f3f2ee';
    ctx.lineWidth = 3 * this.ratio;
    ctx.beginPath();
    ctx.moveTo(cx - p.rx * half, cy - p.rz * half);
    ctx.lineTo(cx + p.rx * half, cy + p.rz * half);
    ctx.stroke();
    this.background = bg;
  }

  /** dots: [{ x, z, color, highlight }] — highlight = race leader. */
  draw(dots) {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.background, 0, 0);
    for (const dot of dots) {
      const [x, y] = this.toScreen(dot.x, dot.z);
      const r = (dot.highlight ? 6 : 5) * this.ratio;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = dot.color;
      ctx.fill();
      ctx.lineWidth = (dot.highlight ? 2.5 : 1.5) * this.ratio;
      ctx.strokeStyle = dot.highlight ? '#ffffff' : '#101216';
      ctx.stroke();
    }
  }
}
