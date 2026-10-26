import { GuidedSuite } from './guided-suite.js';
import { AudioChecks } from './audio.js';
import { GuidedControllerView } from './guided-controller.js';
const $=id=>document.getElementById(id);
const label={pending:'Waiting',active:'In progress',passed:'Observed','needs-check':'Check needed',unsupported:'Unavailable',skipped:'Skipped'};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const write=(id,value)=>{const node=$(id);if(node.textContent!==String(value))node.textContent=value;};
const shortNames={buttons:'Buttons',sticks:'Sticks',triggers:'Triggers',drift:'Center',touchpad:'Touch',motion:'Motion',adaptiveTriggers:'Adaptive',lights:'Lights',vibration:'Vibration',speaker:'Speaker',microphone:'Mic',charging:'Power'};
const BUILTIN_SPEAKER='__ssfps5tester_builtin__';
const names=['Cross / A','Circle / B','Square / X','Triangle / Y','L1 / LB','R1 / RB','L2 / LT','R2 / RT','Share / View','Options / Menu','L3','R3','D-pad up','D-pad down','D-pad left','D-pad right','PS / Home','Touchpad click','Mute','Fn left','Fn right','Paddle left','Paddle right'];

export class GuidedChecksUI {
 constructor({hub,onStart,startDrift,notice}){
  this.hub=hub;this.onStart=onStart;this.startDrift=startDrift;this.notice=notice;
  this.suite=new GuidedSuite();this.audio=new AudioChecks();this.state=this.suite.getSummary();
  this.controllerView=new GuidedControllerView({mount:$('suite-controller-view'),sourceSvg:$('controller-visual')});
  this.snapshot=null;this.lastInput=null;this.metrics=null;this.measurementRecord=null;this.entered=null;this.audioSignature='';this.buttons=[];this.mediaGeneration=0;
  this.vibrationPlayed=false;this.speakerPlayed=false;this.micTimer=null;this.micChecking=false;this.micOpened=false;this.outputEvidence='';this.vibrationAttempted=false;this.speakerAttempted=false;this.outputBusy=false;
  this.effectsPlayed={adaptiveTriggers:false,lights:false};this.effectsAttempted={adaptiveTriggers:false,lights:false};
  $('test-all').addEventListener('click',()=>this.start());
  $('suite-cancel').addEventListener('click',()=>this.cancel('Stopped by the user.'));
  $('suite-skip').addEventListener('click',()=>{this.suite.skip('Skipped by the user.',performance.now());this.sync();});
  $('suite-save').addEventListener('click',()=>this.save());
  for(const [id,kind] of [['adaptive','adaptiveTriggers'],['lights','lights']]){
   $(`suite-play-${id}`).addEventListener('click',async()=>{
    if(this.outputBusy||this.state.activeStep?.id!==kind)return;
    const generation=this.mediaGeneration;this.outputBusy=true;this.effectsPlayed[kind]=false;this.effectsAttempted[kind]=true;this.render();
    let okay=false;
    try{okay=kind==='lights'?await this.hub.cycleLights():await this.hub.testAdaptiveTriggers('both');}catch{}
    if(generation!==this.mediaGeneration||this.state.activeStep?.id!==kind)return;
    this.effectsPlayed[kind]=!!okay;this.outputBusy=false;this.render();
   });
   $(`suite-stop-${id}`).addEventListener('click',async()=>{
    const generation=++this.mediaGeneration;this.effectsPlayed[kind]=false;
    if(kind==='lights')await this.hub.stopLights();else await this.hub.stopAdaptiveTriggers();
    if(generation!==this.mediaGeneration||this.state.activeStep?.id!==kind)return;
    this.outputBusy=false;this.render();
   });
   $(`suite-${id}-yes`).addEventListener('click',()=>{
    if(!this.effectsPlayed[kind]||this.state.activeStep?.id!==kind)return;
    this.record(kind,'passed',kind==='lights'?'User confirmed RGB colors, white/off, player indicators 1–5 and the microphone indicator responded after the requested sequence.':'User confirmed resistance on both adaptive triggers after the short requested test.');
   });
   $(`suite-${id}-no`).addEventListener('click',()=>this.record(kind,'needs-check',kind==='lights'?'The complete set of controller lights was not confirmed. Check USB access and repeat the sequence.':'Resistance on both adaptive triggers was not confirmed. Check USB access and retest.'));
  }
  this.effectsProgress=event=>{
   const detail=event.detail;if(this.state.activeStep?.id!==detail.kind)return;
   if(detail.kind==='lights'){
    write('suite-lights-progress',detail.label||'Light cycle in progress.');
    if(detail.color)$('suite-light-swatch').style.backgroundColor=`rgb(${detail.color.join(',')})`;
   }else write('suite-adaptive-progress',detail.label||'Resistance test in progress.');
  };
  hub.addEventListener('effectsprogress',this.effectsProgress);
  $('suite-play-vibration').addEventListener('click',async()=>{
   if(this.outputBusy)return;this.outputBusy=true;
   const generation=this.mediaGeneration;this.vibrationAttempted=true;this.vibrationPlayed=false;this.render();$('suite-play-vibration').disabled=true;
   const okay=await this.hub.rumble('both');
   if(generation!==this.mediaGeneration||this.state.activeStep?.id!=='vibration')return;
   this.vibrationPlayed=okay;this.outputBusy=false;
   if(!okay)this.notice('This connection could not run the vibration pulse. You can mark it for checking or skip it.');
   $('suite-vibration-no').disabled=false;this.render();
  });
  $('suite-vibration-yes').addEventListener('click',()=>this.record('vibration','passed','User confirmed feeling the requested pulse in both motors.'));
  $('suite-vibration-no').addEventListener('click',()=>this.record('vibration','needs-check','User did not feel both motors during the vibration check. Browser, route, and hardware remain possible causes.'));
  $('suite-play-tone').addEventListener('click',async()=>{
   if(this.outputBusy)return;this.outputBusy=true;
   const generation=this.mediaGeneration;this.speakerAttempted=true;this.speakerPlayed=false;this.render();$('suite-play-tone').disabled=true;
   const builtin=$('suite-output').value===BUILTIN_SPEAKER;
   const okay=builtin?await this.hub.playSpeakerTone?.():await this.audio.playTone($('suite-output').value);
   if(generation!==this.mediaGeneration||this.state.activeStep?.id!=='speaker')return;
   this.speakerPlayed=!!okay;this.outputEvidence=builtin?'DualSense built-in USB speaker':this.audio.outputRoute;this.outputBusy=false;
   this.render();
  });
  $('suite-speaker-yes').addEventListener('click',()=>this.record('speaker','passed',`User confirmed hearing the tone from the controller speaker. Requested browser route: ${this.outputEvidence}. Route identity is user-confirmed.`));
  $('suite-speaker-no').addEventListener('click',()=>this.record('speaker','needs-check',`User did not hear the controller speaker. Requested browser route: ${this.outputEvidence||'not selected'}. Check the audio route before judging the hardware.`));
  $('suite-start-mic').addEventListener('click',async()=>{
   if(this.audio.micState==='running'){this.audio.stopMic();clearTimeout(this.micTimer);this.renderAudio();return;}
   const generation=this.mediaGeneration;this.micChecking=true;this.renderAudio();
   const okay=await this.audio.startMic($('suite-input').value);
   if(generation!==this.mediaGeneration||this.state.activeStep?.id!=='microphone'){this.audio.stopMic();return;}
   this.micChecking=false;
   if(okay){this.micOpened=true;clearTimeout(this.micTimer);this.micTimer=setTimeout(()=>{this.audio.stopMic();this.renderAudio();},10000);}
   this.renderAudio();
  });
  $('suite-input').addEventListener('change',()=>{this.audio.stopMic();clearTimeout(this.micTimer);this.audio.peak=0;this.micOpened=false;$('suite-mic-is-controller').checked=false;this.renderAudio();});
  $('suite-output').addEventListener('change',()=>{this.audio.stopTone();void this.hub.stopSpeakerTone?.();this.speakerPlayed=false;this.speakerAttempted=false;this.renderAudio();});
  $('suite-mic-is-controller').addEventListener('change',()=>this.renderAudio());
  $('suite-mic-yes').addEventListener('click',()=>{
   if(!this.microphoneReady())return;
   this.record('microphone','passed',`User identified ${this.audio.inputLabel} as the controller microphone; peak RMS ${(this.audio.peak*100).toFixed(1)}% was observed. Audio was not recorded.`);
  });
  $('suite-mic-no').addEventListener('click',()=>this.record('microphone','needs-check',`No controller microphone response was confirmed. Selected input: ${this.audio.inputLabel||'not opened'}. Check mute, input selection, and browser permission.`));
  this.audio.addEventListener('status',event=>{if(this.state.state==='running')this.notice(event.detail.message,event.detail.kind==='error'?'error':'info');});
  this.audio.addEventListener('change',()=>{this.refreshAudioSelectors();this.renderAudio();});
  this.hidden=()=>{if(document.hidden){this.cleanMedia();if(this.state.state==='running')this.notice('Audio and controller effects stopped while this page was hidden. Resume the current check when ready.');}};
  document.addEventListener('visibilitychange',this.hidden);
 }
 start(){
  if(!this.snapshot)return;
  this.cleanMedia();this.onStart();this.measurementRecord=null;this.suite.start(this.snapshot,performance.now());this.lastInput=this.snapshot;this.entered=null;
  this.sync();$('suite-panel').scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});
 }
 cancel(reason='Stopped by the user.'){
  this.suite.cancel(reason);this.sync();this.cleanMedia();
 }
 record(id,status,detail){this.suite.recordManual(id,status,detail,performance.now());this.sync();}
 cleanMedia(){
  this.mediaGeneration++;clearTimeout(this.micTimer);this.micTimer=null;this.micChecking=false;this.outputBusy=false;
  this.audio.stopMic();this.audio.stopTone();void this.hub.stopRumble();void this.hub.stopSpeakerTone?.();void this.hub.stopControllerEffects?.();
 }
 sync(){
  this.state=this.suite.getSummary();const next=this.state.activeStep?.id??this.state.state;
  if(next!==this.entered){
   this.entered=next;this.cleanMedia();this.vibrationPlayed=false;this.speakerPlayed=false;this.micOpened=false;this.outputEvidence='';this.vibrationAttempted=false;this.speakerAttempted=false;
   this.effectsPlayed={adaptiveTriggers:false,lights:false};this.effectsAttempted={adaptiveTriggers:false,lights:false};
   write('suite-adaptive-progress','Ready for a short resistance test.');write('suite-lights-progress','Ready to cycle.');
   if(this.state.state==='complete'||this.state.state==='cancelled')this.measurementRecord=this.metrics?JSON.parse(JSON.stringify(this.metrics)):null;
   $('suite-mic-is-controller').checked=false;
   if(next==='drift')this.startDrift();
   if(next==='speaker'||next==='microphone'){this.refreshAudioSelectors();void this.audio.refreshDevices();if(next==='speaker'&&this.snapshot?.speakerTone)$('suite-output').value=BUILTIN_SPEAKER;}
  }
  this.render();
 }
 update(snapshot,now,metrics){
  this.snapshot=snapshot;this.metrics=metrics;
  $('test-all').disabled=!snapshot;
  $('test-all').title=snapshot?'Start every supported check in one guided run.':'Connect a controller first.';
  if(this.state.state==='running'){
   if(snapshot)this.lastInput=snapshot;
   if(this.state.activeStep?.id==='drift'&&metrics?.drift?.interrupted)this.suite.recordManual('drift','needs-check','The timed center check was interrupted. Keep the page visible and retest.',now);
   else this.suite.update(snapshot,now,{drift:metrics?.drift});this.sync();
  }
  else if(this.state.state==='idle'&&this.previewKey!==(snapshot?.key??null)){this.previewKey=snapshot?.key??null;this.render();}
 }
 refreshAudioSelectors(){
  const outputs=this.snapshot?.speakerTone?[{deviceId:BUILTIN_SPEAKER,label:'Built-in DualSense speaker · USB'},...this.audio.outputs]:this.audio.outputs;
  const signature=JSON.stringify([this.audio.inputs,outputs]);if(signature===this.audioSignature)return;this.audioSignature=signature;
  for(const [id,devices,defaultLabel]of[['suite-input',this.audio.inputs,'Browser default: verify the device'],['suite-output',outputs,'System default']]){
   const select=$(id),previous=select.value;select.replaceChildren();
   if(!devices.some(d=>d.deviceId==='')){const option=document.createElement('option');option.value='';option.textContent=defaultLabel;select.append(option);}
   for(const device of devices){const option=document.createElement('option');option.value=device.deviceId;option.textContent=device.label;select.append(option);}
   select.value=[...select.options].some(option=>option.value===previous)?previous:'';
  }
 }
 microphoneReady(){return this.micOpened&&this.audio.peak>=0.015&&!!this.audio.inputLabel&&$('suite-mic-is-controller').checked;}
 renderAudio(){
  if(this.state.activeStep?.id==='microphone'){
   const running=this.audio.micState==='running';write('suite-start-mic',this.micChecking?'Requesting microphone…':running?'Stop microphone':'Allow & test microphone');
   $('suite-start-mic').disabled=this.micChecking;
   const value=Math.min(100,this.audio.level*500);$('suite-mic-fill').style.width=`${value}%`;
   $('suite-mic-fill').parentElement.setAttribute('aria-valuenow',String(Math.round(this.audio.level*100)));
   write('suite-mic-source',this.micOpened&&this.audio.inputLabel?`${running?'Listening to':'Last input'}: ${this.audio.inputLabel} · peak RMS ${(this.audio.peak*100).toFixed(1)}%`:'Microphone access is off.');
   $('suite-mic-yes').disabled=!this.microphoneReady();
  }
  $('suite-play-tone').disabled=this.outputBusy;
  $('suite-speaker-yes').disabled=!this.speakerPlayed;$('suite-speaker-no').disabled=!this.speakerAttempted||this.outputBusy;
  write('suite-output-route',this.speakerPlayed?`Tone route: ${this.outputEvidence==='system-default'?'System default':this.outputEvidence}. Confirm sound came from the controller.`:'No tone requested yet.');
 }
 detail(step){
  const d=step.data;
  if(step.id==='buttons'){
   const remaining=d.required?.filter(i=>!d.tested?.includes(i))||[];
   return `${d.tested?.length||0} / ${d.required?.length||0} digital buttons observed${remaining.length?` · Remaining: ${remaining.slice(0,8).map(i=>names[i]||`Button ${i}`).join(', ')}${remaining.length>8?'…':''}`:''}`;
  }
  if(step.id==='sticks')return `Left sweep ${Math.round((d.left?.coverage||0)*100)}%${d.left?.centered?' · centered':''} / Right sweep ${Math.round((d.right?.coverage||0)*100)}%${d.right?.centered?' · centered':''}`;
  if(step.id==='triggers')return `Left: ${d.left?.released?'released':d.left?.squeezed?'release now':'squeeze fully'} · Right: ${d.right?.released?'released':d.right?.squeezed?'release now':'squeeze fully'}`;
  if(step.id==='drift')return 'Keep this page visible and both sticks completely untouched.';
  if(step.id==='touchpad')return ['tap','movement','twoContacts','click'].map(k=>`${({tap:'Tap + release',movement:'Slide',twoContacts:'Two fingers',click:'Click'})[k]}: ${d[k]?'passed':'waiting'}`).join(' · ');
  if(step.id==='motion')return `Gyro axis ranges: ${(d.gyroRange||[0,0,0]).map(v=>v.toFixed(0)).join(' / ')} °/s · Accel: ${(d.accelRange||[0,0,0]).map(v=>v.toFixed(2)).join(' / ')} g`;
  return step.detail||'You can skip a feature your controller or browser does not expose.';
 }
 render(){
  const s=this.state,active=s.activeStep,running=s.state==='running';
  const idle=s.state==='idle',panel=$('suite-panel');
  panel.hidden=false;panel.classList.toggle('is-idle',idle);panel.inert=idle;panel.setAttribute('aria-disabled',String(idle));
  const stepper=$('suite-stepper');
  if(!this.buttons.length){for(const step of s.steps){const chip=document.createElement('div');chip.className='suite-chip';const symbol=document.createElement('span'),name=document.createElement('span');name.textContent=shortNames[step.id];chip.append(symbol,name);stepper.append(chip);this.buttons.push({chip,symbol});}}
  if(idle){
   const snapshot=this.snapshot,standard=snapshot?.mapping==='standard';
   const required=(snapshot?.buttons||[]).map((_,index)=>index).filter(index=>!standard||(index!==6&&index!==7));
   const preview={...s,deviceKey:snapshot?.key??null,source:snapshot?.source??null,steps:s.steps.map(step=>step.id==='buttons'?{...step,data:{required}}:step)};
   this.controllerView.update(preview,snapshot,null);
   this.buttons.forEach(({chip,symbol},index)=>{chip.className='suite-chip pending';symbol.textContent=String(index+1);});
   write('test-all','Start full test');write('suite-title','Full test preview');write('suite-step-number','12 checks');write('suite-step-title','Ready to start');
   write('suite-instructions','Press Start full test to begin recording checks.');write('suite-detail','');write('suite-status-note','Inputs are not recorded as passed until the test starts.');
   $('suite-progress').style.width='0%';
   for(const id of['suite-cancel','suite-skip','suite-live-note','suite-results','suite-adaptive','suite-lights','suite-vibration','suite-speaker','suite-microphone'])$(id).hidden=true;
   return;
  }
  this.controllerView.update(s,this.snapshot||this.lastInput,this.metrics);
  write('test-all',running?'Restart full test':'Start full test');
  write('suite-title',running?`${active.label} check`:s.state==='complete'?'Test complete':'Test stopped');
  $('suite-cancel').hidden=!running;$('suite-skip').hidden=!running;
  s.steps.forEach((step,i)=>{const {chip,symbol}=this.buttons[i];chip.className=`suite-chip ${step.status}`;symbol.textContent=step.status==='passed'?'✓':step.status==='needs-check'?'!':step.status==='unsupported'||step.status==='skipped'?'−':String(i+1);chip.title=`${step.label}: ${label[step.status]}${step.detail?`. ${step.detail}`:''}`;chip.setAttribute('aria-label',chip.title);if(step.status==='active')chip.setAttribute('aria-current','step');else chip.removeAttribute('aria-current');});
  write('suite-step-number',running?`Check ${s.stepIndex+1} of ${s.total}`:`${s.completedCount} of ${s.total} checks recorded`);
  write('suite-step-title',active?.label||(s.state==='cancelled'?'Recorded results':'Test results'));
  write('suite-instructions',active?.instructions||(s.state==='cancelled'?s.reason:'Observed checks, features needing attention, and skipped items are listed below. You can download the complete record.'));
  $('suite-progress').style.width=`${(active?.progress??s.completedCount/s.total)*100}%`;
  write('suite-detail',active?this.detail(active):'');
  for(const id of['vibration','speaker','microphone'])$(`suite-${id}`).hidden=!running||active?.id!==id;
  for(const [id,kind]of[['adaptive','adaptiveTriggers'],['lights','lights']]){
   $(`suite-${id}`).hidden=!running||active?.id!==kind;
   $(`suite-play-${id}`).disabled=this.outputBusy||this.snapshot?.[kind]!==true;
   $(`suite-stop-${id}`).disabled=!this.outputBusy;
   $(`suite-${id}-yes`).disabled=!this.effectsPlayed[kind]||this.outputBusy;
   $(`suite-${id}-no`).disabled=!this.effectsAttempted[kind]||this.outputBusy;
  }
  $('suite-live-note').hidden=!running||active?.manual;
  $('suite-results').hidden=running;
  $('suite-play-vibration').disabled=!running||!this.snapshot?.haptics||this.outputBusy;
  $('suite-vibration-yes').disabled=!this.vibrationPlayed;
  $('suite-vibration-no').disabled=!this.vibrationAttempted||this.outputBusy;
  if(!running){
   const counts=s.steps.reduce((out,step)=>{out[step.status]=(out[step.status]||0)+1;return out;},{});
   const results=$('suite-results-counts');results.replaceChildren();
   for(const status of['passed','needs-check','unsupported','skipped','pending'])if(counts[status]){const row=document.createElement('div');row.className=`result-line ${status}`;const name=document.createElement('span');name.textContent=label[status];const count=document.createElement('strong');count.textContent=counts[status];row.append(name,count);results.append(row);}
   const list=$('suite-result-list');list.replaceChildren();for(const step of s.steps){const item=document.createElement('div');item.className=`suite-result-item ${step.status}`;const line=document.createElement('div'),name=document.createElement('strong'),status=document.createElement('small'),detail=document.createElement('p');name.textContent=step.label;status.textContent=label[step.status];detail.textContent=step.detail||'Not reached during this run.';line.append(name,status);item.append(line,detail);list.append(item);}
  }
  write('suite-status-note','USB details confirm observed data and reported power state. Resistance, lights, audio and vibration require your confirmation.');
  this.renderAudio();
 }
 getReport(){return {version:'0.7.0-beta.0',controller:this.lastInput?{name:this.lastInput.name,source:this.lastInput.source,model:this.lastInput.model,transport:this.lastInput.transport}:null,suite:this.suite.getSummary(),measurements:this.state.state==='running'?this.metrics:this.measurementRecord,limitations:['Input observations do not certify hardware health.','Adaptive resistance, visible lights, audio route and perceived vibration are confirmed by the user.','Power state is a controller report, not a measurement of charging current or battery capacity.','Audio was metered locally and was not recorded.']};}
 save(){
  const report={app:'ssfps5tester',createdAt:new Date().toISOString(),...this.getReport()};
  const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=`ssfps5tester-full-test-${Date.now()}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
 }
 dispose(){this.cleanMedia();this.controllerView.dispose();this.hub.removeEventListener('effectsprogress',this.effectsProgress);document.removeEventListener('visibilitychange',this.hidden);void this.audio.dispose();}
}
