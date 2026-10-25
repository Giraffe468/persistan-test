'use strict';
(()=>{
const W=14,H=10,canvas=document.getElementById('battle'),ctx=canvas.getContext('2d');
const $=id=>document.getElementById(id),rnd=(a,b)=>Math.floor(Math.random()*(b-a+1))+a;
const walls=new Set(['5,1','5,2','5,3','9,6','9,7','10,7','2,6','3,6','11,2']);
const crates=new Set(['3,2','7,2','8,2','6,5','7,5','10,4','4,8','11,7']);
const occupied=(x,y)=>walls.has(`${x},${y}`)||crates.has(`${x},${y}`);
let units=[],selected=0,mode='move',turn=1,phase='friendly',gameover=false,logs=[],hover=null,layout={cell:40,ox:0,oy:0},moving=false;
let effects=[],effectFrame=0,walkAnimation=null;
// CAS is a mission-local support asset. No permanent inventory is consumed.
const CAS_RADIUS=1,CAS_DAMAGE=7,CAS_SCATTER_CHANCE=.20; // legacy test constants
let casCharges=2,casPending=null,casUsed=0;
// QRF: one mission-local reinforcement request. Reserves come from the persistent roster.
let qrfCharges=1,qrfPending=null,qrfUsed=0,qrfArrived=0;
const QRF_DELAY=2,QRF_MAX=2;
// Support preparation is persistent, while ammunition and calls remain mission-local.
const SUPPORT_CAS={precision:{name:'精密攻撃',damage:8,radius:0,scatter:.08,delay:1},area:{name:'広域攻撃',damage:6,radius:1,scatter:.25,delay:1}};
const SUPPORT_QRF={light:{name:'軽即応班',size:2,delay:2},fast:{name:'先遣班',size:1,delay:1}};
function supportPlan(){const raw=strategy.support||{};return {cas:SUPPORT_CAS[raw.cas]?raw.cas:'area',qrf:SUPPORT_QRF[raw.qrf]?raw.qrf:'light'};}
function supportCAS(){return SUPPORT_CAS[supportPlan().cas]}
function supportQRF(){return SUPPORT_QRF[supportPlan().qrf]}
function supportReady(){return strategy.facilities.intel>=1&&strategy.facilities.barracks>=1}

function qrfCandidates(){const onField=new Set(units.filter(u=>u.team==='friendly').map(u=>u.id));return roster.filter(r=>!r.kia&&!r.injury&&!onField.has(r.id)).slice(0,supportQRF().size);}
function requestQRF(){
 if(gameover||phase!=='friendly'||moving)return toast('味方ターン中のみQRFを要請できます'),false;
 if(qrfCharges<1||qrfPending)return toast('QRFの要請枠がありません'),false;
 if(strategy.facilities.barracks<1)return toast('QRFには兵舎Lv.1以上が必要です'),false;
 const reserves=qrfCandidates();if(!reserves.length)return toast('出動可能な予備隊員がいません。隊員名簿を確認してください'),false;
 const caller=selectedUnit();if(!caller||caller.hp<=0||caller.ap<2)return toast('QRF要請にはAP2が必要です'),false;
 caller.ap-=2;qrfCharges--;qrfUsed++;
 qrfPending={arrival:turn+supportQRF().delay,ids:reserves.map(r=>r.id)};
 log(`${caller.name} がQRFを要請 / ${reserves.length}名 / T${qrfPending.arrival}に到着予定`);
 toast(`QRF要請受理：${supportQRF().delay}ターン後に到着`);sync();draw();return true;
}
function resolveQRF(){
 if(!qrfPending||gameover)return;
 const pending=qrfPending;qrfPending=null;
 const arrivalTiles=[{x:0,y:1},{x:0,y:2},{x:0,y:3},{x:1,y:1},{x:1,y:3},{x:0,y:4},{x:2,y:1},{x:2,y:3}];
 let arrived=0;
 for(const id of pending.ids){
  const r=roster[id];if(!r||r.kia||r.injury||units.some(u=>u.team==='friendly'&&u.id===id))continue;
  const pos=arrivalTiles.find(t=>!occupied(t.x,t.y)&&!unitAt(t.x,t.y));
  if(!pos){log('QRF進入地点が塞がれており、増援が到着できません');break;}
  const w=weaponSpec(operators[id]);units.push({id,name:operators[id].name,team:'friendly',x:pos.x,y:pos.y,hp:maxHP(id),maxhp:maxHP(id),ap:0,ammo:w.mag,grenades:canUseM203(operators[id])?3:0,atAmmo:{rpg:AT_LAUNCHERS.rpg.rounds,javelin:AT_LAUNCHERS.javelin.rounds},overwatch:false,kills:0,qrf:true,qrfArrivalTurn:turn});arrived++;
 }
 qrfArrived+=arrived;log(`QRF到着：${arrived}名 / 次ターンから行動可能`);toast(`QRF ${arrived}名が戦場に到着`);
}

function casTiles(center, radius=supportCAS().radius){const cells=[];for(let y=0;y<H;y++)for(let x=0;x<W;x++)if(Math.abs(x-center.x)+Math.abs(y-center.y)<=radius)cells.push({x,y});return cells;}
function callCAS(x,y){
 if(gameover||phase!=='friendly'||moving)return false;
 if(casCharges<=0)return toast('航空支援の残回数がありません'),false;
 if(strategy.facilities.intel<1)return toast('CASには情報分析室Lv.1以上が必要です'),false;
 if(casPending)return toast('航空支援が到着待機中です'),false;
 if(x<0||x>=W||y<0||y>=H)return false;
 // Support requests consume the selected operator's entire turn.
 const u=selectedUnit();if(!u||u.hp<=0||u.ap<2)return toast('航空支援要請にはAP2が必要です'),false;
 u.ap-=2;casCharges--;casUsed++;
 casPending={x,y,arrival:turn+supportCAS().delay,profile:supportPlan().cas};
 log(`${u.name} がCASを要請：(${x+1},${y+1}) / 次の味方ターンに着弾`);
 toast('CAS要請受理：黄色の範囲内は味方も危険');sync();draw();return true;
}
function resolveCAS(){
 if(!casPending||gameover)return;
 const aim=casPending;casPending=null;
 // Abstract weather/identification error; a one-tile displacement may endanger allies.
 const profile=SUPPORT_CAS[aim.profile]||SUPPORT_CAS.area;
 const scattered=Math.random()<profile.scatter;
 const offsets=[[1,0],[-1,0],[0,1],[0,-1]];
 const offset=scattered?offsets[Math.floor(Math.random()*offsets.length)]:[0,0];
 const impact={x:Math.max(0,Math.min(W-1,aim.x+offset[0])),y:Math.max(0,Math.min(H-1,aim.y+offset[1]))};
 let hostileHits=0,friendlyHits=0;
 for(const u of units.filter(u=>u.hp>0&&Math.abs(u.x-impact.x)+Math.abs(u.y-impact.y)<=profile.radius)){
  const damage=u.vehicle?Math.max(1,profile.damage-Math.floor(u.armor/2)):profile.damage;
  u.hp=Math.max(0,u.hp-damage);
  if(u.team==='friendly')friendlyHits++;else hostileHits++;
  if(u.hp===0){if(u.team==='enemy')spawnDrop(u);log(`${u.name} がCASにより戦闘不能`);}
 }
 effect('shot',{x:impact.x,y:0},impact,true);
 log(`CAS着弾 (${impact.x+1},${impact.y+1})：敵${hostileHits} / 味方${friendlyHits}${scattered?' / 目標から逸脱':''}`);
 toast(friendlyHits?'CAS着弾：味方に被害発生':'CAS着弾：航空支援完了');
}

function effect(kind,from,to,hit=true){effects.push({kind,from:{x:from.x,y:from.y},to:{x:to.x,y:to.y},hit,born:performance.now(),duration:kind==='move'?480:650});if(!effectFrame)effectFrame=requestAnimationFrame(animateEffects)}
function animateEffects(now){effects=effects.filter(e=>now-e.born<e.duration);draw();effectFrame=effects.length?requestAnimationFrame(animateEffects):0}
function cancelWalk(){walkAnimation=null;moving=false;}
function animateWalk(unit,steps){
 const epoch=missionEpoch,stepDuration=145;
 moving=true;
 const origin={x:unit.x,y:unit.y},route=[origin,...steps];
 walkAnimation={id:unit.id,from:origin,to:steps[0],progress:0};
 let index=0,started=null;
 function frame(now){
  if(epoch!==missionEpoch||gameover||phase!=='friendly'||!moving){cancelWalk();return;}
  if(started===null)started=now;
  const progress=Math.min(1,(now-started)/stepDuration);
  walkAnimation={id:unit.id,from:route[index],to:route[index+1],progress};
  draw();
  if(progress<1){requestAnimationFrame(frame);return;}
  unit.x=route[index+1].x;unit.y=route[index+1].y;
  index++;started=null;
  if(index<steps.length){requestAnimationFrame(frame);return;}
  cancelWalk();
  const stride=unit.carrying!==undefined&&unit.carrying!==null?2:rec(unit.id).skills.some(k=>['rapid','sprint','quickstep','lightfoot'].includes(k))?6:4;
  unit.ap-=Math.ceil(steps.length/stride);
  if(unit.carrying!==undefined&&unit.carrying!==null){const patient=units.find(v=>v.id===unit.carrying);if(patient){patient.x=unit.x;patient.y=unit.y;}}log(`${unit.name} が ${steps.length} マス移動${unit.carrying!==undefined&&unit.carrying!==null?'（負傷者搬送）':''}`);
  toast(`${unit.name} 移動完了`);
  checkEnd();sync();draw();
 }
 requestAnimationFrame(frame);
}
function drawEffects(){const {cell:c,ox,oy}=layout;for(const e of effects){const progress=Math.min(1,(performance.now()-e.born)/e.duration),alpha=1-progress;const sx=ox+(e.from.x+.5)*c,sy=oy+(e.from.y+.5)*c,tx=ox+(e.to.x+.5)*c,ty=oy+(e.to.y+.5)*c;ctx.save();ctx.globalAlpha=alpha;if(e.kind==='move'){ctx.strokeStyle='#a8e7c9';ctx.lineWidth=Math.max(2,c*.09);ctx.setLineDash([c*.12,c*.15]);ctx.beginPath();ctx.moveTo(sx,sy);ctx.lineTo(tx,ty);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#c1f5d7';ctx.beginPath();ctx.arc(sx+(tx-sx)*progress,sy+(ty-sy)*progress,c*.11,0,Math.PI*2);ctx.fill()}else{ctx.strokeStyle=e.hit?'#ffe4a0':'#e0b1a0';ctx.lineWidth=Math.max(2,c*.065);ctx.beginPath();ctx.moveTo(sx,sy);ctx.lineTo(sx+(tx-sx)*Math.min(1,progress*3),sy+(ty-sy)*Math.min(1,progress*3));ctx.stroke();if(e.hit){ctx.fillStyle='#ffd59d';ctx.beginPath();ctx.arc(tx,ty,c*(.12+progress*.28),0,Math.PI*2);ctx.fill()}}ctx.restore()}}
const names=['VIPER','NOMAD','GHOST','RAVEN'];
const STORAGE='persistan.w0.5.0.operators';
const PREVIOUS_STORAGE='persistan.w0.4.0.operators';
const OLD_STORAGE='persistan.w0.3.0.operators';
const ROSTER_KEY='persistan.w0.5.0.roster';
const STRATEGY_KEY='persistan.w0.6.0.strategy';
const CAMPAIGN_KEY='persistan.w0.7.0.campaign';
const UI_KEY='persistan.w0.8.0.ui';
const VERSION='W2.1.0';
const LOOT_KEY='persistan.w1.5.0.armory';
const PREV_LOOT_KEY='persistan.w1.4.0.armory';
const ENEMY_WEAPONS=['akm','ak74','rpk','svd','aks74u','ak103','akms','pkm','mosin','type56','fal','g3a3','uzi','ppsh41','m79','m14'];
const ENEMY_LOADOUTS=[{weapon:'akm',ammo:30},{weapon:'ak74',ammo:30},{weapon:'rpk',ammo:40},{weapon:'svd',ammo:10},{weapon:'aks74u',ammo:30},{weapon:'pkm',ammo:50},{weapon:'fal',ammo:20},{weapon:'g3a3',ammo:20},{weapon:'ak103',ammo:30},{weapon:'type56',ammo:30},{weapon:'m14',ammo:20},{weapon:'uzi',ammo:32},{weapon:'akms',ammo:30},{weapon:'mosin',ammo:5},{weapon:'ppsh41',ammo:35},{weapon:'m79',ammo:1}];
const INITIAL_OWNED=['m4a1','mk18','hk416','g36c','scar_l','m16a4','mk12','mp5sd','m4','m733','m249','m240b','m110','m24','m40a3','m82a1','mp5a3','ump45','p90','mp7','aug_a3','famas','l85a2','sig552','g36k','scar_h','m1014','m870','mossberg500','m60'];
function loadArmory(){try{const data=JSON.parse(localStorage.getItem(LOOT_KEY)||localStorage.getItem(PREV_LOOT_KEY));if(!data||!Array.isArray(data.owned)||!Array.isArray(data.history))throw Error('bad');const counts={};for(const k of INITIAL_OWNED)counts[k]=1;for(const k of ENEMY_WEAPONS){const count=Number(data.counts?.[k]);counts[k]=Number.isInteger(count)&&count>=0&&count<=999?count:(data.owned.includes(k)?1:0)}return {owned:[...new Set([...INITIAL_OWNED,...ENEMY_WEAPONS.filter(k=>counts[k]>0)])],counts,ammo:Math.max(0,Math.min(9999,Number.isInteger(data.ammo)?data.ammo:0)),history:data.history.slice(-40)}}catch{const counts=Object.fromEntries(INITIAL_OWNED.map(k=>[k,1]));return {owned:[...INITIAL_OWNED],counts,ammo:0,history:[]}}}
function normalizeArmory(){for(const k of INITIAL_OWNED)armory.counts[k]=Math.max(1,armory.counts[k]||0);armory.owned=[...new Set([...INITIAL_OWNED,...ENEMY_WEAPONS.filter(k=>(armory.counts[k]||0)>0)])]}

let armory=loadArmory(),drops=[],collected=[];
function saveArmory(){try{localStorage.setItem(LOOT_KEY,JSON.stringify(armory));return true}catch{toast('鹵獲武器を保存できません');return false}}
function ownWeapon(k){return armory.owned.includes(k)}
function enemyWeaponFor(index){return ENEMY_LOADOUTS[index%ENEMY_LOADOUTS.length].weapon}
function spawnDrop(enemy){if(enemy.team!=='enemy'||enemy.vehicle||enemy.lootDropped)return;enemy.lootDropped=true;drops.push({id:enemy.id,x:enemy.x,y:enemy.y,weapon:enemy.weapon||'akm',ammo:Math.max(0,Math.min(60,enemy.ammo||0))});log(`${WEAPONS[enemy.weapon||'akm'].name} を現場で確認。接近して回収可能`)}
function pickup(){if(gameover||phase!=='friendly'||moving)return toast('回収できません');const u=selectedUnit();if(!u||u.hp<=0||u.ap<1)return toast('回収にはAP1が必要です');const index=drops.findIndex(d=>distance(u,d)<=1);if(index<0)return toast('回収可能な武器がありません（隣接1マス以内）');const d=drops.splice(index,1)[0];u.ap--;collected.push({weapon:d.weapon,ammo:d.ammo,by:u.id});log(`${u.name} が ${WEAPONS[d.weapon].name} を回収`);toast(`${WEAPONS[d.weapon].name} 回収 / 作戦終了後に武器庫へ`);sync();draw()}

// Vehicles remain single-cell entities in W2.1.0; movement and line-of-sight AI are enabled.
// Abstract gameplay values, not real-world penetration or guidance data.
const AT_LAUNCHERS={rpg:{name:'RPG-7',range:6,accuracy:-8,damage:9,penetration:2,rounds:2},javelin:{name:'FGM-148 Javelin',range:11,accuracy:12,damage:16,penetration:4,rounds:1}};
function antiArmorDamage(spec,target){return Math.max(0,spec.damage-Math.max(0,(target.armor||0)-spec.penetration)*3)}
function antiArmorChance(actor,target,spec){return Math.max(10,Math.min(95,75-distance(actor,target)*4-cover(target,actor)+spec.accuracy))}
const VEHICLE_TYPES={technical:{name:'武装ピックアップ',hp:8,armor:1,damage:2,range:8,accuracy:-8},apc:{name:'装甲兵員輸送車',hp:14,armor:2,damage:3,range:8,accuracy:-5},tank:{name:'主力戦車',hp:22,armor:3,damage:4,range:9,accuracy:-12}};
function vehicleDamage(raw,target){return target.vehicle?Math.max(0,raw-target.armor):raw}
function vehicleRoster(region){return region.threat>=5?['apc','tank']:region.threat>=4?['apc']:region.threat>=3?['technical']:[]}
// Tactical vehicle movement: bounded grid search, avoiding blocked and occupied cells.
// Distances and statistics are abstract game units, not real-world vehicle performance.
function vehicleMoves(vehicle, target){
 const speed=vehicle.vehicle==='technical'?3:vehicle.vehicle==='apc'?2:1;
 const queue=[{x:vehicle.x,y:vehicle.y,steps:0,first:null}];
 const seen=new Set([`${vehicle.x},${vehicle.y}`]);
 const options=[];
 while(queue.length){
  const cur=queue.shift();
  if(cur.steps>0)options.push(cur);
  if(cur.steps>=speed)continue;
  for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
   const x=cur.x+dx,y=cur.y+dy,key=`${x},${y}`;
   if(x<0||x>=W||y<0||y>=H||occupied(x,y)||seen.has(key)||units.some(u=>u!==vehicle&&u.hp>0&&u.x===x&&u.y===y))continue;
   seen.add(key);queue.push({x,y,steps:cur.steps+1,first:cur.first||{x,y}});
  }
 }
 // Prefer clear firing lanes, useful range, and distance from exposed infantry.
 const spec=VEHICLE_TYPES[vehicle.vehicle];
 const score=pos=>{
  const d=Math.abs(pos.x-target.x)+Math.abs(pos.y-target.y);
  const clear=line(pos,target);
  return (clear&&d<=spec.range?40:0)-Math.abs(d-Math.min(5,spec.range))*3-cover(pos,target)*.05-pos.steps*.4;
 };
 const current={x:vehicle.x,y:vehicle.y,steps:0};
 options.sort((a,b)=>score(b)-score(a));
 return options.length&&score(options[0])>score(current)+.5?options[0]:null;
}
function moveEnemyVehicle(vehicle,target){
 const dest=vehicleMoves(vehicle,target);
 if(!dest)return false;
 const from={x:vehicle.x,y:vehicle.y};vehicle.x=dest.x;vehicle.y=dest.y;
 effect('move',from,vehicle);log(`${vehicle.name} が ${dest.steps}マス機動`);
 for(const f of units.filter(u=>u.team==='friendly'&&u.hp>0&&u.overwatch&&u.ammo>0)){
  if(vehicle.hp<=0)break;
  if(line(f,vehicle)&&distance(f,vehicle)<=currentWeapon(f).range+(rec(f.id).skills.some(k=>['scout','range','spotter'].includes(k))?2:0)){
   f.overwatch=false;shootOverwatch(f,vehicle);
  }
 }
 return true;
}

const MISSION_TYPES=['eliminate','secure','extract','rescue'];
const MISSION_LABELS={eliminate:'敵部隊排除',secure:'重要地点確保',extract:'撤収地点到達',rescue:'孤立した負傷隊員の救出・後送'};
let atMode='rpg';
let missionType='eliminate',missionLimit=12,objectiveTile={x:8,y:8},lastResult=null,missionEpoch=0;
const CLASSES={assault:['Assaulter','突撃'],marksman:['Marksman','精密射撃'],support:['Support','火力支援'],medic:['Medic','衛生'],recon:['Recon','偵察'],engineer:['Engineer','工兵']};
const SKILLS={steady:['精密照準','命中率 +8'],rapid:['迅速行動','移動距離 +2'],armor:['強化装備','最大HP +2'],field:['野戦衛生','任務後の負傷軽減'],scout:['索敵','射程 +2'],focus:['集中射撃','射撃威力 +1']};
// Rank and billet are separate. Enlisted soldiers never automatically become commissioned officers.
const RANKS=['Private (E-1)','Private First Class (E-3)','Specialist (E-4)','Sergeant (E-5)','Staff Sergeant (E-6)','Sergeant First Class (E-7)'];
const ENLISTED_RANKS=['Private (E-1)','Private First Class (E-3)','Specialist (E-4)','Sergeant (E-5)','Staff Sergeant (E-6)','Sergeant First Class (E-7)','Master Sergeant (E-8)'];
const OFFICER_RANKS=['Second Lieutenant (O-1)','First Lieutenant (O-2)','Captain (O-3)'];
const ROLES={operator:'オペレーター',squad:'分隊長',senior:'小隊先任下士官',deputy:'副小隊長',oic:'小隊責任者 (OIC)'};
const COMMAND_ABILITIES={order:'指揮命令',succession:'指揮権継承',veteran:'古参兵の指導',fireteam:'分隊連携'};
function rank(r){if(r.branch==='officer')return OFFICER_RANKS[Math.min(2,Math.max(0,(r.officerGrade||1)-1))];return ENLISTED_RANKS[Math.min(6,Math.max(0,r.level+(r.seniorGrade||0)))];}
function roleEligible(r,role){if(role==='operator')return true;if(r.kia)return false;if(role==='oic')return r.branch==='officer'&&r.officerGrade>=2;if(role==='deputy')return r.branch==='officer';if(role==='senior')return r.branch!=='officer'&&r.level>=5;if(role==='squad')return r.branch!=='officer'&&r.level>=4;return false;}
function assignRole(r,role){if(!roleEligible(r,role))return false;if(role!=='operator'&&roster.some(x=>x.id!==r.id&&x.role===role&&!x.kia))return false;r.role=role;saveRoster();return true;}
function effectiveCommander(){const alive=units.filter(u=>u.team==='friendly'&&u.hp>0);return alive.find(u=>rec(u.id).role==='oic')||alive.find(u=>rec(u.id).role==='deputy')||null;}
function commandOrder(){if(gameover||moving||phase!=='friendly')return toast('現在は指揮命令を使用できません');const leader=effectiveCommander();if(!leader)return toast('出撃中のOICまたは副小隊長が必要です');if(leader.ap<1)return toast('指揮官のAPが不足');if(commandUsedTurn===turn)return toast('指揮命令は1ターンに1回です');const target=selectedUnit();if(!target||target.hp<=0||target.id===leader.id||target.ap>=2)return toast('APが不足した別の味方隊員を選択してください');leader.ap--;target.ap++;commandUsedTurn=turn;log(`${leader.name} が ${target.name} に指揮命令（AP+1）`);sync();draw();}
let commandUsedTurn=0;
// XCOM-inspired branching class abilities. Each tier unlocks at a rank; one pick per tier.
const CLASS_TREES={
 assault:[[['breach','突入射撃','近距離(3マス以内)命中+12'],['sprint','機動突撃','移動距離+2']], [['hardhit','強襲弾','近距離(3マス以内)威力+1'],['guard','前衛装甲','最大HP+2']]],
 marksman:[[['aim','精密射撃','命中+10'],['range','長距離観測','射程+2']], [['critical','弱点射撃','威力+1'],['steadyhand','安定照準','警戒射撃の命中ペナルティ軽減']]],
 support:[[['suppress','制圧訓練','警戒射撃命中+10'],['reserve','予備弾倉','装弾数+10%（ゲーム内抽象値）']], [['sturdy','重装備','最大HP+2'],['assist','戦術支援','射撃命中+6']]],
 medic:[[['triage','救急処置','任務後の負傷日数-1'],['resilience','耐久訓練','最大HP+2']], [['combatmedic','戦闘衛生','最大HP+2'],['quickstep','緊急移動','移動距離+2']]],
 recon:[[['spotter','前進観測','射程+2'],['lightfoot','軽装機動','移動距離+2']], [['ambush','伏撃','警戒射撃命中+10'],['precision','標的識別','命中+8']]],
 engineer:[[['plates','防護強化','最大HP+2'],['technical','整備訓練','射撃命中+6']], [['demolition','対装甲訓練','対装甲命中+10'],['survivor','野戦生存','最大HP+2']]]
};
const TREE_SKILLS=Object.fromEntries(Object.values(CLASS_TREES).flat(2).map(([id,name,description])=>[id,[name,description]]));
const ALL_SKILLS={...SKILLS,...TREE_SKILLS};
const hasSkill=(id,key)=>Boolean(roster[id]?.skills?.includes(key));
const skillTier=(cls,key)=>CLASS_TREES[cls]?.findIndex(t=>t.some(s=>s[0]===key))??-1;
function canLearn(r,key){const tier=skillTier(r.cls,key);return !r.kia&&r.points>0&&tier>=0&&r.level>=tier+1&&!r.skills.includes(key)&&!CLASS_TREES[r.cls][tier].some(s=>r.skills.includes(s[0]));}

const XP_LEVELS=[0,20,55,105,170,250];
const clone=v=>JSON.parse(JSON.stringify(v));
const WEAPONS={
 m4a1:{name:'M4A1',mag:30,range:9,accuracy:0,damage:2,shape:'carbine'},
 mk18:{name:'Mk 18 Mod 0',mag:30,range:7,accuracy:5,damage:2,shape:'short'},
 hk416:{name:'HK416',mag:30,range:9,accuracy:3,damage:2,shape:'carbine'},
 g36c:{name:'G36C',mag:30,range:8,accuracy:1,damage:2,shape:'short'},
 scar_l:{name:'FN SCAR-L',mag:30,range:10,accuracy:2,damage:2,shape:'carbine'},
 m16a4:{name:'M16A4',mag:30,range:11,accuracy:4,damage:2,shape:'long'},
 mk12:{name:'Mk 12 SPR',mag:20,range:13,accuracy:9,damage:3,shape:'long'},
 mp5sd:{name:'MP5SD',mag:30,range:6,accuracy:8,damage:1,shape:'short',integral_suppressor:true},
 akm:{name:'AKM (鹵獲)',mag:30,range:8,accuracy:-4,damage:3,shape:'carbine'},
 ak74:{name:'AK-74 (鹵獲)',mag:30,range:9,accuracy:-1,damage:2,shape:'carbine'},
 rpk:{name:'RPK (鹵獲)',mag:40,range:10,accuracy:-5,damage:3,shape:'long'},
 svd:{name:'SVD (鹵獲)',mag:10,range:13,accuracy:5,damage:3,shape:'long'},
 m4:{name:'M4 Carbine',mag:30,range:9,accuracy:0,damage:2,shape:'carbine'},
 m733:{name:'Colt Model 733',mag:30,range:7,accuracy:3,damage:2,shape:'short'},
 m249:{name:'M249 SAW',mag:100,range:10,accuracy:-6,damage:3,shape:'long'},
 m240b:{name:'M240B',mag:100,range:11,accuracy:-9,damage:4,shape:'long'},
 m110:{name:'M110 SASS',mag:20,range:13,accuracy:9,damage:3,shape:'long'},
 m24:{name:'M24 SWS',mag:5,range:14,accuracy:12,damage:4,shape:'long'},
 m40a3:{name:'M40A3',mag:5,range:14,accuracy:11,damage:4,shape:'long'},
 m82a1:{name:'M82A1',mag:10,range:14,accuracy:3,damage:5,shape:'long'},
 mp5a3:{name:'MP5A3',mag:30,range:6,accuracy:7,damage:1,shape:'short'},
 ump45:{name:'UMP45',mag:25,range:6,accuracy:4,damage:2,shape:'short'},
 p90:{name:'FN P90',mag:50,range:7,accuracy:5,damage:1,shape:'short'},
 mp7:{name:'HK MP7',mag:40,range:7,accuracy:6,damage:1,shape:'short'},
 aug_a3:{name:'Steyr AUG A3',mag:30,range:10,accuracy:4,damage:2,shape:'carbine'},
 famas:{name:'FAMAS F1',mag:25,range:9,accuracy:1,damage:2,shape:'carbine'},
 l85a2:{name:'L85A2',mag:30,range:10,accuracy:3,damage:2,shape:'carbine'},
 sig552:{name:'SIG SG 552',mag:30,range:8,accuracy:5,damage:2,shape:'short'},
 g36k:{name:'G36K',mag:30,range:9,accuracy:3,damage:2,shape:'carbine'},
 scar_h:{name:'FN SCAR-H',mag:20,range:11,accuracy:0,damage:3,shape:'carbine'},
 m1014:{name:'Benelli M4',mag:7,range:4,accuracy:10,damage:4,shape:'short'},
 m870:{name:'Remington 870',mag:6,range:4,accuracy:7,damage:4,shape:'long'},
 mossberg500:{name:'Mossberg 500',mag:6,range:4,accuracy:5,damage:4,shape:'long'},
 m60:{name:'M60E4',mag:100,range:11,accuracy:-9,damage:4,shape:'long'},
 aks74u:{name:'AKS-74U (鹵獲)',mag:30,range:7,accuracy:-3,damage:2,shape:'short'},
 ak103:{name:'AK-103 (鹵獲)',mag:30,range:9,accuracy:-2,damage:3,shape:'carbine'},
 akms:{name:'AKMS (鹵獲)',mag:30,range:8,accuracy:-5,damage:3,shape:'carbine'},
 pkm:{name:'PKM (鹵獲)',mag:100,range:11,accuracy:-10,damage:4,shape:'long'},
 mosin:{name:'Mosin-Nagant (鹵獲)',mag:5,range:13,accuracy:2,damage:4,shape:'long'},
 type56:{name:'Type 56 (鹵獲)',mag:30,range:8,accuracy:-5,damage:3,shape:'carbine'},
 fal:{name:'FN FAL (鹵獲)',mag:20,range:11,accuracy:-2,damage:3,shape:'long'},
 g3a3:{name:'HK G3A3 (鹵獲)',mag:20,range:11,accuracy:-3,damage:3,shape:'long'},
 uzi:{name:'Uzi (鹵獲)',mag:32,range:5,accuracy:-1,damage:1,shape:'short'},
 ppsh41:{name:'PPSh-41 (鹵獲)',mag:35,range:5,accuracy:-7,damage:1,shape:'short'},
 m79:{name:'M79 (鹵獲)',mag:1,range:5,accuracy:-8,damage:4,shape:'short'},
 m14:{name:'M14 (鹵獲)',mag:20,range:12,accuracy:2,damage:3,shape:'long'}
};
// W2.0.0: attachment metadata: label, accuracy, range, damage, magazine bonus.
const ATTACHMENTS={
 optic:[['iron','アイアンサイト',0,0,0,0],['red_dot','レッドドット',5,0,0,0],['holo','ホログラフィック',6,0,0,0],['acog','ACOG 4倍',9,2,0,0],['lpvo','可変倍率 1-6倍',7,3,0,0],['scope','高倍率スコープ',8,4,0,0]],
 muzzle:[['standard','標準銃口',0,0,0,0],['suppressor','サプレッサー',-2,0,0,0],['flash_hider','フラッシュハイダー',1,0,0,0],['compensator','コンペンセイター',4,0,0,0],['brake','マズルブレーキ',5,0,0,0]],
 grip:[['standard','標準',0,0,0,0],['vertical','バーティカル',3,0,0,0],['angled','アングル',4,0,0,0],['bipod','バイポッド',6,0,0,0]],
 stock:[['standard','標準ストック',0,0,0,0],['compact','コンパクト',-2,0,0,0],['precision','精密ストック',4,0,0,0],['recoil','反動制御ストック',3,0,0,0]],
 laser:[['none','なし',0,0,0,0],['red','可視レーザー',2,0,0,0],['ir','IRレーザー',3,0,0,0]],
 light:[['none','なし',0,0,0,0],['white','ウェポンライト',1,0,0,0],['compact','小型ライト',1,0,0,0]],
 handguard:[['standard','標準ハンドガード',0,0,0,0],['rail','レール拡張',1,0,0,0],['freefloat','フリーフロート',3,1,0,0]],
 magazine:[['standard','標準弾倉（銃種固有）',0,0,0,0],['stanag20','STANAG 20発（5.56mm AR系）',0,0,0,0]],
 underbarrel:[['none','なし',0,0,0,0],['m203','M203 40mm（対応小銃のみ）',-1,0,0,0]]
};
const DEFAULT_WEAPON={weapon:'m4a1',...Object.fromEntries(Object.entries(ATTACHMENTS).map(([key,options])=>[key,options[0][0]]))};
function attachmentStats(o){const sum={accuracy:0,range:0,damage:0,mag:0};for(const [key,options] of Object.entries(ATTACHMENTS)){const row=options.find(r=>r[0]===o[key])||options[0];sum.accuracy+=row[2];sum.range+=row[3];sum.damage+=row[4];sum.mag+=row[5];}return sum;}
function weaponSpec(o){const w=WEAPONS[o.weapon]||WEAPONS.m4a1,bonuses=attachmentStats(o);return {...w,accuracy:w.accuracy+bonuses.accuracy,range:w.range+bonuses.range,damage:w.damage+bonuses.damage,mag:effectiveMag(o),noise:(o.muzzle==='suppressor'||w.integral_suppressor)?'LOW':'HIGH'};}
// Historical equipment policy: 2008 era, weapon-specific compatibility, no universal magazine bonus.
const STANAG_556=new Set(['m4a1','mk18','hk416','m16a4','mk12','m249']);
const M203_HOSTS=new Set(['m4a1','mk18','m16a4']);
function compatibleAttachment(o,key,value){
 if(key==='magazine'&&value==='stanag20')return STANAG_556.has(o.weapon)&&o.weapon!=='m249';
 if(key==='underbarrel'&&value==='m203')return M203_HOSTS.has(o.weapon);
 return true;
}
function sanitizeLoadout(o){
 for(const key of ['magazine','underbarrel'])if(!compatibleAttachment(o,key,o[key]))o[key]=ATTACHMENTS[key][0][0];
 return o;
}
function effectiveMag(o){return o.magazine==='stanag20'&&compatibleAttachment(o,'magazine','stanag20')?20:(WEAPONS[o.weapon]||WEAPONS.m4a1).mag;}
function canUseM203(o){return o.underbarrel==='m203'&&M203_HOSTS.has(o.weapon);}
function currentWeapon(u){return weaponSpec(operators[u.id]||DEFAULT_WEAPON)}
const OPTIONS={uniform:[['desert','Desert / デザート'],['woodland','Woodland / ウッドランド'],['olive','Olive / オリーブ'],['black','Black / ブラック']],headgear:[['helmet','ヘルメット'],['cap','キャップ'],['boonie','ブーニーハット'],['none','なし']],facegear:[['goggles','ゴーグル'],['mask','フェイスマスク'],['none','なし']],vest:[['tan','タン'],['olive','オリーブ'],['black','ブラック']],skin:[['light','ライト'],['medium','ミディアム'],['brown','ブラウン'],['dark','ダーク']]};
const DEFAULTS=names.concat(['ECHO','FALCON','WOLF','ATLAS']).map((name,id)=>({id,name,uniform:['desert','woodland','olive','black'][id%4],headgear:'helmet',facegear:'goggles',vest:'tan',skin:'medium',...DEFAULT_WEAPON}));
let operators=loadOperators(),editing=0,editorSnapshot=null;
const HOME_STATES=['Texas','California','Virginia','Florida','North Carolina','Georgia','New York','Washington','Colorado','Arizona','Ohio','Pennsylvania','Massachusetts','Tennessee','Oregon','Alaska','Hawaii','Illinois','Michigan','Maryland'];
const INITIAL_HOME=['Texas','Virginia','California','Texas','Florida','North Carolina','Virginia','Georgia'];
function hometown(r){return HOME_STATES.includes(r?.homeState)?r.homeState:'Virginia';}
function sameHometown(a,b){return !!a&&!!b&&hometown(a)===hometown(b);}
function newRecord(id){return {id,active:id<4,cls:['assault','marksman','support','medic','recon','engineer'][id%6],xp:0,level:0,points:0,skills:[],missions:0,kills:0,injury:0,kia:false,branch:'enlisted',officerGrade:0,role:'operator',seniorGrade:0,bondPartner:null,bondXP:0,homeState:INITIAL_HOME[id],stress:0,trauma:0}}
function loadRoster(){try{const raw=JSON.parse(localStorage.getItem(ROSTER_KEY));if(!Array.isArray(raw))throw Error('invalid');return DEFAULTS.map((_,id)=>{const d=newRecord(id),v=raw.find(r=>r&&r.id===id)||{};return {...d,...v,id,skills:Array.isArray(v.skills)?v.skills.filter(k=>ALL_SKILLS[k]):[],cls:CLASSES[v.cls]?v.cls:d.cls,level:Math.max(0,Math.min(5,Number(v.level)||0)),xp:Math.max(0,Number(v.xp)||0),points:Math.max(0,Number(v.points)||0),injury:Math.max(0,Number(v.injury)||0),kia:!!v.kia,branch:v.branch==='officer'?'officer':'enlisted',officerGrade:v.branch==='officer'?Math.max(1,Math.min(3,Number(v.officerGrade)||1)):0,role:ROLES[v.role]?v.role:'operator',seniorGrade:Math.max(0,Math.min(1,Number(v.seniorGrade)||0)),bondPartner:Number.isInteger(v.bondPartner)&&v.bondPartner>=0&&v.bondPartner<DEFAULTS.length&&v.bondPartner!==id?v.bondPartner:null,bondXP:Math.max(0,Math.min(999,Number(v.bondXP)||0)),homeState:HOME_STATES.includes(v.homeState)?v.homeState:d.homeState,stress:Math.max(0,Math.min(100,Number(v.stress)||0)),trauma:Math.max(0,Math.min(99,Number(v.trauma)||0))}})}catch{return DEFAULTS.map((_,i)=>newRecord(i))}}
let roster=loadRoster(),missionCommitted=false,enemyTurnTimer=null;
const REGIONS=[
 {id:'kardan',name:'カルダン首都圏',threat:3,security:40,terrain:'都市'},
 {id:'zar',name:'ザル山地',threat:4,security:25,terrain:'山岳'},
 {id:'hadir',name:'ハディール砂漠',threat:2,security:55,terrain:'砂漠'},
 {id:'azra',name:'アズラ港',threat:3,security:45,terrain:'港湾'},
 {id:'barkan',name:'バルカン工業地帯',threat:5,security:20,terrain:'工業'}
];
const FACILITIES=[['barracks','兵舎','部隊管理の基盤'],['medical','医療施設','回復を促進'],['intel','情報分析室','偵察効率を改善'],['armory','武器庫','作戦報酬を増加'],['workshop','整備施設','将来の装備研究基盤']];
function initialStrategy(){return {day:1,funds:600,selected:'kardan',regions:REGIONS.map(r=>({...r,intel:0,wins:0})),facilities:Object.fromEntries(FACILITIES.map(f=>[f[0],0])),missions:0,wins:0,support:{cas:'area',qrf:'light'}}}
function loadStrategy(){try{const raw=JSON.parse(localStorage.getItem(STRATEGY_KEY));if(!raw||!Array.isArray(raw.regions))throw Error('bad');const def=initialStrategy();return {...def,day:Math.max(1,Number(raw.day)||1),funds:Math.max(0,Number(raw.funds)||0),selected:REGIONS.some(r=>r.id===raw.selected)?raw.selected:def.selected,regions:def.regions.map(r=>{const v=raw.regions.find(x=>x.id===r.id)||{};return {...r,threat:Math.max(1,Math.min(5,Number(v.threat)||r.threat)),security:Math.max(0,Math.min(100,Number.isFinite(Number(v.security))?Number(v.security):r.security)),intel:Math.max(0,Math.min(5,Number(v.intel)||0)),wins:Math.max(0,Number(v.wins)||0)}}),facilities:Object.fromEntries(FACILITIES.map(([id])=>[id,Math.max(0,Math.min(3,Number(raw.facilities?.[id])||0))])),missions:Math.max(0,Number(raw.missions)||0),wins:Math.max(0,Number(raw.wins)||0),support:{cas:raw.support?.cas==='precision'?'precision':'area',qrf:raw.support?.qrf==='fast'?'fast':'light'}}}catch{return initialStrategy()}}
let strategy=loadStrategy(),missionRegion=strategy.selected;
function loadCampaign(){try{const x=JSON.parse(localStorage.getItem(CAMPAIGN_KEY));if(!x||!Array.isArray(x.history))throw Error('invalid');return {sequence:Math.max(0,Number(x.sequence)||0),history:x.history.slice(-30),completed:!!x.completed}}catch{return {sequence:0,history:[],completed:false}}}
let campaign=loadCampaign();
function saveCampaign(){try{localStorage.setItem(CAMPAIGN_KEY,JSON.stringify(campaign));return true}catch{return false}}
function saveStrategy(){try{localStorage.setItem(STRATEGY_KEY,JSON.stringify(strategy));return true}catch{toast('戦略データを保存できません');return false}}
function currentRegion(){return strategy.regions.find(r=>r.id===strategy.selected)}
function renderCommand(){const r=currentRegion();normalizeArmory();$('armory-summary').textContent=`武器庫：${armory.owned.length}種 / 回収弾薬 ${armory.ammo}発 / 鹵獲武器 ${ENEMY_WEAPONS.reduce((n,k)=>n+(armory.counts[k]||0),0)}挺`; $('armory-list').innerHTML=ENEMY_WEAPONS.map(k=>`<div class="armory-item"><span>${htmlEscape(WEAPONS[k].name)}</span><strong>× ${armory.counts[k]||0}</strong></div>`).join('')+'<p class="command-note">回収した弾薬は兵站在庫として記録します。戦闘中の自動補給には未対応です。</p>';$('campaign-status').textContent=`作戦進行 ${campaign.sequence}件 · 成功 ${strategy.wins}件 · ${campaign.completed?'全域安定化達成':'全5地域の治安70以上でキャンペーン達成'}`;$('campaign-history').innerHTML=campaign.history.slice(-6).reverse().map(h=>`<div>${htmlEscape(h.region)} / ${htmlEscape(MISSION_LABELS[h.type]||h.type)} / ${h.win?'成功':'失敗'} / T${h.turn}</div>`).join('')||'作戦履歴はありません';$('command-stats').textContent=`DAY ${strategy.day}  ·  BUDGET ${strategy.funds}  ·  OPERATIONS ${strategy.missions}  ·  SUCCESS ${strategy.wins}`;
 $('region-list').innerHTML=strategy.regions.map(v=>`<button class="region-button ${v.id===r.id?'active':''}" data-region="${v.id}"><b>${v.name}</b><small>${v.terrain} · 脅威 ${v.threat}/5 · 治安 ${v.security}/100 · 情報 ${v.intel}/5</small></button>`).join('');
 $('region-detail').textContent=`選択地域：${r.name} ／ 推定脅威 ${r.threat}/5 ／ 情報 ${r.intel}/5 ／ 成功作戦 ${r.wins}`;
 $('facility-list').innerHTML=FACILITIES.map(([id,name,description])=>{const level=strategy.facilities[id],cost=100+level*100;return `<div class="facility"><div><b>${name} Lv.${level}/3</b><small>${description}</small></div><button data-upgrade="${id}" ${level>=3||strategy.funds<cost?'disabled':''}>${level>=3?'最大':`強化 ${cost}`}</button></div>`}).join('');
 const plan=supportPlan();$('support-cas').value=plan.cas;$('support-qrf').value=plan.qrf;
 $('support-info').textContent=`CAS ${SUPPORT_CAS[plan.cas].name} / QRF ${SUPPORT_QRF[plan.qrf].name}：CASは情報分析室Lv.1、QRFは兵舎Lv.1が必要です。任務開始時に編制を確定します。`;
 $('support-cas').disabled=strategy.facilities.intel<1;$('support-qrf').disabled=strategy.facilities.barracks<1;
 $('recon').disabled=strategy.funds<40||r.intel>=5;
 document.querySelectorAll('[data-region]').forEach(b=>b.onclick=()=>{strategy.selected=b.dataset.region;saveStrategy();renderCommand()});
 document.querySelectorAll('[data-upgrade]').forEach(b=>b.onclick=()=>{const id=b.dataset.upgrade,level=strategy.facilities[id],cost=100+level*100;if(level>=3||strategy.funds<cost)return;strategy.funds-=cost;strategy.facilities[id]++;saveStrategy();renderCommand();toast('施設を強化しました')});}
$('support-cas').onchange=()=>{if(strategy.facilities.intel<1)return;strategy.support={...supportPlan(),cas:$('support-cas').value};saveStrategy();renderCommand()};
$('support-qrf').onchange=()=>{if(strategy.facilities.barracks<1)return;strategy.support={...supportPlan(),qrf:$('support-qrf').value};saveStrategy();renderCommand()};
function openCommand(){renderCommand();$('command-overlay').classList.remove('hidden')}
function closeCommand(){$('command-overlay').classList.add('hidden')}
function advanceDay(){strategy.day++;for(const r of roster)if(!r.kia){r.injury=Math.max(0,r.injury-1-(strategy.facilities.medical>=2?1:0));r.stress=Math.max(0,r.stress-(strategy.facilities.medical>=1?12:7));}saveRoster();saveStrategy();renderRoster();renderCommand();toast('日数が経過し負傷者が回復しました')}
$('command').onclick=openCommand;$('command-close').onclick=closeCommand;
$('recon').onclick=()=>{const r=currentRegion();if(strategy.funds<40||r.intel>=5)return;strategy.funds-=40;r.intel=Math.min(5,r.intel+1+(strategy.facilities.intel>=2?1:0));saveStrategy();renderCommand();toast(r.name+' の偵察が進展')};
$('command-day').onclick=advanceDay;
$('launch').onclick=()=>{if(!deployed().length){closeCommand();openRoster();return toast('出撃可能な隊員がいません')}missionRegion=strategy.selected;closeCommand();start()};

function saveRoster(){try{localStorage.setItem(ROSTER_KEY,JSON.stringify(roster));return true}catch{toast('隊員データを保存できません');return false}}
function rec(id){return roster[id]}
function deployed(){return roster.filter(r=>r.active&&!r.kia&&r.injury===0).slice(0,4)}

// BROTHERHOOD: symmetric, exclusive partner bonds, saved with the roster.
const BOND_THRESHOLDS=[0,2,5,9];
function bondTier(r){return r&&r.bondPartner!==null?Math.min(3,BOND_THRESHOLDS.reduce((n,x,i)=>r.bondXP>=x?i:n,0)):0;}
function bondedPartner(id){const r=rec(id);if(!r||r.bondPartner===null||r.kia)return null;const partner=rec(r.bondPartner);return partner&&!partner.kia&&partner.bondPartner===id?partner:null;}
function bondUnit(id){const r=bondedPartner(id);return r?units.find(u=>u.team==='friendly'&&u.id===r.id&&u.hp>0):null;}
function bondNearby(u,range=4){const p=bondUnit(u.id);return p&&u.hp>0&&distance(u,p)<=range?p:null;}
function setBrotherhood(id,partnerId){const a=rec(id),b=rec(partnerId);if(!a||!b||a.id===b.id||a.kia||b.kia||a.bondPartner!==null||b.bondPartner!==null)return false;a.bondPartner=b.id;b.bondPartner=a.id;a.bondXP=0;b.bondXP=0;saveRoster();return true;}
function clearBrotherhood(id){const a=rec(id);if(!a)return;const b=a.bondPartner!==null?rec(a.bondPartner):null;if(b&&b.bondPartner===id){b.bondPartner=null;b.bondXP=0;}a.bondPartner=null;a.bondXP=0;saveRoster();}
function bondMissionProgress(){const onField=new Map(units.filter(u=>u.team==='friendly').map(u=>[u.id,u]));for(const r of roster){const p=bondedPartner(r.id);if(!p||r.id>p.id)continue;const a=onField.get(r.id),b=onField.get(p.id);if(!a||!b||a.hp<=0||b.hp<=0)continue;const gain=1+(Math.abs(a.x-b.x)+Math.abs(a.y-b.y)<=4?1:0)+(sameHometown(r,p)?1:0);r.bondXP=Math.min(999,r.bondXP+gain);p.bondXP=r.bondXP;log(`${operators[r.id].name} / ${operators[p.id].name} 絆経験値 +${gain}（Tier ${bondTier(r)}）`);}}
let bondActionUsedTurn=0;
function brotherhoodAssist(){if(gameover||moving||phase!=='friendly')return toast('現在は絆アビリティを使用できません');const actor=selectedUnit();if(!actor||actor.hp<=0)return;const partner=bondNearby(actor,4);if(!partner)return toast('絆相手が4マス以内に必要です');const tier=bondTier(rec(actor.id));if(tier<2)return toast('絆Tier 2で解放されます');if(bondActionUsedTurn===turn)return toast('絆アビリティは1ターン1回です');if(actor.ap<1)return toast('AP1が必要です');if(partner.ap>=2)return toast('絆相手のAPが満タンです');actor.ap--;partner.ap++;bondActionUsedTurn=turn;log(`${actor.name} → ${partner.name} BROTHERHOOD ASSIST（AP+1）`);sync();draw();}
function brotherhoodAccuracy(u){const p=bondNearby(u,4);return bondTier(rec(u.id))>=1&&p?5+(sameHometown(rec(u.id),rec(p.id))?3:0):0;}
function brotherhoodDefense(u){return bondTier(rec(u.id))>=3&&bondNearby(u,4)?1:0;}
function hometownRescueBonus(u){const p=bondNearby(u,2);return !!p&&bondTier(rec(u.id))>=2&&sameHometown(rec(u.id),rec(p.id));}
// W2.7.0: persistent combat stress and brotherhood rescue.
let rescueUsed=new Set();
// W2.9.0: downed operators remain recoverable until bleeding out.
const EVAC={x:1,y:8};let evacuated=new Set(),evacRescues=0,rescueObjectiveId=null;
let rallyUsedTurn=0, squadCoverUsedTurn=0;
function combatStress(u){const r=rec(u.id);if(!r)return 0;const partner=bondedPartner(u.id);const fallen=partner&&units.some(v=>v.id===partner.id&&v.team==='friendly'&&v.hp<=0);return Math.min(35,Math.floor((r.stress||0)/10)*2+(fallen?12:0));}
function brotherhoodRescue(){
 if(gameover||moving||phase!=='friendly')return toast('現在は救助できません');
 const actor=selectedUnit();if(!actor||actor.hp<=0)return;
 const partner=bondUnit(actor.id),r=rec(actor.id);
 if(!partner||distance(actor,partner)>1)return toast('戦友が隣接している必要があります');
 if(bondTier(r)<1)return toast('絆Tier 1で解放されます');
 if(partner.hp>=partner.maxhp)return toast('戦友は負傷していません');
 if(actor.ap<1)return toast('救助にはAP1が必要です');
 if(rescueUsed.has(actor.id))return toast('救助は隊員ごとに1任務1回です');
 actor.ap--;const bonus=sameHometown(r,rec(partner.id))?1:0;
 const healed=Math.min(partner.maxhp-partner.hp,2+bonus);partner.hp+=healed;
 r.stress=Math.max(0,(r.stress||0)-5);rec(partner.id).stress=Math.max(0,(rec(partner.id).stress||0)-8);
 rescueUsed.add(actor.id);log(`${actor.name} → ${partner.name} 戦友救助 HP+${healed}${bonus?'（同郷連携）':''}`);
 sync();draw();return true;
}
// W2.8.0: command-led recovery and fire-team protection.
function leadershipRally(){
 if(gameover||moving||phase!=='friendly')return toast('現在は士気回復できません');
 const leader=units.find(u=>u.team==='friendly'&&u.hp>0&&rec(u.id).role==='senior')||effectiveCommander();
 if(!leader)return toast('出撃中の小隊先任下士官または指揮官が必要です');
 if(leader.ap<1)return toast('指揮役のAPが不足しています');
 if(rallyUsedTurn===turn)return toast('士気回復は1ターン1回です');
 const allies=units.filter(u=>u.team==='friendly'&&u.hp>0&&distance(u,leader)<=4);
 const stressed=allies.filter(u=>(rec(u.id).stress||0)>0);
 if(!stressed.length)return toast('周囲4マスにストレスを抱える味方がいません');
 leader.ap--;rallyUsedTurn=turn;
 const amount=rec(leader.id).role==='senior'?14:9;
 for(const ally of stressed){const r=rec(ally.id);r.stress=Math.max(0,r.stress-amount);}
 saveRoster();log(`${leader.name} 士気回復：周囲${stressed.length}名のストレス-${amount}`);sync();draw();return true;
}
function squadCover(){
 if(gameover||moving||phase!=='friendly')return toast('現在は分隊援護できません');
 const leader=units.find(u=>u.team==='friendly'&&u.hp>0&&rec(u.id).role==='squad');
 if(!leader)return toast('出撃中の分隊長が必要です');
 if(leader.ap<1)return toast('分隊長のAPが不足しています');
 if(squadCoverUsedTurn===turn)return toast('分隊援護は1ターン1回です');
 const target=selectedUnit();
 if(!target||target.hp<=0||target.id===leader.id||distance(leader,target)>4)return toast('分隊長から4マス以内の別の隊員を選択');
 if(target.coveredUntil===turn)return toast('すでに援護中です');
 leader.ap--;target.coveredUntil=turn;squadCoverUsedTurn=turn;
 log(`${leader.name} → ${target.name} 分隊援護：敵ターン中の被ダメージ-1`);sync();draw();return true;
}
function fieldBondSummary(){return roster.filter(r=>r.bondPartner!==null&&r.id<r.bondPartner).map(r=>{const p=bondedPartner(r.id);if(!p)return null;const a=units.find(u=>u.id===r.id&&u.team==='friendly'),b=units.find(u=>u.id===p.id&&u.team==='friendly');return {names:`${operators[r.id].name} / ${operators[p.id].name}`,tier:bondTier(r),sameHome:sameHometown(r,p),deployed:!!(a&&b),distance:a&&b?distance(a,b):null,alive:!!(a&&b&&a.hp>0&&b.hp>0)};}).filter(Boolean)}
function applyBrotherhoodTrauma(){
 const field=new Map(units.filter(u=>u.team==='friendly').map(u=>[u.id,u]));
 const processed=new Set();
 for(const r of roster){const partner=bondedPartner(r.id);if(!partner||processed.has(r.id)||processed.has(partner.id))continue;
 processed.add(r.id);processed.add(partner.id);
 const a=field.get(r.id),b=field.get(partner.id);
 if(!a||!b)continue;
 if(a.hp<=0&&b.hp>0){partner.stress=Math.min(100,(partner.stress||0)+35);partner.trauma=(partner.trauma||0)+1;log(`${operators[partner.id].name} 戦友喪失：ストレス+35`);}
 if(b.hp<=0&&a.hp>0){r.stress=Math.min(100,(r.stress||0)+35);r.trauma=(r.trauma||0)+1;log(`${operators[r.id].name} 戦友喪失：ストレス+35`);}
 }
}
function validateBrotherhood(){for(const r of roster){if(r.bondPartner===null)continue;const p=rec(r.bondPartner);if(r.kia||!p||p.kia||p.bondPartner!==r.id){r.bondPartner=null;r.bondXP=0;}}}
validateBrotherhood();
function maxHP(id){return 6+(rec(id).skills.includes('armor')?2:0)+(rec(id).skills.filter(k=>['guard','sturdy','resilience','combatmedic','plates','survivor'].includes(k)).length*2)}
function xpGain(r,amount){r.xp+=amount;while(r.level<5&&r.xp>=XP_LEVELS[r.level+1]){r.level++;r.points++;if(r.branch==='officer')r.officerGrade=Math.min(3,Math.max(1,r.level-2));log(operators[r.id].name+' 昇進: '+rank(r))}}
function replaceDead(id){const r=rec(id);if(!r.kia)return;clearBrotherhood(id);roster[id]=newRecord(id);roster[id].active=false;operators[id]={...DEFAULTS[id]};saveOperators();saveRoster();renderRoster()}
function renderRoster(){validateBrotherhood();
 const selectedCount=roster.filter(r=>r.active&&!r.kia).length;
 const wrap=$('roster-list');
 wrap.innerHTML=roster.map(r=>{
  const o=operators[r.id],state=r.kia?'KIA':r.injury?'負傷 '+r.injury+'任務':'出撃可能';
  const partner=bondedPartner(r.id);const bondLabel=partner?`BROTHERHOOD: ${htmlEscape(operators[partner.id].name)} / Tier ${bondTier(r)} / ${r.bondXP} XP${sameHometown(r,partner)?' / ★ 同郷ボーナス':''}`:'BROTHERHOOD: 未設定';
  const bondControls=partner?`<button data-unbond="${r.id}">絆を解消</button>`:`<select data-bond="${r.id}"><option value="">絆相手を選択</option>${roster.filter(p=>p.id!==r.id&&!p.kia&&p.bondPartner===null).map(p=>`<option value="${p.id}">${htmlEscape(operators[p.id].name)}</option>`).join('')}</select>`;
  const next=r.level<5?`次の熟練段階まで ${Math.max(0,XP_LEVELS[r.level+1]-r.xp)} XP`:'最高熟練段階';
  const tree=CLASS_TREES[r.cls].map((tier,i)=>`<div class="talent-tier"><small>Tier ${i+1} / ${RANKS[i+1]}で解放</small><div class="skill-row">${tier.map(([k,name,description])=>`<button title="${description}" data-talent="${r.id}:${k}" ${canLearn(r,k)?'':'disabled'}>${r.skills.includes(k)?'✓ ':''}${name}<small>${description}</small></button>`).join('')}</div></div>`).join('');
  return `<article class="roster-item"><div class="roster-top"><strong>${htmlEscape(o.name)}</strong><span>${htmlEscape(CLASSES[r.cls][0])} · ${rank(r)} · ${ROLES[r.role]||ROLES.operator}</span></div><small>Lv ${r.level+1} / XP ${r.xp} / ${next} / 撃破 ${r.kills} / 出撃 ${r.missions} / ${state} / STRESS ${r.stress||0}/100 / 戦友喪失 ${r.trauma||0}</small><div class="roster-actions"><label><input type="checkbox" data-active="${r.id}" ${r.active?'checked':''} ${r.kia||r.injury?'disabled':''}> 出撃</label><select aria-label="兵科" data-class="${r.id}" ${r.kia||r.level>0?'disabled':''}>${Object.entries(CLASSES).map(([k,v])=>`<option value="${k}" ${r.cls===k?'selected':''}>${v[1]}</option>`).join('')}</select><button data-edit-roster="${r.id}">外見・武器</button><select aria-label="役職" data-role="${r.id}">${Object.entries(ROLES).map(([key,label])=>`<option value="${key}" ${r.role===key?'selected':''} ${roleEligible(r,key)?'':'disabled'}>${label}</option>`).join('')}</select>${r.branch==='enlisted'&&r.level>=3&&!r.kia?`<button data-commission="${r.id}">将校任官（O-1）</button>`:''}${r.kia?`<button data-recruit="${r.id}">補充</button>`:''}</div><div class="brotherhood-roster"><label>出身州 <select aria-label="出身州" data-hometown="${r.id}">${HOME_STATES.map(st=>`<option value="${st}" ${hometown(r)===st?'selected':''}>${st}</option>`).join('')}</select></label><strong>${bondLabel}</strong> ${bondControls}</div><div class="talent-tree"><strong>兵科別スキルツリー</strong>${tree}</div><small>未使用スキルポイント ${r.points} · 習得済み ${r.skills.map(k=>ALL_SKILLS[k]?.[0]||k).join('、')||'なし'}${r.level>0?' · 昇進後の兵科変更不可':''}</small></article>`;
 }).join('');
 $('roster-summary').textContent=`出撃指定 ${selectedCount}/4人 · 出撃可能 ${deployed().length}人 · 昇進時にスキルポイント獲得。各Tierは2択です。`;
 wrap.querySelectorAll('[data-active]').forEach(el=>el.onchange=()=>{const r=rec(Number(el.dataset.active));if(el.checked&&roster.filter(x=>x.active&&!x.kia).length>=4){el.checked=false;return toast('出撃は最大4名です')}r.active=el.checked;saveRoster();renderRoster()});
 wrap.querySelectorAll('[data-class]').forEach(el=>el.onchange=()=>{const r=rec(Number(el.dataset.class));if(r.level>0)return;r.cls=el.value;saveRoster();renderRoster()});
 wrap.querySelectorAll('[data-edit-roster]').forEach(el=>el.onclick=()=>{editing=Number(el.dataset.editRoster);closeRoster();openEditor(true)});
 wrap.querySelectorAll('[data-role]').forEach(el=>el.onchange=()=>{const r=rec(Number(el.dataset.role));if(!assignRole(r,el.value))toast('階級条件または役職の重複を確認してください');renderRoster()});
 wrap.querySelectorAll('[data-commission]').forEach(el=>el.onclick=()=>{const r=rec(Number(el.dataset.commission));if(r.branch!=='enlisted'||r.level<3||r.kia)return;if(!confirm('将校に任官しますか？ 下士官階級からO-1へ移行します。'))return;r.branch='officer';r.officerGrade=Math.min(3,Math.max(1,r.level-2));r.role='operator';saveRoster();renderRoster()});
 wrap.querySelectorAll('[data-talent]').forEach(el=>el.onclick=()=>{const [id,k]=el.dataset.talent.split(':'),r=rec(Number(id));if(!canLearn(r,k))return;r.skills.push(k);r.points--;saveRoster();renderRoster();toast(ALL_SKILLS[k][0]+' 習得')});
 wrap.querySelectorAll('[data-hometown]').forEach(el=>el.onchange=()=>{const r=rec(Number(el.dataset.hometown));if(HOME_STATES.includes(el.value)){r.homeState=el.value;saveRoster();renderRoster();sync();}});
 wrap.querySelectorAll('[data-bond]').forEach(el=>el.onchange=()=>{if(el.value==='')return;if(!setBrotherhood(Number(el.dataset.bond),Number(el.value)))toast('既存の絆または隊員状態を確認してください');renderRoster()});
 wrap.querySelectorAll('[data-unbond]').forEach(el=>el.onclick=()=>{clearBrotherhood(Number(el.dataset.unbond));renderRoster()});
 wrap.querySelectorAll('[data-recruit]').forEach(el=>el.onclick=()=>replaceDead(Number(el.dataset.recruit)));
}
function openRoster(){$('roster-overlay').classList.remove('hidden');renderRoster()}
function closeRoster(){$('roster-overlay').classList.add('hidden')}
$('roster').onclick=openRoster;$('roster-close').onclick=closeRoster;
$('roster-recover').onclick=advanceDay;
function loadOperators(){try{const saved=JSON.parse((localStorage.getItem(STORAGE)||localStorage.getItem(PREVIOUS_STORAGE)||localStorage.getItem(OLD_STORAGE)));if(!Array.isArray(saved))return clone(DEFAULTS);return DEFAULTS.map((d,i)=>{const v=saved.find(x=>x&&x.id===i)||{};const o={...d};o.name=typeof v.name==='string'&&v.name.trim()?v.name.trim().slice(0,14):d.name;for(const k of Object.keys(OPTIONS))if(OPTIONS[k].some(([key])=>key===v[k]))o[k]=v[k];if(WEAPONS[v.weapon]&&ownWeapon(v.weapon))o.weapon=v.weapon;for(const k of Object.keys(ATTACHMENTS))if(ATTACHMENTS[k].some(([key])=>key===v[k]))o[k]=v[k];return sanitizeLoadout(o)})}catch{return DEFAULTS.map(x=>({...x}))}}
function saveOperators(){try{localStorage.setItem(STORAGE,JSON.stringify(operators));return true}catch{toast('ブラウザの保存領域を利用できません');return false}}
function htmlEscape(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function applyOperator(u){if(u&&u.team==='friendly')u.name=operators[u.id].name}
function colorFor(o){return {desert:'#c7b08b',woodland:'#687b5d',olive:'#75836c',black:'#4b5457'}[o.uniform]}
function gearColor(o){return {tan:'#aa9673',olive:'#566a50',black:'#303b3e'}[o.vest]}
function skinColor(o){return {light:'#e3b995',medium:'#b98966',brown:'#8e5f47',dark:'#5b3d31'}[o.skin]}
function drawOperatorGlyph(c,x,y,r,o){c.save();c.translate(x,y);c.fillStyle=colorFor(o);c.strokeStyle='#1a292b';c.lineWidth=Math.max(1,r*.11);c.beginPath();c.ellipse(0,r*.42,r*.8,r*.7,0,0,Math.PI*2);c.fill();c.stroke();c.fillStyle=gearColor(o);c.fillRect(-r*.5,r*.2,r,r*.52);c.fillStyle=skinColor(o);c.beginPath();c.arc(0,-r*.13,r*.55,0,Math.PI*2);c.fill();c.stroke();if(o.facegear==='mask'){c.fillStyle='#303b3b';c.fillRect(-r*.43,-r*.12,r*.86,r*.33)}if(o.facegear==='goggles'){c.fillStyle='#263b42';c.fillRect(-r*.48,-r*.36,r*.96,r*.22);c.strokeRect(-r*.48,-r*.36,r*.96,r*.22)}if(o.headgear==='helmet'){c.fillStyle=colorFor(o);c.beginPath();c.arc(0,-r*.35,r*.65,Math.PI,Math.PI*2);c.fill();c.stroke()}else if(o.headgear==='cap'){c.fillStyle=colorFor(o);c.fillRect(-r*.58,-r*.68,r*1.16,r*.23);c.fillRect(-r*.72,-r*.47,r*1.05,r*.12)}else if(o.headgear==='boonie'){c.fillStyle=colorFor(o);c.fillRect(-r*.83,-r*.53,r*1.66,r*.18);c.fillRect(-r*.5,-r*.8,r,r*.3)}c.restore()}
function drawWeapon(c,x,y,scale,o){const w=WEAPONS[o.weapon]||WEAPONS.m4a1;c.save();c.translate(x,y);c.scale(scale,scale);c.fillStyle='#1b2324';const len=w.shape==='long'?95:w.shape==='short'?58:76;c.fillRect(-18,-4,len,9);c.fillRect(2,5,14,22);c.fillRect(-32,-2,18,6);c.fillStyle=o.handguard==='freefloat'?'#7b837c':'#343f3f';c.fillRect(-15,-7,len*.63,3);c.fillStyle='#1b2324';if(o.optic!=='iron'){const big=['acog','lpvo','scope'].includes(o.optic);c.fillRect(1,big?-20:-17,big?31:19,big?11:9);c.fillStyle='#8ac3b9';c.fillRect(10,-15,9,5)}else c.fillRect(5,-11,3,6);if(o.grip!=='standard')c.fillRect(35,5,7,o.grip==='bipod'?27:21);if(o.muzzle==='suppressor'&&!w.integral_suppressor)c.fillRect(len-18,-7,35,14);else if(o.muzzle==='brake'||o.muzzle==='compensator')c.fillRect(len-16,-6,20,12);if(w.integral_suppressor)c.fillRect(len-25,-8,28,16);if(o.laser!=='none'){c.fillStyle='#4a625a';c.fillRect(34,-12,23,4)}if(o.light!=='none'){c.fillStyle='#d1c48a';c.fillRect(48,7,15,7)}if(o.stock==='precision'){c.fillStyle='#4b5553';c.fillRect(-39,-8,9,16)}if(canUseM203(o)){c.fillStyle='#4b5451';c.fillRect(19,10,49,7);c.fillRect(17,10,9,13)}if(o.magazine==='stanag20'){c.fillStyle='#414c4b';c.fillRect(2,8,14,16)}c.restore()}
function preview(){const c=$('preview'),p=c.getContext('2d'),o=operators[editing];p.clearRect(0,0,c.width,c.height);p.fillStyle='#26352f';p.fillRect(0,0,c.width,c.height);p.strokeStyle='#647c7255';for(let i=0;i<c.width;i+=28){p.beginPath();p.moveTo(i,0);p.lineTo(i,c.height);p.stroke()}for(let i=0;i<c.height;i+=28){p.beginPath();p.moveTo(0,i);p.lineTo(c.width,i);p.stroke()}p.fillStyle=colorFor(o);p.strokeStyle='#1c2727';p.lineWidth=5;p.fillRect(99,132,82,95);p.strokeRect(99,132,82,95);p.fillStyle=gearColor(o);p.fillRect(108,143,64,69);p.fillStyle=colorFor(o);p.fillRect(67,147,31,75);p.fillRect(182,147,31,75);p.fillRect(105,227,30,49);p.fillRect(146,227,30,49);p.fillStyle=skinColor(o);p.beginPath();p.arc(140,99,40,0,Math.PI*2);p.fill();drawOperatorGlyph(p,140,105,57,o);drawWeapon(p,143,175,.83,o);p.fillStyle='#dce8d8';p.font='bold 16px system-ui';p.textAlign='center';p.fillText(o.name,140,24);p.font='12px system-ui';p.fillText(WEAPONS[o.weapon].name+' · '+weaponSpec(o).noise+' NOISE',140,282)}
function fillEditor(){sanitizeLoadout(operators[editing]);refreshWeaponOptions();const o=operators[editing];$('edit-unit').value=String(editing);$('edit-name').value=o.name;for(const key of Object.keys(OPTIONS))$('edit-'+key).value=o[key];$('edit-weapon').value=o.weapon;refreshAttachmentOptions();for(const key of Object.keys(ATTACHMENTS))$('edit-'+key).value=o[key];updateWeaponStats();preview()}
function updateWeaponStats(){const o=operators[editing],w=weaponSpec(o);$('weapon-stats').textContent=`${w.name}  |  DMG ${w.damage}  |  RANGE ${w.range}  |  ACC ${w.accuracy>=0?'+':''}${w.accuracy}  |  MAG ${w.mag}  |  NOISE ${w.noise}${canUseM203(o)?'  |  M203 40mm x3':''}`}
function openEditor(fromRoster=false){if(!fromRoster&&(phase!=='friendly'||gameover))return toast('隊員編集は味方ターン中のみ可能');if(!fromRoster)editing=selected;editorSnapshot=clone(operators);fillEditor();$('editor-overlay').classList.remove('hidden')}
function closeEditor(commit=false){if(!commit&&editorSnapshot)operators=editorSnapshot;editorSnapshot=null;$('editor-overlay').classList.add('hidden')}
for(const key of Object.keys(OPTIONS)){$('edit-'+key).innerHTML=OPTIONS[key].map(([v,label])=>`<option value="${v}">${label}</option>`).join('');$('edit-'+key).addEventListener('change',()=>{operators[editing][key]=$('edit-'+key).value;preview()})}
function refreshAttachmentOptions(){const o=operators[editing];for(const key of ['magazine','underbarrel']){const el=$('edit-'+key);el.innerHTML=ATTACHMENTS[key].filter(([v])=>compatibleAttachment(o,key,v)).map(([v,label])=>`<option value="${v}">${label}</option>`).join('');el.value=o[key];}}
function refreshWeaponOptions(){$('edit-weapon').innerHTML=Object.entries(WEAPONS).filter(([k])=>ownWeapon(k)).map(([k,w])=>`<option value="${k}">${w.name}</option>`).join('')}refreshWeaponOptions();$('edit-weapon').onchange=()=>{operators[editing].weapon=$('edit-weapon').value;sanitizeLoadout(operators[editing]);refreshAttachmentOptions();updateWeaponStats();preview()};for(const key of Object.keys(ATTACHMENTS)){$('edit-'+key).innerHTML=ATTACHMENTS[key].map(([v,label])=>`<option value="${v}">${label}</option>`).join('');$('edit-'+key).onchange=()=>{operators[editing][key]=$('edit-'+key).value;sanitizeLoadout(operators[editing]);updateWeaponStats();preview()}}
$('edit-unit').innerHTML=DEFAULTS.map((o,i)=>`<option value="${i}">${htmlEscape(o.name)}</option>`).join('');$('edit-unit').onchange=()=>{editing=Number($('edit-unit').value);fillEditor()};$('edit-name').oninput=()=>{operators[editing].name=$('edit-name').value.slice(0,14);preview()};$('customize').onclick=openEditor;$('editor-close').onclick=()=>closeEditor(false);
$('edit-save').onclick=()=>{const o=operators[editing];o.name=o.name.trim()||DEFAULTS[editing].name;applyOperator(units.find(u=>u.id===editing));const editedUnit=units.find(u=>u.team==='friendly'&&u.id===editing);if(editedUnit){editedUnit.ammo=Math.min(editedUnit.ammo,weaponSpec(o).mag)}saveOperators();if(editedUnit)selected=editing;closeEditor(true);log(`${o.name} の外見設定を更新`);sync();draw();toast('隊員設定を保存しました')};
$('edit-reset').onclick=()=>{operators[editing]={...DEFAULTS[editing]};fillEditor();toast('初期値に戻しました。保存で確定します')};

function start(){commandUsedTurn=0;bondActionUsedTurn=0;cancelWalk();effects=[];missionEpoch++;if(enemyTurnTimer!==null){clearTimeout(enemyTurnTimer);enemyTurnTimer=null;}missionRegion=strategy.selected;missionType=MISSION_TYPES[campaign.sequence%MISSION_TYPES.length];missionLimit=missionType==='eliminate'?14:missionType==='rescue'?18:12;objectiveTile=missionType==='secure'?{x:8,y:8}:{x:1,y:8};const region=strategy.regions.find(r=>r.id===missionRegion);const squad=deployed();if(!squad.length){openRoster();toast('出撃可能な隊員を選択してください');return}if(missionType==='rescue'&&squad.length<2){openRoster();toast('救出任務には出撃可能な隊員が2名以上必要です');return}drops=[];collected=[];rescueUsed=new Set();evacuated=new Set();evacRescues=0;rescueObjectiveId=null;rallyUsedTurn=0;squadCoverUsedTurn=0;casCharges=2;casPending=null;casUsed=0;qrfCharges=1;qrfPending=null;qrfUsed=0;qrfArrived=0;units=squad.map((r,i)=>({id:r.id,name:operators[r.id].name,team:'friendly',x:1+(i%2),y:2+Math.floor(i/2)*2,hp:maxHP(r.id),maxhp:maxHP(r.id),ap:2,ammo:weaponSpec(operators[r.id]).mag,grenades:canUseM203(operators[r.id])?3:0,atAmmo:{rpg:AT_LAUNCHERS.rpg.rounds,javelin:AT_LAUNCHERS.javelin.rounds},overwatch:false,kills:0}));const spots=[[11,1],[12,3],[11,6],[12,8],[10,1],[12,5],[10,8],[9,1]];const enemyCount=Math.min(8,Math.max(2,2+region.threat-(region.intel>=3?1:0)));spots.slice(0,enemyCount).forEach(([x,y],i)=>units.push({id:i+8,name:'HOSTILE '+(i+1),team:'enemy',weapon:enemyWeaponFor(i),x,y,hp:4,maxhp:4,ap:2,ammo:ENEMY_LOADOUTS[i%ENEMY_LOADOUTS.length].ammo,overwatch:false,kills:0}));
 const vehicleSpots=[[8,7],[8,4]];
 vehicleRoster(region).forEach((type,i)=>{const spec=VEHICLE_TYPES[type],pos=vehicleSpots[i];if(!occupied(pos[0],pos[1])&&!units.some(u=>u.x===pos[0]&&u.y===pos[1]))units.push({id:100+i,name:spec.name,team:'enemy',vehicle:type,armor:spec.armor,x:pos[0],y:pos[1],hp:spec.hp,maxhp:spec.hp,ap:0,ammo:99,overwatch:false,kills:0})});if(missionType==='rescue'){
 // An isolated wounded operator is an existing roster member, never a disposable NPC.
 const patient=units.find(u=>u.team==='friendly'&&u.id===squad[squad.length-1].id);
 if(patient){patient.x=7;patient.y=7;patient.hp=0;patient.ap=0;patient.downed=true;patient.bleed=6;patient.stabilized=false;patient.carriedBy=null;rescueObjectiveId=patient.id;}
 }
 selected=squad[0].id;if(missionType==='rescue'&&selected===rescueObjectiveId){const able=units.find(u=>u.team==='friendly'&&u.hp>0);if(able)selected=able.id;}missionCommitted=false;$('result-overlay').classList.add('hidden');$('status').textContent='OPERATION ACTIVE';mode='move';atMode='rpg';turn=1;phase='friendly';gameover=false;logs=[];$('mission-name').textContent='OPERATION '+region.id.toUpperCase();$('objective').textContent=region.name+'：'+MISSION_LABELS[missionType]+'（制限'+missionLimit+'ターン）';log(region.name+' への作戦開始');log('目標：'+MISSION_LABELS[missionType]);sync();draw();}
function log(s){logs.unshift(`[T${turn}] ${s}`);logs=logs.slice(0,30);$('log').innerHTML=logs.map(x=>`<div>${htmlEscape(x)}</div>`).join('');}
function unitAt(x,y){return units.find(u=>u.hp>0&&u.x===x&&u.y===y)}
function distance(a,b){return Math.abs(a.x-b.x)+Math.abs(a.y-b.y)}
function line(a,b){let x=a.x,y=a.y,dx=Math.abs(b.x-x),dy=Math.abs(b.y-y),sx=x<b.x?1:-1,sy=y<b.y?1:-1,err=dx-dy;while(x!==b.x||y!==b.y){let e2=2*err;if(e2>-dy){err-=dy;x+=sx}if(e2<dx){err+=dx;y+=sy}if((x!==b.x||y!==b.y)&&occupied(x,y))return false;}return true}
function cover(u,from){const dx=Math.sign(from.x-u.x),dy=Math.sign(from.y-u.y);const keys=[`${u.x+dx},${u.y}`,`${u.x},${u.y+dy}`];if(keys.some(k=>walls.has(k)))return 35;if(keys.some(k=>crates.has(k)))return 20;return 0}
function chance(a,b){const w=a.team==='friendly'?currentWeapon(a):{range:8,accuracy:0};const dist=distance(a,b);return Math.max(5,Math.min(95,83-dist*5-cover(b,a)+(w.accuracy||0)+(a.team==='friendly'&&rec(a.id).skills.includes('steady')?8:0)+(a.team==='friendly'&&hasSkill(a.id,'aim')?10:0)+(a.team==='friendly'&&hasSkill(a.id,'precision')?8:0)+(a.team==='friendly'&&hasSkill(a.id,'assist')?6:0)+(a.team==='friendly'&&hasSkill(a.id,'technical')?6:0)+(a.team==='friendly'&&hasSkill(a.id,'breach')&&dist<=3?12:0)+(a.team==='friendly'?brotherhoodAccuracy(a)-combatStress(a):0)-Math.max(0,dist-(w.range+(a.team==='friendly'&&rec(a.id).skills.some(k=>['scout','range','spotter'].includes(k))?2:0)))*12))}
function path(a,b){if(b.x<0||b.x>=W||b.y<0||b.y>=H||occupied(b.x,b.y)||unitAt(b.x,b.y))return null;const q=[[a.x,a.y]],seen=new Map([[`${a.x},${a.y}`,null]]);for(let i=0;i<q.length;i++){const [x,y]=q[i];if(x===b.x&&y===b.y)break;for(const [nx,ny] of [[x+1,y],[x-1,y],[x,y+1],[x,y-1]]){let k=`${nx},${ny}`;if(nx<0||ny<0||nx>=W||ny>=H||seen.has(k)||occupied(nx,ny)||unitAt(nx,ny))continue;seen.set(k,`${x},${y}`);q.push([nx,ny]);}}let k=`${b.x},${b.y}`;if(!seen.has(k))return null;let p=[];while(seen.get(k)!==null){let [x,y]=k.split(',').map(Number);p.unshift({x,y});k=seen.get(k)}return p;}
function selectedUnit(){return units.find(u=>u.team==='friendly'&&u.id===selected)}
function movementBudget(u){return (u.carrying!==undefined&&u.carrying!==null?Math.min(u.ap,1):u.ap)*(rec(u.id).skills.some(k=>['rapid','sprint','quickstep','lightfoot'].includes(k))?6:4)}
function tileHint(u,x,y){const t=unitAt(x,y);if(mode==='cas')return `CAS ${supportCAS().name} / 半径${supportCAS().radius}マス / 味方被害あり / 残${casCharges}回`;if(mode==='at'&&t&&t.team==='enemy'){const spec=AT_LAUNCHERS[atMode];return t.vehicle?`対装甲 ${spec.name} / 命中 ${antiArmorChance(u,t,spec)}% / 推定ダメージ ${antiArmorDamage(spec,t)} / 残弾 ${u.atAmmo?.[atMode]||0}`:'対戦車兵器は車両のみ対象';}if(mode==='fire'&&t&&t.team==='enemy'){const range=currentWeapon(u).range+(rec(u.id).skills.some(k=>['scout','range','spotter'].includes(k))?2:0);if(distance(u,t)>range)return '射程外';if(!line(u,t))return '射線遮断';return `命中 ${Math.round(chance(u,t))}% / 遮蔽 ${cover(t,u)}% / HP ${t.hp}${t.vehicle?' / 装甲 '+t.armor:''}`;}if(mode==='move'&&!t){const d=drops.find(d=>d.x===x&&d.y===y);if(d&&distance(u,d)<=1)return `${WEAPONS[d.weapon].name} 回収可（回収ボタン）`;const p=path(u,{x,y});if(!p)return '移動不可';const stride=u.carrying!==undefined&&u.carrying!==null?2:rec(u.id).skills.some(k=>['rapid','sprint','quickstep','lightfoot'].includes(k))?6:4;return p.length<=movementBudget(u)?`移動 ${p.length}マス / AP ${Math.ceil(p.length/stride)}`:`移動範囲外（${p.length}マス）`;}return ''}
function updateTacticalHud(){const u=selectedUnit(),hud=$('battle-hud');if(!hud)return;if(moving){hud.textContent='移動中…';return;}if(!u||gameover){hud.textContent=gameover?'作戦終了':'隊員を選択';return;}const target=hover&&hover.x>=0&&hover.x<W&&hover.y>=0&&hover.y<H?tileHint(u,hover.x,hover.y):'';hud.textContent=`${mode==='fire'?'FIRE':mode==='cas'?'CAS':mode==='at'?'AT':'MOVE'} · ${u.name} · AP ${u.ap} · ${target||'マスをタップして行動'}`;}
function action(x,y){if(gameover||phase!=='friendly'||moving)return;const u=selectedUnit();if(!u||u.hp<=0)return;const other=unitAt(x,y);if(other&&other.team==='friendly'){selected=other.id;sync();draw();return;}if(mode==='cas'){callCAS(x,y);return;}if(mode==='m203'){fireM203(u,x,y);return;}if(mode==='move'){if(u.ap<1)return toast('行動ポイントがありません');const p=path(u,{x,y});if(!p||p.length===0)return toast('移動できない場所です');if(p.length>movementBudget(u))return toast('移動可能範囲外です');const steps=p;if(steps.length===0)return;animateWalk(u,steps);return;}else if(mode==='fire'){if(!other||other.team!=='enemy')return toast('敵ユニットを選択してください');if(u.ap<1||u.ammo<1)return toast('APまたは弾薬が不足');shoot(u,other);}else if(mode==='at'){if(!other||other.team!=='enemy'||!other.vehicle)return toast('対装甲兵器は敵車両を選択してください');fireAntiArmor(u,other);}else if(mode==='overwatch'){setOverwatch();return;}checkEnd();sync();draw();}
function fireM203(u,x,y){
 const o=operators[u.id];if(!canUseM203(o))return toast('この小銃にはM203が装着されていません');
 if(u.ap<2||u.grenades<1)return toast('M203はAP2と40mm弾1発が必要です');
 if(distance(u,{x,y})>7||distance(u,{x,y})<2)return toast('M203のゲーム内有効範囲は2〜7マスです');
 if(!line(u,{x,y}))return toast('射線が遮られています');
 u.ap-=2;u.grenades--;effect('shot',u,{x,y},true);
 let hits=0;for(const target of units.filter(v=>v.hp>0&&distance(v,{x,y})<=1)){
  const damage=target.vehicle?Math.max(0,5-target.armor):5;
  target.hp=Math.max(0,target.hp-damage);hits++;
  if(target.hp===0){if(target.team==='enemy'){spawnDrop(target);if(u.team==='friendly')u.kills++;}log(`${target.name} が40mm榴弾で戦闘不能`);}
 }
 log(`${u.name} M203発射：(${x+1},${y+1}) / 範囲内${hits}目標`);
 checkEnd();sync();draw();return true;
}
function shoot(a,b){if(distance(a,b)>currentWeapon(a).range+(rec(a.id).skills.some(k=>['scout','range','spotter'].includes(k))?2:0))return toast('武器の有効射程外です');if(!line(a,b))return toast('射線が遮られています');a.ap--;a.ammo--;const hit=Math.random()*100<chance(a,b);effect('shot',a,b,hit);if(hit){const damage=vehicleDamage(currentWeapon(a).damage+(rec(a.id).skills.some(k=>['focus','critical'].includes(k))?1:0),b);b.hp-=damage;if(b.vehicle&&damage===0)log(`${b.name}：小銃弾を装甲が防御`);if(b.hp<=0){b.hp=0;a.kills++;spawnDrop(b);log(`${a.name} → ${b.name} 排除`);}else log(`${a.name} → ${b.name} 命中 (HP ${b.hp})`);}else log(`${a.name} → ${b.name} 射撃失敗`);toast(`${Math.round(chance(a,b))}% 命中率 / ${hit?'命中':'外れ'}`);}
function fireAntiArmor(a,b){
 const spec=AT_LAUNCHERS[atMode];
 if(gameover||moving||phase!=='friendly'||!a||a.hp<=0||!b.vehicle||b.hp<=0)return;
 if(a.ap<2)return toast('対装甲兵器の使用にはAP2が必要です');
 if((a.atAmmo?.[atMode]||0)<1)return toast(`${spec.name}の弾薬がありません`);
 if(distance(a,b)>spec.range)return toast(`${spec.name}の射程外です`);
 if(!line(a,b))return toast('射線が遮られています');
 a.ap-=2;a.atAmmo[atMode]--;
 const probability=antiArmorChance(a,b,spec),hit=Math.random()*100<probability;
 effect('shot',a,b,hit);
 if(hit){const damage=antiArmorDamage(spec,b);b.hp=Math.max(0,b.hp-damage);log(`${a.name} が ${spec.name} で ${b.name} を攻撃 / ${damage}ダメージ`);if(b.hp===0){a.kills++;log(`${b.name} 撃破`);}}
 else log(`${a.name} の ${spec.name} が ${b.name} に命中せず`);
 toast(`${spec.name} / 命中率 ${probability}% / ${hit?'命中':'外れ'}`);
 checkEnd();sync();draw();
}
function setOverwatch(){if(moving)return;const u=selectedUnit();if(!u||u.ap<1||u.ammo<1||phase!=='friendly')return toast('警戒できません');u.ap=0;u.overwatch=true;log(`${u.name} 警戒射撃を設定`);toast('敵の移動に反応します');sync();draw();}
function reload(){if(moving)return;const u=selectedUnit();if(!u||u.ap<1||phase!=='friendly')return toast('装填できません');u.ammo=currentWeapon(u).mag;u.ap--;log(`${u.name} 弾倉交換`);sync();draw();}
function downedAllies(){return units.filter(u=>u.team==='friendly'&&u.downed&&!u.evacuated&&!u.kiaConfirmed)}
function registerCasualties(){for(const u of units.filter(u=>u.team==='friendly'&&u.hp<=0&&!u.downed&&!u.evacuated&&!u.kiaConfirmed)){u.downed=true;u.bleed=3;u.stabilized=false;u.carriedBy=null;u.ap=0;u.overwatch=false;log(`${u.name} 重傷・戦闘不能：救助が必要（残り${u.bleed}ターン）`);}}
function casualtyTick(){for(const u of downedAllies()){if(u.stabilized||u.carriedBy!==null)continue;u.bleed--;if(u.bleed<=0){u.kiaConfirmed=true;u.downed=false;log(`${u.name} は救助が間に合わず戦死`);}}}
function dropCarriedCasualties(){for(const carrier of units.filter(u=>u.team==='friendly'&&u.hp<=0&&u.carrying!==undefined&&u.carrying!==null)){const patient=units.find(u=>u.id===carrier.carrying&&u.team==='friendly'&&u.downed);if(patient){patient.carriedBy=null;patient.x=carrier.x;patient.y=carrier.y;log(`${carrier.name} が戦闘不能：${patient.name} の搬送が中断`);}carrier.carrying=null;}}
function rescueMissionComplete(){return missionType==='rescue'&&rescueObjectiveId!==null&&evacuated.has(rescueObjectiveId)&&units.some(u=>u.team==='friendly'&&u.hp>0)}
function rescueTarget(actor){return downedAllies().filter(u=>u.carriedBy===null&&distance(actor,u)<=1).sort((a,b)=>a.bleed-b.bleed)[0]||null}
function stabilizeCasualty(){if(gameover||moving||phase!=='friendly')return toast('味方ターンのみ救命可能');const actor=selectedUnit();if(!actor||actor.hp<=0||actor.ap<1)return toast('救命にはAP1が必要');const target=rescueTarget(actor);if(!target)return toast('隣接する戦闘不能の隊員がいません');if(target.stabilized)return toast('すでに止血済みです。搬送してください');actor.ap--;target.stabilized=true;const p=bondedPartner(actor.id);if(p&&p.id===target.id){const r=rec(actor.id);r.stress=Math.max(0,r.stress-8);}log(`${actor.name} が ${target.name} を止血：出血カウント停止`);sync();draw();return true;}
function carryCasualty(){if(gameover||moving||phase!=='friendly')return toast('味方ターンのみ搬送可能');const actor=selectedUnit();if(!actor||actor.hp<=0||actor.ap<1)return toast('搬送にはAP1が必要');if(actor.carrying!==undefined&&actor.carrying!==null)return toast('すでに負傷者を搬送中');const target=rescueTarget(actor);if(!target)return toast('隣接する戦闘不能の隊員がいません');if(!target.stabilized)return toast('先に止血してください');actor.ap--;actor.carrying=target.id;target.carriedBy=actor.id;target.x=actor.x;target.y=actor.y;log(`${actor.name} が ${target.name} の搬送を開始`);sync();draw();return true;}
function evacuateCasualty(){if(gameover||moving||phase!=='friendly')return toast('味方ターンのみ後送可能');const actor=selectedUnit();if(!actor||actor.hp<=0||actor.ap<1)return toast('後送にはAP1が必要');const target=units.find(u=>u.id===actor.carrying&&u.team==='friendly'&&u.downed);if(!target)return toast('搬送中の負傷者がいません');if(distance(actor,EVAC)>1)return toast('左下のEVAC地点（1,8）へ移動してください');actor.ap--;target.evacuated=true;target.downed=false;target.carriedBy=null;actor.carrying=null;evacuated.add(target.id);evacRescues++;const a=rec(actor.id),b=rec(target.id);if(a.bondPartner===b.id&&b.bondPartner===a.id){const gain=2+(sameHometown(a,b)?1:0);a.bondXP=Math.min(999,a.bondXP+gain);b.bondXP=a.bondXP;log(`BROTHERHOOD 救出成功：絆XP+${gain}`);}log(`${actor.name} が ${target.name} を安全地帯へ後送`);sync();draw();return true;}
function checkEnd(){if(gameover)return;registerCasualties();dropCarriedCasualties();const friends=units.filter(u=>u.team==='friendly'&&u.hp>0),enemies=units.filter(u=>u.team==='enemy'&&u.hp>0);if(!friends.length)return finish(false);if(missionType==='rescue'){if(rescueMissionComplete())return finish(true);if(units.some(u=>u.id===rescueObjectiveId&&u.kiaConfirmed))return finish(false);}if(missionType==='eliminate'&&!enemies.length)return finish(true);if(missionType==='secure'&&friends.some(u=>u.x===objectiveTile.x&&u.y===objectiveTile.y))return finish(true);if(missionType==='extract'&&enemies.length<=2&&friends.some(u=>u.x===objectiveTile.x&&u.y===objectiveTile.y))return finish(true);if(turn>missionLimit)return finish(false);}
function finish(win){if(missionCommitted)return;registerCasualties();cancelWalk();missionCommitted=true;missionEpoch++;if(enemyTurnTimer!==null){clearTimeout(enemyTurnTimer);enemyTurnTimer=null;}gameover=true;phase='complete';const recovered=collected.filter(item=>units.some(u=>u.id===item.by&&u.team==='friendly'&&u.hp>0));for(const item of recovered){armory.counts[item.weapon]=Math.min(999,(armory.counts[item.weapon]||0)+1);armory.ammo=Math.min(9999,armory.ammo+(item.ammo||0));armory.history.push({weapon:item.weapon,ammo:item.ammo||0,day:strategy.day,region:missionRegion})}normalizeArmory();armory.history=armory.history.slice(-40);saveArmory();bondMissionProgress();applyBrotherhoodTrauma();for(const u of units.filter(x=>x.team==='friendly')){const r=rec(u.id);r.missions++;r.kills+=u.kills;if(u.hp<=0){if(u.evacuated||(u.downed&&u.stabilized&&u.carriedBy!==null&&units.some(c=>c.id===u.carriedBy&&c.hp>0))){r.injury=Math.max(r.injury,5);r.active=false;xpGain(r,5)}else{r.kia=true;r.active=false;clearBrotherhood(r.id)}}else{xpGain(r,(win?18:7)+u.kills*12);if(u.hp<u.maxhp){r.injury=Math.max(1,Math.ceil((u.maxhp-u.hp)/3)-(r.skills.some(k=>['field','triage'].includes(k))?1:0));if(r.injury)r.active=false}}}const region=strategy.regions.find(r=>r.id===missionRegion);strategy.missions++;if(win){strategy.wins++;region.wins++;region.security=Math.min(100,region.security+8+strategy.facilities.intel*2);region.threat=Math.max(1,region.threat-1);strategy.funds+=120+strategy.facilities.armory*30;}else{region.security=Math.max(0,region.security-5);region.threat=Math.min(5,region.threat+1);strategy.funds+=20;}strategy.day++;campaign.sequence++;campaign.history.push({region:region.name,type:missionType,win,turn,day:strategy.day});campaign.history=campaign.history.slice(-30);if(strategy.regions.every(r=>r.security>=70))campaign.completed=true;saveStrategy();saveRoster();saveCampaign();$('status').textContent=win?'MISSION SUCCESS':'MISSION FAILED';lastResult={win,region:region.name,type:missionType,turn,survivors:units.filter(u=>u.team==='friendly'&&u.hp>0).length,roster:units.filter(u=>u.team==='friendly').length,funds:strategy.funds,completed:campaign.completed,qrfUsed,qrfArrived,evacRescues,downed:units.filter(u=>u.team==='friendly'&&u.hp<=0&&!u.evacuated&&!u.kiaConfirmed).length,recovered:recovered.map(i=>`${WEAPONS[i.weapon].name}（弾薬${i.ammo||0}）`),casUsed};renderResult();}
function endTurn(){if(gameover||phase!=='friendly'||moving)return;phase='enemy';sync();toast('敵ターン');const scheduledEpoch=missionEpoch;enemyTurnTimer=setTimeout(()=>{enemyTurnTimer=null;if(scheduledEpoch!==missionEpoch||gameover||phase!=='enemy')return;for(const e of units.filter(u=>u.team==='enemy'&&u.hp>0)){if(gameover)break;const fs=units.filter(u=>u.team==='friendly'&&u.hp>0).sort((a,b)=>(distance(e,a)*2+a.hp*.3+cover(a,e)*.04)-(distance(e,b)*2+b.hp*.3+cover(b,e)*.04));if(!fs.length)break;let t=fs[0];if(e.vehicle&&!(distance(e,t)<=VEHICLE_TYPES[e.vehicle].range&&line(e,t))){moveEnemyVehicle(e,t);if(e.hp<=0){checkEnd();continue;}}if(distance(e,t)<=(e.vehicle?VEHICLE_TYPES[e.vehicle].range:7)&&line(e,t)){const p=chance(e,t)-10+(e.vehicle?VEHICLE_TYPES[e.vehicle].accuracy:0),hit=Math.random()*100<p;effect('shot',e,t,hit);if(hit){t.hp=Math.max(0,t.hp-Math.max(1,(e.vehicle?VEHICLE_TYPES[e.vehicle].damage:2)-brotherhoodDefense(t)-(hometownRescueBonus(t)?1:0)-(t.coveredUntil===turn?1:0)));log(`${e.name} → ${t.name} 命中${e.vehicle?'（車載火器）':''}`);}else log(`${e.name} が射撃 (外れ)`);}else if(!e.vehicle){const candidates=[[e.x+1,e.y],[e.x-1,e.y],[e.x,e.y+1],[e.x,e.y-1]].filter(([x,y])=>x>=0&&x<W&&y>=0&&y<H&&!occupied(x,y)&&!unitAt(x,y)).sort((a,b)=>{const score=([x,y])=>Math.abs(x-t.x)+Math.abs(y-t.y)-cover({x,y},t)*.035;return score(a)-score(b)});if(candidates.length){[e.x,e.y]=candidates[0];log(`${e.name} が前進`);for(const f of units.filter(u=>u.team==='friendly'&&u.hp>0&&u.overwatch&&u.ammo>0)){if(line(f,e)&&distance(f,e)<=currentWeapon(f).range+(rec(f.id).skills.some(k=>['scout','range','spotter'].includes(k))?2:0)){f.overwatch=false;shootOverwatch(f,e);if(e.hp<=0)break;}}}}checkEnd();}if(!gameover){turn++;phase='friendly';casualtyTick();checkEnd();if(gameover){sync();draw();return;}if(casPending&&turn>=casPending.arrival){resolveCAS();checkEnd();}if(qrfPending&&turn>=qrfPending.arrival&&!gameover){resolveQRF();checkEnd();}checkEnd();units.filter(u=>u.team==='friendly'&&u.hp>0).forEach(u=>{u.ap=u.qrfArrivalTurn===turn?0:2;u.overwatch=false});if(!gameover){log('味方ターン開始');toast('YOUR TURN');checkEnd();}}sync();draw();},400);}
function shootOverwatch(a,b){if(a.hp<=0||b.hp<=0||gameover)return;a.ammo--;let hit=Math.random()*100<chance(a,b)-10+(hasSkill(a.id,'steadyhand')?10:0)+(hasSkill(a.id,'suppress')?10:0)+(hasSkill(a.id,'ambush')?10:0);effect('shot',a,b,hit);if(hit){b.hp=Math.max(0,b.hp-vehicleDamage(currentWeapon(a).damage+(rec(a.id).skills.some(k=>['focus','critical'].includes(k))?1:0),b));if(!b.hp){a.kills++;spawnDrop(b);}}log(`${a.name} 警戒射撃 ${hit?'命中':'外れ'}`);}
function toast(s){$('toast').textContent=s;const hud=$('battle-hud');if(hud)hud.textContent=String(s).slice(0,72);}
function sync(){let u=selectedUnit();if(!u||u.hp<=0){u=units.find(x=>x.team==='friendly'&&x.hp>0)||units.find(x=>x.team==='friendly');if(u)selected=u.id}$('turn').textContent=`${String(turn).padStart(2,'0')} / ${phase.toUpperCase()}`;$('hostiles').textContent=String(units.filter(u=>u.team==='enemy'&&u.hp>0).length).padStart(2,'0');$('casualty-status').textContent=`重傷 ${downedAllies().length}名 / 後送 ${evacRescues}名 / EVAC 左下(1,8)${missionType==='rescue'?' / 救出対象 '+(evacuated.has(rescueObjectiveId)?'後送済み':'未後送'):''}`;$('bond-field').textContent=fieldBondSummary().filter(b=>b.deployed).map(b=>`${b.names} / Tier ${b.tier}${b.sameHome?' / 同郷':''} / ${b.alive?b.distance+'マス':'戦闘不能'}`).join(' ｜ ')||'出撃中の戦友ペアなし';$('squad').innerHTML=units.filter(x=>x.team==='friendly').map(x=>`<button class="soldier ${selected===x.id?'selected':''}" data-id="${x.id}" ${x.hp<=0?'disabled':''}><span><span class="name">${bondedPartner(x.id)?'🤝 ':''}${htmlEscape(x.name)}</span><small>${x.hp>0?`AP ${x.ap}/2 · AMMO ${x.ammo}${x.carrying!==undefined&&x.carrying!==null?' · 搬送中':''}`:x.evacuated?'EVACUATED':x.downed?`DOWN / ${x.stabilized?'止血済み':x.bleed+'T'}`:'KIA'}</small></span><span class="hp">${x.hp}/${x.maxhp} HP</span></button>`).join('');$('operator').innerHTML=u?`<b>${htmlEscape(u.name)}</b> / ${CLASSES[rec(u.id).cls][0]}<br>HEALTH ${u.hp}/${u.maxhp}　AP ${u.ap}/2<br>${CLASSES[rec(u.id).cls][0]} · ${rank(rec(u.id))} · ${ROLES[rec(u.id).role]||ROLES.operator} · 出身 ${hometown(rec(u.id))}<br>${WEAPONS[operators[u.id].weapon].name} · ${u.ammo}/${currentWeapon(u).mag}　KILLS ${u.kills}<br>M203 ${u.grenades||0}発 · AT RPG ${u.atAmmo?.rpg||0} / JAVELIN ${u.atAmmo?.javelin||0}${u.overwatch?'<br>OVERWATCH ACTIVE':''}${u.coveredUntil===turn?'<br>FIRE TEAM COVER ACTIVE':''}<br>BROTHERHOOD: ${bondedPartner(u.id)?htmlEscape(operators[bondedPartner(u.id).id].name)+' / Tier '+bondTier(rec(u.id)):'未設定'}${bondNearby(u,4)?' / 連携範囲内':''}${bondedPartner(u.id)&&sameHometown(rec(u.id),bondedPartner(u.id))?' / ★ 同郷':''}<br>STRESS ${rec(u.id).stress||0}/100 · 命中ペナルティ ${combatStress(u)}%`:'未選択';document.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>{if(moving)return;selected=Number(b.dataset.id);sync();draw()});document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));$('at-launcher').value=atMode;$('cas-status').textContent=`CAS ${supportCAS().name} 残${casCharges}回${casPending?' / T'+casPending.arrival+'着弾待機':''}`;$('qrf-status').textContent=`QRF ${supportQRF().name} 残${qrfCharges}回${qrfPending?' / T'+qrfPending.arrival+'到着予定':''} / 到着${qrfArrived}名`;$('end').disabled=phase!=='friendly'||moving;updateTacticalHud();}
function resize(){const r=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(r.width*dpr);canvas.height=Math.round(r.height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);const cell=Math.min((r.width-24)/W,(r.height-24)/H);layout={cell,ox:(r.width-cell*W)/2,oy:(r.height-cell*H)/2};draw();}
function draw(){const r=canvas.getBoundingClientRect();if(!r.width)return;ctx.clearRect(0,0,r.width,r.height);const {cell:c,ox,oy}=layout;ctx.fillStyle='#182422';ctx.fillRect(0,0,r.width,r.height);for(let y=0;y<H;y++)for(let x=0;x<W;x++){const px=ox+x*c,py=oy+y*c;const terrain=strategy.regions.find(r=>r.id===missionRegion)?.terrain;const ground=terrain==='砂漠'?['#9b8d6d','#a89977']:terrain==='山岳'?['#59655b','#637067']:terrain==='港湾'?['#566c70','#5d7679']:terrain==='工業'?['#606568','#686e70']:['#526158','#58665c'];ctx.fillStyle=ground[(x+y)%2];ctx.fillRect(px,py,c,c);ctx.strokeStyle='#71807855';ctx.lineWidth=.6;ctx.strokeRect(px+.3,py+.3,c-.6,c-.6);if(walls.has(`${x},${y}`)){ctx.fillStyle='#7a817b';ctx.fillRect(px+2,py+2,c-4,c-4);ctx.fillStyle='#a3aaa0';ctx.fillRect(px+3,py+3,c-7,c*.25);}else if(crates.has(`${x},${y}`)){ctx.fillStyle='#967c5c';ctx.fillRect(px+c*.15,py+c*.15,c*.7,c*.7);ctx.strokeStyle='#c3ad89';ctx.strokeRect(px+c*.2,py+c*.2,c*.6,c*.6);ctx.beginPath();ctx.moveTo(px+c*.2,py+c*.2);ctx.lineTo(px+c*.8,py+c*.8);ctx.moveTo(px+c*.8,py+c*.2);ctx.lineTo(px+c*.2,py+c*.8);ctx.stroke();}}
// Tactical overlay: reachable cells, target hit probability and sightline.
const actor=selectedUnit();if(actor&&actor.hp>0&&!gameover&&phase==='friendly'&&!moving){
 if(mode==='move'&&actor.ap>0){const budget=movementBudget(actor);const queue=[[actor.x,actor.y,0]],seen=new Set([`${actor.x},${actor.y}`]);for(let i=0;i<queue.length;i++){const [x,y,steps]=queue[i];if(steps>0){ctx.fillStyle='#82d6b52e';ctx.fillRect(ox+x*c+2,oy+y*c+2,c-4,c-4);ctx.strokeStyle='#a8e7cc66';ctx.lineWidth=1;ctx.strokeRect(ox+x*c+3,oy+y*c+3,c-6,c-6);}if(steps>=budget)continue;for(const [nx,ny] of [[x+1,y],[x-1,y],[x,y+1],[x,y-1]]){const k=`${nx},${ny}`;if(nx<0||ny<0||nx>=W||ny>=H||seen.has(k)||occupied(nx,ny)||unitAt(nx,ny))continue;seen.add(k);queue.push([nx,ny,steps+1]);}}}
 if(mode==='at'){const spec=AT_LAUNCHERS[atMode];for(const enemy of units.filter(v=>v.team==='enemy'&&v.hp>0&&v.vehicle)){const valid=distance(actor,enemy)<=spec.range&&line(actor,enemy);const px=ox+enemy.x*c,py=oy+enemy.y*c;ctx.strokeStyle=valid?'#f6d47a':'#a68a7e';ctx.lineWidth=2.5;ctx.strokeRect(px+3,py+3,c-6,c-6);ctx.fillStyle='#202820dd';ctx.fillRect(px+2,py+c*.69,c-4,c*.27);ctx.fillStyle='#ffe2a6';ctx.textAlign='center';ctx.textBaseline='middle';ctx.font=`bold ${Math.max(9,c*.23)}px system-ui`;ctx.fillText(valid?`${antiArmorChance(actor,enemy,spec)}%`:'×',px+c/2,py+c*.82);}}
 if(mode==='fire'){const range=currentWeapon(actor).range+(rec(actor.id).skills.includes('scout')?2:0);for(const enemy of units.filter(v=>v.team==='enemy'&&v.hp>0)){const valid=distance(actor,enemy)<=range&&line(actor,enemy);const px=ox+enemy.x*c,py=oy+enemy.y*c;ctx.strokeStyle=valid?'#f6c37d':'#9c7777';ctx.lineWidth=valid?2.5:1.3;ctx.strokeRect(px+3,py+3,c-6,c-6);ctx.fillStyle=valid?'#162820e8':'#392d2de0';ctx.fillRect(px+2,py+c*.69,c-4,c*.27);ctx.fillStyle=valid?'#f8dfa5':'#d7c3c3';ctx.textAlign='center';ctx.textBaseline='middle';ctx.font=`bold ${Math.max(9,c*.23)}px system-ui`;ctx.fillText(valid?`${Math.round(chance(actor,enemy))}%`:'×',px+c/2,py+c*.82);}}
 if(hover&&hover.x>=0&&hover.x<W&&hover.y>=0&&hover.y<H){const target=unitAt(hover.x,hover.y);if(mode==='fire'&&target&&target.team==='enemy'){ctx.beginPath();ctx.moveTo(ox+(actor.x+.5)*c,oy+(actor.y+.5)*c);ctx.lineTo(ox+(target.x+.5)*c,oy+(target.y+.5)*c);ctx.strokeStyle=line(actor,target)?'#f8d795a8':'#f27777a8';ctx.lineWidth=2;ctx.setLineDash([5,5]);ctx.stroke();ctx.setLineDash([]);}}}
if(casPending||mode==='cas'){
 const aim=casPending||(hover&&hover.x>=0&&hover.x<W&&hover.y>=0&&hover.y<H?hover:null);
 if(aim){for(const tile of casTiles(aim)){const px=ox+tile.x*c,py=oy+tile.y*c;ctx.fillStyle='#e5b45442';ctx.fillRect(px+2,py+2,c-4,c-4);ctx.strokeStyle='#f4c56f';ctx.lineWidth=1.4;ctx.strokeRect(px+2,py+2,c-4,c-4);}ctx.fillStyle='#ffe5a0';ctx.font=`bold ${Math.max(9,c*.24)}px system-ui`;ctx.textAlign='center';ctx.fillText(casPending?'CAS T'+casPending.arrival:'CAS?',ox+(aim.x+.5)*c,oy+(aim.y+.48)*c);}}
for(const patient of downedAllies().filter(u=>u.carriedBy===null)){const px=ox+(patient.x+.5)*c,py=oy+(patient.y+.5)*c;ctx.fillStyle='#f6d2a2';ctx.fillRect(px-c*.17,py-c*.17,c*.34,c*.34);ctx.fillStyle='#762c2c';ctx.font=`bold ${Math.max(10,c*.24)}px system-ui`;ctx.textAlign='center';ctx.fillText(patient.id===rescueObjectiveId?'SOS':patient.stabilized?'S':String(patient.bleed),px,py+c*.08);}for(const d of drops){const dx=ox+(d.x+.5)*c,dy=oy+(d.y+.5)*c;ctx.fillStyle='#d5c16a';ctx.fillRect(dx-c*.21,dy-c*.13,c*.42,c*.26);ctx.strokeStyle='#3e3725';ctx.lineWidth=1.5;ctx.strokeRect(dx-c*.21,dy-c*.13,c*.42,c*.26);ctx.fillStyle='#171d19';ctx.font=`bold ${Math.max(8,c*.20)}px system-ui`;ctx.textAlign='center';ctx.fillText('W',dx,dy+c*.06)}if(missionType!=='eliminate'&&missionType!=='rescue'){const gx=ox+objectiveTile.x*c,gy=oy+objectiveTile.y*c;ctx.fillStyle='#e2c66a55';ctx.fillRect(gx+2,gy+2,c-4,c-4);ctx.strokeStyle='#f4d775';ctx.lineWidth=2;ctx.strokeRect(gx+3,gy+3,c-6,c-6);ctx.fillStyle='#ffe7a2';ctx.font=`bold ${Math.max(9,c*.23)}px system-ui`;ctx.textAlign='center';ctx.fillText('OBJ',gx+c/2,gy+c/2+3)}const u=selectedUnit();if(u&&u.hp>0){ctx.strokeStyle='#d9eab0';ctx.lineWidth=2.4;ctx.strokeRect(ox+u.x*c+2,oy+u.y*c+2,c-4,c-4);if(mode==='fire')for(const e of units.filter(x=>x.team==='enemy'&&x.hp>0&&line(u,x))){ctx.strokeStyle='#e4b68e';ctx.lineWidth=1.5;ctx.strokeRect(ox+e.x*c+4,oy+e.y*c+4,c-8,c-8);}}
for(const a of units.filter(x=>x.hp>0)){const anim=walkAnimation&&walkAnimation.id===a.id?walkAnimation:null;const ax=anim?anim.from.x+(anim.to.x-anim.from.x)*anim.progress:a.x,ay=anim?anim.from.y+(anim.to.y-anim.from.y)*anim.progress:a.y;const px=ox+(ax+.5)*c,py=oy+(ay+.5)*c,rad=c*.27;ctx.fillStyle='#0e1a1c66';ctx.beginPath();ctx.ellipse(px+2,py+c*.19,rad*1.2,rad*.45,0,0,Math.PI*2);ctx.fill();ctx.fillStyle=a.team==='friendly'?'#9acbc1':a.vehicle?'#7d8873':'#e2a08a';ctx.strokeStyle='#172321';ctx.lineWidth=2;ctx.beginPath();ctx.arc(px,py,rad,0,Math.PI*2);ctx.fill();ctx.stroke();if(a.team==='friendly'){drawOperatorGlyph(ctx,px,py,rad,operators[a.id]);drawWeapon(ctx,px+rad*.25,py+rad*.55,Math.max(.12,c/170),operators[a.id]);}
 if(a.vehicle){ctx.save();ctx.translate(px,py);ctx.fillStyle=a.vehicle==='tank'?'#525d49':'#66715d';ctx.strokeStyle='#1a241c';ctx.lineWidth=2;ctx.fillRect(-c*.35,-c*.23,c*.70,c*.46);ctx.strokeRect(-c*.35,-c*.23,c*.70,c*.46);ctx.fillStyle='#263028';ctx.fillRect(-c*.27,-c*.31,c*.14,c*.09);ctx.fillRect(c*.13,-c*.31,c*.14,c*.09);ctx.fillRect(-c*.27,c*.23,c*.14,c*.09);ctx.fillRect(c*.13,c*.23,c*.14,c*.09);ctx.fillStyle='#a4aa91';ctx.beginPath();ctx.arc(0,0,c*.14,0,Math.PI*2);ctx.fill();ctx.fillStyle='#252e25';ctx.fillRect(0,-c*.045,c*.36,c*.09);ctx.restore();}
 ctx.fillStyle='#172321';ctx.font=`bold ${Math.max(9,c*.23)}px system-ui`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(a.team==='friendly'||a.vehicle?'': '!',px,py);ctx.fillStyle='#192521';ctx.fillRect(px-c*.33,py-c*.41,c*.66,3);ctx.fillStyle=a.team==='friendly'?'#a8dfb6':'#f3ac96';ctx.fillRect(px-c*.33,py-c*.41,c*.66*a.hp/a.maxhp,3);}
drawEffects();if(hover&&hover.x>=0&&hover.x<W&&hover.y>=0&&hover.y<H){ctx.strokeStyle='#ffffffa8';ctx.lineWidth=1;ctx.strokeRect(ox+hover.x*c+1,oy+hover.y*c+1,c-2,c-2);}}
function position(evt){const r=canvas.getBoundingClientRect(),{cell,ox,oy}=layout;return{x:Math.floor((evt.clientX-r.left-ox)/cell),y:Math.floor((evt.clientY-r.top-oy)/cell)}}
// Multi-pointer safety: two-finger gestures never trigger tactical actions.
const pointers=new Map();let touchStart=null,gestureBlocked=false;
canvas.addEventListener('pointerdown',e=>{pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(pointers.size>1){gestureBlocked=true;touchStart=null;return}touchStart={id:e.pointerId,x:e.clientX,y:e.clientY};try{canvas.setPointerCapture(e.pointerId)}catch{}});
canvas.addEventListener('pointermove',e=>{if(e.pointerType==='mouse'||pointers.has(e.pointerId)){hover=position(e);updateTacticalHud();draw()}});
canvas.addEventListener('pointerup',e=>{pointers.delete(e.pointerId);if(gestureBlocked){if(!pointers.size)gestureBlocked=false;touchStart=null;return}if(!touchStart||touchStart.id!==e.pointerId)return;const delta=Math.hypot(e.clientX-touchStart.x,e.clientY-touchStart.y);touchStart=null;if(delta>14)return;const p=position(e);if(p.x>=0&&p.x<W&&p.y>=0&&p.y<H)action(p.x,p.y)});
canvas.addEventListener('pointercancel',e=>{pointers.delete(e.pointerId);touchStart=null;if(!pointers.size)gestureBlocked=false});
canvas.addEventListener('lostpointercapture',e=>{if(pointers.has(e.pointerId)){pointers.delete(e.pointerId);touchStart=null;if(!pointers.size)gestureBlocked=false}});

document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{if(moving)return;mode=b.dataset.mode;if(mode==='overwatch'){setOverwatch();mode='move';}sync();draw();});$('at-launcher').onchange=()=>{atMode=$('at-launcher').value;sync();draw()};$('qrf-request').onclick=requestQRF;$('reload').onclick=reload;$('pickup').onclick=pickup;$('end').onclick=endTurn;$('reset').onclick=()=>modal('作戦を再開しますか？','現在の戦闘状況を破棄して最初から開始します。',true);$('help').onclick=()=>modal('操作説明','1. 右側の隊員名をタップして選択\n2. 「移動」を選び、移動先のマスをタップ\n3. 「射撃」を選び、敵をタップ\n4. 「警戒」で敵ターンの移動に反応\n5. APが尽きたら「ターン終了」\n\n移動は4マスにつきAP1。射撃はAP1。遮蔽物は命中率を低下させます（壁35%、木箱20%）。武器の射程を超えると射撃できません。緑色は移動可能マス、射撃時の数値は命中率です。装備は「隊員編集」で変更できます。\n\n横画面でのプレイを推奨します。');
function modal(title,body,restart=false){$('modal-title').textContent=title;$('modal-body').textContent=body;$('overlay').classList.remove('hidden');$('modal-close').textContent=restart?'再開する':'閉じる';$('modal-close').onclick=()=>{$('overlay').classList.add('hidden');if(restart)start()};}

function renderResult(){if(!lastResult)return;const r=lastResult;$('result-title').textContent=r.win?'MISSION SUCCESS':'MISSION FAILED';$('result-detail').textContent=`${r.region} / ${MISSION_LABELS[r.type]}\n所要ターン ${r.turn} / 生存 ${r.survivors}/${r.roster}\n現在資金 ${r.funds}\nCAS要請 ${r.casUsed||0}回\nQRF要請 ${r.qrfUsed||0}回 / 到着 ${r.qrfArrived||0}名\n負傷者後送 ${r.evacRescues||0}名 / 現地救命 ${r.downed||0}名\n回収装備：${r.recovered.length?r.recovered.join(' / '):'なし'}\n${r.completed?'CAMPAIGN COMPLETE：全地域安定化達成':'次の任務は司令部から開始できます'}`;$('result-overlay').classList.remove('hidden');}
$('result-close').onclick=()=>{$('result-overlay').classList.add('hidden');openCommand()};
$('backup-export').onclick=()=>{const data={format:'PERSISTAN-W3.0.0',created:new Date().toISOString(),operators,roster,strategy,campaign,armory};const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='persistan-save-W3.0.0.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),2000);toast('バックアップを出力しました')};
$('backup-import').addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;try{if(file.size>200000)throw Error('ファイルが大きすぎます');const d=JSON.parse(await file.text());if(!['PERSISTAN-W1.8.0','PERSISTAN-W1.9.0','PERSISTAN-W0.7.0','PERSISTAN-W0.8.0','PERSISTAN-W0.9.0','PERSISTAN-W1.0.0','PERSISTAN-W1.4.0','PERSISTAN-W1.5.0','PERSISTAN-W1.6.0','PERSISTAN-W1.7.0'].includes(d.format)||!Array.isArray(d.operators)||!Array.isArray(d.roster)||!d.strategy||!Array.isArray(d.strategy.regions)||!d.campaign||!Array.isArray(d.campaign.history))throw Error('対応していないセーブデータ');if(d.operators.length!==8||d.roster.length!==8||d.strategy.regions.length!==5||d.campaign.history.length>30)throw Error('不正なデータ件数');if(!d.operators.every((o,i)=>o&&typeof o==='object'&&o.id===i&&typeof o.name==='string'&&o.name.length<=60)||!d.roster.every((r,i)=>r&&typeof r==='object'&&r.id===i&&Array.isArray(r.skills)&&r.skills.length<=6)||!d.strategy.regions.every(r=>r&&typeof r.id==='string'&&Number.isFinite(Number(r.security)))||!d.campaign.history.every(h=>h&&typeof h==='object'))throw Error('セーブデータの構造が不正です');if(d.armory&&(!Array.isArray(d.armory.owned)||!Array.isArray(d.armory.history)||d.armory.owned.length>30||d.armory.history.length>40||!d.armory.owned.every(k=>typeof k==='string'&&WEAPONS[k])||(d.armory.counts&&(!Object.entries(d.armory.counts).every(([k,v])=>WEAPONS[k]&&Number.isInteger(v)&&v>=0&&v<=999)))||(d.armory.ammo!==undefined&&(!Number.isInteger(d.armory.ammo)||d.armory.ammo<0||d.armory.ammo>9999))))throw Error('武器庫データが不正です');if(!confirm('現在のセーブを上書きして読み込みますか？'))return;localStorage.setItem(LOOT_KEY,JSON.stringify(d.armory?{owned:[...new Set([...INITIAL_OWNED,...d.armory.owned])],counts:d.armory.counts||Object.fromEntries(d.armory.owned.map(k=>[k,1])),ammo:d.armory.ammo||0,history:d.armory.history}: {owned:INITIAL_OWNED,counts:Object.fromEntries(INITIAL_OWNED.map(k=>[k,1])),ammo:0,history:[]}));localStorage.setItem(STORAGE,JSON.stringify(d.operators));localStorage.setItem(ROSTER_KEY,JSON.stringify(d.roster));localStorage.setItem(STRATEGY_KEY,JSON.stringify(d.strategy));localStorage.setItem(CAMPAIGN_KEY,JSON.stringify(d.campaign));location.reload()}catch(err){toast('読み込み失敗: '+err.message)}finally{e.target.value=''}});

