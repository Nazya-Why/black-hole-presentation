/* Фон презентації — чорна діра, що рахується в реальному часі (WebGL).

   Прохід 1 (сцена, у зниженій роздільності — це дорого):
     промінь з камери летить крізь викривлений простір (геодезична Шварцшильда),
     тому диск за дірою видно над і під нею, а навколо тіні — тонке фотонне кільце.
       • акреційний диск: смуги-кільця, що обертаються за Кеплером
         (внутрішні швидше за зовнішні), біло-гарячий усередині, пиловий брунатний назовні;
       • ефект Допплера: бік, що летить до нас, яскравіший і "біліший";
       • тепла імла біля площини диска, теж заломлена;
       • мала темна планета на нахиленій орбіті, освітлена диском;
       • ледь помітні зорі, що "течуть" довкола тіні, коли камера рухається.
   Прохід 2 (повна роздільність екрана):
     великі слова (blend "luminosity"), віньєтка, плівкове зерно, дизеринг.

   Рух:
     • кожен слайд має свій ракурс (data-cam) — камера перелітає пружиною;
     • під час перельоту диск коротко прискорюється, а маса ледь "дихає" —
       лінзування на мить розширюється;
     • постійно: обертання диска, повільний дрейф камери, планета, паралакс від курсора.

   API:
     Bg.set({dist, elev, roll, ox, oy, bright}) — ракурс (див. коментар у index.html)
     Bg.setWords(top, bottom, strong)          — великі слова (strong=false — тихіші)
     Bg.prewarm([[top, bottom], ...])          — заздалегідь підготувати текстури слів   */
