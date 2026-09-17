import Matter from 'matter-js';
import type { SaveData } from './storage';
const { Bodies, Body, Composite, Constraint, Engine, Events } = Matter;
export const STEP = 1000 / 120;
export const CHUNK = 720;
export const TRACKS = [
  { name: 'Сосновый перевал', region: 'СЕВЕРНЫЙ ХРЕБЕТ', seed: 14287, difficulty: 1, chunks: 7, target: 42, description: 'Первый след. Плавные холмы, свежий воздух и только ты за рулём.', theme: 'pine' },
  { name: 'Каменная тропа', region: 'СКАЛИСТАЯ ДОЛИНА', seed: 32718, difficulty: 2, chunks: 9, target: 55, description: 'Камни под колёсами. Держи скорость и мягко приземляйся.', theme: 'pine' },
  { name: 'Рыжий каньон', region: 'ЮЖНОЕ ПЛАТО', seed: 71839, difficulty: 3, chunks: 10, target: 62, description: 'Трамплины над ущельями. Здесь решает правильный наклон.', theme: 'desert' },
  { name: 'Ледяная грань', region: 'ПОЛЯРНЫЙ МАССИВ', seed: 58123, difficulty: 4, chunks: 11, target: 75, description: 'Меньше сцепления. Больше точности. Не отпускай контроль.', theme: 'ice' },
  { name: 'Высота 1200', region: 'ВЕРХНИЙ ПЕРЕВАЛ', seed: 92013, difficulty: 5, chunks: 12, target: 82, description: 'Подвижные платформы и крутые подъёмы для опытных райдеров.', theme: 'pine' },
  { name: 'За горизонтом', region: 'ПОСЛЕДНИЙ РУБЕЖ', seed: 18657, difficulty: 6, chunks: 14, target: 95, description: 'Последнее испытание. Найди свой ритм и дойди до финиша.', theme: 'desert' },
];
export type Mode = 'campaign' | 'daily' | 'endless' | 'custom' | 'progression';
export interface TrackConfig { seed: number; difficulty: number; chunks: number; theme: string; mode: Mode; modifier: string; }
export interface Controls { gas: boolean; brake: boolean; left: boolean; right: boolean; }
export interface TerrainChunk { index: number; points: {x:number;y:number;gap:boolean}[]; bodies: Matter.Body[]; coins: {x:number;y:number;id:string}[]; type: ChunkType; }
export const clamp = (x:number, a:number,b:number) => Math.max(a,Math.min(b,x));
export function hash(n:number, seed:number):number { let x = (Math.imul(n,374761393) + Math.imul(seed,668265263)) | 0; x = Math.imul(x ^ (x >>> 13),1274126177); return ((x ^ (x >>> 16)) >>> 0) / 4294967296; }
const smooth = (t:number) => t*t*(3-2*t);
function noise(x:number,seed:number) { const i=Math.floor(x),t=smooth(x-i);return (hash(i,seed)*(1-t)+hash(i+1,seed)*t)*2-1; }
// ── Chunk types for progressive difficulty ────────────────────────────────
export type ChunkType = 'flat' | 'hills' | 'uphill' | 'downhill' | 'jump' | 'pit' | 'spiral' | 'cliff';

function getChunkWeights(level:number):Record<ChunkType,number> {
  if (level < 2) return { flat:0.5, hills:0.5, uphill:0, downhill:0, jump:0, pit:0, spiral:0, cliff:0 };
  if (level < 4) return { flat:0.25, hills:0.4, uphill:0.2, downhill:0.15, jump:0, pit:0, spiral:0, cliff:0 };
  if (level < 6) return { flat:0.1, hills:0.3, uphill:0.2, downhill:0.2, jump:0.15, pit:0.05, spiral:0, cliff:0 };
  if (level < 8) return { flat:0.05, hills:0.2, uphill:0.15, downhill:0.15, jump:0.2, pit:0.1, spiral:0.1, cliff:0.05 };
  return { flat:0, hills:0.1, uphill:0.1, downhill:0.1, jump:0.2, pit:0.15, spiral:0.15, cliff:0.2 };
}

