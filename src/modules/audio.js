import * as THREE from 'three';
import { TAU, clamp, rng } from './math.js';
import { RIVER_PTS, riverField, riverWidth } from './terrain.js';
import { windAtJS } from './wind.js';

/*──────────────────────── §14  AUDIO — ALL SYNTHESISED ─────────────────────*/
/* No samples.  Noise buffers, oscillators, biquads, and one convolution
   reverb whose impulse response is generated from decaying noise.  The wind
   bus is driven by the same field that bends the grass, so you hear a gust
   arrive a beat before you see the near blades move.                         */

export class Audio {
  constructor(){ this.ok=false; this.vol=0.7; this.music=true; }
  init(){
    if(this.ok) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return;
    const ctx = this.ctx = new AC();
    this.t0 = ctx.currentTime;

    // ── master chain ────────────────────────────────────────────────────
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value=-16; comp.knee.value=22; comp.ratio.value=3.2;
    comp.attack.value=0.02; comp.release.value=0.35;
    const master = this.master = ctx.createGain(); master.gain.value=this.vol;
    const warm = ctx.createBiquadFilter(); warm.type='lowshelf'; warm.frequency.value=220; warm.gain.value=2.5;
    const air  = ctx.createBiquadFilter(); air.type='highshelf'; air.frequency.value=9000; air.gain.value=-3;
    master.connect(warm); warm.connect(air); air.connect(comp); comp.connect(ctx.destination);

    // ── procedural convolution reverb: a valley, not a room ─────────────
    const rvLen = Math.floor(ctx.sampleRate*3.4);
    const ir = ctx.createBuffer(2, rvLen, ctx.sampleRate);
    for(let ch=0; ch<2; ch++){
      const d = ir.getChannelData(ch);
      const r = rng(999+ch*7);
      for(let i=0;i<rvLen;i++){
        const u = i/rvLen;
        let e = Math.pow(1-u, 2.6)*Math.exp(-u*2.1);
        // sparse early reflections off the valley sides
        if(i < ctx.sampleRate*0.35){
          const tt=i/ctx.sampleRate;
          e *= 1 + 2.4*Math.exp(-Math.pow((tt-0.031)/0.004,2))
                 + 1.9*Math.exp(-Math.pow((tt-0.068)/0.005,2))
                 + 1.4*Math.exp(-Math.pow((tt-0.121)/0.008,2))
                 + 1.1*Math.exp(-Math.pow((tt-0.205)/0.012,2));
        }
        d[i]=(r()*2-1)*e;
      }
      // darken the tail
      let lp=0; for(let i=0;i<rvLen;i++){ lp += (d[i]-lp)*0.30; d[i]=lp; }
    }
    const conv = this.conv = ctx.createConvolver(); conv.buffer=ir;
    const wet = this.wet = ctx.createGain(); wet.gain.value=0.34;
    conv.connect(wet); wet.connect(master);

    // ── noise sources ───────────────────────────────────────────────────
    const mkNoise=(sec, pink)=>{
      const b=ctx.createBuffer(1, Math.floor(ctx.sampleRate*sec), ctx.sampleRate);
      const d=b.getChannelData(0); const r=rng(pink?4242:1234);
      let b0=0,b1=0,b2=0;
      for(let i=0;i<d.length;i++){
        const w=r()*2-1;
        if(pink){ b0=0.99765*b0+w*0.0990460; b1=0.96300*b1+w*0.2965164;
                  b2=0.57000*b2+w*1.0526913; d[i]=(b0+b1+b2+w*0.1848)*0.22; }
        else d[i]=w*0.42;
      }
      return b;
    };
    this.nWhite = mkNoise(7.0,false);
    this.nPink  = mkNoise(9.0,true);
    const src=(buf)=>{ const s=ctx.createBufferSource(); s.buffer=buf; s.loop=true; s.start(); return s; };

    // ── WIND: three bands whose gains track the real wind speed ─────────
    const wSrc = src(this.nPink);
    this.wind = {};
    const mkBand=(type,f,q,g)=>{
      const bq=ctx.createBiquadFilter(); bq.type=type; bq.frequency.value=f; bq.Q.value=q;
      const gn=ctx.createGain(); gn.gain.value=g;
      wSrc.connect(bq); bq.connect(gn); gn.connect(master);
      const sd=ctx.createGain(); sd.gain.value=0.32; gn.connect(sd); sd.connect(conv);
      return {bq,gn};
    };
    this.wind.low  = mkBand('lowpass',   150, 0.8, 0.10);
    this.wind.mid  = mkBand('bandpass',  520, 0.7, 0.06);
    this.wind.hiss = mkBand('bandpass', 2600, 0.9, 0.03);
    this.wind.whis = mkBand('bandpass', 1450, 8.0, 0.0);
    // grass rustle: a second, brighter, faster-responding layer
    const gSrc = src(this.nWhite);
    const gbq = ctx.createBiquadFilter(); gbq.type='bandpass'; gbq.frequency.value=4200; gbq.Q.value=0.6;
    const gg = ctx.createGain(); gg.gain.value=0.0;
    gSrc.connect(gbq); gbq.connect(gg); gg.connect(master);
    this.wind.grass={bq:gbq,gn:gg};

    // ── RIVER: pink noise through a resonant bank ───────────────────────
    const rSrc = src(this.nPink);
    this.river = { gain: ctx.createGain(), bands:[] };
    this.river.gain.gain.value=0;
    this.river.pan = ctx.createStereoPanner();
    this.river.gain.connect(this.river.pan); this.river.pan.connect(master);
    const rSend=ctx.createGain(); rSend.gain.value=0.16;
    this.river.gain.connect(rSend); rSend.connect(conv);
    // The low-pass was built and then never wired in, so the whole band bank
    // arrived unfiltered — that plus resonances up to Q=11 is what turned a
    // wide, slow river into a hissing gush.  Softer Q, gentler top bands, and
    // the filter actually in the path, its corner opening as you approach.
    const rlp=ctx.createBiquadFilter(); rlp.type='lowpass';
    rlp.frequency.value=1100; rlp.Q.value=0.5;
    const rhs=ctx.createBiquadFilter(); rhs.type='highshelf';
    rhs.frequency.value=1800; rhs.gain.value=-8;
    rlp.connect(rhs); rhs.connect(this.river.gain);
    this.river.lp=rlp;
    const freqs=[150, 235, 390, 700, 1250, 2200];
    for(let i=0;i<freqs.length;i++){
      const bq=ctx.createBiquadFilter(); bq.type='bandpass'; bq.frequency.value=freqs[i];
      bq.Q.value=1.1+i*0.55;
      const g=ctx.createGain(); g.gain.value=0.46/(1+i*0.62);
      rSrc.connect(bq); bq.connect(g); g.connect(rlp);
      this.river.bands.push({bq,g,base:g.gain.value, ph:Math.random()*10, sp:0.07+Math.random()*0.22});
    }

    // ── INSECTS ─────────────────────────────────────────────────────────
    const iSrc = src(this.nWhite);
    const ibq=ctx.createBiquadFilter(); ibq.type='bandpass'; ibq.frequency.value=5600; ibq.Q.value=7;
    const ig=ctx.createGain(); ig.gain.value=0.0;
    const iam=ctx.createGain(); iam.gain.value=1.0;
    const ilfo=ctx.createOscillator(); ilfo.type='sine'; ilfo.frequency.value=42;
    const ilfg=ctx.createGain(); ilfg.gain.value=0.55;
    ilfo.connect(ilfg); ilfg.connect(iam.gain); ilfo.start();
    iSrc.connect(ibq); ibq.connect(iam); iam.connect(ig); ig.connect(master);
    const iSend=ctx.createGain(); iSend.gain.value=0.4; ig.connect(iSend); iSend.connect(conv);
    this.insects={g:ig};

    // ── TRAIN bus ───────────────────────────────────────────────────────
    this.train = {};
    this.train.pan = ctx.createStereoPanner();
    this.train.lp  = ctx.createBiquadFilter(); this.train.lp.type='lowpass'; this.train.lp.frequency.value=4000;
    this.train.gain= ctx.createGain(); this.train.gain.gain.value=0.0;
    this.train.gain.connect(this.train.lp); this.train.lp.connect(this.train.pan);
    this.train.pan.connect(master);
    const tSend=ctx.createGain(); tSend.gain.value=0.5; this.train.pan.connect(tSend); tSend.connect(conv);
    const tSrc = src(this.nWhite);
    const trb=ctx.createBiquadFilter(); trb.type='lowpass'; trb.frequency.value=110; trb.Q.value=1.2;
    const trg=ctx.createGain(); trg.gain.value=0.0;
    tSrc.connect(trb); trb.connect(trg); trg.connect(this.train.gain);
    this.train.rumble=trg;

    // ── MUSIC bus ───────────────────────────────────────────────────────
    this.mus = ctx.createGain(); this.mus.gain.value=0.0;
    this.mus.connect(master);
    const mSend=ctx.createGain(); mSend.gain.value=0.85; this.mus.connect(mSend); mSend.connect(conv);
    this.nextNote = ctx.currentTime + 3.0;
    this.scaleIdx = 0;

    // ── ambient bus for birds ───────────────────────────────────────────
    this.birds = ctx.createGain(); this.birds.gain.value=0.5;
    this.birds.connect(master);
    const bSend=ctx.createGain(); bSend.gain.value=0.75; this.birds.connect(bSend); bSend.connect(conv);
    this.nextBird = ctx.currentTime + 1.5;

    this.ok=true;
  }
  resume(){ if(this.ok && this.ctx.state==='suspended') this.ctx.resume(); }

