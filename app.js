import { ControllerHub } from './device.js';
import { TestSession } from './metrics.js';
import { GuidedChecksUI } from './guided-ui.js';
import { initPs5Panel } from './ps5-ui.js';
import { ControllerPages } from './pages.js';
import { ControllerInfoUI } from './controller-info-ui.js';
import { NavigationMotion } from './navigation-motion.js';

const $ = id => document.getElementById(id);
const hub = new ControllerHub();
const session = new TestSession();
const traces = {left:[],right:[]};
let activeKey = null, current = null, summary = session.getSummary(0), tiles = [], tileSignature = '', lastTraceAt = 0;
let raf, interruptedMeasurement = false, guidedUI = null, pages = null, controllerInfo = null, navigationMotion = null;
initPs5Panel();
const standardNames = ['× / A','○ / B','□ / X','△ / Y','L1 / LB','R1 / RB','L2 / LT','R2 / RT','Share / View','Options / Menu','L3','R3','D-pad ↑','D-pad ↓','D-pad ←','D-pad →','Home'];
const sonyNames = ['× Cross','○ Circle','□ Square','△ Triangle','L1','R1','L2','R2','Share / Create','Options','L3','R3','D-pad ↑','D-pad ↓','D-pad ←','D-pad →','PS','Touch click','Mute','Fn left','Fn right','Paddle L','Paddle R'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const percent = value => `${(value*100).toFixed(1)}%`;
$('skip-content').addEventListener('click',event=>{event.preventDefault();$('main-content').focus();$('main-content').scrollIntoView({block:'start'});});
function text(id,value){const node=$(id);if(node.textContent!==String(value))node.textContent=value;}
function notice(message,kind='info'){text('notice',message);$('notice').classList.toggle('error',kind==='error');$('notice').hidden=!message;}
function clearTraces(){traces.left=[];traces.right=[];lastTraceAt=0;}
function reset(key=hub.activeKey,stopSuite=true){if(stopSuite)guidedUI?.cancel('The controller or session changed. Start a fresh full check.');activeKey=key;const device=hub.devices.find(d=>d.key===key);session.reset(key,device?.buttonCount||17);summary=session.getSummary(performance.now());clearTraces();interruptedMeasurement=false;}
function updateDevices(){
 const select=$('device-select');const previous=select.value;select.replaceChildren();
 if(!hub.devices.length){const option=document.createElement('option');option.textContent='Waiting for a controller';option.value='';select.append(option);}
 for(const device of hub.devices){const option=document.createElement('option');option.value=device.key;option.textContent=device.name;select.append(option);}
 select.value=hub.activeKey||'';
 if(activeKey!==hub.activeKey){reset(hub.activeKey);if(previous&&previous!==hub.activeKey)notice('Controller selection changed. A fresh testing session has started.');}
}
hub.addEventListener('deviceschange',updateDevices);
hub.addEventListener('status',event=>notice(event.detail.message,event.detail.kind));
$('device-select').addEventListener('change',event=>{if(hub.select(event.target.value)){reset();notice('');}});
$('connect').addEventListener('click',async()=>{
 $('connect').disabled=true;text('connect','Choose a controller…');
 try{await hub.connectPlayStation();updateDevices();}
 finally{$('connect').disabled=false;text('connect','Connect PlayStation');}
});
$('reset-session').addEventListener('click',()=>{reset();notice(current?'Session reset. Test each input to start a fresh report.':'Session reset. Connect a controller to begin.');});
$('clear-trails').addEventListener('click',clearTraces);
$('measure-drift').addEventListener('click',()=>{
 if(!current||current.mapping!=='standard')return;
 interruptedMeasurement=false;
 if(session.startDrift(performance.now(),3000))notice('Measurement started. Keep both sticks untouched for 3 seconds.');
});
for(const [opener,dialog] of [['help-open','help-dialog'],['credits-open','credits-dialog']]){
 $(opener).addEventListener('click',()=>$(dialog).showModal());
 for(const button of $(dialog).querySelectorAll('.close-dialog'))button.addEventListener('click',()=>$(dialog).close());
 $(dialog).addEventListener('click',event=>{if(event.target===$(dialog)){const r=$(dialog).getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$(dialog).close();}});
}
$('export-report').addEventListener('click',()=>{
 if(!current)return;
 const measurements=session.getSummary(performance.now());
 const complete=measurements.drift.state==='complete'&&!interruptedMeasurement&&measurements.drift.left.samples>0&&measurements.drift.right.samples>0;
 const report={app:'ssfps5tester',version:'0.7.0-beta.0',createdAt:new Date().toISOString(),controller:{name:current.name,source:current.source,mapping:current.mapping},observedInput:{axes:current.axes,rawAxes:current.rawAxes,buttons:current.buttons,battery:current.battery,motion:current.motion,touches:current.touches},session:measurements,guidedTest:guidedUI?.getReport(),driftMeasurementValid:complete,measurementInterrupted:interruptedMeasurement,limitations:['Browser observations; not a hardware latency or USB polling-rate measurement.','Controller firmware, dead zones, OS mappings and browser support affect readings.','Radial error is meaningful only after at least 80% sweep coverage.','Battery is approximate and motion readings are uncalibrated.','A requested vibration pulse does not confirm that a motor physically worked.','No physical pass/fail certification is provided.']};
 const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
 const link=document.createElement('a');link.href=url;link.download=`ssfps5tester-session-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
});
function interruptDrift(){if(session.getSummary(performance.now()).drift.state==='measuring'){interruptedMeasurement=true;notice('Drift measurement interrupted when this page lost focus. Measure again with the page visible.');}}
window.addEventListener('blur',interruptDrift);
document.addEventListener('visibilitychange',()=>{if(document.hidden)interruptDrift();});
function buildButtons(state){
 const standard=state?.mapping!=='raw', count=state?.buttons.length??17, sony=state?.source==='hid';
 const signature=`${count}:${standard}:${sony}`;if(signature===tileSignature)return;tileSignature=signature;
 const grid=$('button-grid');grid.replaceChildren();tiles=[];
 for(let i=0;i<count;i++){
  const tile=document.createElement('div');tile.className='button-tile';tile.setAttribute('role','img');
  const name=document.createElement('span');name.className='button-name';name.textContent=standard?((sony?sonyNames:standardNames)[i]||`Button ${i}`):`Button ${i}`;
  const value=document.createElement('span');value.className='button-value';value.textContent='0.00';tile.append(name,value);grid.append(tile);tiles.push({tile,value,name:name.textContent});
 }
}
function renderButtons(state,stats){
 buildButtons(state);const tested=new Set(stats.buttonsTested);
 for(let i=0;i<tiles.length;i++){
  const input=state?.buttons[i],pressed=!!input?.pressed,value=finite(input?.value)?input.value:0;
  tiles[i].tile.classList.toggle('pressed',pressed);tiles[i].tile.classList.toggle('tested',tested.has(i));
  const v=state?value.toFixed(2):'N/A';if(tiles[i].value.textContent!==v)tiles[i].value.textContent=v;
  const label=`${tiles[i].name}: ${pressed?'pressed':'released'}${tested.has(i)?', tested':''}, pressure ${v}`;
  if(tiles[i].tile.getAttribute('aria-label')!==label)tiles[i].tile.setAttribute('aria-label',label);
 }
 for(const element of document.querySelectorAll('#controller-visual [data-button]')){
  const i=Number(element.dataset.button),canShow=state?.mapping==='standard'&&(i<=16||state.source==='hid');
  element.classList.toggle('pressed',canShow&&!!state?.buttons[i]?.pressed);
 }
 for(const [side,index]of[['left',0],['right',2]]){
  const x=finite(state?.axes[index])?state.axes[index]:0,y=finite(state?.axes[index+1])?state.axes[index+1]:0;
  const stick=$(`visual-${side}-stick`);stick.setAttribute('cx',Number(stick.dataset.centerX)+x*10);stick.setAttribute('cy',Number(stick.dataset.centerY)+y*10);
 }
 for(const [side,index]of[['left',6],['right',7]]){
  const rawValue=state?.mapping==='standard'?state.buttons[index]?.value:null;
  const value=finite(rawValue)?Math.max(0,Math.min(1,rawValue)):null;
  const percentage=value===null?'N/A':`${Math.round(value*100)}%`;
  text(`${side}-trigger-value`,percentage);text(`${side}-trigger-outline-value`,percentage);$(`${side}-trigger-fill`).style.width=`${value===null?0:value*100}%`;
 }
 const raw=state?.mapping==='raw';$('raw-axes').hidden=!raw;
 if(raw)text('raw-axes',(state.rawAxes||[]).map((axis,i)=>`Axis ${i}: ${finite(axis)?axis.toFixed(3):'unavailable'}`).join(' · '));
 text('button-hint',raw?'Your browser has no standard layout for this controller. Numbered inputs are shown as reported.':'Live pressure above. A small dot marks each button you’ve tested.');
}
function drawStick(side,coords,now){
 if(pages?.page!=='inputs')return;
 const canvas=$(`${side}-canvas`),rect=canvas.getBoundingClientRect(),ratio=Math.min(window.devicePixelRatio||1,2),w=Math.round(rect.width*ratio),h=Math.round(rect.height*ratio);
 if(!w||!h)return;
 if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
 const ctx=canvas.getContext('2d');if(!ctx)return;ctx.setTransform(ratio,0,0,ratio,0,0);
 const width=rect.width,height=rect.height,cx=width/2,cy=height/2,r=Math.min(width*.34,height*.36);
 ctx.clearRect(0,0,width,height);
 ctx.strokeStyle='#dedede';ctx.lineWidth=1;ctx.setLineDash([]);
 ctx.beginPath();ctx.moveTo(cx-r-15,cy);ctx.lineTo(cx+r+15,cy);ctx.moveTo(cx,cy-r-15);ctx.lineTo(cx,cy+r+15);ctx.stroke();
 ctx.setLineDash([2,4]);for(const f of [.5,1]){ctx.beginPath();ctx.arc(cx,cy,r*f,0,Math.PI*2);ctx.stroke();}ctx.setLineDash([]);
 ctx.fillStyle='#f4f4f4';ctx.beginPath();ctx.arc(cx,cy,r*.05,0,Math.PI*2);ctx.fill();
 ctx.fillStyle='#555';ctx.font='12px Helvetica,Arial,sans-serif';ctx.textAlign='center';ctx.fillText('−1',cx-r-12,cy-6);ctx.fillText('+1',cx+r+12,cy-6);ctx.fillText('−1',cx,cy-r-10);ctx.fillText('+1',cx,cy+r+15);
 const points=traces[side];if(points.length>1){ctx.lineWidth=1.4;ctx.strokeStyle='#bd2b2088';ctx.beginPath();points.forEach((p,i)=>{const x=cx+p[0]*r,y=cy+p[1]*r;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();}
 ctx.strokeStyle='#777';ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.stroke();
 const x=coords?.[0],y=coords?.[1];if(finite(x)&&finite(y)){
  const px=cx+x*r,py=cy+y*r;ctx.strokeStyle='#bd2b2066';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(px,py);ctx.stroke();ctx.fillStyle='#bd2b20';ctx.beginPath();ctx.arc(px,py,4.5,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(px,py,1.5,0,Math.PI*2);ctx.fill();
 }else{ctx.fillStyle='#777';ctx.beginPath();ctx.arc(cx,cy,3,0,Math.PI*2);ctx.fill();}
}
function renderSticks(state,stats,now){
 const standard=state?.mapping==='standard';
 for(const [side,index]of[['left',0],['right',2]]){
  const axes=standard?state.axes.slice(index,index+2):null,valid=axes?.length===2&&axes.every(finite);
  if(valid&&now-lastTraceAt>25){const trail=traces[side],last=trail.at(-1);if(!last||Math.hypot(last[0]-axes[0],last[1]-axes[1])>.002){trail.push(axes);if(trail.length>150)trail.shift();}}
  drawStick(side,valid?axes:null,now);text(`${side}-coordinate`,valid?`X ${axes[0].toFixed(3)}   Y ${axes[1].toFixed(3)}`:'X N/A   Y N/A');
  const measured=stats.drift.state==='complete'&&!interruptedMeasurement&&stats.drift[side].samples>0;
  const offset=measured?Math.hypot(stats.drift[side].meanX,stats.drift[side].meanY):valid?Math.hypot(...axes):null;
  text(`${side}-offset`,offset===null?'N/A':percent(offset));
  const circ=stats.circularity[side];text(`${side}-error`,standard&&circ.coverage>=.8?percent(circ.error):'Need a sweep');
 }
 if(now-lastTraceAt>25)lastTraceAt=now;
 const measuring=stats.drift.state==='measuring'&&!interruptedMeasurement;
 const hasBothSticks=standard&&state.axes.length>=4&&state.axes.slice(0,4).every(finite);
 $('measure-drift').disabled=!hasBothSticks||measuring;
 text('measure-drift',measuring?`Measuring… ${(stats.drift.remainingMs/1000).toFixed(1)}s`:stats.drift.state==='complete'||interruptedMeasurement?'Measure again':'Measure drift');
 $('drift-progress').hidden=!measuring;$('drift-progress').firstElementChild.style.width=`${stats.drift.progress*100}%`;
 if(interruptedMeasurement){text('drift-heading','Measurement interrupted');text('drift-description','Keep this page in focus, then measure again.');}
 else if(measuring){text('drift-heading','Hands off the sticks…');text('drift-description','Collecting browser observations for 3 seconds.');}
 else if(stats.drift.state==='complete'&&stats.drift.left.samples&&stats.drift.right.samples){text('drift-heading','Center measurement complete');text('drift-description',`Jitter · left ${percent(stats.drift.left.jitter)} / right ${percent(stats.drift.right.jitter)}. Offsets show the measured centers.`);}
 else if(stats.drift.state==='complete'){text('drift-heading','No stick samples collected');text('drift-description','Move each stick once, release it, then measure again.');}
 else{text('drift-heading','Check for stick drift');text('drift-description',state?.mapping==='raw'?'Stick roles are unavailable for this controller’s raw mapping.':'Leave both sticks untouched for a 3-second measurement.');}
}
function renderDetails(state){
 const detailed=state?.source==='hid';
 if(!detailed){text('battery-value','Unavailable');text('motion-values','Connect PlayStation over USB for sensor readings.');return;}
 const powerLabels={charging:'Charging',full:'Full',discharging:'Discharging','not-charging':'Not charging',error:'Charge error',unknown:'Unknown state'};
 text('battery-value',state.battery?`${finite(state.battery.level)?`≈ ${Math.round(state.battery.level*100)}% · `:''}${powerLabels[state.battery.powerState]||'Unavailable'}`:'Unavailable');
 text('motion-values',state.motion?`Gyro  ${state.motion.gyro.map(v=>v.toFixed(1)).join(' / ')} °/s\nAccel ${state.motion.accel.map(v=>v.toFixed(2)).join(' / ')} g`:'No motion data');
}
function render(now){
 if(activeKey!==hub.activeKey)updateDevices();
 current=hub.snapshot(now);
 pages?.sync(current);
 if(current)summary=session.update(current,now);else { if(summary.drift.state==='measuring')interruptedMeasurement=true;summary=session.getSummary(now); }
 const device=hub.devices.find(d=>d.key===hub.activeKey),connected=!!current;
 text('workspace-label',connected?'Controller connected':'No controller');
 $('connection-dot').classList.toggle('connected',connected);
 text('connection-detail',current?(current.mapping==='raw'?'Connected · raw button and axis values':current.source==='hid'?'Connected over USB · detailed PlayStation inputs':'Connected · standard browser input mapping'):device?.source==='hid'?'Waiting for USB input. Move a stick or reconnect with a USB cable.':'Plug in or pair a controller, then press a button to start.');
 text('source-tag',current?(current.source==='hid'?'PLAYSTATION USB':current.mapping==='raw'?'RAW INPUTS':'GAMEPAD API'):'READY WHEN YOU ARE');
 text('input-status',connected?(current.mapping==='raw'?'RAW LAYOUT':'LIVE'):'NO INPUT');
 text('stage-caption',current?(current.mapping==='raw'?'Use the numbered buttons and raw axes below':'Press, move, squeeze. Every input appears here.'):'Your inputs appear here in real time');
 $('export-report').disabled=!connected;
 text('home-controller-name',current?.name||'');
 text('home-title','Controller connected');
 renderButtons(current,summary);renderSticks(current,summary,now);renderDetails(current);
 guidedUI?.update(current,now,{...summary,drift:{...summary.drift,interrupted:interruptedMeasurement}});
 controllerInfo?.update(current,connected&&pages?.page==='info');
 raf=requestAnimationFrame(render);
}
if(!window.isSecureContext)notice('Controller access needs a secure page. Open the hosted HTTPS version or run this app on localhost.','error');
else if(!navigator.getGamepads&&!navigator.hid)notice('This browser does not expose controller inputs. Try the latest Chrome or Edge.','error');
if(!navigator.hid){$('connect').title='Detailed USB mode requires Chrome or Edge. Other controllers can connect automatically.';}
guidedUI=new GuidedChecksUI({hub,onStart:()=>{reset(hub.activeKey,false);notice('');},startDrift:()=>{interruptedMeasurement=false;session.startDrift(performance.now(),3000);},notice});
controllerInfo=new ControllerInfoUI({hub});
pages=new ControllerPages({onChange:({from,to,connected})=>{
 if(!from)return;
 if(from==='test'&&(to!=='test'||!connected)&&guidedUI?.state.state==='running')guidedUI.cancel('Test stopped when you left the test page. Recorded results are kept.');
 if(from!==to||!connected){
  if(session.getSummary(performance.now()).drift.state==='measuring')interruptedMeasurement=true;
  void hub.stopRumble();void hub.stopSpeakerTone();void hub.stopControllerEffects();
 }
}});
navigationMotion=new NavigationMotion();
hub.start();updateDevices();raf=requestAnimationFrame(render);
window.addEventListener('pagehide',event=>{cancelAnimationFrame(raf);guidedUI?.cancel('The page was left during the check.');if(event.persisted){void hub.stopRumble();void hub.stopControllerEffects();}else{navigationMotion?.dispose();pages?.dispose();controllerInfo?.dispose();guidedUI?.dispose();void hub.dispose();}});
window.addEventListener('pageshow',event=>{if(event.persisted){hub.start();updateDevices();cancelAnimationFrame(raf);raf=requestAnimationFrame(render);}});