function pickChunkType(index:number, difficulty:number, seed:number):ChunkType {
  if (index <= 1) return 'flat';
  const level = Math.floor(index / 3) + Math.floor(difficulty / 2);
  const w = getChunkWeights(level);
  const r = hash(index, seed + 777);
  let cum = 0;
  const entries = Object.entries(w) as [ChunkType, number][];
  for (const [type, weight] of entries) {
    cum += weight;
    if (r < cum) return type;
  }
  return 'hills';
}

function chunkTargetHeight(index:number, type:ChunkType, difficulty:number):number {
  const base = 420 + index * 2; // gentle upward trend
  const d = difficulty;
  switch (type) {
    case 'uphill':   return base + (30 + d * 6);
    case 'downhill': return base - (25 + d * 5);
    case 'jump':     return base + (10 + d * 2);
    case 'pit':      return base - (15 + d * 3);
    case 'cliff':    return base + (50 + d * 10);
    case 'spiral':   return base;
    case 'flat':     return base;
    case 'hills':    return base;
  }
}

export class Terrain {
  chunks = new Map<number,TerrainChunk>();
  obstacles: {body:Matter.Body;kind:string;x:number;y:number;phase:number}[]=[];
  collected = new Set<string>();
  constructor(public engine:Matter.Engine,public config:TrackConfig) {}
  get finishX() { return this.config.mode === 'endless' ? Infinity : this.config.chunks*CHUNK-200; }

  chunkType(index:number):ChunkType {
    return pickChunkType(index, this.config.difficulty, this.config.seed);
  }

  targetHeight(index:number):number {
    return chunkTargetHeight(index, this.chunkType(index), this.config.difficulty);
  }

  height(x:number) {
    const d = this.config.difficulty;
    const fade = smooth(clamp((x - 420) / 750, 0, 1));
    const index = Math.floor(x / CHUNK);
    const t = ((x % CHUNK) + CHUNK) % CHUNK / CHUNK;
    const type = this.chunkType(index);

    // Smooth baseline between chunk target heights
    const h0 = this.targetHeight(index - 1);
    const h1 = this.targetHeight(index);
    const baseline = h0 + (h1 - h0) * smooth(t);

    // Per-type height variation
    let variation = 0;
    switch (type) {
      case 'flat':
        variation = noise(x / 400, this.config.seed) * 4;
        break;
      case 'hills': {
        const hFade = smooth(clamp((x - 420) / 600, 0, 1));
        variation = hFade * (noise(x / 640, this.config.seed) * (50 + d * 9) + noise(x / 210, this.config.seed + 9) * (8 + d * 3));
        break;
      }
      case 'uphill': {
        const ramp = Math.pow(t, 0.7) * (35 + d * 7) * fade;
        variation = ramp + noise(x / 500, this.config.seed) * 4;
        break;
      }
      case 'downhill': {
        const ramp = -Math.pow(t, 0.7) * (30 + d * 6) * fade;
        variation = ramp + noise(x / 500, this.config.seed) * 4;
        break;
      }
      case 'jump': {
        const jump = Math.sin(t * Math.PI) * (25 + d * 10) * fade;
        variation = jump + noise(x / 500, this.config.seed) * 3;
        break;
      }
      case 'pit': {
        const pit = -Math.sin(t * Math.PI) * (20 + d * 7) * fade;
        variation = pit + noise(x / 500, this.config.seed) * 3;
        break;
      }
      case 'spiral': {
        const spiral = Math.sin(t * 2.5 * Math.PI) * (12 + d * 4) * fade;
        variation = spiral + noise(x / 350, this.config.seed) * 3;
        break;
      }
      case 'cliff': {
        const cliff = (t > 0.25 ? 1 : 0) * (45 + d * 12) * fade;
        variation = cliff + noise(x / 500, this.config.seed) * 4;
        break;
      }
    }
    return baseline + variation;
  }