(() => {
  const canvas = document.getElementById('bg');
  const gl = canvas.getContext('webgl', {
    antialias: false, alpha: false, depth: false, stencil: false,
    premultipliedAlpha: false, powerPreference: 'high-performance',
  });

  const api = { set() {}, setWords() {}, prewarm() {} };
  window.Bg = api;

  if (!gl) {
    document.documentElement.classList.add('no-webgl');
    return;
  }

  /* ---------------- шейдери ---------------- */
  const vert = `
    attribute vec2 p;
    void main() { gl_Position = vec4(p, 0.0, 1.0); }
  `;

  const sceneFrag = `
    precision highp float;
    uniform vec2 u_res;
    uniform vec3 u_cam;     // відстань, висота над диском (рад), азимут (рад)
    uniform float u_roll;   // нахил кадру (рад)
    uniform vec2 u_off;     // зсув центру діри на екрані
    uniform float u_rot;    // накопичений кут обертання диска
    uniform float u_mass;   // радіус горизонту (1 = норма)
    uniform float u_bright;
    uniform vec4 u_pl;      // планета: xyz — центр, w — радіус
    uniform sampler2D u_noise; // безшовний шум 256×256 (готується один раз у JS)

    const float RIN = 2.35;
    const float ROUT = 15.0;

    float hash13(vec3 p) {
      p = fract(p * 0.1031);
      p += dot(p, p.zyx + 31.32);
      return fract((p.x + p.y) * p.z);
    }

    // смуги диска: витягнуті вздовж орбіти, дрібні впоперек.
    // Текстура повторюється, тож ціле число обертів по куту не дає шва.
    float streaks(float r, float a, float seed) {
      float u = a * 0.15915494;
      float big = texture2D(u_noise, vec2(u * 2.0 + seed, r * 0.16)).r;
      float fine = texture2D(u_noise, vec2(u * 6.0 - seed, r * 0.9 + big * 0.35)).r;
      float rings = 0.5 + 0.5 * sin(r * 11.0 + big * 9.0 + seed * 6.0);
      return big * 0.55 + fine * 0.35 + rings * 0.12;
    }

    // температура -> колір: пиловий брунатний -> помаранчевий -> біло-гарячий
    vec3 heatRamp(float h) {
      vec3 c = vec3(0.09, 0.03, 0.012);
      c = mix(c, vec3(0.50, 0.18, 0.055), smoothstep(0.04, 0.22, h));
      c = mix(c, vec3(1.00, 0.52, 0.20),  smoothstep(0.18, 0.48, h));
      c = mix(c, vec3(1.00, 0.84, 0.66),  smoothstep(0.42, 0.78, h));
      c = mix(c, vec3(1.00, 0.97, 0.93),  smoothstep(0.72, 1.05, h));
      return c;
    }

    // rgb — випромінювання, a — непрозорість
    vec4 disk(vec3 p, vec3 rd) {
      float r = length(p.xz);
      if (r < RIN * 0.9 || r > ROUT) return vec4(0.0);
      float phi = atan(p.z, p.x);

      // кеплерівське обертання; щоб смуги не "закручувались" нескінченно,
      // змішуємо два шари з фазами, що по черзі перезапускаються
      float ir = RIN / r;
      float om = ir * sqrt(ir);
      const float P = 6.0;
      float f0 = fract(u_rot / P);
      float f1 = fract(u_rot / P + 0.5);
      float w0 = 1.0 - abs(2.0 * f0 - 1.0);
      float n = streaks(r, phi - f0 * P * om, 0.0) * w0
              + streaks(r, phi - f1 * P * om, 0.43) * (1.0 - w0);
      n = smoothstep(0.22, 0.78, n);

      float edge = smoothstep(RIN * 0.9, RIN * 1.25, r) * (1.0 - smoothstep(ROUT * 0.45, ROUT, r));
      float heat = ir * sqrt(ir) * 0.95 + 0.05 * ir;

      // Допплер: бік, що летить до камери, яскравіший і гарячіший
      vec3 vdir = normalize(vec3(-p.z, 0.0, p.x));
      float beta = min(0.6, sqrt(0.5 * u_mass / r));
      float gam = inversesqrt(1.0 - beta * beta);
      float D = 1.0 / (gam * (1.0 - beta * dot(vdir, -rd)));
      float grav = sqrt(max(0.0, 1.0 - u_mass / r));
      float shift = D * grav;
      heat *= mix(1.0, shift, 0.55);
      float beam = mix(1.0, pow(shift, 2.6), 0.6);

      float dens = edge * (0.45 + 0.85 * n);
      float I = (4.2 * pow(heat, 1.25) + 0.07) * beam * (0.6 + 0.6 * n);
      float a = clamp(dens * mix(0.75, 1.6, heat), 0.0, 0.98);
      return vec4(heatRamp(heat) * I * a, a);
    }

    vec3 stars(vec3 d) {
      vec3 c = vec3(0.0);
      for (int l = 0; l < 2; l++) {
        float s = l == 0 ? 90.0 : 190.0;
        vec3 p = d * s;
        vec3 id = floor(p);
        float h = hash13(id + float(l) * 17.0);
        if (h > 0.972) {
          vec3 f = fract(p) - 0.5 - (vec3(hash13(id + 3.1), hash13(id + 7.7), hash13(id + 1.3)) - 0.5) * 0.5;
          float k = smoothstep(0.16, 0.0, length(f));
          c += k * mix(vec3(1.0, 0.82, 0.68), vec3(0.8, 0.88, 1.0), hash13(id + 5.5)) * (h - 0.972) * 26.0;
        }
      }
      return c * 0.55;
    }

    void main() {
      vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
      uv -= u_off;
      float cr = cos(u_roll), sr = sin(u_roll);
      uv = mat2(cr, -sr, sr, cr) * uv;

      float ce = cos(u_cam.y);
      vec3 ro = u_cam.x * vec3(ce * sin(u_cam.z), sin(u_cam.y), ce * cos(u_cam.z));
      vec3 fw = normalize(-ro);
      vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
      vec3 up = cross(rt, fw);
      vec3 vel = normalize(fw + (uv.x * rt + uv.y * up) * 0.95);
      vec3 vel0 = vel;

      vec3 pos = ro;
      vec3 hv = cross(pos, vel);
      float h2 = dot(hv, hv);

      // планета — один перетин прямого променя зі сферою (без лінзування:
      // перевірка в кожному кроці коштувала б половину кадру)
      vec3 oc = ro - u_pl.xyz;
      float pb = dot(oc, vel);
      float pdisc = pb * pb - dot(oc, oc) + u_pl.w * u_pl.w;
      float tPl = pdisc > 0.0 ? -pb - sqrt(pdisc) : -1.0;
      bool planetBehind = tPl > dot(-ro, vel);

      // У циклі лише запам'ятовуємо перетини з диском і влучання в планету,
      // а розфарбовуємо після: текстура всередині циклу змусила б DirectX
      // (Chrome на Windows) розгорнути всі кроки — це в десятки разів повільніше.
      vec3 hp0 = vec3(0.0), hp1 = vec3(0.0), hp2 = vec3(0.0);
      vec3 hd0 = vec3(0.0), hd1 = vec3(0.0);
      int nh = 0;
      float glow = 0.0;
      bool hole = false;

      for (int i = 0; i < 110; i++) {
        float r = length(pos);
        if (r < u_mass) { hole = true; break; }
        if (r > 36.0 && dot(pos, vel) > 0.0) break;

        // дрібний крок лише біля фотонної сфери, далі — великий
        float dt = r * mix(0.055, 0.14, clamp((r - 2.0) * 0.14, 0.0, 1.0));
        // викривлення: a = -3/2 · rs · h² · r̂ / r⁴
        float r2 = r * r;
        vel += -1.5 * u_mass * h2 * pos / (r2 * r2 * r) * dt;
        vec3 np = pos + vel * dt;

        // тепла імла біля площини диска (за диском — слабша)
        float rr = max(length(np.xz), RIN);
        float gy = np.y * 1.2;
        glow += (RIN * RIN) / (rr * rr * (1.0 + gy * gy)) * dt * (nh == 0 ? 1.0 : 0.35);

        // перетин площини диска
        if (pos.y * np.y < 0.0) {
          vec3 hp = mix(pos, np, pos.y / (pos.y - np.y));
          float hr = length(hp.xz);
          if (hr > RIN * 0.9 && hr < ROUT) {
            if (nh == 0) { hp0 = hp; hd0 = vel; }
            else if (nh == 1) { hp1 = hp; hd1 = vel; }
            else { hp2 = hp; }
            nh++;
            if (nh > 2) break;
          }
        }
        pos = np;
      }

      // спереду назад: диск (два образи + тонке кільце), потім планета або зорі
      vec3 col = vec3(0.0);
      float acc = 0.0;
      vec4 d0 = nh > 0 ? disk(hp0, normalize(hd0)) : vec4(0.0);
      col = d0.rgb;
      acc = d0.a;
      if (nh > 1) { vec4 d = disk(hp1, normalize(hd1)); col += (1.0 - acc) * d.rgb; acc += (1.0 - acc) * d.a; }
      if (nh > 2) {
        // третій образ — тонке фотонне кільце, текстура там не видна
        float k = smoothstep(RIN * 0.9, RIN * 1.3, length(hp2.xz)) * 0.9;
        col += (1.0 - acc) * vec3(1.0, 0.8, 0.62) * 1.6 * k;
        acc += (1.0 - acc) * k;
      }

      // планета: перед дірою — над усім, крім ближчої частини диска;
      // за дірою — лише там, де промінь не впав у горизонт
      if (tPl > 0.0 && !(planetBehind && hole)) {
        bool diskFront = nh > 0 && length(hp0 - ro) < tPl;
        vec3 pn = normalize(ro + vel0 * tPl - u_pl.xyz);
        // темна планета: світиться лише тонкий серп, повернутий до диска
        vec3 L = normalize(-u_pl.xyz);
        float lit = max(dot(pn, L), 0.0);
        float under = max(dot(pn, vec3(0.0, -sign(u_pl.y), 0.0)), 0.0);
        float rim = pow(1.0 - max(dot(pn, -vel0), 0.0), 3.0);
        vec3 pc = vec3(0.008, 0.007, 0.007)
                + vec3(1.0, 0.78, 0.6) * pow(lit, 6.0) * 0.9
                + vec3(1.0, 0.5, 0.22) * pow(under, 4.0) * 0.12
                + vec3(1.0, 0.65, 0.4) * rim * pow(lit, 2.0) * 1.4;
        // планета закриває все позаду себе
        col = diskFront ? d0.rgb + (1.0 - d0.a) * pc : pc;
        glow *= 0.3;
      } else if (!hole) {
        col += (1.0 - acc) * stars(normalize(vel));
      }
      col += glow * vec3(1.0, 0.5, 0.2) * 0.06;

      col *= u_bright;
      col = 1.0 - exp(-col * 1.15);          // м'яка тональна компресія
      col = pow(col, vec3(1.0, 1.04, 1.1));  // теплий відтінок у тінях
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  const compFrag = `
    precision highp float;
    uniform vec2 u_res;
    uniform float u_seed;
    uniform float u_dim;
    uniform sampler2D u_scene;
    uniform sampler2D u_ta; uniform sampler2D u_ba; uniform vec3 u_a;
    uniform sampler2D u_tb; uniform sampler2D u_bb; uniform vec3 u_b;
    uniform vec2 u_texelA; uniform vec2 u_texelB;

    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
    vec3 clipColor(vec3 c) {
      float l = lum(c);
      float n = min(min(c.r, c.g), c.b);
      float x = max(max(c.r, c.g), c.b);
      if (n < 0.0) c = l + (c - l) * l / (l - n);
      if (x > 1.0) c = l + (c - l) * (1.0 - l) / (x - l);
      return c;
    }
    vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }

    // s = (непрозорість, розмиття 0..1, зсув назовні у частках висоти)
    float word(sampler2D t, sampler2D b, vec3 s, vec2 texel, vec2 uv) {
      if (s.x < 0.002) return 0.0;
      float side = uv.y > 0.5 ? 1.0 : -1.0;
      vec2 p = uv - vec2(0.0, s.z * side);
      float a = texture2D(t, p).a;
      if (s.y > 0.002) {
        float bl = 0.25 * (
          texture2D(b, p + vec2( texel.x,  texel.y)).a +
          texture2D(b, p + vec2(-texel.x,  texel.y)).a +
          texture2D(b, p + vec2( texel.x, -texel.y)).a +
          texture2D(b, p - texel).a);
        a = mix(a, bl, s.y);
      }
      return a * s.x;
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / u_res;
      float asp = u_res.x / u_res.y;
      vec3 col = texture2D(u_scene, uv).rgb;

      vec2 vv = (uv - 0.5) * vec2(asp, 1.0);
      col *= 1.0 - 0.32 * smoothstep(0.4, 1.3, length(vv));

      // великі слова: на чорному — сірі, на диску — темні
      float a = word(u_ta, u_ba, u_a, u_texelA, uv);
      float b = word(u_tb, u_bb, u_b, u_texelB, uv);
      float ta = 1.0 - (1.0 - a) * (1.0 - b);
      float tl = mix(0.34, 0.12, smoothstep(0.1, 0.4, lum(col)));
      col = mix(col, setLum(col, tl), ta * u_dim);

      // плівкове зерно на рівні фізичного пікселя + дизеринг проти смуг
      vec2 fc = gl_FragCoord.xy;
      float grain = hash(fc + u_seed * 61.7) + hash(fc.yx + u_seed * 23.1 + 17.0) - 1.0;
      col += grain * (0.010 + 0.026 * sqrt(lum(col)));

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(fragSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vert));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSrc));
    gl.bindAttribLocation(p, 0, 'p');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
      const name = gl.getActiveUniform(p, i).name;
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  let scene, comp;
  try {
    scene = program(sceneFrag);
    comp = program(compFrag);
  } catch (err) {
    console.error(err);
    document.documentElement.classList.add('no-webgl');
    return;
  }

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  function makeTex() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  // порожня текстура для слотів без слів
  const empty = makeTex();
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, 1, 1, 0, gl.ALPHA, gl.UNSIGNED_BYTE, new Uint8Array([0]));
  const EMPTY = { t: empty, b: empty, texel: [0, 0] };

  /* ---------------- шум для диска ---------------- */
  // Безшовний (тайловий) fbm 256×256: дешевше за шум у шейдері в десятки разів.
  function makeNoise(size) {
    const out = new Float32Array(size * size);
    let amp = 0.5, total = 0;
    for (let o = 0; o < 5; o++) {
      const cells = 4 << o;
      const g = new Float32Array(cells * cells).map(() => Math.random());
      const step = size / cells;
      for (let y = 0; y < size; y++) {
        const fy = y / step, iy = Math.floor(fy), ty = fy - iy;
        const sy = ty * ty * (3 - 2 * ty);
        const y0 = iy % cells, y1 = (iy + 1) % cells;
        for (let x = 0; x < size; x++) {
          const fx = x / step, ix = Math.floor(fx), tx = fx - ix;
          const sx = tx * tx * (3 - 2 * tx);
          const x0 = ix % cells, x1 = (ix + 1) % cells;
          const a = g[y0 * cells + x0] + (g[y0 * cells + x1] - g[y0 * cells + x0]) * sx;
          const b = g[y1 * cells + x0] + (g[y1 * cells + x1] - g[y1 * cells + x0]) * sx;
          out[y * size + x] += (a + (b - a) * sy) * amp;
        }
      }
      total += amp;
      amp *= 0.5;
    }
    const bytes = new Uint8Array(size * size);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round((out[i] / total) * 255);
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, size, size, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, bytes);
    return t;
  }
  const noiseTex = makeNoise(256);

  /* ---------------- роздільність ---------------- */
  // Екран — у повній роздільності (зерно і слова чіткі),
  // сцену рахуємо в меншій: світло диска м'яке, різниці не видно.
  // Якщо пристрій не встигає — сцена крок за кроком дешевшає.
  const DPR = Math.min(devicePixelRatio || 1, 2);
  const LEVELS = [1, 0.8, 0.66, 0.54, 0.44, 0.36]; // частка від CSS-пікселя
  // стартуємо з бюджету ~0.5 Мпікс на сцену; далі автоякість знизить, якщо треба
  let level = LEVELS.findIndex(k => innerWidth * innerHeight * k * k <= 520000);
  if (level < 0) level = LEVELS.length - 1;

  const sceneTex = makeTex();
  const fbo = gl.createFramebuffer();
  let sw = 2, sh = 2;

  function resize() {
    canvas.width = Math.max(2, Math.round(innerWidth * DPR));
    canvas.height = Math.max(2, Math.round(innerHeight * DPR));
    const k = Math.min(DPR, LEVELS[level]);
    sw = Math.max(2, Math.round(innerWidth * k));
    sh = Math.max(2, Math.round(innerHeight * k));
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sw, sh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /* ---------------- текстури слів ---------------- */
  const TEXT_DPR = DPR;
  const cache = new Map();
  let fontFamily = '';

  function frameH() {
    return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--frame-h')) || 64;
  }

  function drawLine(ctx, text, maxSize, baselineOf) {
    if (!text) return;
    const spacing = -0.055;
    const native = 'letterSpacing' in ctx;
    const setFont = size => {
      ctx.font = `700 ${size}px ${fontFamily}`;
      if (native) ctx.letterSpacing = `${spacing * size}px`;
    };
    const chars = [...text];
    const widthAt = size => {
      setFont(size);
      if (native) return ctx.measureText(text).width;
      return chars.reduce((s, c) => s + ctx.measureText(c).width, 0) + spacing * size * (chars.length - 1);
    };

    const size = Math.min((100 * innerWidth * 1.04) / (widthAt(100) || 1), maxSize);
    const w = widthAt(size);
    const y = baselineOf(size);
    if (native) {
      ctx.textAlign = 'center';
      ctx.fillText(text, innerWidth / 2 - (spacing * size) / 2, y);
    } else {
      ctx.textAlign = 'left';
      let x = innerWidth / 2 - w / 2;
      for (const c of chars) {
        ctx.fillText(c, x, y);
        x += ctx.measureText(c).width + spacing * size;
      }
    }
  }

  function buildWords(top, bottom) {
    const key = `${top}|${bottom}`;
    if (cache.has(key)) return cache.get(key);
    if (!top && !bottom) return EMPTY;

    const W = Math.round(innerWidth * TEXT_DPR);
    const H = Math.round(innerHeight * TEXT_DPR);
    if (W < 2 || H < 2) return EMPTY;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    ctx.setTransform(TEXT_DPR, 0, 0, TEXT_DPR, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';
    const fh = frameH();
    drawLine(ctx, top, innerHeight * 0.3, s => fh + innerHeight * 0.01 + s * 0.77);
    drawLine(ctx, bottom, innerHeight * 0.26, s => innerHeight - (fh - innerHeight * 0.01) - s * 0.03);

    // розмита копія: послідовне зменшення вдвічі ≈ гаусове розмиття
    let src = c;
    let w = W, h = H;
    while (w > innerWidth / 8) {
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
      const d = document.createElement('canvas');
      d.width = w;
      d.height = h;
      const dc = d.getContext('2d');
      dc.imageSmoothingQuality = 'high';
      dc.drawImage(src, 0, 0, w, h);
      src = d;
    }

    const t = makeTex();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, gl.ALPHA, gl.UNSIGNED_BYTE, c);
    const b = makeTex();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, gl.ALPHA, gl.UNSIGNED_BYTE, src);
    const entry = { t, b, texel: [1 / w, 1 / h] };
    cache.set(key, entry);
    return entry;
  }

  function clearCache() {
    cache.forEach(e => { gl.deleteTexture(e.t); gl.deleteTexture(e.b); });
    cache.clear();
  }

  /* ---------------- анімація слів ---------------- */
  const ease = t => 1 - Math.pow(1 - t, 4.5);
  const now = () => performance.now() / 1000;

  function slot() {
    return { entry: EMPTY, key: '', op: 0, blur: 1, off: 0, tw: null };
  }
  let cur = slot(), old = slot();
  const dim = { v: 1, t: 1 };

  function tween(s, to, dur, delay) {
    s.tw = { from: { op: s.op, blur: s.blur, off: s.off }, to, dur, start: now() + delay };
  }
  function stepTween(s, t) {
    const tw = s.tw;
    if (!tw) return;
    const k = Math.min(1, Math.max(0, (t - tw.start) / tw.dur));
    const e = ease(k);
    for (const p in tw.to) s[p] = tw.from[p] + (tw.to[p] - tw.from[p]) * e;
    if (k >= 1) s.tw = null;
  }

  let wanted = { top: '', bottom: '' };
  api.setWords = (top = '', bottom = '', strong = true) => {
    dim.t = strong ? 1 : 0.45;
    wanted = { top, bottom };
    const key = `${top}|${bottom}`;
    if (key === cur.key) return;
    // поточні слова йдуть, нові приходять
    [cur, old] = [old, cur];
    tween(old, { op: 0, blur: 1, off: -0.03 }, 0.6, 0);
    Object.assign(cur, { entry: buildWords(top, bottom), key, op: 0, blur: 1, off: 0.045 });
    tween(cur, { op: 1, blur: 0, off: 0 }, 1.25, 0.12);
  };

  // готуємо текстури заздалегідь, по одній, щоб перемикання слайдів було миттєвим
  let warmList = [];
  let allWords = [];
  api.prewarm = list => {
    allWords = list.slice();
    warmList = list.slice();
    const next = () => {
      const item = warmList.shift();
      if (!item) return;
      buildWords(item[0] || '', item[1] || '');
      setTimeout(next, 60);
    };
    setTimeout(next, 400);
  };

  /* ---------------- камера ---------------- */
  // Кожен параметр — критично згасаюча пружина: рушає м'яко, приходить без відскоку.
  const KEYS = ['dist', 'elev', 'roll', 'ox', 'oy', 'bright'];
  const cam = {};
  const DEFAULT = { dist: 22, elev: 6, roll: 0, ox: 0, oy: 0, bright: 1 };
  KEYS.forEach(k => { cam[k] = { x: DEFAULT[k], v: 0, t: DEFAULT[k] }; });
  let firstSet = true;

  let spinKick = 0;   // додаткове обертання диска під час перельоту
  let pulseAt = -10;  // момент останнього "подиху" маси

  api.set = p => {
    KEYS.forEach(k => { if (p[k] != null && !Number.isNaN(p[k])) cam[k].t = p[k]; });
    if (firstSet) {
      KEYS.forEach(k => { cam[k].x = cam[k].t; });
      firstSet = false;
      return;
    }
    spinKick = Math.min(spinKick + 2.2, 3.5);
    pulseAt = time;
  };

  function stepSpring(s, dt, w) {
    const a = -2 * w * s.v - w * w * (s.x - s.t);
    s.v += a * dt;
    s.x += s.v * dt;
  }

  /* ---------------- події ---------------- */
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };

  let resizeT;
  addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      resize();
      clearCache();
      cur.entry = buildWords(wanted.top, wanted.bottom);
      old.op = 0;
      old.entry = EMPTY;
      if (allWords.length) api.prewarm(allWords);
    }, 120);
  });

  addEventListener('pointermove', e => {
    mouse.tx = e.clientX / innerWidth - 0.5;
    mouse.ty = 0.5 - e.clientY / innerHeight;
  }, { passive: true });

  fontFamily = getComputedStyle(document.body).fontFamily;
  resize();

  // ?fps — лічильник кадрів у кутку (для перевірки на слабкому залізі)
  let fpsEl = null, fpsN = 0, fpsT = 0;
  if (new URLSearchParams(location.search).has('fps')) {
    fpsEl = document.createElement('div');
    fpsEl.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99;font:600 12px/1 monospace;color:#fff;background:#000a;padding:6px 8px;border-radius:6px';
    document.body.appendChild(fpsEl);
  }

  /* ---------------- кадр ---------------- */
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DEG = Math.PI / 180;
  let last = performance.now();
  let lastDraw = 0;
  let time = 0;
  let rot = 0;
  let slowFrames = 0, sampled = 0;

  function bindWord(s, texUnit, blurUnit, uVec, uTex, uBlur, uTexel) {
    gl.activeTexture(gl.TEXTURE0 + texUnit);
    gl.bindTexture(gl.TEXTURE_2D, s.entry.t);
    gl.activeTexture(gl.TEXTURE0 + blurUnit);
    gl.bindTexture(gl.TEXTURE_2D, s.entry.b);
    gl.uniform1i(uTex, texUnit);
    gl.uniform1i(uBlur, blurUnit);
    gl.uniform3f(uVec, s.op, s.blur, s.off);
    gl.uniform2f(uTexel, s.entry.texel[0], s.entry.texel[1]);
  }

  function frame(ms) {
    requestAnimationFrame(frame);
    // ~60 к/с: на 120–144 Гц екранах малюємо кожен другий кадр
    // (поріг 13 мс, а не 16,6 — інакше на 144 Гц виходить кожен третій, 48 к/с)
    if (ms - lastDraw < 13) return;
    lastDraw = ms;

    const dt = Math.min(0.1, (ms - last) / 1000);
    last = ms;
    if (fpsEl) {
      fpsN++;
      if (ms - fpsT > 1000) {
        fpsEl.textContent = `${Math.round((fpsN * 1000) / (ms - fpsT))} fps · сцена ${sw}×${sh}`;
        fpsN = 0;
        fpsT = ms;
      }
    }
    const speed = reduced ? 0.25 : 1;
    time += dt * speed;

    // автоякість: якщо кадри стабільно довші за ~28 мс — сцена дешевшає
    if (!document.hidden && level < LEVELS.length - 1) {
      sampled++;
      if (dt > 0.028) slowFrames++;
      if (sampled >= 90) {
        if (slowFrames > 50) { level++; resize(); }
        sampled = 0;
        slowFrames = 0;
      }
    }

    KEYS.forEach(k => stepSpring(cam[k], dt, reduced ? 6 : 1.9));
    const km = 1 - Math.exp(-dt * 2.2);
    mouse.x += (mouse.tx - mouse.x) * km;
    mouse.y += (mouse.ty - mouse.y) * km;

    spinKick *= Math.exp(-dt * 0.9);
    rot += dt * speed * 0.2 * (1 + spinKick);

    // "подих" маси після перемикання: лінзування на мить ширшає
    const pk = (time - pulseAt) / 1.8;
    const pulse = pk > 0 && pk < 1 ? Math.pow(Math.sin(Math.PI * pk), 2) : 0;
    const mass = 1 + 0.07 * pulse * (reduced ? 0 : 1);

    const asp = innerWidth / innerHeight;
    const t = time;
    // на вузьких екранах камера трохи далі, щоб диск влазив по ширині
    const narrow = Math.pow(Math.max(1, 1.25 / asp), 0.55);
    const dist = cam.dist.x * narrow * (1 + 0.025 * Math.sin(t * 0.21));
    const elev = (cam.elev.x + 1.4 * Math.sin(t * 0.13) + mouse.y * 2.5) * DEG;
    const az = (t * 0.6 + mouse.x * 6) * DEG;
    const roll = (cam.roll.x + 0.8 * Math.sin(t * 0.09)) * DEG;
    // зсув у координатах екрана: ±1 — край
    const ox = (cam.ox.x * asp) / 2 + mouse.x * 0.012;
    const oy = cam.oy.x / 2 + mouse.y * 0.01;

    // планета: нахилена орбіта, оберт приблизно за 100 с
    const pa = t * 0.063 + 1.2;
    const pr = 9.2;
    const pin = 0.38;
    const plx = Math.cos(pa) * pr;
    const plz = Math.sin(pa) * pr;

    /* прохід 1: сцена */
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, sw, sh);
    gl.useProgram(scene.p);
    const su = scene.u;
    gl.uniform2f(su.u_res, sw, sh);
    gl.uniform3f(su.u_cam, dist, elev, az);
    gl.uniform1f(su.u_roll, roll);
    gl.uniform2f(su.u_off, ox, oy);
    gl.uniform1f(su.u_rot, rot);
    gl.uniform1f(su.u_mass, mass);
    gl.uniform1f(su.u_bright, Math.max(0, cam.bright.x));
    gl.uniform4f(su.u_pl, plx, plz * Math.sin(pin) + 1.1, plz * Math.cos(pin), 0.42);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, noiseTex);
    gl.uniform1i(su.u_noise, 5);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    /* прохід 2: екран */
    stepTween(cur, now());
    stepTween(old, now());
    dim.v += (dim.t - dim.v) * (1 - Math.exp(-dt * 1.6));

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(comp.p);
    const cu = comp.u;
    gl.uniform2f(cu.u_res, canvas.width, canvas.height);
    gl.uniform1f(cu.u_seed, reduced ? 0 : Math.floor(t * 12) % 97);
    gl.uniform1f(cu.u_dim, dim.v);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.uniform1i(cu.u_scene, 4);
    bindWord(cur, 0, 1, cu.u_a, cu.u_ta, cu.u_ba, cu.u_texelA);
    bindWord(old, 2, 3, cu.u_b, cu.u_tb, cu.u_bb, cu.u_texelB);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  requestAnimationFrame(frame);
})();