// Persist UI preferences separately from gameplay state.
let uiPrefs={};try{uiPrefs=JSON.parse(localStorage.getItem(UI_KEY)||'{}')||{}}catch{}
const detail=$('detail-panels'),toggle=$('toggle-detail'),tip=$('orientation-tip');
function updateDetail(){const open=uiPrefs.detail!==false;detail.hidden=!open;toggle.textContent=open?'詳細 ▾':'詳細 ▸';toggle.setAttribute('aria-expanded',String(open))}
toggle.onclick=()=>{uiPrefs.detail=detail.hidden;try{localStorage.setItem(UI_KEY,JSON.stringify(uiPrefs))}catch{}updateDetail()};updateDetail();
if(uiPrefs.hideOrientation)tip.classList.add('dismissed');
$('dismiss-orientation').onclick=()=>{tip.classList.add('dismissed');uiPrefs.hideOrientation=true;try{localStorage.setItem(UI_KEY,JSON.stringify(uiPrefs))}catch{}};
window.addEventListener('resize',resize);
if(typeof ResizeObserver!=='undefined')new ResizeObserver(()=>resize()).observe(canvas);
start();resize();
$('stabilize-casualty').onclick=stabilizeCasualty;$('carry-casualty').onclick=carryCasualty;$('evacuate-casualty').onclick=evacuateCasualty;$('command-order').onclick=commandOrder;$('leadership-rally').onclick=leadershipRally;$('squad-cover').onclick=squadCover;$('brotherhood-assist').onclick=brotherhoodAssist;$('brotherhood-rescue').onclick=brotherhoodRescue;
if(new URLSearchParams(location.search).has('test') && ['localhost','127.0.0.1'].includes(location.hostname)){window.__persistanTest={EVAC,rescueMissionComplete,dropCarriedCasualties,downedAllies,registerCasualties,casualtyTick,stabilizeCasualty,carryCasualty,evacuateCasualty,HOME_STATES,hometown,sameHometown,hometownRescueBonus,leadershipRally,squadCover,fieldBondSummary,combatStress,brotherhoodRescue,applyBrotherhoodTrauma,BOND_THRESHOLDS,bondTier,bondedPartner,bondNearby,setBrotherhood,clearBrotherhood,bondMissionProgress,brotherhoodAssist,brotherhoodAccuracy,brotherhoodDefense,ROLES,rank,roleEligible,assignRole,effectiveCommander,commandOrder,CLASS_TREES,ALL_SKILLS,canLearn,skillTier,CAS_RADIUS,CAS_DAMAGE,casTiles,callCAS,resolveCAS,QRF_DELAY,QRF_MAX,SUPPORT_CAS,SUPPORT_QRF,supportPlan,supportReady,requestQRF,resolveQRF,qrfCandidates,AT_LAUNCHERS,antiArmorDamage,antiArmorChance,fireAntiArmor,vehicleDamage,vehicleRoster,VEHICLE_TYPES,vehicleMoves,moveEnemyVehicle,state:()=>({moving,turn,phase,gameover,casCharges,casPending:clone(casPending),casUsed,support:clone(supportPlan()),qrfCharges,qrfPending:clone(qrfPending),qrfUsed,qrfArrived,units:clone(units),drops:clone(drops),collected:clone(collected),armory:clone(armory),roster:clone(roster),strategy:clone(strategy),campaign:clone(campaign)}),action,start,finish,pickup,spawnDrop,openEditor,closeEditor,selected:()=>selected,changeMode:v=>{mode=v;sync();draw()}};}
})();