  gap(x:number) {
    const i = Math.floor(x / CHUNK), t = x - i * CHUNK;
    const type = this.chunkType(i);
    const d = this.config.difficulty;
    // Gaps appear on jump and cliff chunks, and randomly at higher difficulty
    if (type === 'jump' && t > 420 && t < 520) return true;
    if (type === 'cliff' && t > 120 && t < 200) return true;
    return d >= 3 && i > 2 && i % 5 === 3 && t > 355 && t < 435 + d * 5;
  }

  ensure(x:number) {
    const center = Math.floor(x / CHUNK);
    for (let i = Math.max(-1, center - 2); i <= center + 4; i++) if (!this.chunks.has(i)) this.generate(i);
    for (const [i, chunk] of this.chunks) if (i < center - 3 || i > center + 5) { chunk.bodies.forEach(b => Composite.remove(this.engine.world, b)); this.chunks.delete(i); this.obstacles = this.obstacles.filter(o => !chunk.bodies.includes(o.body)); for (const id of this.collected) if (id.startsWith(`${i}:`)) this.collected.delete(id); }
  }

  generate(index:number) {
    const points: TerrainChunk['points'] = [], bodies: Matter.Body[] = [], coins: TerrainChunk['coins'] = [];
    const start = index * CHUNK;
    const type = this.chunkType(index);
    const d = this.config.difficulty;

    for (let j = 0; j <= CHUNK / 24; j++) { const x = start + j * 24; points.push({ x, y: this.height(x), gap: this.gap(x) }); }
    for (let j = 0; j < points.length - 1; j++) {
      const a = points[j], b = points[j + 1]; if (this.gap((a.x + b.x) / 2)) continue;
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy), nx = -dy / len, ny = dx / len;
      const body = Bodies.rectangle((a.x + b.x) / 2 + nx * 18, (a.y + b.y) / 2 + ny * 18, len + 2.5, 36, { isStatic: true, angle: Math.atan2(dy, dx), friction: 1.1, restitution: 0, slop: 0.03, label: 'terrain' });
      bodies.push(body);
    }

    // Coins — placement depends on chunk type
    if (index >= 1) {
      const coinCount = type === 'flat' ? 2 : type === 'hills' ? 3 : 4;
      for (let j = 0; j < coinCount; j++) {
        const cx = start + 180 + j * 70;
        if (cx < this.finishX - 80) coins.push({ x: cx, y: this.height(cx) - 55 - Math.sin(j * Math.PI / 2) * 15, id: `${index}:${j}` });
      }
    }

    // Obstacles — scaled by chunk type and difficulty
    const level = Math.floor(index / 3) + Math.floor(d / 2);
    if (index >= 2 && (type === 'hills' || type === 'uphill' || type === 'downhill') && hash(index, this.config.seed + 100) < 0.5 + level * 0.06) {
      const ox = start + 340 + hash(index, this.config.seed + 200) * 280;
      const oy = this.height(ox) - 16;
      const body = Bodies.polygon(ox, oy, 7, 20 + d * 5, { isStatic: true, friction: 0.9, label: 'rock', angle: 0.4 });
      bodies.push(body); this.obstacles.push({ body, kind: 'rock', x: ox, y: oy, phase: 0 });
    }
    if (index >= 3 && level >= 2 && (type === 'hills' || type === 'spiral') && hash(index, this.config.seed + 300) < 0.4 + level * 0.05) {
      const ox = start + 300 + hash(index, this.config.seed + 400) * 300;
      const oy = this.height(ox) - 24;
      const body = Bodies.circle(ox, oy, 22 + d * 3, { friction: 0.6, density: 0.004, restitution: 0.15, label: 'barrel' });
      bodies.push(body); this.obstacles.push({ body, kind: 'barrel', x: ox, y: oy, phase: index });
    }
    if (index >= 4 && level >= 3 && hash(index, this.config.seed + 500) < 0.2 + level * 0.03) {
      const ox = start + 380 + hash(index, this.config.seed + 600) * 180;
      const oy = this.height(ox) - 8;
      const body = Bodies.rectangle(ox, oy, 130, 12, { isStatic: true, label: 'platform', friction: 1 });
      bodies.push(body); this.obstacles.push({ body, kind: 'platform', x: ox, y: oy, phase: index });
    }
    if (index >= 5 && level >= 4 && (type === 'jump' || type === 'cliff') && hash(index, this.config.seed + 700) < 0.2 + level * 0.03) {
      const ox = start + 420 + hash(index, this.config.seed + 800) * 200;
      const oy = this.height(ox) - 40;
      const body = Bodies.rectangle(ox, oy, 100, 10, { isStatic: true, label: 'beam', friction: 0.8 });
      bodies.push(body); this.obstacles.push({ body, kind: 'beam', x: ox, y: oy, phase: index });
    }

