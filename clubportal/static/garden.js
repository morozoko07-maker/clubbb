/* Garden — the Type Garden drawing engine, ported to plain canvas JS.
   Stems, woven layers, thorns, leaves, spring-opened roses with a spiral
   heart, boil jitter, pointer lean and butterflies.

   Two kinds of scene:
     Garden.text(canvas, { text, clock?, fill?, flies? })  letters that grow a garden
     Garden.field(canvas, { progress })                    a curtain of roses (0..1)
   `clock` / `progress` are functions, so growth can follow time or scroll. */
(function () {
  "use strict";
  var FONT = '"Playfair Display", Georgia, serif';
  var MONO = '"DM Mono", ui-monospace, monospace';
  var SLEEK = '"Bodoni Moda", Didot, serif';
  var SCRIPT = '"Pinyon Script", cursive';
  var SMONO = '"JetBrains Mono", ui-monospace, monospace';
  // pointer velocity, shared by every scene (px per ms)
  var ptr = { x: 0, y: 0, vx: 0, vy: 0, t: 0, speed: 0 };
  var PI = Math.PI;

  // ---------- math ----------
  function h(n) { var x = Math.sin(n) * 43758.5453; return x - Math.floor(x); }
  function spr(t, k, w) { k = k || 7; w = w || 16; if (t <= 0) return 0; return 1 - Math.exp(-t * k) * Math.cos(t * w); }
  function eo(t) { if (t <= 0) return 0; if (t >= 1) return 1; return 1 - Math.pow(1 - t, 3); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function rng(seed) {
    var s = seed | 0;
    return function () { s = (s + 0x6D2B79F5) | 0; var t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function bez(a, b, c, d, n) {
    var P = [];
    for (var i = 0; i <= n; i++) { var t = i / n, u = 1 - t;
      P.push([u*u*u*a[0] + 3*u*u*t*b[0] + 3*u*t*t*c[0] + t*t*t*d[0], u*u*u*a[1] + 3*u*u*t*b[1] + 3*u*t*t*c[1] + t*t*t*d[1]]); }
    return P;
  }
  function at(P, u) {
    var n = P.length, i = Math.min(n - 2, Math.max(1, Math.round(u * (n - 1))));
    return [P[i], Math.atan2(P[i+1][1] - P[i-1][1], P[i+1][0] - P[i-1][0])];
  }
  function jit(id, f, amp) {
    if (!amp) return [0, 0, 0];
    return [(h(id*1.37 + f*7.13)*2 - 1)*amp, (h(id*2.71 + f*3.11)*2 - 1)*amp, (h(id*5.3 + f*1.7)*2 - 1)*0.035];
  }
  function path(c, p, closed) {
    var n = p.length; if (n < 2) return;
    var m = function (a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }, i, q;
    if (closed) {
      var s = m(p[n-1], p[0]); c.moveTo(s[0], s[1]);
      for (i = 0; i < n; i++) { q = m(p[i], p[(i+1) % n]); c.quadraticCurveTo(p[i][0], p[i][1], q[0], q[1]); }
      c.closePath();
    } else {
      c.moveTo(p[0][0], p[0][1]);
      for (i = 1; i < n - 1; i++) { q = m(p[i], p[i+1]); c.quadraticCurveTo(p[i][0], p[i][1], q[0], q[1]); }
      c.lineTo(p[n-1][0], p[n-1][1]);
    }
  }
  function backend(g) {
    return {
      fill: function (p, col) { g.beginPath(); path(g, p, true); g.fillStyle = col; g.fill(); },
      stroke: function (p, col, w) { g.beginPath(); path(g, p, false); g.strokeStyle = col; g.lineWidth = w; g.lineCap = "round"; g.lineJoin = "round"; g.stroke(); },
      rect: function (x, y, w, hh, col) { g.fillStyle = col; g.fillRect(x, y, w, hh); },
      text: function (ch, x, y, S, col) { g.font = "700 " + S + "px " + FONT; g.textAlign = "center"; g.textBaseline = "alphabetic"; g.fillStyle = col; g.fillText(ch, x, y); }
    };
  }
  function vine(base, dir, len, amp, waves, ph, bend, n) {
    n = n || 40; var P = [[base[0], base[1]]], step = len / n, x = base[0], y = base[1];
    for (var i = 1; i <= n; i++) {
      var u = i / n, a = dir + bend * u + amp * Math.sin(u * PI * waves + ph) * Math.min(1, u * 3);
      x += Math.cos(a) * step; y += Math.sin(a) * step; P.push([x, y]);
    }
    return P;
  }
  function curl(P, sign, rad) {
    var n = P.length, e = P[n - 1], a = Math.atan2(e[1] - P[n - 2][1], e[0] - P[n - 2][0]);
    var c = [e[0] - Math.sin(a) * sign * rad, e[1] + Math.cos(a) * sign * rad];
    var a0 = Math.atan2(e[1] - c[1], e[0] - c[0]);
    for (var i = 1; i <= 14; i++) { var u = i / 14, t = a0 + sign * u * PI * 1.6, rr = rad * (1 - 0.5 * u); P.push([c[0] + Math.cos(t) * rr, c[1] + Math.sin(t) * rr]); }
    return P;
  }
  function weave(r, startLayer) {
    var cuts = [], nc = 1 + Math.floor(r() * 3), i;
    for (i = 0; i < nc; i++) cuts.push(0.15 + r() * 0.7);
    cuts.sort(function (a, b) { return a - b; });
    var segs = [], u0 = 0, layer = startLayer;
    for (i = 0; i < cuts.length; i++) {
      var c = cuts[i]; if (c <= u0) continue;
      segs.push({ u0: u0, u1: c, layer: layer });
      if (r() < 0.3) u0 = Math.min(0.98, c + 0.02 + r() * 0.03); else u0 = c;
      layer = 1 - layer;
    }
    segs.push({ u0: u0, u1: 1, layer: layer });
    return segs;
  }
  function layerAt(segs, u) { for (var i = 0; i < segs.length; i++) if (u >= segs[i].u0 && u <= segs[i].u1) return segs[i].layer; return segs[segs.length - 1].layer; }

  // ---------- growth ----------
  function wordParams(ws, dens) {
    var r = rng(ws * 7 + 13);
    return { roseP: 0.3 + r() * 0.3, leafy: (0.6 + r() * 0.8) * dens, dens: dens, lean: (r() - 0.5) * 0.6, big: 0.85 + r() * 0.45, curvy: 0.8 + r() * 0.6, bridgeP: Math.min(0.95, (0.45 + r() * 0.35) * dens), w: 0.5 };
  }
  function grow(r, E, nid, p, o) {
    var tip = o.tip || (r() < p.roseP ? "rose" : r() < 0.45 ? "fan" : r() < 0.6 ? "leaf" : "curl");
    var P = o.pts || vine(o.base, o.dir, o.len, (0.35 + r() * 0.45) * p.curvy, 1 + r() * 1.6, r() * 6.28, (r() - 0.5) * 1.2, 40);
    if (tip === "curl") P = curl(P, r() < 0.5 ? -1 : 1, 0.05 + r() * 0.05);
    var segs = weave(r, o.layer0 != null ? o.layer0 : (r() < 0.5 ? 0 : 1));
    var dur = Math.max(320, (o.len || 0.8) * 620);
    var thorns = [], nt = Math.floor(r() * 2.5), i;
    for (i = 0; i < nt; i++) thorns.push({ u: 0.15 + r() * 0.65, s: r() < 0.5 ? -1 : 1 });
    E.push({ t: "stem", id: nid(), pts: P, segs: segs, d0: o.d0, dur: dur, w: (o.depth ? 0.82 : 1) * (p.sw || 1), thorns: thorns });
    var nl = Math.floor(r() * 2.8 * p.leafy), sd = r() < 0.5 ? -1 : 1;
    for (i = 0; i < nl; i++) {
      var u = 0.25 + r() * 0.6, qa = at(P, u); sd = -sd;
      E.push({ t: "leaf", id: nid(), x: qa[0][0], y: qa[0][1], a: qa[1] + sd * (0.55 + r() * 0.5), L: (0.14 + r() * 0.2) * (o.depth ? 0.8 : 1) * (p.leafL || 1), bend: (r() - 0.5) * 1.2, layer: layerAt(segs, u), d0: o.d0 + dur * u });
    }
    var ta0 = at(P, 1), tp = ta0[0], ta = ta0[1], td = o.d0 + dur * 0.8, tl = layerAt(segs, 1);
    if (tip === "rose") {
      var R = (0.13 + r() * 0.15) * p.big * (o.depth ? 0.75 : 1);
      var over = tp[1] > -0.78 && tp[1] < 0.05 && Math.abs(tp[0]) < p.w * 0.5;
      var layer = over ? (r() < 0.22 ? 1 : 0) : (r() < 0.6 ? 1 : tl);
      E.push({ t: "rose", id: nid(), x: tp[0], y: tp[1], R: R, rot: (r() - 0.5) * 1.0, ph1: r() * 6.28, ph2: r() * 6.28, turns: 1.8 + r(), layer: layer, d0: td });
      if (r() < 0.2) { var oo = ta + (r() < 0.5 ? 1 : -1) * 1.3; E.push({ t: "rose", id: nid(), x: tp[0] + Math.cos(oo) * R * 1.4, y: tp[1] + Math.sin(oo) * R * 1.4, R: R * (0.6 + r() * 0.3), rot: (r() - 0.5) * 1.2, ph1: r() * 6.28, ph2: r() * 6.28, turns: 1.8 + r(), layer: layer, d0: td + 120 }); }
    } else if (tip === "fan") {
      var spread = 0.6 + r() * 0.3;
      for (var j = 0; j < 2; j++) E.push({ t: "leaf", id: nid(), x: tp[0], y: tp[1], a: ta + (j - 0.5) * spread, L: (0.2 + r() * 0.2) * (p.leafL || 1), bend: (j - 0.5) * 0.8, layer: tl, d0: td + j * 60 });
    } else if (tip === "leaf") {
      E.push({ t: "leaf", id: nid(), x: tp[0], y: tp[1], a: ta + (r() - 0.5) * 0.3, L: (0.16 + r() * 0.16) * (p.leafL || 1), bend: r() - 0.5, layer: tl, d0: td });
    }
    if (!o.depth && r() < (p.branch || 0.3)) {
      var u2 = 0.35 + r() * 0.35, qb = at(P, u2);
      grow(r, E, nid, p, { base: qb[0], dir: qb[1] + (r() < 0.5 ? -1 : 1) * (0.7 + r() * 0.4), len: (o.len || 0.8) * (0.35 + r() * 0.2), d0: o.d0 + dur * u2, depth: 1, layer0: layerAt(segs, u2), tip: p.forceRose && r() < 0.7 ? "rose" : null });
    }
    return P;
  }

  // ---------- drawing ----------
  function strokeRange(B, P, a, b, col, w) {
    var n = P.length - 1, ia = a * n, ib = b * n;
    var lerp = function (t) { var i = Math.min(n - 1, Math.floor(t)), f = t - i; return [P[i][0] + (P[i+1][0] - P[i][0]) * f, P[i][1] + (P[i+1][1] - P[i][1]) * f]; };
    var pts = [lerp(ia)];
    for (var i = Math.floor(ia) + 1; i < ib; i++) pts.push(P[i]);
    pts.push(lerp(ib));
    if (pts.length >= 2) B.stroke(pts, col, w);
  }
  function thorn(B, P, u, s, S, C) {
    var pa = at(P, u), p = pa[0], d = pa[1] + s * 2.3, L = S * 0.045;
    B.stroke([p, [p[0] + Math.cos(d) * L, p[1] + Math.sin(d) * L]], C.blue, S * 0.022);
  }
  function leaf(B, bx, by, a, L, bend, C) {
    if (L < 0.5) return;
    var ca = Math.cos(a), sa = Math.sin(a), px = -sa, py = ca;
    var ax = function (u) { var b = Math.sin(PI * u) * bend * 0.15 * L; return [bx + ca * u * L + px * b, by + sa * u * L + py * b]; };
    var hw = function (u) { return L * 0.18 * Math.sin(PI * Math.pow(u, 0.8)); };
    var N = 12, s1 = [], s2 = [], i;
    for (i = 0; i <= N; i++) { var u = i / N, c = ax(u), w = hw(u); s1.push([c[0] + px * w, c[1] + py * w]); s2.push([c[0] - px * w, c[1] - py * w]); }
    var tip = ax(1), base = ax(0);
    B.fill([base].concat(s1.slice(1, N), [tip, tip], s2.slice(1, N).reverse(), [base]), C.blue);
    if (L > 6) { var v = []; for (i = 0; i <= 8; i++) v.push(ax(0.08 + 0.72 * i / 8)); B.stroke(v, C.vein, Math.max(0.8, L * 0.03)); }
  }
  var PETALS = [
    [0, -0.36, 0.56, 0.54, 0, 0, 0],
    [-0.5, -0.06, 0.6, 0.6, -0.35, 0, 0],
    [0.52, -0.06, 0.6, 0.6, 0.35, 0, 0],
    [-0.42, 0.3, 0.62, 0.48, 0.2, 0.12, 1],
    [0.47, 0.3, 0.62, 0.48, -0.2, 0.12, 1],
    [0.05, 0.42, 0.56, 0.38, 0, 0.14, 0]
  ];
  function rose(B, cx, cy, R, rot, e, a, tl, C) {
    var cr = Math.cos(rot), sr = Math.sin(rot);
    var tm = tl ? Math.hypot(tl[0], tl[1]) : 0, ux = tm ? tl[0] / tm : 0, uy = tm ? tl[1] / tm : 0, sq = -0.28 * tm;
    var T = function (x, y, z) {
      z = z || 0;
      var dx = x * cr - y * sr, dy = x * sr + y * cr;
      if (tm) { var k = (dx * ux + dy * uy) * sq; dx += k * ux + tl[0] * R * z; dy += k * uy + tl[1] * R * z; }
      return [cx + dx, cy + dy];
    };
    var ay0 = 0.5, lw = Math.max(0.8, R * 0.045), st = 85;
    PETALS.forEach(function (q, i) {
      var s = spr((a - i * st) / 1000, 8, 14); if (s <= 0.001) return;
      var open = (1 - Math.min(1, s)) * (q[0] < 0 ? 0.5 : -0.5), ang = q[4] + open, ca = Math.cos(ang), sa = Math.sin(ang);
      var pt = function (th) {
        var rr = 1 + 0.08 * Math.sin(3 * th + e.ph1 + i) + 0.04 * Math.sin(5 * th + e.ph2);
        var lx = Math.cos(th) * q[2] * rr, ly = Math.sin(th) * q[3] * rr;
        var px = q[0] + lx * ca - ly * sa, py = q[1] + lx * sa + ly * ca;
        return T(px * s * R, (ay0 + (py - ay0) * s) * R, q[5]);
      };
      var pts = []; for (var k = 0; k < 26; k++) pts.push(pt(k / 26 * PI * 2));
      B.fill(pts, C.red);
      if (q[6] && R >= 12 && s > 0.4) {
        var arc = []; for (k = 0; k <= 14; k++) arc.push(pt(PI * (1.18 + 0.64 * k / 14)));
        strokeRange(B, arc, 0, Math.min(1, (s - 0.4) / 0.5), C.line, lw * 0.8);
      }
    });
    var fr = eo((a - PETALS.length * st - 80) / 520);
    if (fr > 0 && R > 3) {
      var sp = [], scl = [], i;
      var turns = R < 20 ? Math.min(e.turns, 1.3) : R < 32 ? e.turns * 0.8 : e.turns;
      for (i = 0; i <= 70; i++) { var u = i / 70, th = e.ph1 + u * turns * PI * 2, rr = R * (0.08 + 0.57 * u); sp.push(T(Math.cos(th) * rr * 1.05, Math.sin(th) * rr * 0.72 - 0.12 * R, 0.34 - 0.24 * u)); }
      strokeRange(B, sp, 0, fr, C.line, lw);
      if (R >= 14) {
        for (i = 0; i <= 36; i++) { var u2 = i / 36; scl.push(T((-0.72 + 1.5 * u2) * R, 0.36 * R + 0.16 * R * Math.abs(Math.sin(u2 * PI * 3)), 0.18)); }
        strokeRange(B, scl, 0, fr, C.line, lw);
      }
    }
  }
  function butterfly(B, x, y, s, ang, o, C) {
    var ca = Math.cos(ang), sa = Math.sin(ang), T = function (px, py) { return [x + (px * ca - py * sa) * s, y + (px * sa + py * ca) * s]; };
    var wing = function (cx, cy, rx, ry, a, side) {
      var pts = [], c = Math.cos(a), sn = Math.sin(a);
      for (var k = 0; k < 22; k++) { var th = k / 22 * PI * 2, r = 1 + 0.08 * Math.sin(th * 3), lx = Math.cos(th) * rx * r, ly = Math.sin(th) * ry * r; pts.push(T(side * (cx + lx * c - ly * sn) * (0.12 + 0.88 * o), cy + lx * sn + ly * c)); }
      return pts;
    };
    [-1, 1].forEach(function (sd) {
      B.fill(wing(0.46, 0.28, 0.36, 0.3, 0.5, sd), C.text);
      B.fill(wing(0.55, -0.32, 0.55, 0.36, -0.55, sd), C.text);
      if (o > 0.35) B.fill(wing(0.66, -0.4, 0.13, 0.11, 0, sd), C.red);
    });
    var body = []; for (var k = 0; k < 18; k++) { var th = k / 18 * PI * 2; body.push(T(Math.cos(th) * 0.08, Math.sin(th) * 0.48)); }
    B.fill(body, C.blue);
    var lw = Math.max(0.8, s * 0.05);
    B.stroke([T(0, -0.42), T(-0.14, -0.72), T(-0.24, -0.86)], C.blue, lw);
    B.stroke([T(0, -0.42), T(0.14, -0.72), T(0.24, -0.86)], C.blue, lw);
  }

  // ---------- palette from CSS ----------
  function colors() {
    var cs = getComputedStyle(document.documentElement), v = function (n, d) { return cs.getPropertyValue(n).trim() || d; };
    return { red: v("--flower", "#FF1400"), blue: v("--stem", "#3257FF"), line: v("--line", "#FFB4A8"), text: v("--ink", "#FFFFFF"), vein: v("--bg", "#000000"), bg: v("--bg", "#000000"), accent: v("--accent", "#FF1400") };
  }
  function mode() { return document.documentElement.getAttribute("data-theme") === "mono" ? "signal" : "bloom"; }

  // ---------- scene ----------
  var widthCache = {}, measureCtx = document.createElement("canvas").getContext("2d");
  function mw(ch) {
    if (widthCache[ch] != null) return widthCache[ch];
    measureCtx.font = "700 100px " + FONT;
    var w = measureCtx.measureText(ch).width / 100;
    if (ch === " ") w *= 1.4;
    return (widthCache[ch] = w);
  }
  var scenes = [];
  var GLYPHS = "@#%*+=-:. ".split("");
  var SCRAMBLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=<>/\\".split("");

  function Scene(canvas, o) {
    this.cv = canvas; this.g = canvas.getContext("2d"); this.o = o || {};
    this.kind = this.o.kind || "text";
    this.t0 = performance.now(); this.flies = []; this.perch = []; this.fa = {};
    this.mx = null; this.my = null; this.visible = true; this.seed = this.o.seed || ((Math.random() * 1e9) | 0);
    this.dens = this.o.density || 1;
    this.C = colors();
    var self = this;
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (es) { es.forEach(function (e) { self.visible = e.isIntersecting; if (self.visible && typeof kick === "function") kick(); }); }).observe(canvas);
    }
    this.resize();
    if (this.kind === "text") this.setText(this.o.text || "");
    scenes.push(this);
    kick();
  }
  Scene.prototype.resize = function () {
    this._drawn = false;
    if (typeof kick === "function") kick();
    var r = this.cv.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1);
    if (!r.width || !r.height) return;
    this.W = r.width; this.H = r.height; this.dpr = d;
    this.cv.width = Math.round(r.width * d); this.cv.height = Math.round(r.height * d);
    if (this.kind === "text") this.layout(); else this.genField();
  };
  Scene.prototype.setText = function (text) {
    var rand = rng(this.seed), L = [], prev = null, uid = 1, stagger = this.o.stagger != null ? this.o.stagger : 90, t = 0;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === " ") {
        if (prev && prev.ch !== " ") { prev.cut = t; prev.endEls = this.genEnd(prev, t - prev.birth, rand); }
        prev = { ch: " ", id: uid++, birth: t, els: [] }; L.push(prev); t += stagger; continue;
      }
      var same = prev && prev.ch !== " ";
      var l = { ch: ch, id: uid++, birth: t, tb: t, ws: same ? prev.ws : Math.floor(rand() * 1e9), wi: same ? prev.wi + 1 : 0, prev: same ? prev : null, lean: [0, 0] };
      this.gen(l, rand); L.push(l); prev = l; t += stagger;
    }
    this.letters = L; this.total = t + 2400;
    this.layout();
  };
  Scene.prototype.gen = function (l, rand) {
    var r = rng((l.ws ^ Math.imul(l.wi + 1, 2654435761)) + Math.floor(rand() * 1e6));
    var p = wordParams(l.ws, this.dens), E = [], k0 = 0, nid = function () { return l.id * 100 + (k0++); };
    var w = mw(l.ch), inX = function () { return (r() - 0.5) * w * 0.7; }; p.w = w;
    var nUp = 1 + (r() < 0.45 * p.dens ? 1 : 0), i;
    for (i = 0; i < nUp; i++) grow(r, E, nid, p, { base: [inX(), -r() * 0.3], dir: -PI / 2 + p.lean * 0.5 + (r() - 0.5) * 0.7, len: 0.6 + r() * 0.5, d0: 40 + i * 130, tip: l.wi === 0 && i === 0 ? "rose" : null });
    if (r() < 0.4 * p.dens) grow(r, E, nid, p, { base: [inX(), -0.1 - r() * 0.35], dir: PI / 2 + (r() - 0.5) * 0.8, len: 0.35 + r() * 0.35, d0: 160 });
    if (l.prev && r() < p.bridgeP) {
      var px = -(mw(l.prev.ch) + w) / 2;
      var a = [inX(), -0.05 - r() * 0.55], b = [px + (r() - 0.5) * 0.25, -0.05 - r() * 0.55];
      var bulge = (r() < 0.55 ? -1 : 1) * (0.4 + r() * 0.4), dx = b[0] - a[0];
      var P = bez(a, [a[0] + dx * 0.15, a[1] + bulge], [b[0] - dx * 0.15, b[1] + bulge * 0.9], b, 40);
      if (r() < 0.45) P = P.slice(0, Math.floor(P.length * (0.7 + r() * 0.2)));
      grow(r, E, nid, p, { pts: P, len: Math.abs(dx) + Math.abs(bulge), d0: 90, tip: r() < 0.5 ? "curl" : r() < 0.5 ? "leaf" : "rose" });
    }
    if (l.wi === 0) grow(r, E, nid, p, { base: [-w * 0.3, -0.15 - r() * 0.4], dir: PI + (r() - 0.5) * 1.2, len: 0.45 + r() * 0.3, d0: 120, tip: "curl" });
    l.els = E;
    var T = [], tr = rng(l.id * 977 + Math.floor(rand() * 1e6));
    grow(tr, T, function () { return l.id * 100 + 90 + T.length; }, p, { base: [w * 0.25, -0.1 - tr() * 0.45], dir: (tr() - 0.5) * 1.4, len: 0.45 + tr() * 0.25, d0: 0, tip: "curl", depth: 1 });
    l.tend = T.filter(function (e) { return e.t === "stem"; }).slice(0, 1);
  };
  Scene.prototype.genEnd = function (l, rel, rand) {
    var r = rng(l.ws + l.wi * 31 + Math.floor(rand() * 1e6)), p = wordParams(l.ws, this.dens), E = [];
    var k0 = 50, nid = function () { return l.id * 100 + (k0++); };
    var w = mw(l.ch), n = 1 + Math.floor(r() * 2.5); p.w = w;
    for (var i = 0; i < n; i++) {
      var dir = -PI / 2 + 0.6 + (i - (n - 1) / 2) * 0.9 + (r() - 0.5) * 0.4;
      grow(r, E, nid, p, { base: [(r() - 0.2) * w * 0.6, -r() * 0.5], dir: dir, len: 0.4 + r() * 0.45, d0: rel + 40 + i * 90, depth: 1, tip: i === 0 || r() < 0.5 ? "rose" : "fan" });
    }
    return E;
  };
  // fit the type (single line, or wrapped by words) leaving headroom for the garden
  Scene.prototype.layout = function () {
    if (!this.W || !this.letters) return;
    var A = this.letters, W = this.W, H = this.H, fill = this.o.fill || 0.34, maxW = W * (this.o.maxW || 0.84);
    var words = [], cur = [];
    A.forEach(function (l, i) { if (l.ch === " ") { if (cur.length) words.push(cur); cur = []; } else cur.push(i); });
    if (cur.length) words.push(cur);
    var ww = function (wd) { return wd.reduce(function (s, i) { return s + mw(A[i].ch); }, 0); };
    var total = A.reduce(function (s, l) { return s + mw(l.ch); }, 0);
    var S = Math.min(H * fill, maxW / Math.max(0.01, total)), lines = [words];
    if (words.length > 1 && S < H * fill * 0.55) {
      // wrap: greedy by words at the largest size that fits
      var best = null;
      for (var s = H * fill; s > 8; s *= 0.94) {
        var ls = [[]], lw = 0, sp = mw(" ") * s;
        words.forEach(function (wd) { var x = ww(wd) * s; if (lw > 0 && lw + sp + x > maxW) { ls.push([]); lw = 0; } lw += (lw ? sp : 0) + x; ls[ls.length - 1].push(wd); });
        if (ls.length * 1.9 * s <= H * 0.86 && ls.every(function (li) { return li.reduce(function (a, wd) { return a + ww(wd) * s; }, 0) + (li.length - 1) * sp <= maxW; })) { best = { S: s, ls: ls }; break; }
      }
      if (best) { S = best.S; lines = best.ls; }
    }
    var n = lines.length, lh = 1.9 * S, sp2 = mw(" ") * S, oy = this.o.oy || 0;
    lines.forEach(function (li, k) {
      var width = li.reduce(function (a, wd) { return a + ww(wd) * S; }, 0) + (li.length - 1) * sp2;
      var x = W / 2 - width / 2, y = H / 2 + (k - (n - 1) / 2) * lh + 0.33 * S + oy * H;
      li.forEach(function (wd, wi) {
        if (wi) x += sp2;
        wd.forEach(function (i) { var l = A[i], w = mw(l.ch) * S; l.x = x + w / 2; l.y = y; l.tw = w; x += w; });
      });
    });
    this.S = S;
  };
  // a curtain of tall roses from the bottom and top edges
  Scene.prototype.genField = function () {
    var W = this.W, H = this.H; if (!W) return;
    var small = !!this.o.small, r = rng(this.seed), S = this.S = small ? Math.max(40, Math.min(W, H) * 0.2) : Math.max(90, Math.min(W, H) * 0.24), L = [], uid = 1;
    var n = Math.ceil(W / (S * (small ? 0.5 : 0.72))) + 1;   // fewer, fuller plants: same cover, less drawing
    var self = this;
    [1, 0].forEach(function (bottom) {
      for (var i = 0; i < n; i++) {
        var l = { ch: "", id: uid++, x: (i + 0.2 + r() * 0.6) * W / n, y: bottom ? H + S * 0.05 : -S * 0.05, birth: r() * 500, lean: [0, 0], els: [] };
        var p = wordParams(Math.floor(r() * 1e9), 1.2), k0 = 0, nid = function () { return l.id * 100 + (k0++); };
        p.big = 1.9 + r() * 1.1; p.roseP = 0.9; p.branch = 0.75; p.forceRose = true; p.sw = 1.5; p.leafL = 1.4; p.w = 0;
        var stems = bottom ? 3 : 2;
        for (var j = 0; j < stems; j++) {
          var len = ((bottom ? 2.2 : 1.3) + r() * (bottom ? 2.4 : 1.6)) * (small ? 0.42 : 1);
          grow(r, l.els, nid, p, { base: [(r() - 0.5) * 0.4, 0], dir: (bottom ? -PI / 2 : PI / 2) + (r() - 0.5) * 0.9, len: len, d0: j * 140 + r() * 260, tip: r() < 0.85 ? "rose" : "fan" });
        }
        L.push(l);
      }
    });
    this.letters = L;
    this.total = small ? 2600 : 3600;
    self.fieldGlyphs = null;
  };

  Scene.prototype.age = function (now) {
    if (this.kind === "field") return clamp(this.o.progress ? this.o.progress() : 0, 0, 1) * this.total;
    return this.o.clock ? this.o.clock(now) : now - this.t0;
  };
  Scene.prototype.near = function (x, y) { return this.mx != null ? [this.mx, this.my] : null; };
  Scene.prototype.faceTurn = function (e, x, y) {
    var wx = 0, wy = 0, A = this.near(x, y);
    if (A) {
      var dx = A[0] - x, dy = A[1] - y, d = Math.hypot(dx, dy), reach = 300;
      if (d < reach && d > 0.001) { var w = 1 - d / reach, s = w * w * (3 - 2 * w) * Math.min(1, d / 40); wx = dx / d * s; wy = dy / d * s; }
    }
    var c = this.fa[e.id] || [0, 0];
    c[0] += (wx - c[0]) * 0.09; c[1] += (wy - c[1]) * 0.09;
    this.fa[e.id] = c; return c;
  };
  Scene.prototype.wpt = function (l, x, y, age, now) {
    var S = this.S;
    var t = (age - l.birth) / 1000;
    if (t > 0 && t < 2.5) {
      var hh = Math.max(0, (l.y - y) / S), dmp = Math.exp(-t * 3.2), dir = (l.id % 2 ? 1 : -1);
      x += S * 0.07 * hh * dmp * Math.sin(t * 11) * dir; y += S * 0.035 * hh * dmp * Math.sin(t * 11 + 1.2);
    }
    if (l.lean) {
      var hh2 = Math.min(2.5, Math.abs(l.y - y) / S), f = hh2 * hh2 * 0.5 + hh2 * 0.5;
      x += l.lean[0] * S * 0.1 * f; y += l.lean[1] * S * 0.05 * f;
      if (l.sx) { x += l.sx * S * 0.13 * f; y += Math.abs(l.sx) * S * 0.025 * f; }
    }
    if (this.kind === "field") { // breathe
      var hb = Math.abs(l.y - y) / S, ph = now / 3000 * PI * 2;
      x += Math.sin(ph + l.x * 0.004 + hb * 1.1) * S * 0.03 * hb;
    }
    return [x, y];
  };
  Scene.prototype.drawStem = function (B, e, l, age, f, amp, layer, frO) {
    var S = this.S, fr = frO != null ? frO : eo((age - l.birth - e.d0) / e.dur); if (fr <= 0) return;
    var j = jit(e.id, f, amp), self = this, now = this._now, C = this.C;
    var P = e.pts.map(function (p) { return self.wpt(l, l.x + p[0] * S + j[0], l.y + p[1] * S + j[1], age, now); });
    for (var i = 0; i < e.segs.length; i++) {
      var sg = e.segs[i]; if (sg.layer !== layer) continue;
      var b = Math.min(sg.u1, fr); if (b <= sg.u0) continue;
      strokeRange(B, P, sg.u0, b, C.blue, S * 0.022 * (e.w || 1));
    }
    for (i = 0; i < e.thorns.length; i++) { var th = e.thorns[i]; if (fr > th.u && layerAt(e.segs, th.u) === layer) thorn(B, P, th.u, th.s, S, C); }
  };
  Scene.prototype.drawEl = function (B, e, l, age, f, amp) {
    var S = this.S, j = jit(e.id, f, amp), self = this, now = this._now;
    var wx = function (x, y) { return self.wpt(l, l.x + x * S + j[0], l.y + y * S + j[1], age, now); };
    var a = age - l.birth - e.d0;
    if (e.t === "leaf") {
      var sc = spr(a / 1000, 7, 15); if (sc <= 0) return;
      var p = wx(e.x, e.y), flut = Math.sin(now / 520 + e.id * 1.7) * 0.05 + (l.sx || 0) * (0.45 + 0.35 * Math.sin(e.id)) + (l.sv || 0) * 2.2;
      leaf(B, p[0], p[1], e.a + j[2] + flut, e.L * S * sc * (1 - Math.min(0.35, Math.abs(l.sv || 0) * 1.5)), e.bend + (l.sx || 0) * 0.8, this.C);
    } else if (e.t === "rose") {
      if (a < 0) return;
      var q = wx(e.x, e.y), tl = this.o.face !== false ? this.faceTurn(e, q[0], q[1]) : null;
      if (a > 700) this.perch.push({ id: e.id, x: q[0], y: q[1], R: e.R * S });
      rose(B, q[0], q[1], e.R * S, e.rot + j[2] + (tl ? tl[0] * 0.22 : 0) + (l.sx || 0) * 0.35, e, a, tl, this.C);
    }
  };
  // each plant is a damped spring pushed by the pointer's velocity
  Scene.prototype.stepSprings = function () {
    var L = this.letters, S = this.S || 1, energy = 0;
    if (!L) return 0;
    var fast = ptr.speed > 0.08 && performance.now() - ptr.t < 60, reach = Math.max(120, S * (this.kind === "field" ? 1.1 : 1.6));
    for (var i = 0; i < L.length; i++) {
      var l = L[i]; if (l.ch === " " || l.x == null) continue;
      if (l.sx == null) { l.sx = 0; l.sv = 0; }
      if (fast && this.mx != null) {
        var cy = this.kind === "field" ? (l.y > this.H / 2 ? l.y - S * 1.6 : l.y + S * 1.0) : l.y - S * 0.6;
        var d = this.kind === "field" ? Math.abs(this.mx - l.x) : Math.hypot(this.mx - l.x, this.my - cy);
        if (d < reach) { var w = 1 - d / reach; l.sv += clamp(ptr.vx, -3, 3) * w * w * 0.05; }
      }
      if (l.kick) { l.sv += l.kick; l.kick = 0; }
      l.sv += -l.sx * 0.055; l.sv *= 0.9; l.sx = clamp(l.sx + l.sv, -1.6, 1.6);
      energy += Math.abs(l.sx) + Math.abs(l.sv);
    }
    return energy;
  };
  // a tap shakes the plants near it
  Scene.prototype.shake = function (x, y, power) {
    var S = this.S || 1, L = this.letters || [];
    for (var i = 0; i < L.length; i++) {
      var l = L[i]; if (l.x == null) continue;
      var d = Math.hypot(x - l.x, y - (l.y - S * 0.5)), reach = S * 2.4;
      if (d < reach) l.kick = (l.kick || 0) + (x < l.x ? 1 : -1) * (1 - d / reach) * (power || 0.6);
    }
  };
  Scene.prototype.render = function (B, age, now) {
    var S = this.S, L = this.letters, self = this;
    this.perch = [];
    for (var i = 0; i < L.length; i++) {
      var l = L[i], tx = 0, ty = 0;
      if (l.ch !== " " && this.mx != null) {
        var dx = this.mx - l.x, dy = this.my - (l.y - S * 0.6), d = Math.hypot(dx, dy), reach = Math.max(260, S * 3.2);
        if (d < reach && d > 1) { var w = 1 - d / reach, s = w * w * (3 - 2 * w); tx = dx / d * s; ty = dy / d * s; }
      }
      if (l.lean) { l.lean[0] += (tx - l.lean[0]) * 0.07; l.lean[1] += (ty - l.lean[1]) * 0.07; }
    }
    var f = Math.floor(now / 120), amp = Math.max(0.8, S * 0.01);
    var draw = function (layer) {
      for (var i = 0; i < L.length; i++) {
        var l = L[i]; if (l.ch === " " || !l.els) continue;
        var each = function (e) { if (e.t === "stem") self.drawStem(B, e, l, age, f, amp, layer); else if (e.layer === layer) self.drawEl(B, e, l, age, f, amp); };
        l.els.forEach(each);
        if (l.endEls) l.endEls.forEach(each);
        if (l.tend) {
          var fr = eo((age - l.tb - 150) / 450);
          if (l.cut != null) fr *= 1 - eo((age - l.cut) / 150) * 0.85;
          if (fr > 0.001) for (var k = 0; k < l.tend.length; k++) self.drawStem(B, l.tend[k], l, age, f, amp, layer, fr);
        }
      }
    };
    draw(0);
    if (this.kind === "text") for (i = 0; i < L.length; i++) {
      var lt = L[i]; if (lt.ch === " ") continue;
      var ta = eo((age - lt.birth) / 260);
      if (ta <= 0) continue;
      this.g.globalAlpha = ta;
      B.text(lt.ch, lt.x, lt.y + (1 - ta) * S * 0.08, S, this.C.text);
      this.g.globalAlpha = 1;
    }
    draw(1);
  };

  // ---------- signal (ASCII) renderers ----------
  // Mono: thin didone capitals rising out of a mask, a script word written across them
  Scene.prototype.renderSignalText = function (age, now) {
    var g = this.g, L = this.letters, S = this.S, C = this.C, W = this.W, lines = {}, keys = [], lite = this.o.lite;
    L.forEach(function (l) { if (l.y == null) return; var k = Math.round(l.y); if (!lines[k]) { lines[k] = []; keys.push(k); } lines[k].push(l); });
    g.textBaseline = "alphabetic"; g.textAlign = "left";
    var track = 0.06, box = null;
    for (var q = 0; q < keys.length; q++) {
      var row = lines[keys[q]], tw = 0, i;
      g.font = "400 100px " + SLEEK;
      var ws = row.map(function (l) { var w = g.measureText(l.ch === " " ? " " : l.ch.toUpperCase()).width + 100 * track; tw += w; return w; });
      var fs = Math.min(S * (lite ? 0.95 : 0.85), W * (lite ? 0.78 : 0.84) / tw * 100), k = fs / 100;
      var x = (W - tw * k) / 2 + fs * track / 2, base = row[0].y - S * 0.12 + fs * 0.1;
      g.font = "400 " + fs + "px " + SLEEK;
      if (!box) box = { x0: x, x1: x + tw * k, base: base, fs: fs };
      for (i = 0; i < row.length; i++) {
        var l = row[i], t = age - l.birth, w = ws[i] * k;
        if (l.ch !== " " && t > 0) {
          var up = eo(t / 900), lean = (l.sx || 0) * fs * 0.03;
          g.save(); g.beginPath(); g.rect(x - fs * 0.2, base - fs * 1.0, w + fs * 0.4, fs * 1.08); g.clip();
          g.fillStyle = C.text; g.fillText(l.ch.toUpperCase(), x + lean, base + (1 - up) * fs * 1.0);
          g.restore();
        }
        x += w;
      }
    }
    // the script word, written left to right once the capitals are up
    var word = this.o.script;
    if (word && box && !lite) {
      var last = L[L.length - 1], t0 = (last ? last.birth : 0) + 500, p = eo((age - t0) / 1400);
      if (p > 0) {
        var sf = box.fs * 0.5;
        g.save();
        g.font = "400 " + sf + "px " + SCRIPT;
        var sw = g.measureText(word).width, cx = (box.x0 + box.x1) / 2, cy = box.base - box.fs * 0.28;
        g.translate(cx + box.fs * 0.35, cy); g.rotate(-0.12);
        g.beginPath(); g.rect(-sw * 0.5 - sf, -sf * 1.2, (sw + sf * 2) * p, sf * 2.4); g.clip();
        g.shadowColor = C.bg; g.shadowBlur = sf * 0.25;
        g.fillStyle = C.text; g.textAlign = "center"; g.fillText(word, 0, 0);
        g.restore();
      }
    }
    // hairline under the word
    if (box && !lite) {
      var pl = eo((age - 300) / 1200);
      if (pl > 0) { g.fillStyle = C.text; g.globalAlpha = 0.35; var mid = (box.x0 + box.x1) / 2, half = (box.x1 - box.x0) / 2 * pl; g.fillRect(mid - half, box.base + box.fs * 0.2, half * 2, 1); g.globalAlpha = 1; }
    }
  };
  // Mono curtain: a halftone of growing ink dots that closes over the page
  Scene.prototype.renderSignalField = function (p, now) {
    var g = this.g, W = this.W, H = this.H, C = this.C, cell = 22, cols = Math.ceil(W / cell) + 1, rows = Math.ceil(H / cell) + 1;
    if (p <= 0.001) return;
    if (p > 0.92) { g.fillStyle = C.text; g.fillRect(0, 0, W, H); return; }
    g.fillStyle = C.text;
    var t = now / 1000;
    g.beginPath();
    for (var y = 0; y < rows; y++) for (var x = 0; x < cols; x++) {
      var cx = x * cell + (y % 2 ? cell / 2 : 0), cy = y * cell;
      var n = h(x * 3.17 + y * 7.31) * 0.35 + (0.5 + 0.5 * Math.sin(cx * 0.006 + cy * 0.004 + t * 0.8)) * 0.25;
      var r = clamp((p * 1.55 - n - (1 - cy / H) * 0.3) * cell * 0.95, 0, cell * 0.8);
      if (r < 0.4) continue;
      g.moveTo(cx + r, cy); g.arc(cx, cy, r, 0, PI * 2);
    }
    g.fill();
  };

  // ---------- butterflies ----------
  Scene.prototype.spawnFly = function (cx, cy) {
    if (this.flies.length >= 6) this.flies.shift();
    var taken = {}, best = null, bd = 1e9, self = this;
    this.flies.forEach(function (f) { if (f.pid) taken[f.pid] = 1; });
    this.perch.forEach(function (p) { if (taken[p.id]) return; var d = Math.hypot(p.x - cx, p.y - cy); if (d < bd) { bd = d; best = p; } });
    var left = cx < this.W / 2;
    this.flies.push({ x: left ? -40 : this.W + 40, y: cy + (Math.random() - 0.5) * this.H * 0.4, vx: 0, vy: 0, st: best ? "fly" : "wander", pid: best ? best.id : null, hx: cx, hy: cy, t0: performance.now(), ph: 0, sz: Math.max(9, this.S * 0.09), seed: Math.random() * 100, ang: 0, open: 0 });
  };
  Scene.prototype.drawFlies = function (B, now) {
    var dt = Math.min(48, now - (this._fl || now)), self = this, byId = {};
    this._fl = now; this.perch.forEach(function (p) { byId[p.id] = p; });
    var off = function (f) { f.st = "leave"; f.pid = null; f.ex = f.x < self.W / 2 ? -80 : self.W + 80; f.ey = f.y - self.H * 0.3; };
    this.flies = this.flies.filter(function (f) {
      var t = (now - f.t0) / 1000, tx, ty;
      if (f.st === "sit" || f.st === "fly") { var p = byId[f.pid]; if (!p) off(f); else { tx = p.x + p.R * 0.05; ty = p.y - p.R * 0.55; } }
      if (f.st === "wander") { tx = f.hx + Math.sin(t * 1.3 + f.seed) * 70; ty = f.hy + Math.sin(t * 2.1 + f.seed) * 40; if (t > 3.5) off(f); }
      if (f.st === "leave") { tx = f.ex; ty = f.ey; }
      if (f.st === "sit") {
        f.x += (tx - f.x) * 0.35; f.y += (ty - f.y) * 0.35; f.ang *= 0.85; f.ph += dt * 0.004;
        var burst = Math.sin(now / 1000 * 0.9 + f.seed) > 0.75;
        f.open = burst ? 0.2 + 0.8 * Math.abs(Math.cos(now / 1000 * 9 + f.seed)) : 0.25 + 0.15 * Math.sin(f.ph);
        if (t > 9) off(f);
      } else {
        var dx = tx - f.x, dy = ty - f.y, d = Math.hypot(dx, dy) || 1, sp = f.st === "leave" ? 0.42 : Math.min(0.34, 0.06 + d * 0.0016);
        var flut = Math.sin(t * 7 + f.seed) * 0.12, wob = Math.cos(t * 4.3 + f.seed) * 0.1;
        f.vx += ((dx / d * sp + wob) - f.vx) * 0.06 * dt / 16; f.vy += ((dy / d * sp + flut) - f.vy) * 0.06 * dt / 16;
        f.x += f.vx * dt; f.y += f.vy * dt + Math.sin(t * 13 + f.seed) * 0.6;
        f.ang += (clamp(f.vx * 1.4, -0.5, 0.5) - f.ang) * 0.1;
        f.open = Math.abs(Math.cos(t * 17 + f.seed));
        if (f.st === "fly" && d < 5) { f.st = "sit"; f.ph = 0; f.t0 = now - 0; }
        if (f.st === "leave" && (f.x < -60 || f.x > self.W + 60 || f.y < -60)) return false;
      }
      butterfly(B, f.x, f.y, f.sz, f.ang, f.open, self.C);
      return true;
    });
  };

  Scene.prototype.frame = function (now) {
    if (!this.W || !this.visible || this.paused) return;
    if (this.o.still) {                      // Potato mode: one frame, fully grown, then nothing
      if (this._drawn) return;
      this._drawn = true; this._now = now;
      var gs = this.g; gs.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); gs.clearRect(0, 0, this.W, this.H);
      if (mode() === "signal") this.renderSignalText(1e6, now); else this.render(backend(gs), 1e6, now);
      return;
    }
    var g = this.g, age = this.age(now);
    if (this.kind === "field" && age / this.total <= 0.001) {   // nothing to show: clear once, then rest
      if (!this._empty) { g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, this.cv.width, this.cv.height); this._empty = true; }
      return;
    }
    this._empty = false;
    var energy = this.stepSprings();
    if (this.kind === "text" && !this.o.lite && age > this.total + 800 && energy < 0.01 && !this.flies.length && now - ptr.t > 500) {
      var tick = Math.floor(now / 120);                     // grown and calm: redraw on boil ticks only
      if (tick === this._tick) return; this._tick = tick;
    }
    if (this.o.lite) { // cards: redraw only while growing, rustling, hovered or on boil ticks
      var key = Math.floor(now / 120) + ":" + Math.round(age / 16);
      var hot = energy > 0.01 || (this.mx != null && this.mx > -20 && this.my > -20 && this.mx < this.W + 20 && this.my < this.H + 20);
      if (key === this._key && !this.flies.length && !hot) return; this._key = key;
    }
    this._now = now;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.W, this.H);
    var B = backend(g);
    if (mode() === "signal") {
      if (this.kind === "field") this.renderSignalField(age / this.total, now);
      else this.renderSignalText(age, now);
      return;
    }
    if (this.kind === "field") {
      var pr = age / this.total, veil = clamp((pr - 0.55) / 0.4, 0, 1);
      if (pr <= 0.001) return;
      if (veil > 0) { g.globalAlpha = veil; g.fillStyle = this.C.bg; g.fillRect(0, 0, this.W, this.H); g.globalAlpha = 1; }
    }
    this.render(B, age, now);
    if (this.flies.length) this.drawFlies(B, now);
  };

  // one shared frame loop; it stops by itself when every scene is a finished still (Potato mode)
  var running = false;
  function tick(now) {
    var busy = false;
    for (var i = 0; i < scenes.length; i++) { scenes[i].frame(now); var sc = scenes[i]; if (!(sc.o.still && (sc._drawn || !sc.visible))) busy = true; }
    if (busy || !scenes.length) requestAnimationFrame(tick); else running = false;
  }
  function kick() { if (!running) { running = true; requestAnimationFrame(tick); } }
  kick();

  window.addEventListener("pointermove", function (e) {
    var now = performance.now(), dt = Math.max(8, now - (ptr.t || now));
    ptr.vx = ptr.vx * 0.5 + ((e.clientX - ptr.x) / dt) * 0.5; ptr.vy = ptr.vy * 0.5 + ((e.clientY - ptr.y) / dt) * 0.5;
    ptr.x = e.clientX; ptr.y = e.clientY; ptr.t = now; ptr.speed = Math.hypot(ptr.vx, ptr.vy);

  }, { passive: true });
  document.addEventListener("pointerleave", function () { scenes.forEach(function (s) { s.mx = null; }); });
  var rt; window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(function () { scenes.forEach(function (s) { s.resize(); }); }, 120); });

  window.addEventListener("pointerdown", function (e) {
    scenes.forEach(function (s) { var r = s.cv.getBoundingClientRect(); s.shake(e.clientX - r.left, e.clientY - r.top, e.pointerType === "touch" ? 0.9 : 0.6); });
  }, { passive: true });
  // the screen positions of roses currently on show (for falling petals)
  function roses(cx, cy, maxD) {
    var out = [];
    scenes.forEach(function (s) {
      if (!s.visible || !s.perch.length) return;
      var r = s.cv.getBoundingClientRect();
      s.perch.forEach(function (p) { var x = r.left + p.x, y = r.top + p.y; if (Math.hypot(x - cx, y - cy) < maxD) out.push({ x: x, y: y, R: p.R }); });
    });
    return out;
  }
  var sproutCache = {};
  function sproutEls(seed) {
    if (sproutCache[seed]) return sproutCache[seed];
    var r = rng(seed), E = [], k = 0, nid = function () { return seed * 100 + (k++); }, p = wordParams(seed, 1);
    p.big = 1.5; p.leafy = 1.3; p.w = 0;
    grow(r, E, nid, p, { base: [0, 0], dir: -PI / 2 + (r() - 0.5) * 0.6, len: 0.75 + r() * 0.3, d0: 0, tip: "rose" });
    if (r() < 0.6) grow(r, E, nid, p, { base: [0, -0.1], dir: -PI / 2 + (r() < 0.5 ? -0.9 : 0.9), len: 0.35 + r() * 0.2, d0: 160, tip: r() < 0.5 ? "rose" : "fan", depth: 1 });
    var keys = Object.keys(sproutCache); if (keys.length > 40) delete sproutCache[keys[0]];
    return (sproutCache[seed] = E);
  }
  // draw a sprout rooted at (x, y), S px tall-ish, at `age` ms of growth
  function sprout(g, x, y, S, age, seed, C) {
    var B = backend(g), E = sproutEls(seed);
    var map = function (q) { return [x + q[0] * S, y + q[1] * S]; };
    E.forEach(function (e) {
      if (e.t === "stem") {
        var fr = eo((age - e.d0) / e.dur); if (fr <= 0) return;
        strokeRange(B, e.pts.map(map), 0, fr, C.blue, S * 0.026 * (e.w || 1));
      } else if (e.t === "leaf") {
        var sc = spr((age - e.d0) / 1000, 7, 15); if (sc <= 0) return;
        var q = map([e.x, e.y]); leaf(B, q[0], q[1], e.a, e.L * S * sc, e.bend, C);
      } else if (e.t === "rose") {
        var a = age - e.d0; if (a <= 0) return;
        var q2 = map([e.x, e.y]); rose(B, q2[0], q2[1], e.R * S, e.rot, e, a, null, C);
      }
    });
  }

  window.Garden = {
    sprout: sprout, colors: colors,
    roses: roses, ptr: ptr,
    text: function (canvas, o) { o = o || {}; o.kind = "text"; return new Scene(canvas, o); },
    field: function (canvas, o) { o = o || {}; o.kind = "field"; return new Scene(canvas, o); },
    recolor: function () { var C = colors(); scenes.forEach(function (s) { s.C = C; s._key = null; s._drawn = false; s._tick = null; }); kick(); },
    relayout: function () { widthCache = {}; scenes.forEach(function (s) { s.resize(); s._drawn = false; }); },
    scenes: scenes,
    eo: eo
  };
  if (document.fonts && document.fonts.load) Promise.all([document.fonts.load("700 100px " + FONT), document.fonts.load("400 100px " + SLEEK), document.fonts.load("400 60px " + SCRIPT)]).then(function () { scenes.forEach(function (s) { s.dither = null; }); window.Garden.relayout(); }).catch(function () {});
})();
