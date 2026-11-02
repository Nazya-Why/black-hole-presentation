/* Liquid Glass: справжня рефракція краю через SVG-фільтр у backdrop-filter.
   Для кожного .glass генерується карта зміщення під його розмір і радіус:
   біля краю фон "загинається" всередину, як у лінзі, з легкою хроматичною аберацією.
   Працює в Chromium (Chrome, Edge, Arc, Opera). В Safari/Firefox — звичайне матове скло.

   Налаштування на елементі (необов'язково):
     data-refract  сила заломлення, px
     data-edge     ширина зони заломлення біля краю, px
     data-blur     розмиття фону, px
     data-chroma   хроматична аберація (3 проходи замість 1 — дорожче,
                   тому лише для великих "героїв")                           */
(() => {
  const ua = navigator.userAgent;
  const refract = /Chrome\/|Edg\//.test(ua) && !/Firefox\//.test(ua);
  document.documentElement.classList.toggle('lg-refract', refract);

  window.LiquidGlass = { refresh() {} };
  if (!refract) return;

  const defs = document.getElementById('glass-defs');
  const maps = new Map();
  let uid = 0;

  function radiusOf(el, w, h) {
    const raw = getComputedStyle(el).borderTopLeftRadius;
    let r = parseFloat(raw) || 0;
    if (raw.endsWith('%')) r = (r / 100) * Math.min(w, h);
    return Math.min(r, w / 2, h / 2);
  }

  function buildMap(w, h, r, edge) {
    const key = `${w}|${h}|${r}|${edge}`;
    if (maps.has(key)) return maps.get(key);

    const k = Math.min(1, 360 / Math.max(w, h));
    const cw = Math.max(4, Math.round(w * k));
    const ch = Math.max(4, Math.round(h * k));
    const cv = document.createElement('canvas');
    cv.width = cw;
    cv.height = ch;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(cw, ch);
    const data = img.data;
    const hw = w / 2, hh = h / 2;

    for (let y = 0; y < ch; y++) {
      const py = ((y + 0.5) / ch) * h - hh;
      for (let x = 0; x < cw; x++) {
        const px = ((x + 0.5) / cw) * w - hw;
        // signed distance до заокругленого прямокутника + нормаль
        const qx = Math.abs(px) - (hw - r);
        const qy = Math.abs(py) - (hh - r);
        let sd, nx, ny;
        if (qx > 0 && qy > 0) {
          const l = Math.hypot(qx, qy);
          sd = l - r; nx = qx / l; ny = qy / l;
        } else if (qx > qy) {
          sd = qx - r; nx = 1; ny = 0;
        } else {
          sd = qy - r; nx = 0; ny = 1;
        }
        nx *= Math.sign(px) || 1;
        ny *= Math.sign(py) || 1;

        const depth = -sd;
        let m = 0;
        if (depth > 0 && depth < edge) m = Math.pow(1 - depth / edge, 1.8);

        const i = (y * cw + x) * 4;
        data[i] = 128 - nx * m * 127;
        data[i + 1] = 128 - ny * m * 127;
        data[i + 2] = 128;
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const url = cv.toDataURL();
    maps.set(key, url);
    return url;
  }

  const channel = c => {
    const rows = ['0 0 0 0 0', '0 0 0 0 0', '0 0 0 0 0'];
    rows[c] = ['1 0 0 0 0', '0 1 0 0 0', '0 0 1 0 0'][c];
    return `${rows.join(' ')} 0 0 0 1 0`;
  };

  const disp = (s, res) =>
    `<feDisplacementMap in="blur" in2="map" scale="${s}" xChannelSelector="R" yChannelSelector="G" result="${res}"/>`;

  function apply(el) {
    const w = el.offsetWidth, h = el.offsetHeight;
    if (!w || !h) return;
    const r = radiusOf(el, w, h);
    const ds = el.dataset;
    const min = Math.min(w, h);
    const edge = ds.edge ? +ds.edge : Math.min(48, min * 0.3);
    const scale = ds.refract ? +ds.refract : Math.min(80, min * 0.32);
    const blur = ds.blur ? +ds.blur : 3;

    const chroma = 'chroma' in ds;
    const sig = `${w}|${h}|${r}|${edge}|${scale}|${blur}|${chroma}`;
    if (el._lgSig === sig) return;
    el._lgSig = sig;

    const id = el._lgId || (el._lgId = `lg-${++uid}`);
    const url = buildMap(w, h, r, edge);

    document.getElementById(id)?.remove();
    defs.insertAdjacentHTML('beforeend', `
      <filter id="${id}" x="0" y="0" width="${w}" height="${h}" filterUnits="userSpaceOnUse"
              primitiveUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
        <feImage href="${url}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map"/>
        <feGaussianBlur in="SourceGraphic" stdDeviation="${blur}" result="blur"/>
        ${chroma ? chromaChain(scale) : `${disp(scale, 'rgb')}`}
        <feColorMatrix in="rgb" type="saturate" values="0.92" result="sat"/>
        <feComponentTransfer in="sat">
          <feFuncR type="linear" slope="1.04"/><feFuncG type="linear" slope="1.04"/><feFuncB type="linear" slope="1.04"/>
        </feComponentTransfer>
      </filter>`);
    el.style.backdropFilter = `url(#${id})`;
  }

  function chromaChain(scale) {
    return `
        ${disp(scale, 'dr')}
        <feColorMatrix in="dr" type="matrix" values="${channel(0)}" result="r"/>
        ${disp(scale * 0.93, 'dg')}
        <feColorMatrix in="dg" type="matrix" values="${channel(1)}" result="g"/>
        ${disp(scale * 0.86, 'db')}
        <feColorMatrix in="db" type="matrix" values="${channel(2)}" result="b"/>
        <feBlend in="r" in2="g" mode="screen" result="rg"/>
        <feBlend in="rg" in2="b" mode="screen" result="rgb"/>`;
  }

  const queue = new Set();
  let scheduled = false;
  function schedule(el) {
    queue.add(el);
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      queue.forEach(apply);
      queue.clear();
    });
  }

  const ro = new ResizeObserver(entries => entries.forEach(e => schedule(e.target)));
  const observe = root => root.querySelectorAll('.glass').forEach(el => ro.observe(el));

  window.LiquidGlass = { refresh: el => schedule(el), observe };
  observe(document);

  // м'який відблиск, що йде за курсором
  let pending = null;
  addEventListener('pointermove', e => {
    const el = e.target.closest?.('.glass');
    if (!el) return;
    pending = { el, x: e.clientX, y: e.clientY };
    requestAnimationFrame(() => {
      if (!pending) return;
      const b = pending.el.getBoundingClientRect();
      pending.el.style.setProperty('--mx', `${((pending.x - b.left) / b.width) * 100}%`);
      pending.el.style.setProperty('--my', `${((pending.y - b.top) / b.height) * 100}%`);
      pending = null;
    });
  }, { passive: true });
})();
