import * as THREE from 'three';
import { CFG } from './config.js';
import { DEG, TAU, clamp } from './math.js';
import { BRIDGE, sampleHeight, sampleNormal } from './terrain.js';
import { BR } from './viaduct.js';
import { collideWalk, groundHeightAt } from './village.js';
import { windAtJS } from './wind.js';

/*──────────────────────────── §13  CAMERA & GAIT ───────────────────────────*/
/* A real gait clock drives head bob, footstep audio and the grass the walker
   parts, so they can never drift out of sync.                                */

export class Walker {
  constructor(cam){
    this.cam=cam;
    const ov = (typeof QS!=='undefined' && QS.get('cam')) ? QS.get('cam').split(',').map(Number) : null;
    this.pos=new THREE.Vector3(ov?ov[0]:CFG.spawn.x, 0, ov?ov[1]:CFG.spawn.z);
    this.yaw = -(ov?ov[2]:CFG.spawn.heading)*DEG;
    this.pitch = (ov?ov[3]:CFG.spawn.pitch)*DEG;
    this.vel=new THREE.Vector3();
    this.stepPhase=0; this.stepFreq=0; this.lastStep=0;
    this.bobY=0; this.bobX=0; this.roll=0; this.lean=0;
    this.breath=0; this.groundY=0;
    this.keys={};
    this.cinematic=false; this.cineT=0; this.fly=false; this.flyY=0;
    this.onFootstep=null;
    this.windLean=new THREE.Vector2();
    this.idle=0;
  }
  look(dx,dy){
    this.yaw   -= dx*0.0021;
    this.pitch -= dy*0.0021;
    this.pitch = clamp(this.pitch, -1.15, 1.05);
    this.idle=0;
  }
  update(dt, t){
    const k=this.keys;
    let fw=0, sd=0;
    if(k['KeyW']||k['ArrowUp'])   fw+=1;
    if(k['KeyS']||k['ArrowDown']) fw-=1;
    if(k['KeyA']||k['ArrowLeft']) sd-=1;
    if(k['KeyD']||k['ArrowRight'])sd+=1;
    const moving = (fw||sd) && !this.cinematic;
    if(moving) this.idle=0; else this.idle+=dt;

    const run = (k['ShiftLeft']||k['ShiftRight']) ? 2.25 : 1.0;
    const base = (this.fly ? 16.0 : 3.45)*run;
    const sinY=Math.sin(this.yaw), cosY=Math.cos(this.yaw);
    // forward is -Z rotated by yaw
    const fx=-sinY, fz=-cosY, rx=cosY, rz=-sinY;
    let wx=(fx*fw + rx*sd), wz=(fz*fw + rz*sd);
    const wl=Math.hypot(wx,wz); if(wl>0){ wx/=wl; wz/=wl; }

    // uphill is slower, downhill a touch faster
    const n = sampleNormal(this.pos.x, this.pos.z, 1.4);
    const slopeDot = (n.x*wx + n.z*wz);
    const slopeMul = clamp(1.0 + slopeDot*1.15, 0.42, 1.30);
    const target = new THREE.Vector3(wx*base*slopeMul, 0, wz*base*slopeMul);
    const accel = moving ? 9.5 : 12.0;
    this.vel.x += (target.x-this.vel.x)*clamp(accel*dt,0,1);
    this.vel.z += (target.z-this.vel.z)*clamp(accel*dt,0,1);

    if(this.fly){
      let up = 0;
      if(k['Space']||k['KeyE']) up += 1;
      if(k['ControlLeft']||k['ControlRight']||k['KeyQ']||k['ShiftRight']) up -= 1;
      // look-direction flight: pitch steers the climb
      const climb = -Math.sin(this.pitch)*fw*base;
      this.flyY += ((up*base*0.85 + climb) - this.flyY)*clamp(9*dt,0,1);
    } else this.flyY += (0 - this.flyY)*clamp(6*dt,0,1);
    if(!this.cinematic){
      this.pos.x += this.vel.x*dt;
      this.pos.z += this.vel.z*dt;
      this.pos.x = clamp(this.pos.x, -1050, 1050);
      this.pos.z = clamp(this.pos.z, -1050, 1050);
      // flight is noclip: walls and parapets only exist for a walker
      if(!this.fly){
        const r = collideWalk(this.pos.x, this.pos.z, this.groundY, 0.42);
        // kill the velocity component that ran into the wall, or you slide
        // along it while still accelerating into it
        if(r[0] !== this.pos.x || r[1] !== this.pos.z){
          const bx = r[0]-this.pos.x, bz = r[1]-this.pos.z;
          const bl = Math.hypot(bx,bz);
          if(bl > 1e-6){
            const nX=bx/bl, nZ=bz/bl;
            const vn = this.vel.x*nX + this.vel.z*nZ;
            if(vn < 0){ this.vel.x -= vn*nX; this.vel.z -= vn*nZ; }
          }
          this.pos.x = r[0]; this.pos.z = r[1];
        }
      }
    }

    // ── gait clock ────────────────────────────────────────────────────────
    const spd = Math.hypot(this.vel.x, this.vel.z);
    this.stepFreq = (spd > 0.14 && !this.fly) ? (0.58 + 0.34*spd) : 0;
    const prev = this.stepPhase;
    this.stepPhase += this.stepFreq*dt;
    if(Math.floor(this.stepPhase*2) !== Math.floor(prev*2) && this.onFootstep)
      this.onFootstep(spd, this.pos);

    const gp = this.stepPhase*TAU;
    const amp = this.fly ? 0 : clamp(spd/3.6, 0, 1);
    // vertical at 2x step rate, lateral sway at 1x, roll coupled to sway
    this.bobY += (Math.sin(gp*2.0)*0.0135*amp - this.bobY)*clamp(11*dt,0,1);
    this.bobX += (Math.sin(gp)*0.0095*amp     - this.bobX)*clamp(11*dt,0,1);
    this.roll += (Math.sin(gp)*0.0060*amp     - this.roll)*clamp(9*dt,0,1);
    const acc = (target.x*this.vel.x + target.z*this.vel.z);
    this.lean += (clamp(spd*0.016,0,0.05) - this.lean)*clamp(4*dt,0,1);
    this.breath += dt*0.9;

    // ── the wind actually pushes you ──────────────────────────────────────
    const w = windAtJS(this.pos.x, this.pos.z, 1.7);
    this.windLean.x += (w.x*0.0042 - this.windLean.x)*clamp(2.2*dt,0,1);
    this.windLean.y += (w.z*0.0042 - this.windLean.y)*clamp(2.2*dt,0,1);

    // ── cinematic dolly ───────────────────────────────────────────────────
    if(this.cinematic){
      this.cineT += dt;
      const u = this.cineT*0.0125;
      const a = u*TAU;
      const R = 46 + Math.sin(u*3.1)*16;
      this.pos.x = CFG.spawn.x + Math.sin(a)*R*0.9 - 18;
      this.pos.z = CFG.spawn.z + Math.cos(a*0.7)*R*0.6 + 10;
      const look = new THREE.Vector3(BRIDGE.x, BR.deck+4, BRIDGE.z);
      const dx = look.x-this.pos.x, dz = look.z-this.pos.z;
      const tYaw = Math.atan2(-dx, -dz);
      let dy = tYaw - this.yaw;
      while(dy>Math.PI) dy-=TAU; while(dy<-Math.PI) dy+=TAU;
      this.yaw += dy*clamp(1.4*dt,0,1);
      const gy = sampleHeight(this.pos.x,this.pos.z)+CFG.eyeHeight;
      const tPitch = Math.atan2(look.y-gy, Math.hypot(dx,dz)) - 0.02;
      this.pitch += (tPitch-this.pitch)*clamp(1.4*dt,0,1);
      // a breath of handheld
      this.yaw   += Math.sin(t*0.41)*0.00042 + Math.sin(t*1.13)*0.00016;
      this.pitch += Math.cos(t*0.37)*0.00034;
    }

    // ── settle the eye ────────────────────────────────────────────────────
    // groundHeightAt adds the viaduct deck as a second, conditional surface
    const g = groundHeightAt(this.pos.x, this.pos.z, this.groundY);
    if(this.fly){
      this.freeY = (this.freeY===undefined ? this.groundY + CFG.eyeHeight : this.freeY) + this.flyY*dt;
      this.freeY = clamp(this.freeY, -40, 1400);
      this.groundY = this.freeY - CFG.eyeHeight;
    } else {
      this.freeY = undefined;
      this.groundY += (g - this.groundY)*clamp(16*dt,0,1);
    }
    const eye = this.groundY + CFG.eyeHeight + this.bobY
              + Math.sin(this.breath)*0.008;
    this.cam.position.set(
      this.pos.x + (-Math.cos(this.yaw))*this.bobX,
      eye,
      this.pos.z + ( Math.sin(this.yaw))*this.bobX);
    this.cam.rotation.set(0,0,0);
    this.cam.rotateY(this.yaw + this.windLean.x*0.10);
    this.cam.rotateX(this.pitch - this.lean + this.windLean.y*0.06);
    this.cam.rotateZ(this.roll + this.windLean.x*0.22);
    this.speed = spd;
  }
}