    Composite.add(this.engine.world, bodies);
    const chunk: TerrainChunk = { index, points, bodies, coins, type };
    this.chunks.set(index, chunk); return chunk;
  }

  update(time:number) {
    for (const o of this.obstacles) {
      if (o.kind === 'platform') Body.setPosition(o.body, { x: o.x, y: o.y + Math.sin(time * 1.3 + o.phase) * 22 });
      if (o.kind === 'beam') Body.setAngle(o.body, Math.sin(time + o.phase) * 0.6);
    }
  }
}
export class Bike {
  rear:Matter.Body;front:Matter.Body;chassis:Matter.Body;head:Matter.Body;body:Matter.Composite;
  rearConstraints:Matter.Constraint[]=[];frontConstraints:Matter.Constraint[]=[];headConstraint:Matter.Constraint|null=null;
  crashed=false;grounded=false;rearContact=false;lean=0;airtime=0;
  rearDetached=false;frontDetached=false;headDetached=false;
  // Wheels are fragile — they break first in hard collisions
  rearHP=55;frontHP=55;chassisHP=95;headHP=70;
  maxRearHP=55;maxFrontHP=55;maxChassisHP=95;maxHeadHP=70;
  spawnTime=0; // ms timestamp when bike spawned
  collisionHandler:(event:Matter.IEventCollision<Matter.Engine>)=>void;
  private damageCooldown:Map<string,number>=new Map(); // part id -> last damage ms
  private readonly MAX_DAMAGE_PER_HIT=70;
  private _burstApplied=false;

