/*!
 * TT / DEATH RIDE — Engine Audio
 * ---------------------------------------------------------------------------
 * A fully self-contained Web Audio synthesizer for a 1000cc inline-four
 * superbike (Isle-of-Man-TT flavoured). Zero dependencies, zero external
 * assets, works straight from file://.
 *
 * Exposed API (on window.TTEngineAudio):
 *
 *   const audio = new TTEngineAudio({ masterVolume: 0.85 });
 *   await audio.unlock();          // MUST be called from a user gesture
 *   audio.update({ rpm, throttle, speedKmh, gear, braking, tuck,
 *                  airborne, revLimit });           // call at 30-60 Hz
 *   audio.triggerShift(true);      // true = up, false = down
 *   audio.triggerCrash(0.9);       // 0..1
 *   audio.triggerNearMiss();       // short stereo whoosh
 *   audio.triggerCountdown();      // beep
 *   audio.setMuted(true);
 *   audio.setPaused(true);
 *   audio.stop();                  // fade out + close the AudioContext
 *
 * Extras (not required by the game, handy for settings / debug):
 *   audio.setVolume(0..1);
 *   audio.getLevel();              // post-master RMS, 0..~1
 *
 * Nothing is created or scheduled before unlock(): no AudioContext exists
 * until then. All parameter moves use setTargetAtTime / short ramps, so there
 * are no zipper artefacts or clicks. Every transient voice is disconnected on
 * "ended" so the graph cannot creep.
 *
 * The firing frequency of an inline-four is rpm / 30 Hz (two power pulses per
 * crank revolution); the tone stack is built on multiples of that frequency.
 * ---------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- constants
  var REDLINE = 16000;
  var TOP_RPM = REDLINE;

  // ------------------------------------------------------------------ helpers
  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function num(v, fallback) {
    v = +v;
    return isFinite(v) ? v : fallback;
  }

  function smoothstep(edge0, edge1, x) {
    var t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function rand(a, b) {
    return a + Math.random() * (b - a);
  }

  function defaultState() {
    return {
      rpm: 0,
      throttle: 0,
      speedKmh: 0,
      gear: 1,
      braking: false,
      tuck: false,
      airborne: false,
      revLimit: false
    };
  }

  /**
   * Builds a looping noise buffer. "pink" is a decent approximation using the
   * Paul Kellet filter cascade (warmer, less "hiss"); "white" is raw.
   */
  function buildNoiseBuffer(ctx, seconds, kind) {
    var sr = ctx.sampleRate || 44100;
    var len = Math.max(64, Math.floor(sr * seconds));
    var buf = ctx.createBuffer(1, len, sr);
    var data = buf.getChannelData(0);
    var i;
    if (kind === 'white') {
      for (i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } else {
      var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (i = 0; i < len; i++) {
        var white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        var pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
        b6 = white * 0.115926;
        data[i] = clamp(pink * 0.11, -1, 1);
      }
    }
    return buf;
  }

  /** Soft saturation curve (tanh) used to fatten the engine stack. */
  function buildSoftClipCurve(amount, samples) {
    var n = samples || 2048;
    var curve = new Float32Array(n);
    var norm = Math.tanh(amount) || 1;
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(amount * x) / norm;
    }
    return curve;
  }

  /**
   * Final safety limiter curve: linear below 0.55, soft-saturating to 0.95.
   * Inputs outside [-1, 1] clamp to the curve ends, so the post-master signal
   * can never exceed ~0.95 even if the compressor overshoots on a hard
   * transient. Transparent for normal levels.
   */
  function buildLimiterCurve(samples) {
    var n = samples || 4096;
    var curve = new Float32Array(n);
    var kneePoint = 0.55;
    var ceil = 0.95;
    var span = 1 - kneePoint;
    var norm = Math.tanh(2.2) || 1;
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1;
      var ax = Math.abs(x);
      var y;
      if (ax <= kneePoint) {
        y = ax;
      } else {
        y = kneePoint + (ceil - kneePoint) *
          (Math.tanh(((ax - kneePoint) / span) * 2.2) / norm);
      }
      curve[i] = x < 0 ? -y : y;
    }
    return curve;
  }

  // ==========================================================================
  //  TTEngineAudio
  // ==========================================================================
  class TTEngineAudio {
    constructor(options) {
      options = options || {};
      this.options = {
        masterVolume: typeof options.masterVolume === 'number'
          ? clamp(options.masterVolume, 0, 1)
          : 0.85,
        muted: !!options.muted,
        context: options.context || null,
        analyser: options.analyser !== false
      };

      this.ctx = null;            // created only in unlock()
      this._n = null;             // live node graph
      this._buf = null;           // shared noise buffers
      this._built = false;
      this._offline = false;
      this._ownContext = !options.context;
      this._unlocked = false;
      this._stopped = false;
      this._muted = !!options.muted;
      this._paused = false;
      this._volume = this.options.masterVolume;
      this._primed = false;
      this._state = defaultState();
      this._lastUpdate = null;
      this._prevThrottle = 0;
      this._nextPop = 0;
      this._nextLimPop = 0;
      this._resumeAt = 0;
      this._fadeTimer = null;
      this._levelBuf = null;
    }

    // ------------------------------------------------------------- public API

    /**
     * Create (or resume) the AudioContext and start the graph. Must be called
     * from a user gesture (click / keydown / touchend) the first time.
     * Safe to call again: it is a no-op once running and retries resume if the
     * browser had suspended the context.
     * @returns {Promise<boolean>} true when audio is actually running
     */
    async unlock() {
      this._stopped = false;
      try {
        var ctx = this._ensureContext();
        // Open the scheduling window before awaiting resume() so a game can
        // call triggerCountdown()/triggerShift() synchronously right after
        // unlock() from the same gesture; those voices queue on the suspended
        // context and play the instant it resumes.
        this._unlocked = true;
        if (!this._offline && ctx.state === 'suspended' &&
            typeof ctx.resume === 'function') {
          await ctx.resume();
        }
        this._prime();
        // _unlocked doubles as "this context has produced sound before", which
        // gates silent auto-recovery in update(). The caller still gets the
        // honest running state as the return value.
        this._unlocked = this._isRunning();
        this._applyMaster(0.07);
        if (this._lastUpdate) this.update(this._lastUpdate);
        return this._unlocked;
      } catch (e) {
        this._unlocked = false;
        if (global.console && global.console.warn) {
          global.console.warn('[TTEngineAudio] unlock failed:', e);
        }
        return false;
      }
    }

    /** Mute / unmute with a click-free ramp. Works before or after unlock. */
    setMuted(muted) {
      this._muted = !!muted;
      if (this.ctx) this._applyMaster(0.03);
    }

    /**
     * Pause / resume. All layers are ramped down; nothing is scheduled while
     * paused. The context is intentionally NOT suspended (resuming can need a
     * gesture again on some browsers); the master gate is silenced instead.
     */
    setPaused(paused) {
      this._paused = !!paused;
      if (this.ctx) {
        this._applyMaster(0.03);
        if (!this._paused && this._built) {
          this._nextPop = this.ctx.currentTime + 0.2;
          this._nextLimPop = this.ctx.currentTime + 0.2;
          if (this._lastUpdate) this.update(this._lastUpdate);
        }
      }
    }

    /** Runtime master volume, 0..1. (Optional convenience extra.) */
    setVolume(volume) {
      var v = num(volume, this._volume);
      this._volume = clamp(v, 0, 1);
      if (this.ctx) this._applyMaster(0.05);
    }

    /**
     * Main per-frame update. Accepts partial state; everything is clamped.
     * state = { rpm 0..16000, throttle 0..1, speedKmh, gear 1..6,
     *           braking, tuck, airborne, revLimit }
     */
    update(state) {
      state = state || {};
      var s = {
        rpm: clamp(num(state.rpm, 0), 0, TOP_RPM),
        throttle: clamp(num(state.throttle, 0), 0, 1),
        speedKmh: clamp(num(state.speedKmh, 0), 0, 500),
        gear: clamp(Math.round(num(state.gear, 1)), 1, 6),
        braking: !!state.braking,
        tuck: !!state.tuck,
        airborne: !!state.airborne,
        revLimit: !!state.revLimit
      };
      this._state = s;
      this._lastUpdate = s;

      var ctx = this.ctx;
      if (!ctx || !this._built || this._stopped) return;

      if (!this._isRunning()) {
        // A context can be suspended by the browser after a tab switch / OS
        // sleep. Try a gentle recovery, at most once every 2 s.
        var nowMs = Date.now();
        if (this._unlocked && nowMs - this._resumeAt > 2000 &&
            typeof ctx.resume === 'function') {
          this._resumeAt = nowMs;
          try {
            var pr = ctx.resume();
            if (pr && pr.catch) pr.catch(function () {});
          } catch (e) { /* ignore */ }
        }
        return;
      }
      if (this._paused) return;

      var n = this._n;
      var t = ctx.currentTime;
      var rpm = s.rpm;
      var thr = s.throttle;
      var spd = s.speedKmh;
      var rpmNorm = rpm / REDLINE;
      var f0 = Math.max(7, rpm / 30);       // inline-4 firing frequency
      var run = smoothstep(140, 750, rpm);  // 0 = dead, 1 = running
      var load = clamp(0.24 + 0.76 * Math.pow(thr, 0.85), 0, 1);

      // ---- harmonic oscillator stack -------------------------------------
      for (var i = 0; i < n.oscs.length; i++) {
        var o = n.oscs[i];
        o.osc.frequency.setTargetAtTime(f0 * o.ratio, t, 0.035);
      }

      // ---- exhaust shaping / saturation ----------------------------------
      var cutoff = clamp(300 + f0 * 7.2 + thr * 2200, 280, 12500);
      n.engineLP.frequency.setTargetAtTime(cutoff, t, 0.04);
      n.engineLP.Q.setTargetAtTime(1.4 + thr * 1.6, t, 0.05);
      n.enginePeak.frequency.setTargetAtTime(clamp(f0 * 2.15, 80, 5400), t, 0.05);
      n.enginePeak.gain.setTargetAtTime(3 + 4 * thr, t, 0.06);
      n.drive.gain.setTargetAtTime(0.8 + 1.1 * thr, t, 0.05);
      n.toneSum.gain.setTargetAtTime(0.52 + 0.2 * thr, t, 0.06);

      // ---- intake / exhaust broadband noise ------------------------------
      n.intakeBP.frequency.setTargetAtTime(clamp(650 + f0 * 2.3, 380, 9000), t, 0.05);
      n.intakeGain.gain.setTargetAtTime(run * (0.012 + 0.1 * thr), t, 0.05);
      n.exhaustLP.frequency.setTargetAtTime(clamp(260 + f0 * 3.6 + thr * 900, 200, 9000), t, 0.05);
      n.exhaustGain.gain.setTargetAtTime(run * (0.014 + 0.1 * thr), t, 0.05);

      // ---- chain / cam / drivetrain whine --------------------------------
      n.chainOsc.frequency.setTargetAtTime(clamp(f0 * 5.4, 100, 20000), t, 0.05);
      n.camOsc.frequency.setTargetAtTime(clamp(f0 * 8.1, 160, 20000), t, 0.05);
      n.whine.gain.setTargetAtTime(run * (0.4 + 0.6 * thr), t, 0.08);
      n.driveOsc.frequency.setTargetAtTime(clamp(55 + spd * 4.4, 40, 2200), t, 0.12);
      n.driveWineGain.gain.setTargetAtTime(clamp(spd / 260, 0, 1) * 0.016, t, 0.15);

      // ---- overall engine level (idle softer than under load) -------------
      var revGain = 0.8 + 0.2 * rpmNorm;
      n.engLevel.gain.setTargetAtTime(run * (0.2 + 0.8 * load) * 0.52 * revGain, t, 0.06);

      // ---- wind rush (scales with speed, tuck reduces it) ----------------
      var windAmt = Math.pow(clamp(spd / 300, 0, 1), 1.7);
      if (s.tuck) windAmt *= 0.6;
      if (s.airborne) windAmt *= 0.85;
      n.windGain.gain.setTargetAtTime(0.3 * windAmt + 0.004, t, 0.15);
      n.windLP.frequency.setTargetAtTime(clamp(400 + spd * 12, 350, 7000), t, 0.18);
      n.windBand.frequency.setTargetAtTime(clamp(800 + spd * 7, 700, 6000), t, 0.18);
      n.windBandGain.gain.setTargetAtTime(0.055 * windAmt, t, 0.18);

      // ---- tyre / road hiss ----------------------------------------------
      var tyreAmt = s.airborne ? 0 : clamp(spd / 250, 0, 1.15);
      var tyGain = 0.1 * tyreAmt + 0.0015;
      if (s.braking && spd > 12) tyGain *= 1.45;
      n.tyreGain.gain.setTargetAtTime(tyGain, t, 0.12);
      n.tyreBP.frequency.setTargetAtTime(
        clamp(1300 + spd * 3.2 - (s.braking ? 200 : 0), 900, 4200), t, 0.2);

      // ---- rev limiter: hard ignition stutter + pitch flutter -------------
      var limOn = s.revLimit && run > 0.2;
      n.limiterAM.gain.setTargetAtTime(limOn ? 0.55 : 1, t, limOn ? 0.02 : 0.06);
      n.limDepth.gain.setTargetAtTime(limOn ? 0.5 : 0, t, 0.05);
      n.limPitch.gain.setTargetAtTime(limOn ? 9 : 0, t, 0.06);
      n.limLfo.frequency.setTargetAtTime(14 + rpmNorm * 8, t, 0.3);

      // ---- overrun crackle / backfires -----------------------------------
      this._scheduleOverrun(t, s, run);
      this._prevThrottle = thr;
    }

    /**
     * Quickshift. Up = short ignition cut + light pop; down = longer cut,
     * heavier clunk and a bigger backfire. Keep the caller's rpm/gear updates
     * coming immediately after this call for a natural re-engage.
     */
    triggerShift(up) {
      var isUp = up !== false;
      if (!this._canPlay()) return;
      var t = this.ctx.currentTime + 0.005;
      this._cutEngine(t, isUp ? 0.05 : 0.075, isUp ? 0.92 : 0.78);
      this._click(t + 0.006, isUp ? 1.0 : 1.25);
      if (!isUp) this._thunk(t + 0.012, 1.1);
      var popAt = t + (isUp ? 0.05 : 0.085);
      this._pop(popAt, isUp ? 1.05 : 1.2, true);
      if (!isUp) {
        this._pop(popAt + 0.055, 1.2, true);
        this._pop(popAt + 0.12, 0.9, false);
      }
    }

    /** Crash: broadband impact, metallic crunch, ringing partials and a thud. */
    triggerCrash(intensity) {
      if (!this._canPlay()) return;
      var amt = clamp(num(intensity, 1), 0, 1);
      if (amt <= 0) return;
      var ctx = this.ctx;
      var n = this._n;
      var t = ctx.currentTime + 0.01;
      var i;

      // 1) broad impact noise, swept down from bright to dull
      var src = ctx.createBufferSource();
      src.buffer = this._buf.white;
      src.playbackRate.value = rand(0.8, 1.2);
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 1.1;
      lp.frequency.setValueAtTime(9000, t);
      lp.frequency.exponentialRampToValueAtTime(180, t + 0.55);
      var g = ctx.createGain();
      g.gain.value = 0;
      src.connect(lp);
      lp.connect(g);
      g.connect(n.fx);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.85 * amt, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
      src.start(t, 0, 0.75);
      src.stop(t + 0.75);
      this._disposeOnEnd(src, [lp, g]);

      // 2) metallic crunch: several short resonant noise bursts
      for (i = 0; i < 4; i++) {
        var ts = t + rand(0, 0.18);
        var s2 = ctx.createBufferSource();
        s2.buffer = this._buf.white;
        s2.playbackRate.value = rand(0.8, 2.0);
        var bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = rand(500, 3600);
        bp.Q.value = rand(2, 8);
        var g2 = ctx.createGain();
        g2.gain.value = 0;
        s2.connect(bp);
        bp.connect(g2);
        g2.connect(n.fx);
        var pk = rand(0.15, 0.4) * amt;
        var life = rand(0.03, 0.14);
        g2.gain.setValueAtTime(0, ts);
        g2.gain.linearRampToValueAtTime(pk, ts + 0.003);
        g2.gain.exponentialRampToValueAtTime(0.0006, ts + life);
        s2.start(ts, rand(0, 0.4), 0.2);
        s2.stop(ts + 0.2);
        this._disposeOnEnd(s2, [bp, g2]);
      }

      // 3) metallic ringing partials
      var ringFreqs = [rand(1800, 2600), rand(3100, 4300), rand(5200, 6400)];
      for (i = 0; i < ringFreqs.length; i++) {
        var ro = ctx.createOscillator();
        ro.type = 'sine';
        ro.frequency.value = ringFreqs[i];
        var rg = ctx.createGain();
        rg.gain.value = 0;
        ro.connect(rg);
        rg.connect(n.fx);
        rg.gain.setValueAtTime(0, t);
        rg.gain.linearRampToValueAtTime(0.03 * amt, t + 0.02);
        rg.gain.exponentialRampToValueAtTime(0.0004, t + rand(0.7, 1.6));
        ro.start(t);
        ro.stop(t + 1.7);
        this._disposeOnEnd(ro, [rg]);
      }

      // 4) low thud
      var th = ctx.createOscillator();
      th.type = 'sine';
      th.frequency.setValueAtTime(rand(130, 170), t);
      th.frequency.exponentialRampToValueAtTime(30, t + 0.4);
      var tg = ctx.createGain();
      tg.gain.value = 0;
      th.connect(tg);
      tg.connect(n.fx);
      tg.gain.setValueAtTime(0, t);
      tg.gain.linearRampToValueAtTime(0.55 * amt, t + 0.01);
      tg.gain.exponentialRampToValueAtTime(0.0006, t + 0.55);
      th.start(t);
      th.stop(t + 0.6);
      this._disposeOnEnd(th, [tg]);

      // 5) high spray of debris (short, very quiet)
      var sp = ctx.createBufferSource();
      sp.buffer = this._buf.pink;
      sp.playbackRate.value = 1.6;
      var shp = ctx.createBiquadFilter();
      shp.type = 'highpass';
      shp.frequency.value = 3000;
      var sg = ctx.createGain();
      sg.gain.value = 0;
      sp.connect(shp);
      shp.connect(sg);
      sg.connect(n.fx);
      sg.gain.setValueAtTime(0, t);
      sg.gain.linearRampToValueAtTime(0.08 * amt, t + 0.02);
      sg.gain.exponentialRampToValueAtTime(0.0005, t + 0.4);
      sp.start(t, rand(0, 0.4), 0.5);
      sp.stop(t + 0.5);
      this._disposeOnEnd(sp, [shp, sg]);
    }

    /** Short stereo whoosh for a close pass / near miss. */
    triggerNearMiss() {
      if (!this._canPlay()) return;
      var ctx = this.ctx;
      var n = this._n;
      var t = ctx.currentTime + 0.005;
      var dur = 0.38;

      var src = ctx.createBufferSource();
      src.buffer = this._buf.white;
      src.playbackRate.value = 0.9;

      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.8;
      bp.frequency.setValueAtTime(rand(350, 700), t);
      bp.frequency.exponentialRampToValueAtTime(rand(2000, 3600), t + dur * 0.45);
      bp.frequency.exponentialRampToValueAtTime(rand(250, 500), t + dur);

      var g = ctx.createGain();
      g.gain.value = 0;
      src.connect(bp);
      bp.connect(g);

      var panner = null;
      if (typeof ctx.createStereoPanner === 'function') {
        panner = ctx.createStereoPanner();
        panner.pan.setValueAtTime(-0.85, t);
        panner.pan.linearRampToValueAtTime(0.85, t + dur);
        g.connect(panner);
        panner.connect(n.fx);
      } else {
        g.connect(n.fx);
      }

      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.95, t + dur * 0.4);
      g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      src.start(t, rand(0, 0.5), dur + 0.02);
      src.stop(t + dur + 0.05);
      this._disposeOnEnd(src, [bp, g, panner]);
    }

    /** Countdown / start-light beep. */
    triggerCountdown() {
      if (!this._canPlay()) return;
      var ctx = this.ctx;
      var n = this._n;
      var t = ctx.currentTime + 0.005;

      var o1 = ctx.createOscillator();
      o1.type = 'sine';
      o1.frequency.value = 880;
      var o2 = ctx.createOscillator();
      o2.type = 'triangle';
      o2.frequency.value = 1760;
      var o2g = ctx.createGain();
      o2g.gain.value = 0.16;
      var env = ctx.createGain();
      env.gain.value = 0;

      o1.connect(env);
      o2.connect(o2g);
      o2g.connect(env);
      env.connect(n.fx);

      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.26, t + 0.006);
      env.gain.setValueAtTime(0.26, t + 0.09);
      env.gain.exponentialRampToValueAtTime(0.0005, t + 0.28);

      o1.start(t);
      o2.start(t);
      o1.stop(t + 0.3);
      o2.stop(t + 0.3);
      this._disposeOnEnd(o1, [env]);
      this._disposeOnEnd(o2, [o2g]);
    }

    /**
     * Fade out and close the AudioContext. The instance stays reusable:
     * a later unlock() rebuilds a fresh graph.
     */
    stop() {
      this._stopped = true;
      this._unlocked = false;
      this._paused = false;

      if (!this.ctx) {
        this._teardownRefs();
        return;
      }

      var ctx = this.ctx;
      var n = this._n;
      var self = this;
      var t = ctx.currentTime;

      try {
        if (n && n.master) {
          var mg = n.master.gain;
          mg.cancelScheduledValues(t);
          mg.setValueAtTime(mg.value, t);
          mg.linearRampToValueAtTime(0.0001, t + 0.12);
        }
      } catch (e) { /* ignore */ }

      if (this._fadeTimer) {
        clearTimeout(this._fadeTimer);
        this._fadeTimer = null;
      }
      this._fadeTimer = setTimeout(function () {
        self._fadeTimer = null;
        try {
          if (self._ownContext && ctx.state !== 'closed') {
            var p = ctx.close();
            if (p && p.catch) p.catch(function () {});
          } else if (n) {
            try { n.master.disconnect(); } catch (e) {}
            try { n.sum.disconnect(); } catch (e) {}
          }
        } catch (e) { /* ignore */ }
      }, 160);

      this._teardownRefs();
    }

    /** Post-master RMS level, useful for a VU meter. */
    getLevel() {
      var n = this._n;
      if (!n || !n.analyser) return 0;
      try {
        if (!this._levelBuf || this._levelBuf.length !== n.analyser.fftSize) {
          this._levelBuf = new Float32Array(n.analyser.fftSize);
        }
        if (typeof n.analyser.getFloatTimeDomainData === 'function') {
          n.analyser.getFloatTimeDomainData(this._levelBuf);
        } else if (typeof n.analyser.getByteTimeDomainData === 'function') {
          var bytes = new Uint8Array(n.analyser.fftSize);
          n.analyser.getByteTimeDomainData(bytes);
          for (var i = 0; i < bytes.length; i++) {
            this._levelBuf[i] = (bytes[i] - 128) / 128;
          }
        } else {
          return 0;
        }
        var sum = 0;
        for (var j = 0; j < this._levelBuf.length; j++) {
          var v = this._levelBuf[j];
          sum += v * v;
        }
        return Math.sqrt(sum / this._levelBuf.length);
      } catch (e) {
        return 0;
      }
    }

    // ---------------------------------------------------------- graph set-up

    _ensureContext() {
      if (this.ctx) return this.ctx;
      var ctx;
      if (this.options.context) {
        ctx = this.options.context;
        this._ownContext = false;
      } else {
        var Ctor = global.AudioContext || global.webkitAudioContext;
        if (!Ctor) throw new Error('Web Audio API is not supported in this browser.');
        ctx = new Ctor();
        this._ownContext = true;
      }
      this.ctx = ctx;
      this._offline = typeof ctx.startRendering === 'function';
      this._buildGraph();
      return ctx;
    }

    _buildGraph() {
      var ctx = this.ctx;
      var self = this;
      var n = this._n = {};
      this._built = true;
      this._levelBuf = null;

      // shared looping noise buffers
      this._buf = {
        pink: buildNoiseBuffer(ctx, 2.0, 'pink'),
        white: buildNoiseBuffer(ctx, 1.2, 'white')
      };

      function loopNoise(kind) {
        var src = ctx.createBufferSource();
        src.buffer = self._buf[kind];
        src.loop = true;
        src.start(0);
        return src;
      }

      // ---- master chain: sum -> compressor -> makeup -> volume -> out ------
      n.sum = ctx.createGain();
      n.sum.gain.value = 1;

      n.comp = ctx.createDynamicsCompressor();
      n.comp.threshold.value = -10;
      n.comp.knee.value = 18;
      n.comp.ratio.value = 4;
      n.comp.attack.value = 0.004;
      n.comp.release.value = 0.18;

      n.makeup = ctx.createGain();
      n.makeup.gain.value = 1.2;

      // safety limiter (never hard-clips, transparent at normal levels)
      n.soft = ctx.createWaveShaper();
      n.soft.curve = buildLimiterCurve(4096);
      n.soft.oversample = '2x';

      n.master = ctx.createGain();
      n.master.gain.value = 0;      // ramped up in unlock()

      n.sum.connect(n.comp);
      n.comp.connect(n.makeup);
      n.makeup.connect(n.soft);
      n.soft.connect(n.master);

      // The analyser is a pass-through in the output chain (not a dangling
      // tap) so every browser actually pulls it and getLevel() stays live.
      if (this.options.analyser && typeof ctx.createAnalyser === 'function') {
        n.analyser = ctx.createAnalyser();
        n.analyser.fftSize = 512;
        n.analyser.smoothingTimeConstant = 0.6;
        n.master.connect(n.analyser);
        n.analyser.connect(ctx.destination);
      } else {
        n.master.connect(ctx.destination);
      }

      // ---- engine bus with clutch-cut and rev-limiter gates ----------------
      n.engineMix = ctx.createGain();
      n.engineMix.gain.value = 1;
      n.engLevel = ctx.createGain();
      n.engLevel.gain.value = 0;
      n.engineAM = ctx.createGain();          // clutch / quickshift cut
      n.engineAM.gain.value = 1;
      n.limiterAM = ctx.createGain();         // rev-limiter stutter
      n.limiterAM.gain.value = 1;

      n.engineMix.connect(n.engLevel);
      n.engLevel.connect(n.engineAM);
      n.engineAM.connect(n.limiterAM);
      n.limiterAM.connect(n.sum);

      // ---- exhaust tone stack ---------------------------------------------
      n.toneSum = ctx.createGain();
      n.toneSum.gain.value = 0.52;

      n.drive = ctx.createGain();
      n.drive.gain.value = 1;

      n.shaper = ctx.createWaveShaper();
      n.shaper.curve = buildSoftClipCurve(2.6);
      n.shaper.oversample = '2x';

      n.engineLP = ctx.createBiquadFilter();
      n.engineLP.type = 'lowpass';
      n.engineLP.frequency.value = 900;
      n.engineLP.Q.value = 1.8;

      n.enginePeak = ctx.createBiquadFilter();
      n.enginePeak.type = 'peaking';
      n.enginePeak.frequency.value = 180;
      n.enginePeak.Q.value = 2.4;
      n.enginePeak.gain.value = 5;

      n.engineHP = ctx.createBiquadFilter();
      n.engineHP.type = 'highpass';
      n.engineHP.frequency.value = 45;
      n.engineHP.Q.value = 0.7;

      n.toneSum.connect(n.drive);
      n.drive.connect(n.shaper);
      n.shaper.connect(n.engineLP);
      n.engineLP.connect(n.enginePeak);
      n.enginePeak.connect(n.engineHP);
      n.engineHP.connect(n.engineMix);

      // Harmonic oscillator stack. The saw/square/triangle mix + deliberately
      // detuned twins gives the close, beating, "four cylinders fighting each
      // other" texture. All are band-limited by the browser.
      var defs = [
        { ratio: 0.5, type: 'sine',     gain: 0.33, detune: 0 },
        { ratio: 1.0, type: 'sawtooth', gain: 0.53, detune: 0 },
        { ratio: 1.0, type: 'sawtooth', gain: 0.24, detune: 8 },
        { ratio: 2.0, type: 'sawtooth', gain: 0.28, detune: -6 },
        { ratio: 2.0, type: 'sawtooth', gain: 0.11, detune: 14 },
        { ratio: 3.0, type: 'square',   gain: 0.12, detune: 3 },
        { ratio: 4.0, type: 'triangle', gain: 0.11, detune: -9 },
        { ratio: 6.0, type: 'sawtooth', gain: 0.05, detune: 6 }
      ];
      n.oscs = [];
      for (var i = 0; i < defs.length; i++) {
        var def = defs[i];
        var osc = ctx.createOscillator();
        osc.type = def.type;
        osc.frequency.value = 40;
        osc.detune.value = def.detune;
        var og = ctx.createGain();
        og.gain.value = def.gain;
        osc.connect(og);
        og.connect(n.toneSum);
        osc.start(0);
        n.oscs.push({ osc: osc, gain: og, ratio: def.ratio });
      }

      // ---- rev-limiter LFO (square AM + small pitch flutter) --------------
      n.limLfo = ctx.createOscillator();
      n.limLfo.type = 'square';
      n.limLfo.frequency.value = 16;
      n.limDepth = ctx.createGain();
      n.limDepth.gain.value = 0;
      n.limLfo.connect(n.limDepth);
      n.limDepth.connect(n.limiterAM.gain);
      n.limLfo.start(0);

      n.limPitch = ctx.createGain();
      n.limPitch.gain.value = 0;
      n.limLfo.connect(n.limPitch);
      for (i = 0; i < n.oscs.length; i++) {
        n.limPitch.connect(n.oscs[i].osc.detune);
      }

      // ---- intake honk / exhaust roar (filtered noise) --------------------
      var intakeNoise = loopNoise('pink');
      n.intakeHP = ctx.createBiquadFilter();
      n.intakeHP.type = 'highpass';
      n.intakeHP.frequency.value = 170;
      n.intakeBP = ctx.createBiquadFilter();
      n.intakeBP.type = 'bandpass';
      n.intakeBP.frequency.value = 900;
      n.intakeBP.Q.value = 0.9;
      n.intakeGain = ctx.createGain();
      n.intakeGain.gain.value = 0;
      intakeNoise.connect(n.intakeHP);
      n.intakeHP.connect(n.intakeBP);
      n.intakeBP.connect(n.intakeGain);
      n.intakeGain.connect(n.engineMix);

      var exhaustNoise = loopNoise('pink');
      n.exhaustLP = ctx.createBiquadFilter();
      n.exhaustLP.type = 'lowpass';
      n.exhaustLP.frequency.value = 600;
      n.exhaustLP.Q.value = 0.9;
      n.exhaustGain = ctx.createGain();
      n.exhaustGain.gain.value = 0;
      exhaustNoise.connect(n.exhaustLP);
      n.exhaustLP.connect(n.exhaustGain);
      n.exhaustGain.connect(n.engineMix);

      // ---- chain / cam / drivetrain whine ---------------------------------
      n.whine = ctx.createGain();
      n.whine.gain.value = 0.5;
      n.whine.connect(n.engineMix);

      n.chainOsc = ctx.createOscillator();
      n.chainOsc.type = 'sine';
      n.chainOsc.frequency.value = 400;
      n.chainGain = ctx.createGain();
      n.chainGain.gain.value = 0.03;
      n.chainOsc.connect(n.chainGain);
      n.chainGain.connect(n.whine);
      n.chainOsc.start(0);

      n.camOsc = ctx.createOscillator();
      n.camOsc.type = 'triangle';
      n.camOsc.frequency.value = 1200;
      n.camGain = ctx.createGain();
      n.camGain.gain.value = 0.014;
      n.camOsc.connect(n.camGain);
      n.camGain.connect(n.whine);
      n.camOsc.start(0);

      n.driveOsc = ctx.createOscillator();
      n.driveOsc.type = 'sine';
      n.driveOsc.frequency.value = 60;
      n.driveWineGain = ctx.createGain();
      n.driveWineGain.gain.value = 0.016;
      n.driveOsc.connect(n.driveWineGain);
      n.driveWineGain.connect(n.whine);
      n.driveOsc.start(0);

      // ---- wind rush (broadband + narrow howl) ----------------------------
      var windNoise = loopNoise('pink');
      n.windHP = ctx.createBiquadFilter();
      n.windHP.type = 'highpass';
      n.windHP.frequency.value = 160;
      n.windLP = ctx.createBiquadFilter();
      n.windLP.type = 'lowpass';
      n.windLP.frequency.value = 1200;
      n.windLP.Q.value = 0.6;
      n.windGain = ctx.createGain();
      n.windGain.gain.value = 0;
      windNoise.connect(n.windHP);
      n.windHP.connect(n.windLP);
      n.windLP.connect(n.windGain);
      n.windGain.connect(n.sum);

      n.windBand = ctx.createBiquadFilter();
      n.windBand.type = 'bandpass';
      n.windBand.frequency.value = 900;
      n.windBand.Q.value = 1.6;
      n.windBandGain = ctx.createGain();
      n.windBandGain.gain.value = 0;
      n.windHP.connect(n.windBand);
      n.windBand.connect(n.windBandGain);
      n.windBandGain.connect(n.sum);

      // ---- tyre / road hiss ----------------------------------------------
      var tyreNoise = loopNoise('white');
      n.tyreHP = ctx.createBiquadFilter();
      n.tyreHP.type = 'highpass';
      n.tyreHP.frequency.value = 450;
      n.tyreBP = ctx.createBiquadFilter();
      n.tyreBP.type = 'bandpass';
      n.tyreBP.frequency.value = 1500;
      n.tyreBP.Q.value = 0.8;
      n.tyreGain = ctx.createGain();
      n.tyreGain.gain.value = 0;
      tyreNoise.connect(n.tyreHP);
      n.tyreHP.connect(n.tyreBP);
      n.tyreBP.connect(n.tyreGain);
      n.tyreGain.connect(n.sum);

      // ---- transient FX bus ----------------------------------------------
      n.fx = ctx.createGain();
      n.fx.gain.value = 1.0;
      n.fx.connect(n.sum);
    }

    // ------------------------------------------------------------- internals

    _teardownRefs() {
      this.ctx = null;
      this._n = null;
      this._buf = null;
      this._built = false;
      this._primed = false;
      this._levelBuf = null;
      this._state = defaultState();
      this._lastUpdate = null;
      this._prevThrottle = 0;
      this._nextPop = 0;
      this._nextLimPop = 0;
    }

    _isRunning() {
      if (!this.ctx) return false;
      var st = this.ctx.state;
      if (st === 'running') return true;
      if (this._offline && st !== 'closed') return true;
      return false;
    }

    _canPlay() {
      if (!this.ctx || !this._built || this._stopped) return false;
      if (this._isRunning()) return true;
      // We are inside the brief resume() window right after a gesture: allow
      // scheduling so the first beep/shift is not swallowed.
      return this._unlocked && this.ctx.state === 'suspended';
    }

    _applyMaster(tc) {
      var n = this._n;
      if (!n || !n.master) return;
      var target = (this._muted || this._paused || this._stopped) ? 0 : this._volume;
      try {
        n.master.gain.setTargetAtTime(target, this.ctx.currentTime, tc || 0.06);
      } catch (e) { /* ignore */ }
    }

    /** One silent sample on first unlock — helps iOS/Safari open the gate. */
    _prime() {
      if (this._primed || !this.ctx) return;
      this._primed = true;
      try {
        var buf = this.ctx.createBuffer(1, 1, this.ctx.sampleRate || 44100);
        var src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.ctx.destination);
        src.start(0);
      } catch (e) { /* ignore */ }
    }

    _cutEngine(when, duration, depth) {
      var n = this._n;
      if (!n) return;
      var g = n.engineAM.gain;
      try {
        var base = typeof g.value === 'number' ? g.value : 1;
        g.cancelScheduledValues(when);
        g.setValueAtTime(base, when);
        g.setTargetAtTime(clamp(1 - depth, 0.02, 1), when, 0.008);
        g.setTargetAtTime(1, when + duration, 0.018);
      } catch (e) { /* ignore */ }
    }

    /** Decides when to spit an overrun / limiter pop; driven by update(). */
    _scheduleOverrun(t, s, run) {
      if (!this._built) return;

      // limiter backfire pops (fuel cut)
      if (s.revLimit && run > 0.15) {
        if (t >= this._nextLimPop) {
          this._pop(t + 0.008, 0.5, true);
          this._nextLimPop = t + rand(0.05, 0.13);
        }
      } else {
        this._nextLimPop = t + 0.05;
      }

      var off = s.throttle < 0.12;
      var decel = s.braking ||
        (off && this._prevThrottle > 0.4 && s.rpm > 3000);

      if (!off || s.rpm < 2600 || run < 0.2) {
        this._nextPop = t + 0.08;
        return;
      }
      if (t < this._nextPop) return;

      var rpmNorm = s.rpm / REDLINE;
      var rate = clamp(
        2.5 + rpmNorm * 10 + (s.braking ? 8 : 0) + (decel ? 3 : 0),
        3, 16
      );
      var strength = clamp(
        0.3 + rpmNorm * 1.0 + (s.braking ? 0.3 : 0),
        0.25, 1.1
      );
      var when = t + 0.015;
      this._pop(when, strength);
      if (s.braking && Math.random() < 0.45) {
        this._pop(when + rand(0.02, 0.06), strength * 0.85);
      }
      if (Math.random() < 0.22) {
        this._pop(when + rand(0.04, 0.1), strength * 0.65);
      }
      this._nextPop = when + (1 / rate) * rand(0.75, 1.4);
    }

    /** Short exhaust pop / backfire: band-passed noise + low thump. */
    _pop(when, strength, bright) {
      if (!this._canPlay()) return;
      var ctx = this.ctx;
      var n = this._n;
      strength = clamp(num(strength, 0.5), 0, 1.2);

      var dur = rand(0.045, 0.11);
      var src = ctx.createBufferSource();
      src.buffer = this._buf.white;
      src.playbackRate.value = rand(0.7, 1.5);

      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = rand(180, 1300) * (bright ? 1.5 : 1);
      bp.Q.value = bright ? 1.1 : 1.6;

      var g = ctx.createGain();
      g.gain.value = 0;

      var panner = null;
      if (typeof ctx.createStereoPanner === 'function') {
        panner = ctx.createStereoPanner();
        panner.pan.value = rand(-0.5, 0.5);
        g.connect(panner);
        panner.connect(n.fx);
      } else {
        g.connect(n.fx);
      }
      src.connect(bp);
      bp.connect(g);

      var peak = 0.22 * strength;
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(peak, when + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0006, when + dur);
      src.start(when, rand(0, 0.25), dur + 0.03);
      src.stop(when + dur + 0.02);
      this._disposeOnEnd(src, [bp, g, panner]);

      // low-frequency thump under the crackle
      var o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(rand(90, 150), when);
      o.frequency.exponentialRampToValueAtTime(rand(45, 70), when + 0.08);
      var og = ctx.createGain();
      og.gain.value = 0;
      o.connect(og);
      og.connect(n.fx);
      og.gain.setValueAtTime(0, when);
      og.gain.linearRampToValueAtTime(0.09 * strength, when + 0.003);
      og.gain.exponentialRampToValueAtTime(0.0005, when + 0.09);
      o.start(when);
      o.stop(when + 0.1);
      this._disposeOnEnd(o, [og]);
    }

    /** Mechanical click for the shift mechanism. */
    _click(when, level) {
      if (!this._canPlay()) return;
      var ctx = this.ctx;
      var n = this._n;
      level = clamp(num(level, 0.7), 0, 1.5);

      var src = ctx.createBufferSource();
      src.buffer = this._buf.white;
      src.playbackRate.value = 1.2;
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1800;
      hp.Q.value = 0.8;
      var g = ctx.createGain();
      g.gain.value = 0;
      src.connect(hp);
      hp.connect(g);
      g.connect(n.fx);
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(0.24 * level, when + 0.001);
      g.gain.exponentialRampToValueAtTime(0.0005, when + 0.028);
      src.start(when, 0, 0.03);
      src.stop(when + 0.03);
      this._disposeOnEnd(src, [hp, g]);

      // tiny metal "tick"
      var o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(rand(1500, 2300), when);
      var og = ctx.createGain();
      og.gain.value = 0;
      o.connect(og);
      og.connect(n.fx);
      og.gain.setValueAtTime(0, when);
      og.gain.linearRampToValueAtTime(0.06 * level, when + 0.001);
      og.gain.exponentialRampToValueAtTime(0.0006, when + 0.02);
      o.start(when);
      o.stop(when + 0.025);
      this._disposeOnEnd(o, [og]);
    }

    /** Low mechanical clunk (downshift / crash body). */
    _thunk(when, level) {
      if (!this._canPlay()) return;
      var ctx = this.ctx;
      var n = this._n;
      var o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(110, when);
      o.frequency.exponentialRampToValueAtTime(55, when + 0.12);
      var g = ctx.createGain();
      g.gain.value = 0;
      o.connect(g);
      g.connect(n.fx);
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(0.24 * clamp(level, 0, 1.5), when + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0005, when + 0.16);
      o.start(when);
      o.stop(when + 0.18);
      this._disposeOnEnd(o, [g]);
    }

    /** Disconnect a one-shot voice and every node downstream of it on end. */
    _disposeOnEnd(source, nodes) {
      source.onended = function () {
        try { source.disconnect(); } catch (e) {}
        if (!nodes) return;
        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          if (!node) continue;
          try { node.disconnect(); } catch (e) {}
        }
      };
    }
  }

  // ------------------------------------------------------------------ export
  global.TTEngineAudio = TTEngineAudio;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TTEngineAudio;
  }
})(typeof window !== 'undefined' ? window : globalThis);