  // ── one-shots ─────────────────────────────────────────────────────────
  chuff(level, pan, cut){
    if(!this.ok) return;
    const ctx=this.ctx, t=ctx.currentTime;
    const s=ctx.createBufferSource(); s.buffer=this.nWhite;
    s.playbackRate.value=0.8+Math.random()*0.4;
    s.loopStart=Math.random()*4; s.loop=true;
    const bq=ctx.createBiquadFilter(); bq.type='bandpass'; bq.Q.value=1.1;
    bq.frequency.setValueAtTime(1500*cut, t);
    bq.frequency.exponentialRampToValueAtTime(280*cut, t+0.22);
    const hp=ctx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=150;
    const g=ctx.createGain();
    g.gain.setValueAtTime(0.0001,t);
    g.gain.linearRampToValueAtTime(level, t+0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t+0.30);
    s.connect(bq); bq.connect(hp); hp.connect(g); g.connect(this.train.gain);
    s.start(t); s.stop(t+0.34);
  }
  whistle(level){
    if(!this.ok) return;
    const ctx=this.ctx, t=ctx.currentTime;
    // a real steam whistle is a chord: root, minor third, fifth, slightly detuned
    const root=452, ratios=[1, 1.189, 1.498, 2.002];
    const out=ctx.createGain();
    out.gain.setValueAtTime(0.0001,t);
    out.gain.linearRampToValueAtTime(level, t+0.16);
    out.gain.setValueAtTime(level, t+1.05);
    out.gain.exponentialRampToValueAtTime(level*0.55, t+1.45);
    out.gain.linearRampToValueAtTime(level*0.9, t+1.6);
    out.gain.exponentialRampToValueAtTime(0.0001, t+2.5);
    const lp=ctx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=3400;
    out.connect(lp); lp.connect(this.train.gain);
    const vib=ctx.createOscillator(); vib.frequency.value=5.4;
    const vg=ctx.createGain(); vg.gain.value=4.2; vib.connect(vg); vib.start(t); vib.stop(t+2.6);
    for(let i=0;i<ratios.length;i++){
      const o=ctx.createOscillator(); o.type= i===0?'sawtooth':'triangle';
      o.frequency.value=root*ratios[i]*(1+(Math.random()-0.5)*0.006);
      vg.connect(o.frequency);
      const g=ctx.createGain(); g.gain.value=[0.5,0.34,0.26,0.12][i];
      const bp=ctx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=root*ratios[i]; bp.Q.value=6;
      o.connect(bp); bp.connect(g); g.connect(out);
      o.start(t); o.stop(t+2.6);
    }
    // breath
    const s=ctx.createBufferSource(); s.buffer=this.nWhite; s.loop=true;
    const nb=ctx.createBiquadFilter(); nb.type='bandpass'; nb.frequency.value=1800; nb.Q.value=1.4;
    const ng=ctx.createGain(); ng.gain.setValueAtTime(0.0001,t);
    ng.gain.linearRampToValueAtTime(level*0.42,t+0.12);
    ng.gain.exponentialRampToValueAtTime(0.0001,t+2.3);
    s.connect(nb); nb.connect(ng); ng.connect(out); s.start(t); s.stop(t+2.5);
  }
  footstep(spd, onStone){
    if(!this.ok) return;
    const ctx=this.ctx, t=ctx.currentTime;
    const s=ctx.createBufferSource(); s.buffer=this.nWhite; s.loop=true;
    s.loopStart=Math.random()*5;
    s.playbackRate.value=0.7+Math.random()*0.6;
    const bq=ctx.createBiquadFilter();
    bq.type= onStone?'bandpass':'lowpass';
    bq.frequency.setValueAtTime(onStone?2600:1500, t);
    if(!onStone) bq.frequency.exponentialRampToValueAtTime(420, t+0.12);
    bq.Q.value= onStone?1.4:0.8;
    const g=ctx.createGain();
    const lv=(0.028+0.045*clamp(spd/3,0,1))*(onStone?1.4:1.0);
    g.gain.setValueAtTime(0.0001,t);
    g.gain.linearRampToValueAtTime(lv, t+0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t+(onStone?0.15:0.20));
    s.connect(bq); bq.connect(g); g.connect(this.master);
    const sd=ctx.createGain(); sd.gain.value=0.35; g.connect(sd); sd.connect(this.conv);
    s.start(t); s.stop(t+0.24);
  }
  bird(){
    if(!this.ok) return;
    const ctx=this.ctx, t=ctx.currentTime;
    const pan=ctx.createStereoPanner(); pan.pan.value=(Math.random()*2-1)*0.8;
    pan.connect(this.birds);
    const n = 2+(Math.random()*4|0);
    const base = 1900 + Math.random()*2400;
    const species = Math.random();
    let tt=t;
    for(let i=0;i<n;i++){
      const o=ctx.createOscillator(); o.type= species<0.5?'sine':'triangle';
      const f0 = base*(0.82+Math.random()*0.5);
      const f1 = f0*(species<0.35 ? (1.5+Math.random()) : (0.55+Math.random()*0.4));
      const dur = 0.055+Math.random()*0.10;
      o.frequency.setValueAtTime(f0, tt);
      o.frequency.exponentialRampToValueAtTime(Math.max(220,f1), tt+dur);
      const g=ctx.createGain();
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.linearRampToValueAtTime(0.055+Math.random()*0.05, tt+0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, tt+dur);
      o.connect(g); g.connect(pan); o.start(tt); o.stop(tt+dur+0.02);
      tt += dur + 0.02 + Math.random()*0.09;
    }
  }
  note(freq, level, dur){
    if(!this.ok) return;
    const ctx=this.ctx, t=ctx.currentTime;
    const out=ctx.createGain(); out.gain.value=1; out.connect(this.mus);
    const parts=[1,2,3,4.02,5.05,6.1,8.2], amps=[1,0.42,0.24,0.14,0.09,0.05,0.03];
    for(let i=0;i<parts.length;i++){
      const o=ctx.createOscillator(); o.type='sine';
      o.frequency.value=freq*parts[i]*(1+(Math.random()-0.5)*0.001);
      const g=ctx.createGain();
      const a=0.012+i*0.004, d=dur*(1-i*0.085);
      g.gain.setValueAtTime(0.0001,t);
      g.gain.linearRampToValueAtTime(level*amps[i], t+a);
      g.gain.exponentialRampToValueAtTime(0.0001, t+Math.max(0.4,d));
      o.connect(g); g.connect(out); o.start(t); o.stop(t+Math.max(0.5,d)+0.05);
    }
  }

