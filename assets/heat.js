// Crucible teaser: a small block-grid heat field. Rock conducts, cracks carry heat upward,
// hot air rises. The pointer is a heat source.
(function () {
    'use strict';

    var STEP_MS = 1000 / 30;

    var stage = document.querySelector('[data-heat]');
    if (!stage) { return; }

    // Size the grid to the stage so blocks stay square and roughly 8px on any screen
    var box = stage.getBoundingClientRect();
    var W = Math.max(48, Math.min(120, Math.round(box.width / 8)));
    var H = Math.max(24, Math.round(W * box.height / box.width));
    var N = W * H;
    stage.style.setProperty('--cols', W);
    stage.style.setProperty('--rows', H);

    var canvas = stage.querySelector('canvas');
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(W, H);
    var px = img.data;

    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Deterministic layout so the page looks the same on every visit
    var seed = 0x5eed;
    function rand() {
        seed = (seed + 0x6D2B79F5) | 0;
        var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    var T = new Float32Array(N);
    var T2 = new Float32Array(N);
    var solid = new Uint8Array(N);
    var cond = new Float32Array(N);
    var keep = new Float32Array(N);
    var shade = new Float32Array(N);
    var feed = new Int32Array(N).fill(-1);  // crack cell -> the crack cell beneath it
    var surface = new Int16Array(W);
    var vents = [];
    var embers = [];

    // ----- Terrain -----
    for (var x = 0; x < W; x++) {
        var s = H * 0.52
            + 5.0 * Math.sin(x * 0.065 + 1.0)
            + 3.0 * Math.sin(x * 0.17 + 2.0)
            + 1.5 * Math.sin(x * 0.41 + 0.3);
        surface[x] = Math.max(8, Math.min(H - 6, Math.round(s)));
        for (var y = 0; y < H; y++) {
            var i = y * W + x;
            shade[i] = 0.75 + rand() * 0.5;
            if (y >= surface[x]) {
                solid[i] = 1;
                cond[i] = 0.09;
                keep[i] = 0.9975;
            } else {
                cond[i] = 0.2;
                keep[i] = 0.962;
            }
        }
    }

    // ----- Heat sources at the bedrock, each feeding a crack toward the surface -----
    var sources = [];
    var NSRC = Math.max(3, Math.round(W / 24));
    for (var k = 0; k < NSRC; k++) {
        var sx = Math.round((k + 0.5) * W / NSRC + (rand() - 0.5) * 12);
        sources.push({ x: sx, phase: rand() * 6.28, rate: 0.35 + rand() * 0.5 });
        var cx = sx, prev = -1;
        for (var cy = H - 1; cy >= 0; cy--) {
            cx = Math.max(1, Math.min(W - 2, cx + (rand() < 0.35 ? (rand() < 0.5 ? -1 : 1) : 0)));
            var ci = cy * W + cx;
            if (!solid[ci]) {
                if (prev >= 0) { vents.push(prev); }
                break;
            }
            cond[ci] = 0.3;
            keep[ci] = 0.996;
            shade[ci] *= 0.6;
            feed[ci] = prev;
            prev = ci;
        }
    }

    // ----- Palette: cold purple -> ember red -> brand orange -> amber -> white-hot -----
    var STOPS = [
        [0.00, 7, 7, 13],
        [0.10, 34, 20, 62],
        [0.26, 110, 28, 44],
        [0.44, 196, 58, 18],
        [0.62, 249, 115, 22],
        [0.82, 245, 158, 11],
        [1.00, 255, 238, 196]
    ];
    var LUT = new Uint8Array(256 * 3);
    for (var l = 0; l < 256; l++) {
        var v = l / 255, j = 0;
        while (j < STOPS.length - 2 && v > STOPS[j + 1][0]) { j++; }
        var a = STOPS[j], b = STOPS[j + 1];
        var f = Math.max(0, Math.min(1, (v - a[0]) / (b[0] - a[0])));
        LUT[l * 3] = a[1] + (b[1] - a[1]) * f;
        LUT[l * 3 + 1] = a[2] + (b[2] - a[2]) * f;
        LUT[l * 3 + 2] = a[3] + (b[3] - a[3]) * f;
    }

    // ----- Pointer -----
    var pointer = { active: false, x: 0, y: 0, burst: 0 };

    function toCell(e) {
        var r = stage.getBoundingClientRect();
        pointer.x = (e.clientX - r.left) / r.width * W;
        pointer.y = (e.clientY - r.top) / r.height * H;
    }

    function touched() {
        if (!stage.classList.contains('touched')) { stage.classList.add('touched'); }
        if (reduceMotion) { wake(); }
    }

    stage.addEventListener('pointermove', function (e) { toCell(e); pointer.active = true; touched(); });
    stage.addEventListener('pointerdown', function (e) { toCell(e); pointer.active = true; pointer.burst = 6; touched(); });
    stage.addEventListener('pointerleave', function () { pointer.active = false; });
    stage.addEventListener('pointercancel', function () { pointer.active = false; });

    var hint = stage.querySelector('.hud-hint');
    if (hint && hint.dataset.touch && window.matchMedia('(hover: none)').matches) {
        hint.textContent = hint.dataset.touch;
    }

    // ----- Simulation -----
    var time = 0;

    function inject(cx, cy, r, amount) {
        var x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r));
        var y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H - 1, Math.ceil(cy + r));
        for (var yy = y0; yy <= y1; yy++) {
            for (var xx = x0; xx <= x1; xx++) {
                var dx = xx + 0.5 - cx, dy = yy + 0.5 - cy;
                var d = Math.sqrt(dx * dx + dy * dy) / r;
                if (d < 1) {
                    var ii = yy * W + xx;
                    T[ii] = Math.min(1.4, T[ii] + amount * (1 - d));
                }
            }
        }
    }

    function step() {
        time += STEP_MS / 1000;

        // Bedrock warmth and pulsing sources
        for (var bx = 0; bx < W; bx++) {
            var bi = (H - 1) * W + bx;
            T[bi] = Math.max(T[bi], 0.3);
        }
        for (var k = 0; k < sources.length; k++) {
            var src = sources[k];
            var heat = 0.85 + 0.45 * Math.sin(time * src.rate + src.phase);
            for (var oy = 1; oy <= 2; oy++) {
                for (var ox = -1; ox <= 1; ox++) {
                    var si = (H - oy) * W + Math.max(0, Math.min(W - 1, src.x + ox));
                    T[si] = Math.max(T[si], heat);
                }
            }
        }

        // Occasional flare somewhere on the surface
        if (rand() < 0.012) {
            var fx = Math.floor(rand() * W);
            inject(fx + 0.5, surface[fx] + 0.5, 2.2, 0.9);
        }

        if (pointer.active) {
            inject(pointer.x, pointer.y, 3.2, 0.22);
        }
        if (pointer.burst > 0) {
            inject(pointer.x, pointer.y, 4.5, 0.35);
            pointer.burst--;
        }

        for (var y = 0; y < H; y++) {
            var up = y > 0 ? -W : 0;
            var down = y < H - 1 ? W : 0;
            for (var x = 0; x < W; x++) {
                var i = y * W + x;
                var left = x > 0 ? -1 : 0;
                var right = x < W - 1 ? 1 : 0;
                var t = T[i];
                var avg = (T[i + up] + T[i + down] + T[i + left] + T[i + right]) * 0.25;
                var n = t + cond[i] * (avg - t);

                if (feed[i] >= 0) {
                    // Cracks carry heat up from below
                    n += (T[feed[i]] - n) * 0.5;
                } else if (!solid[i] && y < H - 1) {
                    // Buoyancy: pull from the cell below, with a little lateral shimmer
                    var jx = x + (rand() < 0.3 ? (rand() < 0.5 ? -1 : 1) : 0);
                    jx = jx < 0 ? 0 : (jx >= W ? W - 1 : jx);
                    var bj = (y + 1) * W + jx;
                    var below = T[bj] * (solid[bj] ? 0.55 : 1);
                    n += (below - n) * 0.55;
                }

                // Top rows vent heat to the sky
                T2[i] = n * keep[i] * (y < 3 ? 0.9 : 1);
            }
        }

        var tmp = T; T = T2; T2 = tmp;

        // Embers: thrown from hot vents and from wherever the pointer is
        for (var v = 0; v < vents.length; v++) {
            var vt = T[vents[v]];
            if (vt > 0.55 && rand() < (vt - 0.5) * 0.25) {
                spawnEmber((vents[v] % W) + rand(), Math.floor(vents[v] / W) - 0.2);
            }
        }
        if (pointer.active && rand() < 0.35) {
            spawnEmber(pointer.x + (rand() - 0.5) * 3, pointer.y + (rand() - 0.5) * 3);
        }
        for (var e = embers.length - 1; e >= 0; e--) {
            var em = embers[e];
            em.x += em.vx + (rand() - 0.5) * 0.25;
            em.y += em.vy;
            em.vy *= 0.985;
            em.life -= em.decay;
            if (em.life <= 0 || em.y < 0 || em.x < 0 || em.x >= W) {
                embers[e] = embers[embers.length - 1];
                embers.pop();
            }
        }
    }

    function spawnEmber(x, y) {
        if (embers.length > 160) { return; }
        embers.push({
            x: x, y: y,
            vx: (rand() - 0.5) * 0.3,
            vy: -0.25 - rand() * 0.45,
            life: 1,
            decay: 0.012 + rand() * 0.02
        });
    }

    function render() {
        for (var i = 0, p = 0; i < N; i++, p += 4) {
            var t = T[i];
            var r, g, b;
            if (solid[i]) {
                var li = Math.min(255, (t * 255) | 0) * 3;
                var sh = shade[i];
                var top = i >= W && !solid[i - W];
                var base = top ? 46 : 22;
                r = Math.max(base * sh, LUT[li]);
                g = Math.max(base * sh, LUT[li + 1]);
                b = Math.max((base + 16) * sh, LUT[li + 2]);
            } else {
                var la = Math.min(255, (t * 240) | 0) * 3;
                r = LUT[la]; g = LUT[la + 1]; b = LUT[la + 2];
            }
            px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = 255;
        }
        for (var e = 0; e < embers.length; e++) {
            var em = embers[e];
            var ex = em.x | 0, ey = em.y | 0;
            if (ex < 0 || ex >= W || ey < 0 || ey >= H) { continue; }
            var q = (ey * W + ex) * 4;
            var lj = Math.min(255, (0.45 + em.life * 0.6) * 255 | 0) * 3;
            var k = em.life;
            px[q] = Math.max(px[q], LUT[lj] * k);
            px[q + 1] = Math.max(px[q + 1], LUT[lj + 1] * k);
            px[q + 2] = Math.max(px[q + 2], LUT[lj + 2] * k);
        }
        ctx.putImageData(img, 0, 0);
    }

    // Warm up so the first frame already glows
    for (var w = 0; w < 400; w++) { step(); }
    render();

    // ----- Loop: fixed-rate sim, paused when offscreen or hidden -----
    var visible = true, running = false, last = 0, acc = 0, idleUntil = 0;

    function frame(now) {
        if (!running) { return; }
        acc += Math.min(250, now - last);
        last = now;
        while (acc >= STEP_MS) { step(); acc -= STEP_MS; }
        render();
        if (reduceMotion && now > idleUntil) { running = false; return; }
        requestAnimationFrame(frame);
    }

    function start() {
        if (running || !visible || document.hidden) { return; }
        if (reduceMotion && performance.now() > idleUntil) { return; }
        running = true;
        last = performance.now();
        acc = 0;
        requestAnimationFrame(frame);
    }

    function wake() {
        idleUntil = performance.now() + 4000;
        start();
    }

    if ('IntersectionObserver' in window) {
        new IntersectionObserver(function (entries) {
            visible = entries[0].isIntersecting;
            if (visible) { start(); } else { running = false; }
        }).observe(stage);
    }

    document.addEventListener('visibilitychange', function () {
        if (document.hidden) { running = false; } else { start(); }
    });

    start();
})();
