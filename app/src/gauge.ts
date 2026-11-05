// Semicircle SVG speedometer. 0% points left, 100% points right.
const NS = 'http://www.w3.org/2000/svg';
const CX = 100, CY = 96, R = 80;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent.appendChild(node);
  return node;
}

const point = (pct: number, r: number) => {
  const a = Math.PI * (1 - pct / 100);
  return [CX + r * Math.cos(a), CY - r * Math.sin(a)];
};

// Slight overshoot, settles in ~400 ms: reads like a real needle.
const easeOutBack = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;

export class Gauge {
  private arc: SVGPathElement;
  private needle: SVGGElement;
  private pctText: SVGTextElement;
  private shown = 0;
  private target = 0;
  private anim = 0;

  constructor(svg: SVGSVGElement) {
    const d = `M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`;
    el('path', { d, class: 'track', pathLength: 100 }, svg);
    this.arc = el('path', { d, class: 'progress', pathLength: 100, 'stroke-dasharray': '0 100' }, svg);

    const ticks = el('g', { class: 'ticks' }, svg);
    for (let p = 0; p <= 100; p += 10) {
      const major = p % 20 === 0;
      const [x1, y1] = point(p, R - 10);
      const [x2, y2] = point(p, R - (major ? 18 : 15));
      el('line', { x1, y1, x2, y2, class: major ? 'major' : 'minor' }, ticks);
      if (major) {
        const [tx, ty] = point(p, R - 27);
        el('text', { x: tx, y: ty + 3, class: 'tick-label' }, ticks).textContent = String(p);
      }
    }

    this.needle = el('g', { class: 'needle' }, svg);
    el('line', { x1: CX, y1: CY, x2: CX, y2: CY - (R - 36), class: 'needle-line' }, this.needle);
    el('circle', { cx: CX, cy: CY, r: 5, class: 'hub' }, svg);
    this.pctText = el('text', { x: CX, y: CY + 25, class: 'pct' }, svg);
    this.draw(0);
  }

  set(pct: number) {
    pct = Math.max(0, Math.min(100, pct));
    if (pct === this.target) return;
    this.target = pct;
    cancelAnimationFrame(this.anim);
    const from = this.shown, start = performance.now(), dur = 420;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / dur);
      this.draw(from + (pct - from) * easeOutBack(k));
      if (k < 1) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }

  private draw(v: number) {
    this.shown = v;
    const c = Math.max(0, Math.min(100, v));
    this.needle.setAttribute('transform', `rotate(${-90 + c * 1.8} ${CX} ${CY})`);
    this.arc.setAttribute('stroke-dasharray', `${c} 100`);
    this.arc.style.opacity = c < 0.5 ? '0' : '1';
    this.pctText.textContent = `${Math.round(this.target === this.shown ? this.target : c)}%`;
  }
}