  constructor(public engine:Matter.Engine,x:number,y:number,public save:SaveData) {
    const group=Body.nextGroup(true);
    const grip=save.upgrades.grip;
    const rearOpts={collisionFilter:{group},friction:0.5+grip*0.06,frictionStatic:0.01,restitution:0.02,frictionAir:0.001,density:0.0011,slop:0.03,label:'rear'};
    const frontOpts={collisionFilter:{group},friction:0.5+grip*0.06,frictionStatic:0.01,restitution:0.02,frictionAir:0.001,density:0.0019,slop:0.03,label:'front'};
    this.rear=Bodies.circle(x-39,y,19,rearOpts,24);
    this.front=Bodies.circle(x+43,y,19,frontOpts,24);
    this.chassis=Bodies.rectangle(x,y-28,66,17,{collisionFilter:{group},density:0.0024,friction:0.3,frictionAir:0.001,label:'chassis'});
    this.head=Bodies.circle(x+8,y-72,10,{collisionFilter:{group},density:0.0016,label:'head'});
    Body.setInertia(this.chassis,this.chassis.inertia*2.5);
    const stiffness=0.7+save.upgrades.suspension*0.04;
    const c1=Constraint.create({bodyA:this.chassis,pointA:{x:-35,y:5},bodyB:this.rear,length:23.3,stiffness,damping:0.12});
    const c2=Constraint.create({bodyA:this.chassis,pointA:{x:22,y:0},bodyB:this.rear,length:66.7,stiffness:0.92,damping:0.08});
    const c3=Constraint.create({bodyA:this.chassis,pointA:{x:29,y:0},bodyB:this.front,length:31.3,stiffness,damping:0.12});
    const c4=Constraint.create({bodyA:this.chassis,pointA:{x:-22,y:0},bodyB:this.front,length:70.8,stiffness:0.92,damping:0.08});
    const c5=Constraint.create({bodyA:this.chassis,pointA:{x:8,y:-44},bodyB:this.head,length:0,stiffness:1,damping:0.05});
    this.rearConstraints=[c1,c2];this.frontConstraints=[c3,c4];this.headConstraint=c5;
    this.body=Composite.create({label:'bike'});Composite.add(this.body,[this.rear,this.front,this.chassis,this.head,c1,c2,c3,c4,c5]);Composite.add(engine.world,this.body);
    this.spawnTime=performance.now();

    // Collision handler for durability damage
    this.collisionHandler=(event:Matter.IEventCollision<Matter.Engine>)=>{
      // 1.8s spawn invulnerability
      if(performance.now()-this.spawnTime<1800)return;
      const bikeBodies:Set<Matter.Body>=new Set([this.rear,this.front,this.chassis,this.head]);
      for(const pair of event.pairs){
        const a=pair.bodyA,b=pair.bodyB;
        if(!bikeBodies.has(a)&&!bikeBodies.has(b))continue;

        const otherBody=bikeBodies.has(a)?b:a;
        const label=otherBody.label||'';
        const obstacleLabels=new Set(['rock','barrel','beam','platform']);
        const isObstacle=obstacleLabels.has(label);
        const isTerrain=label==='terrain';
        // Only terrain (rolling) and obstacles count — ignore internal bike collisions
        if(!isObstacle&&!isTerrain)continue;

        const relVx=a.velocity.x-b.velocity.x;
        const relVy=a.velocity.y-b.velocity.y;
        const relSpeed=Math.hypot(relVx,relVy);
        const nx=pair.collision.normal.x;
        const ny=pair.collision.normal.y;
        // How much of the velocity is ALONG the collision normal (perpendicular hit).
        // Low = grazing slide (no damage). High = direct smash (damage).
        const angleFactor=Math.abs(relVx*nx+relVy*ny)/Math.max(relSpeed,0.001);

        // === DAMAGE RULES (per surface type) ===
        let impact=0;
        if(isObstacle){
          // ANY contact with a rock/barrel is bad, but especially hard/direct hits.
          // Low speed bump still dents, full-speed smash = instant break.
          if(relSpeed>=0.8){
            const base=this.calcImpact(pair);
            const mul=3.1 + Math.min(1.2,angleFactor*1.1); // 3.1 .. 4.3 multiplier
            impact=base*mul;
          }
        }else if(isTerrain){
          // Normal terrain: NO damage from rolling. Only hard perpendicular impacts
          // i.e. landing from a jump or smashing the frame into a cliff edge.
          const minSpeedForTerrainDamage=2.6;   // ~15+ km/h for terrain hits
          const minAngleForTerrainDamage=0.48;  // mostly perpendicular, not sliding
          if(relSpeed>=minSpeedForTerrainDamage && angleFactor>=minAngleForTerrainDamage){
            impact=this.calcImpact(pair);
            // Landing on wheels: less damage than a face-plant. Frame/chassis hits: full.
            const hitWheel=(a===this.rear||b===this.rear||a===this.front||b===this.front);
            impact*=hitWheel?0.65:1.0;
          }
        }
        if(impact<=0.15)continue;

        // Head crash detection
        if((a===this.head||b===this.head)&&this.canDamagePart('head',80)){
          const other=a===this.head?b:a;
          if(!bikeBodies.has(other)){
            this.headHP-=impact*3.2;
            if(this.canDamagePart('chassis-head',120)) this.chassisHP-=impact*1.25;
            if(this.headHP<=0||this.chassisHP<=0){this.headDetached=true;this.crashBurst(Math.max(impact,28));this.crashed=true;}
          }
        }
        // Rear wheel damage
        if((a===this.rear||b===this.rear)&&!this.rearDetached&&this.canDamagePart('rear',70)){
          const other=a===this.rear?b:a;
          if(!bikeBodies.has(other)){
            this.rearHP-=impact*2.8;
            if(this.canDamagePart('chassis-rear',120)) this.chassisHP-=impact*0.65;
            // Hard obstacle hit: instant wheel snap-off
            if(this.rearHP<=0||(isObstacle&&impact>=24))this.detachRear(impact,pair);
            if(this.chassisHP<=0){this.crashBurst(Math.max(impact,28));this.crashed=true;}
          }
        }
        // Front wheel damage
        if((a===this.front||b===this.front)&&!this.frontDetached&&this.canDamagePart('front',70)){
          const other=a===this.front?b:a;
          if(!bikeBodies.has(other)){
            this.frontHP-=impact*2.8;
            if(this.canDamagePart('chassis-front',120)) this.chassisHP-=impact*0.65;
            if(this.frontHP<=0||(isObstacle&&impact>=24))this.detachFront(impact,pair);
            if(this.chassisHP<=0){this.crashBurst(Math.max(impact,28));this.crashed=true;}
          }
        }
        // Chassis damage (direct hit, not through wheels)
        if((a===this.chassis||b===this.chassis)&&!this.crashed&&this.canDamagePart('chassis',90)){
          const other=a===this.chassis?b:a;
          if(!bikeBodies.has(other)){
            this.chassisHP-=impact*1.5;
            if(this.chassisHP<=0){this.crashBurst(Math.max(impact,28));this.crashed=true;}
          }
        }
      }
    };
    Events.on(engine,'collisionStart',this.collisionHandler);
  }

