// 本文の入力欄で、画像の書き方（なろうの挿絵タグ・みてみんの URL・アルファの画像タグ・「ここに画像を挿入」の目印）に色を付ける。
//
// 入力欄（textarea）は一部の文字だけ色を変えることができない。そこで、同じ文字を同じ位置に並べた「下敷き」を
// 入力欄の後ろに置き、画像の部分にだけ黄色の下地を塗る（下敷きの文字は透明。見えている文字は入力欄のもの）。
// 画像の書き方がない本文では下敷きを出さず、ふだんの入力欄のまま。
import { imageRanges } from './notation.js';

// 折り返しの位置を入力欄と同じにするため、文字と余白に関わる書式を写す
const COPY = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontFeatureSettings', 'fontKerning',
  'letterSpacing', 'wordSpacing', 'lineHeight', 'textIndent', 'textTransform', 'tabSize',
  'wordBreak', 'lineBreak', 'overflowWrap', 'hyphens', 'direction', 'textAlign',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
];

export function attachImageHighlight(t) {
  const layer = document.createElement('div');
  layer.className = 'text-hl';
  layer.setAttribute('aria-hidden', 'true');
  layer.hidden = true;
  const inner = document.createElement('div');
  inner.className = 'text-hl-inner';
  layer.append(inner);
  t.before(layer);
  t.parentElement.classList.add('text-hl-host');

  let active = false;
  let lastText = null;

  function place() {
    if (!active || !t.offsetParent) return;
    const cs = getComputedStyle(t);
    for (const p of COPY) layer.style[p] = cs[p];
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const br = parseFloat(cs.borderRightWidth) || 0;
    layer.style.left = t.offsetLeft + 'px';
    layer.style.top = t.offsetTop + 'px';
    layer.style.width = t.clientWidth + bl + br + 'px'; // 入力欄のスクロールバーの分は除く（折り返し幅を同じにする）
    layer.style.height = t.offsetHeight + 'px';
    inner.style.minHeight = t.scrollHeight + 'px';
    layer.scrollTop = t.scrollTop;
  }

  function update() {
    const text = t.value;
    if (text === lastText) { place(); return; }
    lastText = text;
    const ranges = imageRanges(text);
    active = ranges.length > 0;
    layer.hidden = !active;
    t.classList.toggle('text-hl-on', active);
    if (!active) { inner.replaceChildren(); return; }
    const parts = [];
    let pos = 0;
    for (const [s, e] of ranges) {
      parts.push(text.slice(pos, s));
      const m = document.createElement('mark');
      m.textContent = text.slice(s, e);
      parts.push(m);
      pos = e;
    }
    parts.push(text.slice(pos) + '​'); // 最後が改行のときも、入力欄と同じ行数にする
    inner.replaceChildren(...parts);
    place();
  }

  t.addEventListener('scroll', () => { if (active) layer.scrollTop = t.scrollTop; }, { passive: true });
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(() => place());
    ro.observe(t);
    ro.observe(t.parentElement);
  }
  window.addEventListener('resize', place);
  return { update, place };
}