  // ── per-frame ─────────────────────────────────────────────────────────
  update(dt, cam, walker, state){
    if(!this.ok) return;
    const ctx=this.ctx, t=ctx.currentTime;
    this.master.gain.value += (this.vol - this.master.gain.value)*clamp(dt*3,0,1);

    // WIND — driven by the same field that bends the grass
    const w = windAtJS(cam.position.x, cam.position.z, 1.7);
    const s = w.speed, gust = w.gust;
    const k = clamp(dt*4,0,1);
    const setG=(o,v)=>{ o.gn.gain.value += (v-o.gn.gain.value)*k; };
    setG(this.wind.low,  0.035 + 0.052*clamp(s/6,0,1.6));
    setG(this.wind.mid,  0.014 + 0.048*clamp(s/5,0,1.7));
    setG(this.wind.hiss, 0.004 + 0.030*clamp((s-0.6)/5,0,1.6));
    setG(this.wind.whis, 0.028*clamp((s-3.4)/4.0,0,1)*clamp(gust,0,1.4));
    this.wind.mid.bq.frequency.value  += (420 + 190*clamp(s/6,0,1.5) - this.wind.mid.bq.frequency.value)*k;
    this.wind.hiss.bq.frequency.value += (2100 + 1900*clamp(s/6,0,1.5) - this.wind.hiss.bq.frequency.value)*k;
    this.wind.grass.gn.gain.value += (0.006 + 0.036*clamp((s-0.4)/4.5,0,1.5)*clamp(state.grassNear,0,1)
                                      - this.wind.grass.gn.gain.value)*k;

    // RIVER — distance, and burbling band gains
    const rf = riverField(cam.position.x, cam.position.z);
    // an inverse-distance law, not a linear ramp: water is loud at the bank and
    // a murmur thirty metres up the meadow, which is not what a straight line does
    const near = clamp(14/(14 + Math.max(rf.d-10, 0)), 0, 1);
    const wide = clamp(riverWidth(rf.t)/26, 0.35, 1.3);
    this.river.gain.gain.value += (0.115*near*near*wide - this.river.gain.gain.value)*clamp(dt*2,0,1);
    // distance closes the top end — over a meadow, high frequencies go first
    this.river.lp.frequency.value +=
      ((640 + 2500*near*near) - this.river.lp.frequency.value)*clamp(dt*1.5,0,1);
    for(const b of this.river.bands){
      b.ph += dt*b.sp;
      b.g.gain.value = b.base*(0.68+0.42*(Math.sin(b.ph*TAU)*0.5+0.5));
    }
    // which side is the water on
    {
      let best=1e9, bx=0, bz=0;
      const i0=clamp(Math.round(rf.t*(RIVER_PTS.length-1)),0,RIVER_PTS.length-1);
      const p=RIVER_PTS[i0]; bx=p.x; bz=p.z;
      const dx=bx-cam.position.x, dz=bz-cam.position.z;
      const f=new THREE.Vector3(0,0,-1).applyQuaternion(cam.quaternion);
      const rgt=new THREE.Vector3(1,0,0).applyQuaternion(cam.quaternion);
      const L=Math.hypot(dx,dz)||1;
      this.river.pan.pan.value = clamp((rgt.x*dx+rgt.z*dz)/L, -0.85, 0.85);
    }

    // INSECTS — they sing in the sun and fall quiet in shade
    this.insects.g.gain.value += (0.010*clamp(1-near*0.5,0,1) - this.insects.g.gain.value)*clamp(dt,0,1);

    // TRAIN — distance, air absorption, pan, doppler-ish
    if(state.trainActive){
      const d = state.trainDist;
      const g = clamp(140/(40+d), 0, 1.0)*0.9;
      this.train.gain.gain.value += (g - this.train.gain.gain.value)*clamp(dt*3,0,1);
      this.train.lp.frequency.value += (clamp(11000 - d*22, 700, 11000) - this.train.lp.frequency.value)*clamp(dt*3,0,1);
      this.train.pan.pan.value += (clamp(state.trainPan,-0.9,0.9) - this.train.pan.pan.value)*clamp(dt*4,0,1);
      this.train.rumble.gain.value += (0.16*clamp(90/(30+d),0,1) - this.train.rumble.gain.value)*clamp(dt*2,0,1);
    } else {
      this.train.gain.gain.value += (0 - this.train.gain.gain.value)*clamp(dt*1.5,0,1);
      this.train.rumble.gain.value += (0 - this.train.rumble.gain.value)*clamp(dt*1.5,0,1);
    }

    // BIRDS
    if(t > this.nextBird){ this.bird(); this.nextBird = t + 1.4 + Math.random()*6.5; }

    // SCORE — sparse, pentatonic, a long way off
    this.mus.gain.value += ((this.music?0.30:0.0) - this.mus.gain.value)*clamp(dt,0,1);
    if(this.music && t > this.nextNote){
      const root = 146.83;                       // D3
      const pent = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
      const step = [-2,-1,-1,0,1,1,2,3][(Math.random()*8)|0];
      this.scaleIdx = clamp(this.scaleIdx + step, 0, pent.length-1);
      const f = root*Math.pow(2, pent[this.scaleIdx]/12);
      const lvl = 0.020 + Math.random()*0.016;
      this.note(f, lvl, 3.2+Math.random()*2.6);
      if(Math.random()<0.34){
        const j = clamp(this.scaleIdx + (Math.random()<0.5?2:3), 0, pent.length-1);
        setTimeout(()=>this.note(root*Math.pow(2,pent[j]/12), lvl*0.65, 3.0), 90+Math.random()*180);
      }
      this.nextNote = t + 1.6 + Math.random()*4.4 + (Math.random()<0.18 ? 4.5 : 0);
    }
  }
}