  private calcImpact(pair:Matter.Pair):number {
    const relVx=pair.bodyA.velocity.x-pair.bodyB.velocity.x;
    const relVy=pair.bodyA.velocity.y-pair.bodyB.velocity.y;
    const relSpeed=Math.hypot(relVx,relVy);

    // Cap each body's mass individually (Infinity from isStatic becomes 1.5)
    // Never use Infinity — always a sane value.
    const mA=Number.isFinite(pair.bodyA.mass)&&pair.bodyA.mass>0?Math.min(3,pair.bodyA.mass):1.5;
    const mB=Number.isFinite(pair.bodyB.mass)&&pair.bodyB.mass>0?Math.min(3,pair.bodyB.mass):1.5;
    const effectiveMass=mA+mB; // range ~ 2 .. 6

    const nx=pair.collision.normal.x;
    const ny=pair.collision.normal.y;
    const angleFactor=Math.abs(relVx*nx+relVy*ny)/Math.max(relSpeed,0.001);
    const susFactor=1-this.save.upgrades.suspension*0.025;

    // Raw damage scales aggressively with speed (quadratic for head-on smashes)
    const speedDmg=(relSpeed*relSpeed)*0.012 + relSpeed*0.35;
    const dmg=speedDmg*effectiveMass*0.18*(0.35+angleFactor*0.65)*susFactor;
    return Math.min(this.MAX_DAMAGE_PER_HIT, Math.max(0, dmg));
  }

  private canDamagePart(partId:string, cooldownMs=60):boolean {
    const now=performance.now();
    const last=this.damageCooldown.get(partId)??0;
    if(now-last<cooldownMs) return false;
    this.damageCooldown.set(partId,now);
    return true;
  }

  private detachRear(impact:number=0, pair?:Matter.Pair):void {
    if(this.rearDetached)return;
    this.rearDetached=true;
    this.rearHP=0;
    for(const c of this.rearConstraints){Composite.remove(this.body,c);}
    this.rear.collisionFilter.group=0;
    // Gentle realistic kick — not flying to orbit. Away from impact + small tumble.
    const nx=pair?.collision.normal.x ?? -1;
    const ny=pair?.collision.normal.y ?? -0.2;
    const force=0.004+Math.min(impact,50)*0.00015; // 0.004 .. 0.0115
    const jitterX=(Math.random()-0.5)*0.002;
    const jitterY=(Math.random()-0.5)*0.002;
    Body.applyForce(this.rear,this.rear.position,{
      x: nx*force + jitterX,
      y: ny*force*0.5 - 0.0015 + jitterY, // small lift, not huge
    });
    Body.setAngularVelocity(this.rear,(Math.random()>0.5?1:-1)*(1.4+Math.random()*2));
    // If a wheel rips off, the ride is over — dramatic crash.
    this.crashBurst(Math.max(impact,20));
    this.crashed=true;
  }

