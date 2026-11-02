/* Перемикання слайдів: колесо/тачпад (один жест = один слайд), клавіші, свайп,
   точки збоку, кнопки внизу, #номер у адресі. F — повний екран. */
(() => {
  const root = document.documentElement;
  const deck = document.getElementById('deck');
  const slides = [...deck.querySelectorAll('.slide')];
  const N = slides.length;
  const pad = n => String(n).padStart(2, '0');

  const ui = {
    list: document.getElementById('dots-list'),
    lens: document.getElementById('dots-lens'),
    tip: document.getElementById('dots-tip'),
    cur: document.getElementById('counter-cur'),
    total: document.getElementById('counter-total'),
    title: document.getElementById('slide-title'),
    prev: document.getElementById('btn-prev'),
    next: document.getElementById('btn-next'),
  };

  ui.total.textContent = pad(N);

  // каскадна поява елементів слайда
  slides.forEach(s => s.querySelectorAll('.r, .rg').forEach((el, i) => el.style.setProperty('--i', i)));

  /* ---------- точки ---------- */
  const dots = slides.map((s, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dot';
    b.setAttribute('aria-label', `${pad(i + 1)} — ${s.dataset.title}`);
    b.addEventListener('click', () => go(i));
    b.addEventListener('pointerenter', () => showTip(i));
    b.addEventListener('focus', () => showTip(i));
    b.addEventListener('pointerleave', hideTip);
    b.addEventListener('blur', hideTip);
    ui.list.appendChild(b);
    return b;
  });

  function dotCenter(i) {
    const b = dots[i];
    return ui.list.offsetTop + b.offsetTop + b.offsetHeight / 2;
  }

  function placeLens(i, animate = true) {
    const y = dotCenter(i) - ui.lens.offsetHeight / 2;
    ui.lens.style.setProperty('--y', `${y}px`);
    if (!animate) return;
    ui.lens.classList.add('is-moving');
    clearTimeout(ui.lens._t);
    ui.lens._t = setTimeout(() => ui.lens.classList.remove('is-moving'), 220);
  }

  function showTip(i) {
    ui.tip.textContent = `${pad(i + 1)}  ${slides[i].dataset.title}`;
    ui.tip.style.setProperty('--ty', `${dotCenter(i) - ui.tip.offsetHeight / 2}px`);
    ui.tip.classList.add('is-on');
  }
  function hideTip() { ui.tip.classList.remove('is-on'); }

  /* ---------- маленька анімація зміни тексту в рамці ---------- */
  function swapText(el, text) {
    if (el.textContent === text) return;
    el.textContent = text;
    el.animate(
      [{ opacity: 0, transform: 'translateY(60%)', filter: 'blur(4px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }],
      { duration: 520, easing: 'cubic-bezier(.16,1,.3,1)' }
    );
  }

  const camOf = s => {
    const [dist, elev, roll, ox, oy, bright] = (s.dataset.cam || '22 6 0 0 0 1').trim().split(/\s+/).map(Number);
    return { dist, elev, roll, ox, oy, bright };
  };

  /* ---------- навігація ---------- */
  let cur = -1;

  function go(i) {
    i = Math.max(0, Math.min(N - 1, i));
    if (i === cur) return;
    const dir = i > cur ? 1 : -1;
    deck.style.setProperty('--dir', dir);

    const prev = slides[cur];
    if (prev) {
      prev.classList.remove('is-active');
      prev.classList.add('is-leaving');
      clearTimeout(prev._t);
      prev._t = setTimeout(() => prev.classList.remove('is-leaving'), 800);
    }

    const next = slides[i];
    clearTimeout(next._t);
    next.classList.remove('is-leaving');
    void next.offsetWidth;
    next.classList.add('is-active');

    slides.forEach(s => {
      const on = s === next;
      s.inert = !on;
      s.setAttribute('aria-hidden', String(!on));
    });

    cur = i;

    dots.forEach((d, k) => {
      d.classList.toggle('is-active', k === i);
      if (k === i) d.setAttribute('aria-current', 'step');
      else d.removeAttribute('aria-current');
    });
    placeLens(i);
    swapText(ui.cur, pad(i + 1));
    swapText(ui.title, next.dataset.title);
    ui.prev.disabled = i === 0;
    ui.next.disabled = i === N - 1;

    window.Bg?.set(camOf(next));
    // великі слова малює фон (js/background.js), на текстових слайдах вони тихіші
    window.Bg?.setWords(next.dataset.top || '', next.dataset.bottom || '', next.dataset.type === 'strong');

    history.replaceState(null, '', `#${i + 1}`);
  }

  const next = () => go(cur + 1);
  const prev = () => go(cur - 1);
  ui.prev.addEventListener('click', prev);
  ui.next.addEventListener('click', next);

  // Колесо: жест триває, поки події йдуть без пауз; один жест — один слайд.
  let wheelAcc = 0, lastWheel = 0, consumed = false;
  addEventListener('wheel', e => {
    e.preventDefault();
    const now = performance.now();
    if (now - lastWheel > 180) { consumed = false; wheelAcc = 0; }
    lastWheel = now;
    if (consumed) return;
    wheelAcc += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(wheelAcc) > 40) {
      consumed = true;
      wheelAcc > 0 ? next() : prev();
    }
  }, { passive: false });

  addEventListener('keydown', e => {
    if (e.target.closest?.('input, textarea, [contenteditable]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case 'ArrowDown': case 'ArrowRight': case 'PageDown':
        e.preventDefault(); next(); break;
      case 'ArrowUp': case 'ArrowLeft': case 'PageUp':
        e.preventDefault(); prev(); break;
      case ' ':
        e.preventDefault(); e.shiftKey ? prev() : next(); break;
      case 'Home': e.preventDefault(); go(0); break;
      case 'End': e.preventDefault(); go(N - 1); break;
      case 'f': case 'F': case 'а': case 'А':
        if (document.fullscreenElement) document.exitFullscreen();
        else root.requestFullscreen?.().catch(() => {});
        break;
    }
  });

  let touch = null;
  addEventListener('touchstart', e => {
    const t = e.touches[0];
    touch = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  addEventListener('touchend', e => {
    if (!touch) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.x, dy = t.clientY - touch.y;
    touch = null;
    const d = Math.abs(dy) > Math.abs(dx) ? dy : dx;
    if (Math.abs(d) > 50) d < 0 ? next() : prev();
  }, { passive: true });

  addEventListener('hashchange', () => {
    const n = parseInt(location.hash.slice(1), 10);
    if (n) go(n - 1);
  });

  let resizeT;
  addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      placeLens(cur, false);
    }, 80);
  });

  /* ---------- старт ---------- */
  const start = Math.max(0, (parseInt(location.hash.slice(1), 10) || 1) - 1);
  const boot = () => {
    root.classList.add('is-ready');
    go(start);
    window.Bg?.prewarm(slides.map(s => [s.dataset.top || '', s.dataset.bottom || '']));
    placeLens(cur, false);
  };
  // чекаємо шрифт (щоб великі слова поміряти правильно), але не довше 1.5 с
  const fontsReady = document.fonts?.ready || Promise.resolve();
  Promise.race([fontsReady, new Promise(r => setTimeout(r, 1500))]).then(() => setTimeout(boot, 30));
})();
