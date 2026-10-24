import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from './vendor/spark.module.js';
import { validateLoopManifest, selectSceneChunks, sceneReady, hasFrameCoverage, nearestPathHeight, nearestPathFrame, wrappedFrameIndex, createLoadTransitionState, requestLoadTransition, resolveLoadTransition, failLoadTransition, closedPathLength } from './loop-navigation.mjs';

const $ = id => document.getElementById(id), keys = new Set(), touch = new Set();
const clamp = (v,a,b) => Math.max(a,Math.min(b,v)), mod = (v,n) => ((v % n) + n) % n;
let renderer, spark, scene, camera, upRotation, manifest, ready = false, heightLocked = true;
let selectedFrame = 0, playback = false, playbackFrame = 0, yaw = 0, pitch = 0, viewYawOffset = 0, viewPitchOffset = 0, lastNow = 0;
let active = new Map(), loading = new Map(), queued = [], desired = new Set(), failed = new Set(), transitionState = null, drag = null;
let routePoints = [], intervals = [], priorPaint = 0, renderedFrames = 0, lastFailureMessage = '', manualUnitsPerSecond = 0;
const setDetail = message => { $('loadDetail').textContent = message; };
const residentRadius = () => manifest?.residentRadius ?? 1;
const residentLimit = () => manifest?.sceneMode === 'complete' ? manifest.chunks.length : 2 * residentRadius() + 1;
function median(values) { if (!values.length) return 0; const a=[...values].sort((x,y)=>x-y), m=a.length>>1; return a.length%2 ? a[m] : (a[m-1]+a[m])/2; }
function percentile(values,p) { if (!values.length) return 0; const a=[...values].sort((x,y)=>x-y); return a[Math.min(a.length-1,Math.ceil(p*a.length)-1)]; }
function showError(error) { $('loading').hidden=false; $('loadTitle').textContent='Preparing local loop'; setDetail(error?.message || String(error)); $('status').innerHTML='<i class="status-dot"></i> Preparing local loop'; }
function frameMatrix(frame) {
  const a=frame.camera_to_world;
  return new THREE.Matrix4().set(a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7],a[8],a[9],a[10],a[11],a[12],a[13],a[14],a[15]);
}
function pathPose(frameValue) {
  const n=manifest.camera_path.length, f=mod(frameValue,n), i=Math.floor(f), j=(i+1)%n, t=f-i;
  const ma=frameMatrix(manifest.camera_path[i]), mb=frameMatrix(manifest.camera_path[j]);
  const pa=new THREE.Vector3().setFromMatrixPosition(ma), pb=new THREE.Vector3().setFromMatrixPosition(mb);
  pa.lerp(pb,t).applyQuaternion(upRotation);
  const qa=new THREE.Quaternion().setFromRotationMatrix(ma), qb=new THREE.Quaternion().setFromRotationMatrix(mb);
  qa.slerp(qb,t).premultiply(upRotation).normalize();
  return { position:pa, quaternion:qa, fov:manifest.camera_path[i].fov+(manifest.camera_path[j].fov-manifest.camera_path[i].fov)*t };
}
function routeAngles(frameValue) { return new THREE.Euler().setFromQuaternion(pathPose(frameValue).quaternion,'YXZ'); }
function applyOrientation(frameValue) {
  const base=routeAngles(frameValue); yaw=base.y+viewYawOffset; pitch=clamp(base.x+viewPitchOffset,-1.45,1.45);
  camera.rotation.set(pitch,yaw,0,'YXZ');
}
function applyFrame(frameValue) {
  const pose=pathPose(frameValue); camera.position.copy(pose.position);
  camera.fov=pose.fov; camera.updateProjectionMatrix(); applyOrientation(frameValue);
  if (heightLocked) camera.position.y=nearestPathHeight([camera.position.x,camera.position.z],routePoints);
  selectedFrame=wrappedFrameIndex(frameValue,manifest.camera_path.length);
  $('frameRange').value=String(selectedFrame); $('frameReadout').textContent=String(selectedFrame)+' / '+(manifest.camera_path.length-1);
  refreshChunkLabel();
}
function currentCore(frame=selectedFrame) { const f=wrappedFrameIndex(frame,manifest.camera_path.length); return manifest.chunks.find(c=>f>=c.startFrame&&f<=c.endFrame); }
function loadedIds() { return new Set(active.keys()); }
function covered(frame=selectedFrame) { return hasFrameCoverage(manifest.chunks,frame,loadedIds(),manifest.camera_path.length); }
function sceneIsReady(frame=selectedFrame) { return sceneReady(manifest.sceneMode ?? 'nearby',manifest.chunks,loadedIds(),frame,manifest.camera_path.length); }
function refreshChunkLabel() {
  const c=currentCore(); $('currentChunk').textContent=c ? (c.label || c.id) : '';
  if (renderer) renderer.domElement.dataset.currentChunk=c?.label || c?.id || '';
}
function updateStatus() {
  if (!manifest) return;
  const core=currentCore(), count=active.size;
  if (lastFailureMessage) $('status').innerHTML='<i class="status-dot"></i> '+lastFailureMessage;
  else if (!ready) $('status').innerHTML='<i class="status-dot"></i> Loading local loop · '+(heightLocked?'Source height locked':'Height follow off');
  else $('status').innerHTML='<i class="status-dot"></i> Local loop ready · '+(heightLocked?'Source height locked':'Height follow off');
  $('status').dataset.chunk=core?.label || core?.id || '';
  $('status').dataset.loadedChunks=String(count);
}
function updateCanvasData(now) {
  if (!renderer || !camera) return;
  const canvas=renderer.domElement, e=camera.rotation, core=currentCore();
  canvas.dataset.selectedFrame=String(selectedFrame); canvas.dataset.currentChunk=core?.label || core?.id || '';
  canvas.dataset.loaded=String(ready && covered());
  canvas.dataset.cameraPosition=JSON.stringify(camera.position.toArray().map(v=>+v.toFixed(6)));
  canvas.dataset.cameraRotation=JSON.stringify([e.x,e.y,e.z].map(v=>+v.toFixed(6)));
  canvas.dataset.resolution=canvas.width+'x'+canvas.height; canvas.dataset.loadedChunks=JSON.stringify([...active.keys()]);
  canvas.dataset.rafMedianMs=median(intervals).toFixed(3); canvas.dataset.rafP95Ms=percentile(intervals,.95).toFixed(3);
  canvas.dataset.renderedFrames=String(renderedFrames);
}
function render(now) {
  if (priorPaint && !document.hidden) { intervals.push(now-priorPaint); if(intervals.length>180) intervals.shift(); }
  priorPaint=now;
  if (renderer && camera && ready && !document.hidden) { updateCanvasData(now); renderer.render(scene,camera); renderedFrames++; }
}
function setPlayback(on) { playback=on; $('play').textContent=on?'Ⅱ Pause loop':'▶ Auto-drive loop'; }
function setLock(on) {
  heightLocked=on; $('heightLock').setAttribute('aria-pressed',String(on));
  $('heightLock').innerHTML='Source height '+(on?'locked':'free')+' <b>'+(on?'ON':'OFF')+'</b>';
  if (on && camera && routePoints.length) camera.position.y=nearestPathHeight([camera.position.x,camera.position.z],routePoints);
  updateStatus(); updateCanvasData(performance.now());
}
function transformedChunkMatrix(chunk) {
  const a=chunk.matrix;
  const m=new THREE.Matrix4().set(a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7],a[8],a[9],a[10],a[11],a[12],a[13],a[14],a[15]);
  return m.premultiply(new THREE.Matrix4().makeRotationFromQuaternion(upRotation));
}
function disposeEntry(id, entry) { scene.remove(entry.mesh); entry.mesh.dispose(); active.delete(id); }
function reconcile(frame=selectedFrame) {
  const held=currentCore(selectedFrame)?.id;
  const wanted=selectSceneChunks(manifest.chunks,manifest.sceneMode ?? 'nearby',frame,held,manifest.camera_path.length,residentLimit(),residentRadius()), ids=new Set(wanted.map(c=>c.id)); desired=ids;
  for (const [id,entry] of active) if(!ids.has(id)) disposeEntry(id,entry);
  queued=queued.filter(c=>ids.has(c.id) && !active.has(c.id) && !loading.has(c.id) && !failed.has(c.id));
  for (const chunk of wanted) if(!active.has(chunk.id)&&!loading.has(chunk.id)&&!failed.has(chunk.id)&&!queued.some(c=>c.id===chunk.id)) queued.push(chunk);
  pumpLoads(); updateStatus();
}
function pendingTarget() { return transitionState?.pendingFrame ?? null; }
function handlePendingReady() {
  if (!transitionState || transitionState.pendingFrame===null) return;
  const frame=resolveLoadTransition(transitionState,covered); if(frame===null) return;
  playbackFrame=frame; lastFailureMessage='' ; applyFrame(frame); reconcile(frame); updateStatus();
}
function showChunkFailure(chunk,error) {
  failed.add(chunk.id);
  const message='Chunk '+(chunk.label||chunk.id)+' could not open: '+(error?.message||error); lastFailureMessage=message;
  const pending=pendingTarget(), pendingCore=pending===null?null:currentCore(pending);
  if(pendingCore?.id===chunk.id && failLoadTransition(transitionState,pending)) setPlayback(false);
  setDetail(manifest.sceneMode==='complete' ? message+' · complete scene sections ready: '+active.size+' / '+manifest.chunks.length : message);
  if(!ready) { $('loading').hidden=false; $('loadTitle').textContent=manifest.sceneMode==='complete'?'Complete scene could not open':'Loop scenery could not open'; }
  else $('status').innerHTML='<i class="status-dot"></i> '+message;
}
function pumpLoads() {
  while(active.size+loading.size<residentLimit() && loading.size<2 && queued.length) {
    const chunk=queued.shift(); if(!desired.has(chunk.id)||active.has(chunk.id)||loading.has(chunk.id)||failed.has(chunk.id)) continue;
    const mesh=new SplatMesh({url:chunk.url,extSplats:true,lod:false,maxSh:1});
    const matrix=transformedChunkMatrix(chunk); matrix.decompose(mesh.position,mesh.quaternion,mesh.scale);
    loading.set(chunk.id,{mesh,chunk});
    Promise.resolve(mesh.initialized).then(()=>{
      const pending=loading.get(chunk.id); if(!pending || pending.mesh!==mesh) { mesh.dispose(); return; }
      loading.delete(chunk.id);
      if(!desired.has(chunk.id)) mesh.dispose();
      else if(!mesh.numSplats) { mesh.dispose(); showChunkFailure(chunk,'This chunk contains no readable splats.'); }
      else { scene.add(mesh); active.set(chunk.id,{mesh,chunk}); }
      if(sceneIsReady()) { ready=true; $('frameRange').disabled=false; $('loading').hidden=true; $('play').disabled=false; $('reset').disabled=false; $('heightLock').disabled=false; $('screenshot').disabled=false; }
      else if(manifest.sceneMode==='complete' && !lastFailureMessage) setDetail('Complete scene sections ready: '+active.size+' / '+manifest.chunks.length);
      handlePendingReady(); updateStatus(); updateCanvasData(performance.now()); pumpLoads();
    }).catch(error=>{
      const pending=loading.get(chunk.id); if(pending?.mesh===mesh) loading.delete(chunk.id);
      mesh.dispose(); showChunkFailure(chunk,error); updateStatus(); pumpLoads();
    });
  }
}
function guardFrame(frame, deferUntilLoaded=false) {
  reconcile(frame);
  if(covered(frame)) return true;
  const chunk=currentCore(frame);
  if(deferUntilLoaded) requestLoadTransition(transitionState,frame,covered);
  if(chunk) {
    if(failed.has(chunk.id)) { setDetail('Could not load '+(chunk.label||chunk.id)+'. Current view is held. Reload the local viewer to retry.'); }
    else setDetail('Preparing nearby loop scenery…');
    $('status').innerHTML='<i class="status-dot"></i> '+(failed.has(chunk.id)?'Could not load ':'Loading ')+(chunk.label||chunk.id)+' · movement paused';
  }
  return false;
}
function navigateToFrame(frame) {
  transitionState.pendingFrame=null;
  if(guardFrame(frame,true)) { transitionState.currentFrame=frame; playbackFrame=frame; applyFrame(frame); reconcile(frame); return true; }
  $('frameRange').value=String(selectedFrame); return false;
}
function syncViewOffset() {
  const base=routeAngles(selectedFrame), d=yaw-base.y;
  viewYawOffset=mod(d+Math.PI,Math.PI*2)-Math.PI; viewPitchOffset=pitch-base.x;
}
function moveFree(dt) {
  if(pendingTarget()!==null) return;
  const forward=+(keys.has('w')||keys.has('arrowup')||touch.has('forward'))-+(keys.has('s')||keys.has('arrowdown')||touch.has('back'));
  const right=+(keys.has('d')||keys.has('arrowright')||touch.has('right'))-+(keys.has('a')||keys.has('arrowleft')||touch.has('left'));
  if(!forward&&!right) return;
  const f=new THREE.Vector3(-Math.sin(yaw),0,-Math.cos(yaw)), r=new THREE.Vector3(Math.cos(yaw),0,-Math.sin(yaw));
  const delta=f.multiplyScalar(forward).add(r.multiplyScalar(right)).normalize().multiplyScalar(manualUnitsPerSecond*(keys.has('shift')?3:1)*dt);
  const candidate=camera.position.clone().add(delta), frame=nearestPathFrame([candidate.x,candidate.z],routePoints);
  if(!guardFrame(frame)) return;
  camera.position.copy(candidate);
  if(heightLocked) camera.position.y=nearestPathHeight([candidate.x,candidate.z],routePoints);
  selectedFrame=wrappedFrameIndex(frame,manifest.camera_path.length); $('frameRange').value=String(selectedFrame); $('frameReadout').textContent=String(selectedFrame)+' / '+(manifest.camera_path.length-1); refreshChunkLabel();
  camera.rotation.set(pitch,yaw,0,'YXZ'); syncViewOffset();
}
function animate(now) {
  requestAnimationFrame(animate);
  const dt=Math.min(.05,Math.max(0,(now-lastNow)/1000)); lastNow=now;
  if(!ready||document.hidden) { render(now); return; }
  if(playback) {
    if(pendingTarget()!==null) { render(now); return; }
    const next=mod(playbackFrame+dt*manifest.camera_path.length/manifest.durationSeconds,manifest.camera_path.length);
    if(guardFrame(next,true)) { playbackFrame=next; applyFrame(next); }
  } else moveFree(dt);
  render(now);
}
function resize() {
  if(!renderer||!camera) return;
  const scale=Math.min(1,960/Math.max(window.innerWidth,window.innerHeight)); const w=Math.max(1,Math.round(window.innerWidth*scale)), h=Math.max(1,Math.round(window.innerHeight*scale));
  renderer.setPixelRatio(1); renderer.setSize(w,h,false); camera.aspect=w/h; camera.updateProjectionMatrix();
}
let toastTimer = null;
function toast(message) {
  const el=$('toast'); el.textContent=message; el.classList.add('visible');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('visible'),4500);
}
function downloadSnapshot(blob,filename) {
  const url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download=filename; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function snapshot() {
  if(!renderer||!ready) return;
  const filename='loop-'+String(selectedFrame).padStart(4,'0')+'.png';
  try {
    const blob=await new Promise(resolve=>renderer.domElement.toBlob(resolve,'image/png'));
    if(!blob) throw new Error('The PNG image could not be encoded.');
    let response;
    try {
      response=await fetch('/capture/'+encodeURIComponent(filename),{method:'POST',headers:{'Content-Type':'image/png'},body:blob});
    } catch(error) {
      downloadSnapshot(blob,filename);
      toast('Capture server unavailable; downloaded '+filename+' instead.');
      return;
    }
    if(response.ok) {
      let savedPath='captures/'+filename;
      try { const result=await response.clone().json(); savedPath=result.path||result.savedPath||savedPath; } catch {}
      renderer.domElement.dataset.lastCapture=savedPath;
      toast('Saved snapshot to '+savedPath);
      return;
    }
    if(response.status===404||response.status===405) {
      downloadSnapshot(blob,filename);
      toast('Capture endpoint unavailable ('+response.status+'); downloaded '+filename+' instead.');
      return;
    }
    throw new Error('Capture server returned '+response.status+'. The snapshot was not saved.');
  } catch(error) { toast(error?.message||'Snapshot failed.'); }
}
function setPreset(name) {
  viewYawOffset=name==='left'?Math.PI/2:name==='right'?-Math.PI/2:0; viewPitchOffset=0; applyOrientation(selectedFrame);
  for(const id of ['forward','left','right']) { $(id+'View').classList.toggle('active',id===name); $(id+'View').setAttribute('aria-pressed',String(id===name)); }
}
function bindControls() {
  $('frameRange').oninput=()=>{ setPlayback(false); navigateToFrame(Number($('frameRange').value)); };
  $('play').onclick=()=>{ if(!ready)return; if(playback) setPlayback(false); else { playbackFrame=selectedFrame; reconcile(playbackFrame); setPlayback(true); } };
  $('reset').onclick=()=>{ setPlayback(false); navigateToFrame(0); };
  $('heightLock').onclick=()=>setLock(!heightLocked); $('screenshot').onclick=snapshot;
  $('forwardView').onclick=()=>setPreset('forward'); $('leftView').onclick=()=>setPreset('left'); $('rightView').onclick=()=>setPreset('right');
  const canvas=renderer.domElement; canvas.tabIndex=0; canvas.setAttribute('aria-label','Four-street loop: drag to look, WASD or arrows to move');
  canvas.addEventListener('pointerdown',e=>{ if(e.button!==0)return; canvas.focus({preventScroll:true}); drag={id:e.pointerId,x:e.clientX,y:e.clientY}; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove',e=>{ if(!drag||drag.id!==e.pointerId)return; yaw-=(e.clientX-drag.x)*.004; pitch=clamp(pitch-(e.clientY-drag.y)*.004,-1.45,1.45); drag.x=e.clientX;drag.y=e.clientY; camera.rotation.set(pitch,yaw,0,'YXZ'); syncViewOffset(); });
  for(const event of ['pointerup','pointercancel','lostpointercapture']) canvas.addEventListener(event,()=>drag=null);
  canvas.addEventListener('contextmenu',e=>e.preventDefault());
  document.querySelectorAll('[data-move]').forEach(b=>{ b.addEventListener('pointerdown',e=>{ e.preventDefault(); touch.add(b.dataset.move); b.setPointerCapture(e.pointerId); }); for(const event of ['pointerup','pointercancel','lostpointercapture']) b.addEventListener(event,()=>touch.delete(b.dataset.move)); });
  window.addEventListener('keydown',e=>{ if(e.target.closest('input,button,a'))return; const k=e.key.toLowerCase(); if(['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright','shift'].includes(k)){e.preventDefault();keys.add(k);} });
  window.addEventListener('keyup',e=>keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur',()=>{keys.clear();touch.clear();drag=null;});
  document.addEventListener('visibilitychange',()=>{keys.clear();touch.clear();drag=null;lastNow=performance.now();});
  window.addEventListener('resize',resize);
}
async function start() {
  const response=await fetch('./loop.json');
  if(!response.ok) throw new Error('loop.json is missing from this delivery folder.');
  manifest=await response.json(); validateLoopManifest(manifest); transitionState=createLoadTransitionState(0); $('frameRange').max=String(manifest.camera_path.length-1);
  if(manifest.sceneMode==='complete') { $('frameRange').disabled=true; $('loadTitle').textContent='Loading complete scene'; setDetail('Complete scene sections ready: 0 / '+manifest.chunks.length); }
  $('title').textContent=manifest.title||'Four-street drive'; $('notice').textContent=manifest.notice||'Local review scene. Scale is unverified; no distance or speed measurements are shown.';
  const up=new THREE.Vector3(...manifest.up).normalize(); upRotation=new THREE.Quaternion().setFromUnitVectors(up,new THREE.Vector3(0,1,0));
  routePoints=manifest.camera_path.map(frame=>{const m=frameMatrix(frame); return new THREE.Vector3().setFromMatrixPosition(m).applyQuaternion(upRotation).toArray();});
  manualUnitsPerSecond=closedPathLength(routePoints)/manifest.durationSeconds;
  renderer=new THREE.WebGLRenderer({antialias:false,alpha:false,preserveDrawingBuffer:true,powerPreference:'high-performance'}); renderer.setPixelRatio(1); $('viewport').append(renderer.domElement);
  scene=new THREE.Scene(); scene.background=new THREE.Color('#252b28'); camera=new THREE.PerspectiveCamera(75,1,.01,2500);
  spark=new SparkRenderer({renderer}); scene.add(spark); resize(); bindControls(); applyFrame(0); setLock(true); reconcile(0); updateStatus(); requestAnimationFrame(animate);
}
window.addEventListener('beforeunload',()=>{ for(const [id,e] of active) disposeEntry(id,e); for(const {mesh} of loading.values()) mesh.dispose(); spark?.dispose(); renderer?.dispose(); });
start().catch(showError);





