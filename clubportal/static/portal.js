/* Clubbb portal: season themes, WebGL portal background, menu,
   scroll-driven bloom curtain, 3D spiral and bloom page transitions. */
(function () {
  "use strict";
  var root = document.documentElement;
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Potato mode: a still, light version of the site for phones that struggle (set in <head>)
  var potato = root.hasAttribute("data-potato");
  function ease(dt, tau) { return 1 - Math.exp(-Math.min(dt, 64) / tau); }   // frame-rate independent smoothing
  var vh = window.innerHeight;
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function cssVar(n) { return getComputedStyle(root).getPropertyValue(n).trim(); }
  function hex(c) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c || "");
    return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [1, 0.08, 0];
  }

  // ------------------------------------------------------------------ theme
  var THEMES = ["rosenoir", "mono"];
  function setTheme(t, save) {
    if (t === "signal") t = "mono";
    if (THEMES.indexOf(t) < 0) t = "rosenoir";
    root.setAttribute("data-theme", t);
    if (save) { try { if (t === seasonTheme()) localStorage.removeItem("clubbb-theme"); else localStorage.setItem("clubbb-theme", t); } catch (e) {} }
    document.querySelectorAll("[data-theme-set]").forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-theme-set") === t ? "true" : "false"); });
    var meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute("content", cssVar("--bg") || "#000");
    if (window.Garden) window.Garden.recolor();
    if (bg) bg.recolor();
    if (typeof fx !== "undefined" && fx) fx.recolor();
    if (typeof vine !== "undefined" && vine) vine.build();
  }
  function seasonTheme() { var s = window.CLUBBB_SEASONS || []; return s[new Date().getMonth()] || "rosenoir"; }
  document.querySelectorAll("[data-theme-set]").forEach(function (b) {
    b.addEventListener("click", function () { setTheme(b.getAttribute("data-theme-set"), true); });
  });

  // ------------------------------------------------------- WebGL background
  var VS = "attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}";
  var FS = [
    "precision highp float;",
    "uniform vec2 res,mouse;uniform vec3 click;uniform float t,open,mode,boost;uniform vec3 c1,c2,c3,bgc;uniform sampler2D atlas;",
    "float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}",
    "float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);",
    " return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}",
    "float fbm(vec2 p){float v=0.0,a=0.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);for(int i=0;i<5;i++){v+=a*noise(p);p=m*p;a*=0.5;}return v;}",
    "float fbm4(vec2 p){float v=0.0,a=0.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);for(int i=0;i<4;i++){v+=a*noise(p);p=m*p;a*=0.5;}return v;}",
    "mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}",
    // the portal field: a swirling iris of domain-warped noise
    "vec4 field(vec2 uv){",
    "  float r=length(uv),a=atan(uv.y,uv.x);",
    "  vec2 p=rot(r*2.2-t*0.12)*uv*1.7;",
    "  vec2 q=vec2(fbm4(p+t*0.05),fbm4(p+vec2(5.2,1.3)-t*0.045));",
    "  vec2 w=vec2(fbm4(p+3.0*q+vec2(1.7,9.2)+t*0.03),fbm4(p+3.0*q+vec2(8.3,2.8)));",
    "  float f=fbm4(p+2.6*w);",
    "  float R=open*0.62;",
    // an unfurling rose: four layers of five petals, each layer turned and drawn as a fine line
    "  float ring=0.0,shade=0.0,outer=R;",
    "  for(int k=0;k<3;k++){float fk=float(k);",
    "    float Rk=R*(1.0-0.26*fk);",
    "    float ph=fk*0.63+t*0.035*(mod(fk,2.0)*2.0-1.0);",
    "    float edge=Rk*(0.84+0.16*sqrt(abs(sin(a*2.5+ph))));",
    "    if(k==0)outer=edge;",
    "    ring+=exp(-pow((r-edge)*(64.0+fk*14.0),2.0))*(1.0-fk*0.16);",
    "    shade+=smoothstep(edge,edge-0.09*R,r)*smoothstep(edge-0.3*R,edge-0.09*R,r)*0.5;}",
    "  float inside=smoothstep(outer+0.04,outer-0.22,r);",
    "  float petals=0.5+0.5*sin(a*5.0+f*6.0-t*0.4);",
    "  float dim=1.0/(1.0+max(open-1.0,0.0)*3.2);",                    // once through the portal, the room goes dark
    "  vec3 col=vec3(0.0);",
    "  col+=c1*smoothstep(0.42,0.95,f)*inside*(0.55+0.45*petals)*(0.25+0.75*dim);",
    "  col+=c2*0.55*smoothstep(0.55,1.0,w.x)*inside*(0.3+0.7*dim);",
    "  col+=c3*ring*(0.75+boost);",
    "  col+=c1*shade*0.22*inside;",                                    // each petal darkens toward its edge
    "  col+=c1*0.35*exp(-r*r*5.0/(open*open+0.05))*min(open,1.0)*dim;",  // core bloom
    "  col+=c1*0.22*exp(-abs(r-outer)*9.0)*smoothstep(0.0,0.3,open);",  // soft glow round the outer petals
    "  vec2 m=mouse-uv;col+=mix(c1,c3,0.4)*0.22*exp(-dot(m,m)*14.0);",
    "  float ct=t-click.z;if(ct>0.0&&ct<3.0){float cr=length(uv-click.xy);",
    "    col+=c3*0.9*exp(-pow((cr-ct*0.75)*24.0,2.0))*exp(-ct*1.6);",
    "    col+=c1*0.5*exp(-pow((cr-ct*0.5)*16.0,2.0))*exp(-ct*2.0);}",
    "  float lum=dot(col,vec3(0.299,0.587,0.114));",
    "  return vec4(col,lum);",
    "}",
    "void main(){",
    "  vec2 fc=gl_FragCoord.xy;",
    "  vec2 uv=(fc-0.5*res)/min(res.x,res.y);",
    "  vec3 col;",
    "  if(mode<0.5){",
    "    vec4 f0=field(uv);col=f0.rgb;",                                 // one pass (was three)

    "    col=col/(1.0+col*0.6);",                                       // soft tone map
    "    col+=(hash(fc+fract(t))-0.5)*0.045;",                           // grain
    "  }else{",
    // Mono: liquid chrome. Warped noise folded through a sharp cosine gives metal-like bands.
    "    vec2 p=uv*1.25;",
    "    vec2 dm=uv-mouse;p-=dm*0.35*exp(-dot(dm,dm)*5.0);",               // the cursor pushes the liquid
    "    float ct=t-click.z;if(ct>0.0&&ct<3.0){vec2 dc=uv-click.xy;float cr=length(dc);",
    "      p+=dc/(cr+0.001)*sin((cr-ct*0.7)*38.0)*0.022*exp(-ct*1.5)*exp(-abs(cr-ct*0.7)*8.0);}",
    "    float s=t*0.06;",
    "    vec2 q=vec2(fbm(p+vec2(0.0,s)),fbm(p+vec2(5.2,1.3)-s));",
    "    vec2 r=vec2(fbm(p+3.5*q+vec2(1.7,9.2)+s*1.4),fbm(p+3.5*q+vec2(8.3,2.8)-s));",
    "    float f=fbm(p+3.2*r);",
    "    float band=0.5+0.5*cos(6.2831*(f*2.2+length(q)*0.9-t*0.025));",
    "    float chrome=pow(band,5.0);",                                     // bright metal ridges
    "    float vein=smoothstep(0.985,1.0,0.5+0.5*sin(f*60.0+r.x*12.0));",   // hairline veins
    "    float body=smoothstep(0.25,0.95,f)*0.22;",
    "    float rr=length(uv),R=open*0.62;",
    "    float ring=exp(-pow((rr-R)*90.0,2.0));",                          // the portal: a hairline circle
    "    float inside=smoothstep(R+0.02,R-0.25,rr);",
    "    float dim=1.0/(1.0+max(open-1.0,0.0)*2.4);",
    "    float hb=1.0-0.55*exp(-pow(uv.y*3.2,2.0))*inside*dim;",              // a soft dark band behind the headline
    "    float v=(chrome*0.62+vein*0.4+body)*(0.3+0.7*inside)*(0.22+0.78*dim)*hb+ring*0.9*dim;",
    "    v+=0.5*exp(-pow((rr-R)*14.0,2.0))*dim*0.25;",                     // soft bloom around the ring
    "    col=vec3(v);",
    "    col+=(hash(fc+fract(t*1.7))-0.5)*0.07;",                           // heavy grain
    "  }",
    "  col*=1.0-0.45*smoothstep(0.4,1.25,length(uv));",                   // vignette
    "  gl_FragColor=vec4(bgc+col,1.0);",
    "}"
  ].join("\n");

  var bg = (function () {
    var cv = document.getElementById("bg");
    if (!cv) return null;
    if (potato) { cv.remove(); return null; }
    var gl = cv.getContext("webgl", { antialias: false, alpha: false, powerPreference: "high-performance" });
    if (!gl) { cv.remove(); return null; }
    function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(s)); return null; } return s; }
    var vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) { cv.remove(); return null; }
    var pr = gl.createProgram(); gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr); gl.useProgram(pr);
    var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(pr, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    var U = {}; ["res", "mouse", "click", "t", "open", "mode", "boost", "c1", "c2", "c3", "bgc", "atlas"].forEach(function (n) { U[n] = gl.getUniformLocation(pr, n); });
    // glyph atlas for the signal theme: ten glyphs, light to dense
    var ac = document.createElement("canvas"); ac.width = 320; ac.height = 32;
    var ax = ac.getContext("2d");
    function paintAtlas() {
      ax.fillStyle = "#000"; ax.fillRect(0, 0, 320, 32); ax.fillStyle = "#fff";
      ax.font = "500 26px 'DM Mono', monospace"; ax.textAlign = "center"; ax.textBaseline = "middle";
      " .:-=+*#%@".split("").forEach(function (c, i) { ax.fillText(c, i * 32 + 16, 17); });
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, ac);
    }
    var tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    paintAtlas();
    if (document.fonts) document.fonts.ready.then(paintAtlas);
    gl.uniform1i(U.atlas, 0);

    var st = { mx: 99, my: 99, tx: 99, ty: 99, open: 0, boost: 0, scale: 1, click: [0, 0, -99] };
    function size() {
      var d = Math.min(1.5, window.devicePixelRatio || 1) * st.scale;
      cv.width = Math.round(innerWidth * d); cv.height = Math.round(innerHeight * d);
      gl.viewport(0, 0, cv.width, cv.height);
    }
    function recolor() {
      gl.uniform3fv(U.c1, hex(cssVar("--flower"))); gl.uniform3fv(U.c2, hex(cssVar("--stem")));
      gl.uniform3fv(U.c3, hex(cssVar("--line"))); gl.uniform3fv(U.bgc, hex(cssVar("--bg")));
      gl.uniform1f(U.mode, root.getAttribute("data-theme") === "mono" ? 1 : 0);
    }
    size(); recolor();
    window.addEventListener("resize", size);

    var t0 = performance.now(), last = t0, slow = 0;
    function frame(now) {
      requestAnimationFrame(frame);
      var dt = now - last; last = now;
      // adaptive resolution: drop the buffer size on slow machines
      if (dt > 34) { if (++slow > 40 && st.scale > 0.5) { st.scale -= 0.25; slow = 0; size(); } } else slow = Math.max(0, slow - 1);
      if (document.hidden) return;
      var km = ease(dt, 260), ko = ease(dt, 190);
      st.mx += (st.tx - st.mx) * km; st.my += (st.ty - st.my) * km;
      var target = portalOpen(now - t0);
      st.open += (target - st.open) * ko;
      st.boost *= Math.exp(-Math.min(dt, 64) / 300);
      gl.uniform2f(U.res, cv.width, cv.height); gl.uniform2f(U.mouse, st.mx, st.my); gl.uniform3fv(U.click, st.click);
      gl.uniform1f(U.t, reduced ? 10 : (now - t0) / 1000); gl.uniform1f(U.open, st.open); gl.uniform1f(U.boost, st.boost);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    requestAnimationFrame(frame);

    return { recolor: recolor, pulse: function () { st.boost = 1.2; } };
  })();

  // the iris opens on load, then widens as you scroll into the page
  var isHome = !!document.querySelector("[data-home]");
  function portalOpen(ms) {
    var intro = reduced ? 1 : Garden.eo(Math.max(0, ms - 250) / 1800);
    var s = window.scrollY / vh;
    return (isHome ? 0.05 + intro * 0.95 : 0.85 + intro * 0.25) + s * 0.55;
  }

  // ------------------------------------------------------------------ menu
  var menuBtn = document.querySelector(".menu-btn"), menu = document.getElementById("menu");
  function setMenu(open) {
    if (!menu) return;
    document.body.classList.toggle("menu-open", open);
    menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    menuBtn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    var lab = menuBtn.querySelector(".label"); if (lab) lab.textContent = open ? "Close" : "Menu";
    menu.setAttribute("aria-hidden", open ? "false" : "true");
    if (open) menu.removeAttribute("inert"); else menu.setAttribute("inert", "");
    if (open) {
      var mono = root.getAttribute("data-theme") === "mono";
      var cur = mono ? (menu.querySelector(".menu-row a[aria-current]") || menu.querySelector(".menu-row a")) : menu.querySelector(".menu-list a");
      if (mono) { stageKey = ""; showStage(cur, true); }
      setTimeout(function () { cur.focus({ preventScroll: true }); }, 60);
    }
  }
  // the stage: one big word, swapped letter by letter as you move along the row
  var stage = menu && menu.querySelector(".stage"), stageWord = stage && stage.querySelector(".stage-word"), stageScript = stage && stage.querySelector(".stage-script"), stageKey = "";
  function split(word) {
    return word.split("").map(function (c, i) { return '<span class="ch"><span style="--d:' + i + '">' + (c === " " ? "&nbsp;" : c.replace(/&/g, "&amp;").replace(/</g, "&lt;")) + "</span></span>"; }).join("");
  }
  function showStage(a, instant) {
    if (!stage || !a) return;
    var word = a.getAttribute("data-word"), key = word + (instant ? "!" : "");
    menu.querySelectorAll(".menu-row a").forEach(function (x) { x.classList.toggle("is-on", x === a); });
    if (word === stageKey && !instant) return;
    stageKey = word;
    stage.setAttribute("href", a.getAttribute("href"));
    var swap = function () {
      stageWord.classList.remove("out");
      stageWord.innerHTML = split(word);
      stageWord.style.animation = "none"; void stageWord.offsetWidth; stageWord.style.animation = "";
      stageScript.textContent = a.getAttribute("data-script") || "";
      stage.classList.add("swap"); void stage.offsetWidth; stage.classList.remove("swap");
    };
    if (instant || reduced) return swap();
    stageWord.classList.add("out");
    clearTimeout(showStage._t); showStage._t = setTimeout(swap, 260);
  }
  if (menu) menu.querySelectorAll(".menu-row a").forEach(function (a) {
    a.addEventListener("mouseenter", function () { showStage(a); });
    a.addEventListener("focus", function () { showStage(a); });
  });
  if (menuBtn && menu) {
    menuBtn.addEventListener("click", function () { setMenu(!document.body.classList.contains("menu-open")); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && document.body.classList.contains("menu-open")) { setMenu(false); menuBtn.focus(); } });
  }

  // ------------------------------------------------------------- gardens
  document.querySelectorAll("canvas[data-garden-text]").forEach(function (cv) {
    var sc = Garden.text(cv, { text: cv.getAttribute("data-garden-text"), script: cv.getAttribute("data-script") || "", fill: parseFloat(cv.getAttribute("data-fill") || "0.34"), seed: (cv.getAttribute("data-garden-text").length * 7919) + 3, still: potato, clock: (reduced || potato) ? function () { return 1e6; } : null });
    if (potato) return;
    cv.addEventListener("pointerdown", function (e) { var r = cv.getBoundingClientRect(); sc.spawnFly(e.clientX - r.left, e.clientY - r.top); if (bg) bg.pulse(); });
  });

  // ------------------------------------------------- bloom curtain + transitions
  var curtainCv = document.getElementById("curtain"), trans = { g: 0, from: 0, to: 0, t0: 0, dur: 1 };
  var scrollG = 0, intro = document.querySelector("[data-intro]"), spiralSec = document.querySelector("[data-spiral]");
  function curtainProgress() {
    var now = performance.now(), u = clamp((now - trans.t0) / trans.dur, 0, 1);
    trans.g = trans.from + (trans.to - trans.from) * (trans.to > trans.from ? Garden.eo(u) : smooth(u));
    return Math.max(scrollG, trans.g);
  }
  if (curtainCv && potato) curtainCv.remove();
  else if (curtainCv && window.Garden) Garden.field(curtainCv, { progress: curtainProgress, seed: 424242, lean: true });
  function runTransition(to, dur, cb) {
    trans.from = trans.g; trans.to = to; trans.t0 = performance.now(); trans.dur = dur;
    if (cb) setTimeout(cb, dur + 40);
  }
  try {
    if (sessionStorage.getItem("clubbb-bloom") && !reduced && !potato) {
      sessionStorage.removeItem("clubbb-bloom");
      trans.g = trans.from = trans.to = 1; trans.t0 = performance.now();
      setTimeout(function () { runTransition(0, 1300); }, 120);
    }
  } catch (e) {}
  window.addEventListener("pageshow", function (e) { if (e.persisted) { trans.g = trans.from = trans.to = 0; document.body.classList.remove("leaving"); } });
  requestAnimationFrame(function () { document.body.classList.add("entered"); });
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[data-bloom]");
    if (!a || reduced || potato || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    var href = a.getAttribute("href"); if (!href || href.charAt(0) === "#") return;
    e.preventDefault();
    setMenu(false);
    if (bg) bg.pulse();
    try { sessionStorage.setItem("clubbb-bloom", "1"); } catch (er) {}
    document.body.classList.add("leaving");
    runTransition(1, 1000, function () { location.href = href; });
  });

  // ----------------------------------------------------------------- spiral
  var helix = document.querySelector(".helix"), cards = helix ? Array.prototype.slice.call(helix.children) : [];
  var cur = 0, tiltX = 0, tiltY = 0, mtx = 0, mty = 0, openCards = 0;
  if (potato) cards = [];
  cards.forEach(function (card, i) {
    var cv = card.querySelector("canvas[data-card-text]");
    if (!cv) return;
    card._start = null;
    card._scene = Garden.text(cv, { text: cv.getAttribute("data-card-text"), fill: 0.5, lite: true, stagger: 140, seed: i * 131 + 7, face: true,
      clock: function (now) { return reduced ? 1e6 : card._start == null ? -1 : now - card._start; } });
  });

  if (!potato) document.querySelectorAll(".card3d").forEach(function (card, i) {
    var fcv = card.querySelector(".reveal-field"), h = 0, target = 0, last = performance.now(), scene = null, closeT = null, isOpen = false;
    function on() {
      clearTimeout(closeT);
      if (!isOpen) { isOpen = true; openCards++; }
      target = 1; card.classList.add("is-open");
      if (fcv && !scene && root.getAttribute("data-theme") !== "mono") {
        scene = Garden.field(fcv, { small: true, seed: 9001 + i * 37, progress: function () {
          var now = performance.now(), dt = Math.min(64, now - last); last = now;
          h += (target - h) * (1 - Math.exp(-dt / (target ? 380 : 220)));
          return h * 0.5;
        } });
      }
    }
    function off() {
      clearTimeout(closeT);
      closeT = setTimeout(function () { if (isOpen) { isOpen = false; openCards = Math.max(0, openCards - 1); } target = 0; card.classList.remove("is-open"); }, 220);
    }
    card.addEventListener("mouseenter", on); card.addEventListener("focus", on);
    card.addEventListener("mouseleave", off); card.addEventListener("blur", off);
  });

  var lastSpin = performance.now(), spinIdle = false, M = null;
  function measure() {
    M = { top: spiralSec ? spiralSec.offsetTop : 0, h: spiralSec ? spiralSec.offsetHeight : 0,
          introTop: intro ? intro.offsetTop : 0 };
  }
  // write a style only when it changed: unchanged writes still cost a style pass
  function put(el, k, v) { var c = el._st || (el._st = {}); if (c[k] !== v) { c[k] = v; el.style[k] = v; } }
  window.addEventListener("load", function () { measure(); scrolled = true; spinIdle = false; });
  function layoutSpiral(now) {
    if (!helix || !cards.length) return;
    var dt = now - lastSpin; lastSpin = now;
    if (!M) measure();
    var top = M.top, span = Math.max(1, M.h - vh), y = window.scrollY;
    if (y < top - vh * 1.2 || y > top + M.h + vh * 0.2) return;   // off-screen: no work
    var lead = vh * 0.45;                                   // first card holds still while you arrive
    var p = clamp((y - top - lead) / Math.max(1, span - lead), 0, 1);
    var n = cards.length, target = p * (n - 1);
    var tx = openCards ? tiltX : mty * -7, ty = openCards ? tiltY : mtx * 10;   // hold still while a card is open
    var moving = Math.abs(target - cur) > 0.0005 || Math.abs(tx - tiltX) > 0.01 || Math.abs(ty - tiltY) > 0.01;
    if (!moving && spinIdle) return;      // settled: skip DOM writes entirely
    spinIdle = !moving;
    cur += (target - cur) * (reduced ? 1 : ease(dt, 130));
    tiltX += (tx - tiltX) * ease(dt, 320); tiltY += (ty - tiltY) * ease(dt, 320);
    var w = innerWidth, R = clamp(w * 0.42, 220, 720), step = (Math.PI * 2) / 5.2, dy = clamp(vh * 0.2, 80, 190);
    put(helix, "transform", "rotateX(" + tiltX.toFixed(2) + "deg) rotateY(" + tiltY.toFixed(2) + "deg)");
    var front = Math.round(cur);
    if (root.getAttribute("data-theme") === "mono") { tunnel(n, front); return; }
    for (var i = 0; i < n; i++) {
      var rel = i - cur, ang = rel * step, depth = Math.cos(ang);
      var x = Math.sin(ang) * R, z = (depth - 1) * R, y = rel * dy;
      var vis = clamp(1 - (Math.abs(rel) - 1.0) / 0.6, 0, 1);
      var op = clamp(smooth((depth - 0.15) / 0.85), 0, 1) * vis * (Math.abs(rel) < 0.5 ? 1 : 0.55);
      var c = cards[i];
      put(c, "transform", "translate(-50%,-50%) translate3d(" + x.toFixed(1) + "px," + y.toFixed(1) + "px," + z.toFixed(1) + "px) rotateY(" + (ang * 57.2958).toFixed(2) + "deg)");
      put(c, "opacity", op.toFixed(3)); put(c, "visibility", op < 0.01 ? "hidden" : "visible");
      if (c._scene) c._scene.paused = op < 0.04;          // invisible cards do no drawing
      var isFront = i === front;
      put(c, "pointerEvents", isFront ? "auto" : "none");     // only the front card takes clicks
      put(c, "zIndex", isFront ? "2" : "1");
      if (isFront !== c._front) { c._front = isFront; c.classList.toggle("is-front", isFront); }
      if (Math.abs(rel) < 0.6 && c._start == null) c._start = performance.now();
      c.tabIndex = isFront ? 0 : -1;
    }
    var bar = spiralSec.querySelector(".spiral-bar"); if (bar) put(bar, "transform", "scaleX(" + p.toFixed(4) + ")");
    var idx = spiralSec.querySelector(".spiral-idx"); if (idx && idx._f !== front) idx._f = front, idx.textContent = String(front + 1).padStart(2, "0") + " / " + String(n).padStart(2, "0");
  }

  // Signal: cards hang in a warp tunnel and fly past the camera as you scroll
  function tunnel(n, front) {
    var w = innerWidth, D = clamp(vh * 0.95, 520, 900), spread = clamp(Math.min(w, vh) * 0.34, 120, 380);
    put(helix, "transform", "rotateX(" + (tiltX * 0.6).toFixed(2) + "deg) rotateY(" + (tiltY * 0.8).toFixed(2) + "deg)");
    for (var i = 0; i < n; i++) {
      var rel = i - cur, c = cards[i], ga = i * 2.39996 + 0.6, off = smooth(Math.min(1, Math.abs(rel) * 0.9));
      var x = Math.cos(ga) * spread * off * (w < 700 ? 0.5 : 1), y = Math.sin(ga) * spread * 0.55 * off;
      var z = -rel * D, op = rel < 0 ? clamp(1 + rel * 2.2, 0, 1) : clamp(1 - (rel - 0.6) / 3.2, 0, 1);
      put(c, "transform", "translate(-50%,-50%) translate3d(" + x.toFixed(1) + "px," + y.toFixed(1) + "px," + z.toFixed(1) + "px) rotateY(" + (-x * 0.03).toFixed(2) + "deg) rotateX(" + (y * 0.03).toFixed(2) + "deg)");
      put(c, "opacity", op.toFixed(3)); put(c, "visibility", op < 0.01 ? "hidden" : "visible");
      if (c._scene) c._scene.paused = op < 0.04;
      put(c, "pointerEvents", op > 0.5 && Math.abs(rel) < 0.6 ? "auto" : "none");
      var isFront = i === front;
      if (isFront !== c._front) { c._front = isFront; c.classList.toggle("is-front", isFront); }
      if (Math.abs(rel) < 1.2 && c._start == null) c._start = performance.now();
      c.tabIndex = isFront ? 0 : -1;
    }
    var bar = spiralSec.querySelector(".spiral-bar"), p = n > 1 ? cur / (n - 1) : 0; if (bar) put(bar, "transform", "scaleX(" + p.toFixed(4) + ")");
    var idx = spiralSec.querySelector(".spiral-idx"); if (idx && idx._f !== front) idx._f = front, idx.textContent = String(front + 1).padStart(2, "0") + " / " + String(n).padStart(2, "0");
  }

  // ------------------------------------------------ fx: petals / glyph sparks
  var fx = (function () {
    var cv = document.getElementById("fx"); if (cv) cv.remove(); return null;   // tap effects removed: they cost frames
    var g = cv.getContext("2d"), P = [], sprouts = [], d = 1, W = 0, H = 0, dirty = false;
    function size() { d = Math.min(2, window.devicePixelRatio || 1); W = innerWidth; H = innerHeight; cv.width = W * d; cv.height = H * d; }
    size(); window.addEventListener("resize", size);
    var GL = "·".split("");
    function signal() { return root.getAttribute("data-theme") === "mono"; }
    function petal(x, y, vx, vy, big) {
      if (P.length > 160) P.shift();
      P.push({ k: "p", x: x, y: y, vx: vx + (Math.random() - 0.5) * 0.6, vy: vy - Math.random() * 0.6, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.12,
        s: (big ? 13 : 8) + Math.random() * 9, life: 1, decay: 0.0035 + Math.random() * 0.003, ph: Math.random() * 6.28, flip: Math.random() * 6.28 });
    }
    function spark(x, y, vx, vy) {
      if (P.length > 220) P.shift();
      P.push({ k: "g", x: x, y: y, vx: vx, vy: vy, ch: GL[(Math.random() * GL.length) | 0], life: 1, decay: 0.02 + Math.random() * 0.02, s: 10 + Math.random() * 6 });
    }
    function burst(x, y) {
      if (signal()) {
        for (var i = 0; i < 14; i++) { var a = i / 14 * Math.PI * 2 + Math.random() * 0.3; spark(x, y, Math.cos(a) * (1.5 + Math.random() * 2.5), Math.sin(a) * (1.5 + Math.random() * 2.5)); }
        return;
      }
      if (sprouts.length > 6) sprouts.shift();
      sprouts.push({ x: x, y: y, t0: performance.now(), seed: (Math.random() * 1e6) | 0, S: 70 + Math.random() * 40 });
    }
    var lastSpawn = 0;
    window.addEventListener("pointermove", function (e) {
      var now = performance.now(), sp = Garden.ptr.speed;
      if (signal()) return;

    }, { passive: true });
    window.addEventListener("pointerdown", function (e) { if (!e.target.closest("a,button,input,textarea,select,summary,label")) burst(e.clientX, e.clientY); }, { passive: true });
    var lastY = window.scrollY;
    function drawPetal(p, C) {
      var fl = Math.cos(p.flip), s = p.s;
      g.save(); g.translate(p.x, p.y); g.rotate(p.r); g.scale(1, Math.max(0.15, Math.abs(fl)));
      g.globalAlpha = Math.min(1, p.life * 1.6);
      g.beginPath(); g.moveTo(0, -s); g.quadraticCurveTo(s * 0.95, -s * 0.35, s * 0.18, s * 0.75); g.quadraticCurveTo(0, s * 0.55, -s * 0.18, s * 0.75); g.quadraticCurveTo(-s * 0.95, -s * 0.35, 0, -s);
      g.fillStyle = fl > 0 ? C.flower : C.deep; g.fill();
      g.beginPath(); g.moveTo(0, -s * 0.55); g.quadraticCurveTo(s * 0.2, 0, 0, s * 0.45); g.strokeStyle = C.line; g.lineWidth = 1; g.globalAlpha *= 0.7; g.stroke();
      g.restore();
    }
    var C = {};
    function recolor() { C = { flower: cssVar("--flower"), line: cssVar("--line"), accent: cssVar("--accent"), ink: cssVar("--ink"), deep: cssVar("--flower-deep") || cssVar("--flower") }; }
    recolor();
    function frame(now) {
      requestAnimationFrame(frame);
      // scrolling scatters a few petals / glyphs into the air
      var y = window.scrollY, dy = y - lastY; lastY = y;

      if (!sprouts.length && !P.length) { if (dirty) { g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height); dirty = false; } return; }
      dirty = true;
      g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, W, H);
      // sprouts: grow for 1.4 s, hold, then wither back into the ground
      if (sprouts.length) {
        var GC = Garden.colors();
        sprouts = sprouts.filter(function (sp) {
          var t = now - sp.t0, GROW = 1500, HOLD = 1600, FALL = 900;
          if (t > GROW + HOLD + FALL) return false;
          var age = t < GROW + HOLD ? t : (GROW + HOLD) * (1 - (t - GROW - HOLD) / FALL);
          g.globalAlpha = t < GROW + HOLD ? 1 : Math.max(0, 1 - (t - GROW - HOLD) / FALL);
          Garden.sprout(g, sp.x, sp.y, sp.S, Math.min(age, GROW + 400), sp.seed, GC);
          g.globalAlpha = 1;
          return true;
        });
      }
      if (!P.length) return;
      var t = now / 1000;
      g.font = "400 13px 'JetBrains Mono', monospace"; g.textAlign = "center"; g.textBaseline = "middle";
      P = P.filter(function (p) {
        p.life -= p.decay;
        if (p.life <= 0 || p.y > H + 60 || p.y < -80 || p.x < -60 || p.x > W + 60) return false;
        if (p.k === "p") {
          p.vy += 0.035; p.vx += Math.sin(t * 1.7 + p.ph) * 0.04; p.vx *= 0.985; p.vy *= 0.985; p.vy = Math.min(p.vy, 1.6);
          p.x += p.vx; p.y += p.vy; p.r += p.vr + p.vx * 0.01; p.flip += 0.05 + Math.abs(p.vx) * 0.02;
          drawPetal(p, C);
        } else {
          p.vx *= 0.94; p.vy *= 0.94; p.x += p.vx; p.y += p.vy;
          if (Math.random() < 0.15) p.ch = GL[(Math.random() * GL.length) | 0];
          g.globalAlpha = p.life; g.fillStyle = p.life > 0.6 ? C.ink : C.accent; g.font = "400 " + p.s + "px 'JetBrains Mono', monospace";
          g.fillText(p.ch, p.x, p.y);
        }
        return true;
      });
      g.globalAlpha = 1;
    }
    requestAnimationFrame(frame);
    return { recolor: recolor, burst: burst };
  })();

  // ---------------------------------------------------------- scroll loop
  function scrollState() {
    var y = window.scrollY;
    // curtain blooms over the seam between the intro and the spiral
    if (intro && spiralSec && intro.nextElementSibling === spiralSec) {
      if (!M) measure();
      var seam = M.top, x = (y - (seam - vh * 1.45)) / (vh * 1.35);   // gone by the time the cards arrive
      scrollG = reduced ? 0 : clamp(Math.min(x / 0.42, (1 - x) / 0.42), 0, 1);
      var fade = clamp((y - M.introTop) / (vh * 0.9), 0, 1);
      intro.style.setProperty("--fade", fade.toFixed(3));
    } else {
      scrollG = 0;
      if (intro) intro.style.setProperty("--fade", clamp((y - intro.offsetTop) / (vh * 0.9), 0, 1).toFixed(3));
    }
  }
  var revealEls = document.querySelectorAll("[data-reveal], [data-branch]");
  if (potato || !("IntersectionObserver" in window)) revealEls.forEach(function (el) { el.classList.add("is-in"); });
  else {
    var rio = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("is-in"); rio.unobserve(e.target); } }); }, { rootMargin: "0px 0px -12% 0px" });
    revealEls.forEach(function (el) { rio.observe(el); });
  }
  var scrolled = true;
  window.addEventListener("scroll", function () { scrolled = true; spinIdle = false; }, { passive: true });
  function loop(now) {
    requestAnimationFrame(loop);
    if (scrolled) { scrolled = false; scrollState(); }
    layoutSpiral(now);
  }
  window.addEventListener("resize", function () { vh = window.innerHeight; measure(); scrolled = true; spinIdle = false; });
  if (window.ResizeObserver && spiralSec) new ResizeObserver(function () { measure(); scrolled = true; spinIdle = false; }).observe(document.body);
  setTheme(root.getAttribute("data-theme"), false);
  if (!potato) requestAnimationFrame(loop);


  // ------------------------------------------------------------ potato mode switch + watchdog
  function potatoPref() { try { return localStorage.getItem("clubbb-potato") || "auto"; } catch (e) { return "auto"; } }
  function setPotato(v) {
    try { if (v === "auto") localStorage.removeItem("clubbb-potato"); else localStorage.setItem("clubbb-potato", v); } catch (e) {}
    location.reload();
  }
  document.querySelectorAll("[data-potato-set]").forEach(function (b) {
    var v = b.getAttribute("data-potato-set");
    b.setAttribute("aria-pressed", v === potatoPref() ? "true" : "false");
    b.addEventListener("click", function () { if (v !== potatoPref()) setPotato(v); });
  });
  // if the phone stutters badly in the first seconds, offer Potato mode once
  if (!potato && potatoPref() === "auto") {
    var frames = 0, t1 = 0, asked = false;
    try { asked = sessionStorage.getItem("clubbb-potato-asked") === "1"; } catch (e) {}
    function count(now) {
      if (!t1) t1 = now;
      frames++;
      if (now - t1 < 3500) return requestAnimationFrame(count);
      var fps = frames * 1000 / (now - t1);
      if (fps < 24 && !asked) {
        try { sessionStorage.setItem("clubbb-potato-asked", "1"); } catch (e) {}
        var el = document.createElement("div");
        el.className = "toast potato-offer"; el.setAttribute("role", "status");
        el.innerHTML = '<span class="mono">This page is running slowly</span><span>Switch to <strong>Potato mode</strong>, a lighter version with no animations?</span>' +
          '<span class="potato-actions"><button type="button" class="btn" data-yes>Switch</button><button type="button" class="btn btn-ghost" data-no>No thanks</button></span>';
        document.body.appendChild(el); setTimeout(function () { el.classList.add("in"); }, 50);
        el.querySelector("[data-yes]").addEventListener("click", function () { setPotato("on"); });
        el.querySelector("[data-no]").addEventListener("click", function () { try { localStorage.setItem("clubbb-potato", "off"); } catch (e) {} el.remove(); });
      }
    }
    setTimeout(function () { requestAnimationFrame(count); }, 1500);
  }

  // ------------------------------------------------- clash check while typing
  document.querySelectorAll("form[data-clash-check]").forEach(function (form) {
    var box = form.querySelector(".clash-live"), t = null;
    var token = (/\/manage\/([A-Za-z0-9_-]+)\//.exec(form.getAttribute("action")) || [])[1] || "";
    function esc(v) { return String(v || "").replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
    function when(iso) { var d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }
    function check() {
      var st = form.elements.starts_at.value; if (!st) { box.innerHTML = ""; return; }
      var q = new URLSearchParams({ starts: st, ends: form.elements.ends_at.value, venue: form.elements.venue.value, token: token });
      fetch("/api/clashes?" + q).then(function (r) { return r.json(); }).then(function (d) {
        var c = d.clashes || [];
        if (!c.length) { box.innerHTML = '<p class="clash-ok mono">No clashes at that time.</p>'; return; }
        var hard = c.some(function (x) { return x.same_venue; });
        box.innerHTML = '<div class="clash' + (hard ? " is-hard" : "") + '"><p class="mono">' + (hard ? "Venue double-booked" : "Other events at the same time") + "</p><ul>" +
          c.map(function (x) { return '<li class="' + (x.same_venue ? "hard" : "soft") + '"><strong>' + esc(x.title) + "</strong> · " + esc(x.club) + " · " + esc(when(x.starts_at)) + (x.venue ? " · " + esc(x.venue) : "") + (x.same_venue ? " · <em>same venue</em>" : "") + "</li>"; }).join("") + "</ul></div>";
      }).catch(function () {});
    }
    ["starts_at", "ends_at", "venue"].forEach(function (n) { var el = form.elements[n]; if (el) el.addEventListener("input", function () { clearTimeout(t); t = setTimeout(check, 350); }); });
    if (form.elements.starts_at.value) check();
  });

  // ------------------------------------------- on-site reminders ("Starting soon")
  var REM = "clubbb-reminders";
  function loadRem() { try { return JSON.parse(localStorage.getItem(REM) || "[]"); } catch (e) { return []; } }
  function saveRem(list) { try { localStorage.setItem(REM, JSON.stringify(list)); } catch (e) {} }
  // drop anything that ended more than two hours ago
  var rems = loadRem().filter(function (r) { return new Date(r.start).getTime() > Date.now() - 2 * 3600e3; });
  saveRem(rems);
  document.querySelectorAll("[data-remind]").forEach(function (b) {
    var id = b.getAttribute("data-id");
    function paint() { var on = loadRem().some(function (r) { return r.id === id; }); b.textContent = on ? "Reminder saved ✓" : "Remind me on this site"; b.setAttribute("aria-pressed", on ? "true" : "false"); }
    paint();
    b.addEventListener("click", function () {
      var list = loadRem(), on = list.some(function (r) { return r.id === id; });
      if (on) list = list.filter(function (r) { return r.id !== id; });
      else list.push({ id: id, title: b.getAttribute("data-title"), start: b.getAttribute("data-start"), venue: b.getAttribute("data-venue"), url: "/e/" + id });
      saveRem(list); paint();
      if (!on && "Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(function () {});
    });
  });
  (function soonToast() {
    var now = Date.now(), soon = rems.map(function (r) { return { r: r, t: new Date(r.start).getTime() - now }; })
      .filter(function (x) { return x.t > -3600e3 && x.t < 24 * 3600e3; }).sort(function (a, b) { return a.t - b.t; });
    var seen; try { seen = JSON.parse(sessionStorage.getItem("clubbb-toasted") || "[]"); } catch (e) { seen = []; }
    soon = soon.filter(function (x) { return seen.indexOf(x.r.id) < 0; });
    if (!soon.length) return;
    var x = soon[0], mins = Math.round(x.t / 60000);
    var label = mins <= 0 ? "Happening now" : mins < 60 ? "Starts in " + mins + " min" : "Starts in " + Math.round(mins / 60) + " h";
    var el = document.createElement("div");
    el.className = "toast"; el.setAttribute("role", "status");
    el.innerHTML = '<span class="mono"></span><a></a><button type="button" aria-label="Dismiss">×</button>';
    el.querySelector("span").textContent = label + (soon.length > 1 ? " · +" + (soon.length - 1) + " more" : "");
    var a = el.querySelector("a"); a.textContent = x.r.title; a.href = x.r.url; a.setAttribute("data-bloom", "");
    el.querySelector("button").addEventListener("click", function () { el.classList.remove("in"); setTimeout(function () { el.remove(); }, 400); });
    document.body.appendChild(el);
    setTimeout(function () { el.classList.add("in"); }, 900);
    seen.push(x.r.id); try { sessionStorage.setItem("clubbb-toasted", JSON.stringify(seen)); } catch (e) {}
    if ("Notification" in window && Notification.permission === "granted" && mins <= 60) {
      try { new Notification(x.r.title, { body: label + (x.r.venue ? " · " + x.r.venue : "") }); } catch (e) {}
    }
  })();

  // ------------------------------------------------------------ moments
  // highlights without photos grow a small garden around "1st" when they scroll into view
  document.querySelectorAll(".hl-empty canvas[data-card-text]").forEach(function (cv, i) {
    var start = null;
    Garden.text(cv, { text: cv.getAttribute("data-card-text"), fill: 0.42, lite: true, stagger: 140, seed: 501 + i * 17, still: potato,
      clock: function (now) { return (reduced || potato) ? 1e6 : start == null ? -1 : now - start; } });
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (es) { if (es[0].isIntersecting) { start = performance.now(); io.disconnect(); } }, { threshold: 0.4 });
      io.observe(cv);
    } else start = performance.now();
  });
  // photo viewer
  (function () {
    var box = null, list = [], at = 0;
    function show() {
      box.querySelector("img").src = list[at];
      box.querySelector(".lb-count").textContent = list.length > 1 ? (at + 1) + " / " + list.length : "";
    }
    function close() { if (box) { box.classList.remove("in"); setTimeout(function () { if (box) { box.remove(); box = null; } }, 300); } }
    function open(photos) {
      list = photos; at = 0;
      box = document.createElement("div"); box.className = "lightbox"; box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true");
      box.innerHTML = '<img alt=""><button class="lb-x" type="button" aria-label="Close">×</button>' +
        (photos.length > 1 ? '<button class="lb-prev" type="button" aria-label="Previous">‹</button><button class="lb-next" type="button" aria-label="Next">›</button>' : "") +
        '<span class="lb-count mono"></span>';
      document.body.appendChild(box); show();
      requestAnimationFrame(function () { box.classList.add("in"); });
      box.addEventListener("click", function (e) {
        if (e.target.closest(".lb-next")) { at = (at + 1) % list.length; show(); }
        else if (e.target.closest(".lb-prev")) { at = (at - 1 + list.length) % list.length; show(); }
        else if (!e.target.closest("img")) close();
      });
      box.querySelector(".lb-x").focus();
    }
    document.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-gallery]");
      if (!b) return;
      try { open(JSON.parse(b.getAttribute("data-gallery"))); } catch (er) {}
    });
    document.addEventListener("keydown", function (e) {
      if (!box) return;
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight" && list.length > 1) { at = (at + 1) % list.length; show(); }
      if (e.key === "ArrowLeft" && list.length > 1) { at = (at - 1 + list.length) % list.length; show(); }
    });
  })();
  // shrink big photos in the browser before upload (max 1800 px, JPEG)
  document.querySelectorAll("input[type=file][data-shrink]").forEach(function (input) {
    input.addEventListener("change", function () {
      if (!window.DataTransfer || !input.files.length) return;
      var files = Array.prototype.slice.call(input.files, 0, 8), out = new DataTransfer(), left = files.length;
      var note = input.parentNode.querySelector(".shrink-note") || input.parentNode.appendChild(Object.assign(document.createElement("span"), { className: "shrink-note muted small" }));
      note.textContent = "Preparing " + files.length + " photo" + (files.length > 1 ? "s" : "") + "…";
      files.forEach(function (f, i) {
        var done = function (blob) {
          out.items.add(blob ? new File([blob], (f.name.replace(/\.[^.]+$/, "") || "photo") + ".jpg", { type: "image/jpeg" }) : f);
          if (--left === 0) { input.files = out.files; note.textContent = files.length + " photo" + (files.length > 1 ? "s" : "") + " ready"; }
        };
        if (!/^image\//.test(f.type)) return done(null);
        var img = new Image(), url = URL.createObjectURL(f);
        img.onload = function () {
          var k = Math.min(1, 2000 / Math.max(img.width, img.height)), c = document.createElement("canvas");
          c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
          c.toBlob(function (b) { done(b && b.size < f.size ? b : null); }, "image/jpeg", 0.85);
        };
        img.onerror = function () { URL.revokeObjectURL(url); done(null); };
        img.src = url;
      });
    });
  });

  // ------------------------------------------------------------ the vine (Rose noir)
  // One stem grows down the page as you scroll; at each [data-branch] section it reaches
  // out and a rose opens. Plain SVG lines: almost free to draw.
  var vine = (function () {
    var NS = "http://www.w3.org/2000/svg", svg = null, host = null, hostTop = 0, hostH = 0, shown = true, stem = null, ys = [], lens = [], L = 0, branches = [], leaves = [], built = false;
    function el(tag, attrs, parent) { var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
    function clear() { if (host) host.remove(); host = null; svg = null; built = false; branches = []; leaves = []; }
    function rose(g, s) {
      var r = el("g", { "class": "vr-in" }, g);
      el("path", { d: "M-16 2c0-10 7-15 16-15s17 5 17 14-7 15-17 15-16-5-16-14z", fill: "var(--flower)", transform: "scale(" + s + ")" }, r);
      el("path", { d: "M-6 0c2-5 8-6 11-2s1 8-4 7-4-5-1-5M-11 6c4 3 8 4 12 3s9-3 11-5", fill: "none", stroke: "var(--line)", "stroke-width": 1.6 / s, "stroke-linecap": "round", transform: "scale(" + s + ")" }, r);
    }
    function leaf(x, y, a, s) {
      var g = el("g", { "class": "vine-leaf", transform: "translate(" + x.toFixed(1) + " " + y.toFixed(1) + ") rotate(" + a.toFixed(1) + ")" }, svg);
      el("path", { "class": "vl-in", d: "M0 0c" + (6 * s) + " " + (-7 * s) + " " + (17 * s) + " " + (-6 * s) + " " + (22 * s) + " 0c" + (-6 * s) + " " + (6 * s) + " " + (-16 * s) + " " + (7 * s) + " " + (-22 * s) + " 0z", fill: "var(--stem)" }, g);
      leaves.push({ y: y, g: g });
    }
    function build() {
      clear();
      if (root.getAttribute("data-theme") === "mono") return;
      var secs = Array.prototype.slice.call(document.querySelectorAll("[data-branch]")).filter(function (s) { return s.offsetParent !== null; });
      if (!secs.length) return;
      var W = document.documentElement.clientWidth, sy = window.scrollY, small = W < 760;
      var gx = small ? 9 : clamp(W * 0.032, 22, 52), wob = small ? 2.5 : 12;
      var X = function (y) { return gx + Math.sin(y * 0.0042) * wob + Math.sin(y * 0.0013 + 1.3) * wob * 0.5; };
      var pos = secs.map(function (s) { var r = s.getBoundingClientRect(); return { el: s, top: r.top + sy, h: r.height, left: r.left }; });
      var y0 = Math.max(0, pos[0].top - vh * 0.35), y1 = pos[pos.length - 1].top + Math.min(pos[pos.length - 1].h * 0.5, 260);
      // the layer only spans the stretch of page the vine lives in, and hides when off-screen
      hostTop = Math.max(0, Math.floor(y0 - 80)); hostH = Math.ceil(y1 + 80 - hostTop);
      host = el("svg", { "class": "vine", "aria-hidden": "true", width: W, height: hostH });
      host.style.top = hostTop + "px";
      document.body.appendChild(host);
      svg = el("g", { transform: "translate(0 " + (-hostTop) + ")" }, host);
      // stem: smooth curve through points every 24 px, with its length tabulated by height
      var d = "", px = X(y0), py = y0; ys = [y0]; lens = [0]; L = 0;
      d = "M" + px.toFixed(1) + " " + py.toFixed(1);
      for (var y = y0 + 24; y <= y1; y += 24) {
        var x = X(y); L += Math.hypot(x - px, y - py); d += "L" + x.toFixed(1) + " " + y.toFixed(1);
        ys.push(y); lens.push(L); px = x; py = y;
      }
      stem = el("path", { "class": "vine-stem", d: d, fill: "none", stroke: "var(--stem)", "stroke-width": small ? 2 : 3, "stroke-linecap": "round", "stroke-linejoin": "round" }, svg);
      stem.style.strokeDasharray = L + " " + L; stem.style.strokeDashoffset = L;
      // leaves along the stem, alternating sides
      var side = 1;
      for (var ly = y0 + 110; ly < y1 - 40; ly += small ? 150 : 120) { side = -side; leaf(X(ly), ly, side > 0 ? -35 : 215, small ? 0.7 : 1.1); }
      // small buds along the stem, between the sections
      for (var by0 = y0 + 300; by0 < y1 - 120; by0 += small ? 520 : 420) {
        var bdx = (Math.floor(by0 / 420) % 2 ? 1 : -1) * (small ? 9 : 16), bx0 = X(by0);
        el("path", { "class": "vine-branch bud-stalk", d: "M" + bx0.toFixed(1) + " " + by0.toFixed(1) + "q" + (bdx * 0.4).toFixed(1) + " -6 " + bdx.toFixed(1) + " -14", fill: "none", stroke: "var(--stem)", "stroke-width": small ? 1.3 : 2, "stroke-linecap": "round" }, svg);
        var bg = el("g", { "class": "vine-leaf vine-bud", transform: "translate(" + (bx0 + bdx).toFixed(1) + " " + (by0 - 16).toFixed(1) + ")" }, svg);
        el("ellipse", { "class": "vl-in", rx: small ? 3.2 : 4.6, ry: small ? 4.4 : 6.4, fill: "var(--flower)" }, bg);
        leaves.push({ y: by0, g: bg });
      }
      // a branch out to each section, with a rose at its tip
      pos.forEach(function (s, i) {
        var by = s.top + Math.min(70, s.h * 0.25), bx = X(by);
        var wide = s.left < gx + 70;
        var tx = small ? bx + 1 : (wide ? bx + 74 : Math.max(bx + 40, s.left - 22)), ty = by - (small ? 14 : 34);   // phones: bloom on the stem, in the margin
        var dir = i % 2 ? 1 : -1;
        var bd = "M" + bx.toFixed(1) + " " + by.toFixed(1) + "C" + (bx + (tx - bx) * 0.35).toFixed(1) + " " + (by + 18 * dir).toFixed(1) + " " + (bx + (tx - bx) * 0.7).toFixed(1) + " " + (ty - 10 * dir).toFixed(1) + " " + tx.toFixed(1) + " " + ty.toFixed(1);
        var b = el("path", { "class": "vine-branch", d: bd, fill: "none", stroke: "var(--stem)", "stroke-width": small ? 1.6 : 2.4, "stroke-linecap": "round" }, svg);
        var bl = b.getTotalLength(); b.style.strokeDasharray = bl + " " + bl; b.style.strokeDashoffset = bl;
        var g = el("g", { "class": "vine-rose", transform: "translate(" + tx.toFixed(1) + " " + ty.toFixed(1) + ")" }, svg);
        rose(g, small ? 0.5 : 1.3);
        if (!small) {
          leaf(bx + (tx - bx) * 0.45, by + (ty - by) * 0.45, -20 - 30 * dir, 0.85);
          leaf(bx + (tx - bx) * 0.75, by + (ty - by) * 0.75, 160 + 20 * dir, 0.75);
        }
        branches.push({ y: by, path: b, len: bl, rose: g, open: false });
      });
      built = true;
      update();
    }
    function update() {
      if (!built) return;
      var sy = window.scrollY, vis = sy + vh > hostTop - 40 && sy < hostTop + hostH + 40;
      if (vis !== shown) { shown = vis; host.style.display = vis ? "" : "none"; }
      if (!vis) return;
      var front = potato ? 1e9 : sy + vh * 0.8, drawn;
      if (front <= ys[0]) drawn = 0;
      else if (front >= ys[ys.length - 1]) drawn = L;
      else { var i = Math.min(ys.length - 2, Math.floor((front - ys[0]) / 24)), f = (front - ys[i]) / (ys[i + 1] - ys[i]); drawn = lens[i] + (lens[i + 1] - lens[i]) * f; }
      stem.style.strokeDashoffset = (L - drawn).toFixed(1);
      for (var k = 0; k < branches.length; k++) {
        var b = branches[k], pr = clamp((front - b.y) / (vh * 0.2), 0, 1);
        b.path.style.strokeDashoffset = (b.len * (1 - pr)).toFixed(1);
        var o = pr > 0.92; if (o !== b.open) { b.open = o; b.rose.classList.toggle("open", o); }
      }
      for (var j = 0; j < leaves.length; j++) { var on = front > leaves[j].y + 16; if (on !== leaves[j].on) { leaves[j].on = on; leaves[j].g.classList.toggle("open", on); } }
    }
    var t = null;
    function soon() { clearTimeout(t); t = setTimeout(build, 180); }
    window.addEventListener("load", soon);
    window.addEventListener("resize", soon);
    if (window.ResizeObserver) { var lastH = 0; new ResizeObserver(function () { var h = document.documentElement.scrollHeight; if (Math.abs(h - lastH) > 4) { lastH = h; soon(); } }).observe(document.body); }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(soon);
    return { build: soon, update: update };
  })();
  window.addEventListener("scroll", function () { if (potato) return; vine.update(); }, { passive: true });

  // ------------------------------------------------------------ small bits
  document.querySelectorAll("[data-copy]").forEach(function (b) {
    b.addEventListener("click", function () {
      var text = b.getAttribute("data-copy"), old = b.textContent;
      var done = function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = old; }, 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(location.origin + text).then(done).catch(function () {});
    });
  });
})();