  private detachFront(impact:number=0, pair?:Matter.Pair):void {
    if(this.frontDetached)return;
    this.frontDetached=true;
    this.frontHP=0;
    for(const c of this.frontConstraints){Composite.remove(this.body,c);}
    this.front.collisionFilter.group=0;
    const nx=pair?.collision.normal.x ?? 1;
    const ny=pair?.collision.normal.y ?? -0.2;
    const force=0.0045+Math.min(impact,50)*0.00016;
    const jitterX=(Math.random()-0.5)*0.002;
    const jitterY=(Math.random()-0.5)*0.002;
    Body.applyForce(this.front,this.front.position,{
      x: nx*force + jitterX,
      y: ny*force*0.5 - 0.0018 + jitterY,
    });
    Body.setAngularVelocity(this.front,(Math.random()>0.5?1:-1)*(1.6+Math.random()*2.1));
    this.crashBurst(Math.max(impact,20));
    this.crashed=true;
  }

  /** When bike fully crashes — rip off any remaining wheels for dramatic effect. */
  crashBurst(finalImpact:number=18):void {
    if(this._burstApplied)return;
    this._burstApplied=true;
    if(!this.rearDetached){
      for(const c of this.rearConstraints){Composite.remove(this.body,c);}
      this.rearDetached=true;this.rearHP=0;
      this.rear.collisionFilter.group=0;
      const s=0.0035+finalImpact*0.00012;
      Body.applyForce(this.rear,this.rear.position,{
        x:(-0.5+Math.random()*0.6)*s,
        y:-0.003 - Math.random()*0.0025,
      });
      Body.setAngularVelocity(this.rear,(Math.random()>0.5?1:-1)*(1.3+Math.random()*2));
    }
    if(!this.frontDetached){
      for(const c of this.frontConstraints){Composite.remove(this.body,c);}
      this.frontDetached=true;this.frontHP=0;
      this.front.collisionFilter.group=0;
      const s=0.004+finalImpact*0.00013;
      Body.applyForce(this.front,this.front.position,{
        x:(0.5+Math.random()*0.6)*s,
        y:-0.0035 - Math.random()*0.003,
      });
      Body.setAngularVelocity(this.front,(Math.random()>0.5?1:-1)*(1.5+Math.random()*2.1));
    }
    if(!this.headDetached && this.headConstraint){
      Composite.remove(this.body,this.headConstraint);
      this.headDetached=true;this.headHP=0;
      this.head.collisionFilter.group=0;
      const s=0.0028+finalImpact*0.00009;
      Body.applyForce(this.head,this.head.position,{
        x:(0.15+Math.random()*0.5)*s,
        y:-0.004 - Math.random()*0.0025,
      });
      Body.setAngularVelocity(this.head,(Math.random()>0.5?1:-1)*(2+Math.random()*3));
    }
  }

  get x(){return this.chassis.position.x;} get y(){return this.chassis.position.y;}
  get speed(){return Math.hypot(this.chassis.velocity.x,this.chassis.velocity.y)*60/30;}
  get angle(){return Math.atan2(this.front.position.y-this.rear.position.y,this.front.position.x-this.rear.position.x);}

  update(input:Controls,ice:boolean) {
    const grip=this.save.upgrades.grip;
    this.rearContact=false;this.grounded=false;
    for(const p of this.engine.pairs.list)if(p.isActive){if(!this.rearDetached&&(p.bodyA===this.rear||p.bodyB===this.rear))this.rearContact=true;if((!this.rearDetached&&[p.bodyA,p.bodyB].includes(this.rear))||(!this.frontDetached&&[p.bodyA,p.bodyB].includes(this.front)))this.grounded=true;}
    const dt=STEP/1000;
    this.airtime=this.grounded?0:this.airtime+dt;
    const target=(Number(input.right)-Number(input.left));this.lean+=(target-this.lean)*0.09;
    const fIce=ice?0.3+grip*0.06:0.5+grip*0.06;
    if(!this.rearDetached)this.rear.friction=fIce;
    if(!this.frontDetached)this.front.friction=fIce;
    if(this.crashed)return;

    // Engine: rear wheel drive (disabled if detached)
    if(input.gas && !input.brake && !this.rearDetached) {
      const maxTorque=0.8+this.save.upgrades.power*0.1+this.save.selectedBike*0.13;
      const gain=0.6+this.save.upgrades.power*0.08+this.save.selectedBike*0.1;
      this.rear.torque+=clamp(maxTorque-this.rear.angularVelocity,-0.5,1.2)*gain;
      Body.applyForce(this.chassis,this.chassis.position,{x:0.0006+this.save.upgrades.power*0.00008+this.save.selectedBike*0.0001,y:0});
      if(!this.frontDetached) this.front.torque+=clamp(0.5-this.front.angularVelocity,-0.3,0.8)*gain*0.4;
    }
    // If rear detached but front still attached, front becomes drive wheel (weak)
    if(input.gas && !input.brake && this.rearDetached && !this.frontDetached) {
      const gain=0.3+this.save.upgrades.power*0.04+this.save.selectedBike*0.05;
      this.front.torque+=clamp(0.4-this.front.angularVelocity,-0.3,0.6)*gain;
      Body.applyForce(this.chassis,this.chassis.position,{x:0.0003,y:0});
    }
    // Braking — only on attached wheels
    if(input.brake) {
      if(!this.rearDetached) Body.setAngularVelocity(this.rear,this.rear.angularVelocity*0.9);
      if(!this.frontDetached) Body.setAngularVelocity(this.front,this.front.angularVelocity*0.9);
    }
    // Balance / lean — reduced if wheels detached
    const authority=this.grounded?(this.rearDetached||this.frontDetached?0.25:0.55):0.35;
    this.chassis.torque+=target*authority;
    this.chassis.torque-=this.chassis.angularVelocity*(this.grounded?0.6:0.25);
  }
}
export class Simulation {
  engine:Matter.Engine;terrain:Terrain;bike:Bike;elapsed=0;distance=0;coins=0;finished=false;
  constructor(public config:TrackConfig,save:SaveData) {
    this.engine=Engine.create({positionIterations:10,velocityIterations:8,constraintIterations:6,enableSleeping:false});
    this.engine.gravity.y=config.modifier==='lowgravity'?0.52:1;this.engine.gravity.scale=0.001;
    this.terrain=new Terrain(this.engine,config);this.terrain.ensure(160);
    this.bike=new Bike(this.engine,170,this.terrain.height(170)-22,save);
  }
  step(input:Controls) {
    if(this.finished)return;
    this.terrain.ensure(this.bike.x);this.terrain.update(this.elapsed);this.bike.update(input,this.config.theme==='ice'||this.config.modifier==='ice');
    Engine.update(this.engine,STEP);
    if(!this.bike.crashed)this.elapsed+=STEP/1000;
    this.distance=Math.max(this.distance,(this.bike.x-170)/10);
    const floor=this.terrain.height(this.bike.x);
    if(!Number.isFinite(this.bike.x)||!Number.isFinite(this.bike.y)||this.bike.y>floor+340||this.bike.x<0){
      if(!this.bike.crashed) this.bike.crashBurst(30);
      this.bike.crashed=true;
    }
    if(!this.bike.crashed) {
      for(const chunk of this.terrain.chunks.values())for(const c of chunk.coins)if(!this.terrain.collected.has(c.id)&&Math.hypot(c.x-this.bike.x,c.y-this.bike.y)<66){this.terrain.collected.add(c.id);this.coins+=10;}
      if(this.bike.x>=this.terrain.finishX)this.finished=true;
    }
  }
  destroy(){Events.off(this.engine,'collisionStart',this.bike.collisionHandler);Composite.clear(this.engine.world,false);Engine.clear(this.engine);}
}
