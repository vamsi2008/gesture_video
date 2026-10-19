import { classifyHand, GestureGate } from './gestures.mjs';
import { PlaybackController } from './playback.mjs';
import jsQR from 'jsqr';
const $ = id => document.getElementById(id);
const native = !!window.Native, preview = new URLSearchParams(location.search).get('preview') === 'phone', phone = native || preview;
const role = phone ? 'phone' : 'laptop';
document.body.classList.toggle('phone', phone);
const defaults = { camera: phone ? 'front' : '', mirror: true, showPreview: true, hold: 400, reconnect: true, feedback: false, theme: 'light' };
let settings; try { settings = { ...defaults, ...JSON.parse(localStorage.getItem('gv-settings-v2') || '{}') }; } catch { settings = { ...defaults }; }
let localMode = false, sessionGeneration = 0;
let loadedQrCode = '', refreshingPair = false;
let token = '', activeSession = false, state = { mode: 'laptop', epoch: 0, connected: false, phone: {}, laptop: {} }, mode = 'laptop', page = 'home';
let pending = {}, rpcId = 0, cameraOn = false, starting = false, detector, detectorPromise, stream, scan = false, fileUrl, fileName = '', manualTimer, manualKind, frameBusy = false, frameId = 0, frameAt = 0, lastGesture = 'NONE', lastVideoTime = -1, cameraGeneration = 0, lastSeq = -1;
const gate = new GestureGate(settings.hold), player = $('player'), playback = new PlaybackController(player, updatePlayer);
const names = { NONE: 'Show one clear gesture', PLAY: 'Two fingers · Play', PAUSE: 'One finger · Pause', FORWARD: 'Thumb right · 2× forward', REWIND: 'Thumb left · 2× rewind' };
const playbackHere = () => localMode || mode !== role;
const hide = (id, value) => { $(id).hidden = value; };
function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); hide('notice', !message); }
function failure(e) { notice(e.message || String(e), true); }
window.nativeReply = (id, result) => { const p = pending[id]; if (!p) return; clearTimeout(p.timer); delete pending[id]; if (result.error) p.reject(new Error(result.error)); else p.resolve(result); };
function call(action, data = {}) {
  if (!native) return Promise.reject(new Error('This action is available in the Android app.'));
  return new Promise((resolve, reject) => { const id = ++rpcId; pending[id] = { resolve, reject, timer: setTimeout(() => { delete pending[id]; reject(new Error('The device did not respond. Please try again.')); }, action === 'pair' ? 25000 : action === 'startCamera' ? 60000 : 8000) }; window.Native.call(String(id), action, JSON.stringify(data)); });
}
async function timedFetch(url, options = {}, timeout = 3000) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout); try { return await fetch(url, { ...options, signal: controller.signal }); } finally { clearTimeout(timer); } }
async function api(action, data) {
  if (phone) return call(action, data);
  const response = await timedFetch('/api/' + action, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Controller-Token': token }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Connection failed.'); return result;
}
function navigate(next) {
  if (page === 'session' && next !== 'session') { stopCamera(); releaseManual(); playback.stop(); }
  if (scan && next !== 'pair') stopScan();
  page = ['home','pair','session','devices','settings','about'].includes(next) ? next : 'home';
  document.querySelectorAll('[data-page]').forEach(e => e.hidden = e.dataset.page !== page);
  document.querySelectorAll('[data-nav]').forEach(e => e.classList.toggle('selected', e.dataset.nav === (page === 'about' ? 'settings' : ['session','pair'].includes(page) ? 'home' : page)));
  if (page === 'pair') refreshPair().catch(failure);
  if (page === 'settings') populateCameras().catch(() => {});
  window.scrollTo(0, 0); render();
}
document.querySelectorAll('[data-go]').forEach(e => e.onclick = () => navigate(e.dataset.go));
document.querySelectorAll('[data-nav]').forEach(e => e.onclick = () => navigate(e.dataset.nav));
document.querySelector('.brand').onclick = e => { e.preventDefault(); navigate('home'); };
document.querySelectorAll('[data-mode]').forEach(e => e.onclick = async () => {
  try { stopCamera(); playback.stop(); releaseManual(); localMode = false; sessionGeneration++; mode = e.dataset.mode; if (activeSession) acceptState(await api('mode', { mode })); render(); } catch (err) { failure(err); }
});
$('continue').onclick = () => { stopCamera(); releaseManual(); playback.stop(); localMode = false; sessionGeneration++; navigate('session'); };
$('watchLocal').onclick = () => { stopCamera(); releaseManual(); playback.stop(); localMode = true; sessionGeneration++; lastSeq = state.event ? state.event.seq : -1; navigate('session'); notice('Select a video, then enable your webcam. No pairing needed.'); };
$('replayLocal').onclick = async () => { player.currentTime = 0; hide('videoFinished', true); await startCamera(); if (cameraOn) playback.apply('PLAY').catch(failure); };
async function refreshPair() {
  if (phone) { if (native) { const d = await call('discover'); $('discoveryStatus').textContent = d.count ? 'Laptop found nearby. Enter its code to connect.' : 'Searching nearby… You can scan the QR code instead.'; } return; }
  const result = await api('setup'); token = result.token; activeSession = true; loadedQrCode = result.code;
  $('pairCode').textContent = result.code.slice(0,4) + ' ' + result.code.slice(4); $('pairQr').src = result.qr || ''; hide('pairQr', !result.qr);
  acceptState(result);
}
$('newCode').onclick = async () => { try { await api('new-code', {}); await refreshPair(); } catch (e) { failure(e); } };
$('phonePair').onsubmit = async e => { e.preventDefault(); await pairPhone($('codeInput').value.replace(/\s/g, ''), ''); };
async function pairPhone(code, qr) {
  if (!/^\d{8}$/.test(code)) return notice('Enter all eight digits shown on your laptop.', true);
  $('pairSubmit').disabled = true; notice('Connecting to your laptop…');
  try { const desiredMode = mode; const result = await call('pair', { code, qr }); activeSession = true; acceptState(result); acceptState(await api('mode', { mode: desiredMode })); notice('Connected. Choose a video on the playback device.'); navigate('session'); }
  catch (e) { failure(e); }
  finally { $('pairSubmit').disabled = false; }
}
function acceptState(next) {
  if (!next.mode) return;
  const changed = state.epoch !== next.epoch || state.mode !== next.mode;
  if (changed && !localMode) { stopCamera(false); releaseManual(); playback.stop(); gate.reset(); frameId = 0; lastSeq = next.event.seq; }
  if (!localMode && state.connected && (!next.connected || (phone && !next.laptopOnline))) { stopCamera(false); releaseManual(); playback.restore().catch(failure); }
  const justPaired = !state.connected && next.connected;
  state = next; mode = next.mode;
  if (!phone && page === 'pair' && next.code && next.code !== loadedQrCode && !refreshingPair) { refreshingPair = true; refreshPair().catch(failure).finally(() => { refreshingPair = false; }); }
  if (!localMode && justPaired && !phone && (page === 'pair' || page === 'home')) navigate('session');
  if (!localMode && !changed && next.event.seq > lastSeq) { lastSeq = next.event.seq; if (playbackHere() && page === 'session' && !document.hidden) playback.apply(next.event.action).catch(failure); }
  if (native) { /* Native networking retains mode epoch for camera uploads. */ }
  render();
}
function render() {
  hide('localOffer', phone);
  document.body.classList.toggle('local-session', localMode);
  hide('remoteCard', localMode);
  hide('videoFinished', !localMode || !player.ended);
  const cameraParent = localMode ? $('sessionAside') : $('sessionMain');
  if ($('cameraCard').parentElement !== cameraParent) cameraParent.prepend($('cameraCard'));
  const connected = state.connected && (phone ? state.laptopOnline : true);
  for (const id of ['topStatus','deviceStatus','remoteConnection']) { $(id).textContent = connected ? (phone ? 'Laptop connected' : (state.phone.name || 'Phone') + ' connected') : 'Not connected'; $(id).classList.toggle('connected', connected); }
  document.querySelectorAll('[data-mode]').forEach(e => e.classList.toggle('selected', e.dataset.mode === mode));
  $('pairTitle').textContent = phone ? 'Pair your laptop' : 'Pair your phone'; hide('phonePair', !phone); hide('laptopPair', phone); hide('qrCard', phone);
  $('roleDescription').textContent = localMode ? 'WEBCAM → THIS LAPTOP · NO PAIRING' : mode === 'phone' ? 'PHONE CAMERA → LAPTOP VIDEO' : 'LAPTOP CAMERA → PHONE VIDEO';
  $('sessionTitle').textContent = playbackHere() ? 'Your video' : 'Control Gestures'; hide('playerCard', !playbackHere()); hide('cameraCard', !localMode && playbackHere());
  $('remoteTitle').textContent = playbackHere() ? (phone ? 'Laptop controller' : 'Phone controller') : (phone ? 'Laptop player' : 'Phone player');
  $('remoteIcon').querySelector('use').setAttribute('href', phone ? '#i-laptop' : '#i-phone');
  const peer = phone ? state.laptop : state.phone;
  $('remoteMessage').textContent = !connected ? 'Pair your devices to get started.' : playbackHere() ? (peer.camera ? (state.laptop.gesture || 'Camera active · show a gesture') : 'Enable the camera on the other device.') : (peer.message || 'Open a video on the other device.');
  hide('remotePlayback', playbackHere());
  $('remotePosition').textContent = clock(peer.position); $('remoteDuration').textContent = clock(peer.duration); $('remoteProgress').style.width = (peer.duration ? Math.min(100, peer.position / peer.duration * 100) : 0) + '%';
  document.querySelectorAll('[data-remote]').forEach(e => e.disabled = !connected);
  $('deviceName').textContent = phone ? (state.remembered ? 'My laptop' : 'No laptop paired') : state.remembered ? state.phone.name || 'Android phone' : 'No phone paired';
  $('deviceRole').textContent = connected ? (playbackHere() ? 'Gesture controller' : 'Video player') : 'Open both apps on the same Wi-Fi to connect.';
  $('rememberedText').textContent = state.remembered ? (phone ? 'My laptop' : state.phone.name || 'Android phone') : 'No saved device';
  $('disconnect').disabled = !connected; $('forget').disabled = !state.remembered;
  $('cameraStatus').textContent = starting ? 'STARTING' : cameraOn ? 'CAMERA ACTIVE' : 'CAMERA OFF';
  $('startCamera').disabled = starting || cameraOn || (localMode ? !playback.ready() || player.ended : !connected); $('stopCamera').disabled = !starting && !cameraOn;
  hide('cameraEmpty', cameraOn); hide('previewHidden', !cameraOn || settings.showPreview);
  $('camera').style.visibility = settings.showPreview ? '' : 'hidden'; $('phonePreview').style.visibility = settings.showPreview ? '' : 'hidden';
  $('camera').classList.toggle('mirrored', settings.mirror); $('phonePreview').classList.toggle('mirrored', settings.mirror);
  $('cameraHelp').textContent = phone ? 'Camera images are processed by your laptop over private Wi-Fi. Keep its page open.' : 'Point your thumb left or right as seen in the preview.';
  if (phone && cameraOn && !scan) document.getElementById('gestureText').textContent = state.laptop.gesture || 'Show one clear gesture';
  hide('phonePreview', !phone); hide('camera', phone);
}
function clock(seconds) { const n = Math.max(0, Math.floor(Number(seconds) || 0)); return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0'); }
function updatePlayer() { $('playbackBadge').textContent = !fileName ? 'READY' : playback && playback.mode === 'REWIND' ? 'REWIND · 2×' : player.paused ? 'PAUSED' : 'PLAYING · ' + player.playbackRate + '×'; }
function telemetry() { if (localMode) return { active: false, camera: false }; return { active: !document.hidden && page === 'session', camera: cameraOn && !scan, mirror: settings.mirror, hold: settings.hold, file: fileName, position: player.currentTime || 0, duration: Number.isFinite(player.duration) ? player.duration : 0, playing: !player.paused, message: fileName ? (player.paused ? 'Paused · ' : 'Playing · ') + fileName : 'Open a video on this device.', gesture: names[lastGesture] || '' }; }
async function poll() {
  if (activeSession) {
    try { acceptState(await api('state', telemetry())); }
    catch (e) { if (state.connected && !localMode) { state.connected = false; if (phone && !settings.reconnect) activeSession = false; stopCamera(false); playback.restore().catch(() => {}); render(); notice('Connection interrupted. Check Wi-Fi and keep the laptop page open.', true); } }
  }
  setTimeout(poll, phone ? 350 : 350);
}
let sendQueue = Promise.resolve(), latestCommand = 0;
function send(action) {
  if (localMode) return playback.apply(action).catch(failure);
  if (!activeSession) return Promise.resolve();
  const id = ++latestCommand, epoch = state.epoch, session = sessionGeneration;
  sendQueue = sendQueue.catch(() => {}).then(async () => {
    if (localMode || session !== sessionGeneration || epoch !== state.epoch || (['FORWARD','REWIND'].includes(action) && id !== latestCommand)) return;
    const r = await api('command', { action, epoch });
    if (!localMode && session === sessionGeneration && r.event && r.event.seq > lastSeq && playbackHere() && page === 'session') { lastSeq = r.event.seq; await playback.apply(r.event.action); }
  }).catch(e => { if (action !== 'RESTORE') failure(e); }); return sendQueue;
}
async function ensureDetector() {
  if (detector) return detector;
  if (!detectorPromise) detectorPromise = (async () => {
    const module = await new Function('return import("/vendor/vision_bundle.mjs")')();
    const files = await module.FilesetResolver.forVisionTasks('/vendor/wasm');
    detector = await module.HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: '/hand_landmarker.task', delegate: 'CPU' }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: .65, minHandPresenceConfidence: .65, minTrackingConfidence: .65 }); return detector;
  })().catch(e => { detectorPromise = null; throw e; });
  return detectorPromise;
}
function recognize(input, mirror, hold) {
  const result = detector.detectForVideo(input, performance.now());
  const raw = classifyHand(result.landmarks.length === 1 ? result.landmarks[0] : null, mirror);
  gate.holdMs = hold;
  $('gestureText').textContent = result.landmarks.length > 1 ? 'Show only one hand' : names[raw];
  if (raw !== lastGesture && raw !== 'NONE' && settings.feedback && !phone) sound();
  lastGesture = raw;
  if (!manualKind) { const action = gate.update(raw, performance.now()); if (action) send(action); }
}
async function startCamera() {
  if (starting || cameraOn) return;
  if (localMode && !playback.ready()) return notice('Select a playable video first.', true);
  const generation = ++cameraGeneration; starting = true; render(); notice('');
  try {
    if (phone) { await call('startCamera', { camera: settings.camera, scan: false }); if (generation !== cameraGeneration) { call('stopCamera').catch(() => {}); return; } }
    else {
      if (!navigator.mediaDevices) throw new Error('Use Chrome or Edge at http://localhost:8765.');
      const acquiredStream = await navigator.mediaDevices.getUserMedia({ video: { ...(settings.camera ? { deviceId: { exact: settings.camera } } : {}), width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      if (generation !== cameraGeneration) { acquiredStream.getTracks().forEach(t => t.stop()); return; }
      stream = acquiredStream;
      $('camera').srcObject = stream; await $('camera').play(); await ensureDetector();
      if (generation !== cameraGeneration) return;
      if (document.hidden) { stopCamera(); return; }
      stream.getTracks().forEach(t => t.onended = () => { if (stream === acquiredStream) stopCamera(); });
    }
    cameraOn = true; gate.reset(); lastVideoTime = -1;
  } catch (e) { if (generation === cameraGeneration) { stopCamera(); failure(new Error(e.name === 'NotAllowedError' ? 'Allow camera access, then try again.' : e.message)); } }
  finally { if (generation === cameraGeneration) starting = false; render(); }
}
function stopCamera(notify = true) {
  cameraGeneration++; starting = false; cameraOn = false; gate.reset(); lastGesture = 'NONE';
  if (stream) { stream.getTracks().forEach(t => { t.onended = null; t.stop(); }); stream = null; $('camera').srcObject = null; }
  if (native) call('stopCamera').catch(() => {});
  $('gestureText').textContent = 'Waiting for camera'; if (notify && (localMode || state.epoch)) send('RESTORE'); render();
}
$('startCamera').onclick = startCamera; $('stopCamera').onclick = () => stopCamera();
const remoteImage = new Image();
async function inferenceLoop() {
  if (!phone && page === 'session' && !document.hidden && (localMode || state.connected)) {
    try {
      if ((localMode || mode === 'laptop') && cameraOn && $('camera').readyState >= 2 && $('camera').currentTime !== lastVideoTime) { lastVideoTime = $('camera').currentTime; recognize($('camera'), settings.mirror, settings.hold); }
      else if (!localMode && mode === 'phone' && state.phone.camera && !frameBusy) {
        frameBusy = true; const epoch = state.epoch;
        const response = await timedFetch('/api/frame?after=' + frameId, { headers: { 'X-Controller-Token': token } }, 1600);
        if (response.status === 200) {
          const blob = await response.blob(), url = URL.createObjectURL(blob);
          try { await new Promise((resolve, reject) => { remoteImage.onload = resolve; remoteImage.onerror = () => reject(new Error('Camera frame could not load.')); remoteImage.src = url; }); await ensureDetector();
            if (!localMode && epoch === state.epoch && mode === 'phone' && page === 'session' && !document.hidden) { frameId = Number(response.headers.get('X-Frame-Id')); frameAt = performance.now(); recognize(remoteImage, state.phone.mirror, state.phone.hold); }
          } finally { URL.revokeObjectURL(url); }
        }
      }
      if (!localMode && mode === 'phone' && performance.now() - frameAt > 1300) { const action = gate.update('NONE', performance.now()); if (action) send(action); }
    } catch (e) { gate.reset(); send('RESTORE'); notice('Recognition interrupted: ' + e.message, true); }
    finally { frameBusy = false; }
  }
  setTimeout(inferenceLoop, mode === 'phone' ? 150 : 80);
}
window.nativeEvent = (type, data) => {
  if (type === 'frame') { const image = scan ? $('scanPreview') : $('phonePreview'); image.src = 'data:image/jpeg;base64,' + data.jpeg; }
  if (type === 'cameraStopped') { cameraOn = false; starting = false; render(); if (data.message) notice(data.message, true); }
  if (type === 'pause') { stopCamera(); stopScan(); releaseManual(); playback.stop(); }
};
const qrCanvas = document.createElement('canvas');
$('scanPreview').onload = async () => {
  if (!scan) return;
  const img = $('scanPreview'); qrCanvas.width = img.naturalWidth; qrCanvas.height = img.naturalHeight;
  const ctx = qrCanvas.getContext('2d'); ctx.drawImage(img, 0, 0); const frame = ctx.getImageData(0, 0, qrCanvas.width, qrCanvas.height);
  const result = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
  if (result) { try { const q = JSON.parse(result.data); if (q.app !== 'gesture-video' || q.version !== 2 || !/^\d{8}$/.test(q.code)) return; stopScan(); await pairPhone(q.code, result.data); } catch {} }
};
$('scanQr').onclick = async () => { try { scan = true; hide('scanner', false); await call('startCamera', { camera: 'back', scan: true }); $('scanner').scrollIntoView({ block: 'center' }); } catch (e) { stopScan(); failure(e); } };
function stopScan() { if (!scan) return; scan = false; hide('scanner', true); if (native) call('stopCamera').catch(() => {}); }
$('cancelScan').onclick = stopScan;
$('openVideo').onclick = () => $('videoFile').click();
$('videoFile').onchange = () => { const f = $('videoFile').files[0]; if (!f) return; if (localMode) stopCamera(); playback.stop(); if (fileUrl) URL.revokeObjectURL(fileUrl); fileUrl = URL.createObjectURL(f); fileName = f.name; player.src = fileUrl; player.load(); $('fileName').textContent = fileName; hide('videoEmpty', true); notice(localMode ? 'Video selected. Enable your webcam, then press Play.' : 'Video ready. Press Play once to enable playback.'); updatePlayer(); render(); };
player.onended = () => { playback.ended(); if (localMode) { stopCamera(false); releaseManual(); notice('Video finished. Camera switched off.'); render(); } }; player.onplay = updatePlayer; player.onpause = updatePlayer; player.onratechange = updatePlayer;
player.onerror = () => { if (localMode) stopCamera(); notice('This video could not play. Try an MP4 with H.264 video and AAC audio.', true); render(); };
player.onloadedmetadata = () => { updatePlayer(); render(); };
player.onseeked = render;
setInterval(() => playback.tick().catch(failure), 150);
function releaseManual() { if (!manualKind) return; clearInterval(manualTimer); const local = manualKind === 'local'; manualKind = null; gate.reset(); if (local) playback.apply('RESTORE').catch(failure); else send('RESTORE'); }
for (const kind of ['local','remote']) document.querySelectorAll('[data-' + kind + ']').forEach(button => {
  const action = button.dataset[kind];
  const apply = () => kind === 'local' ? playback.apply(action).catch(failure) : send(action);
  if (['PLAY','PAUSE'].includes(action)) { button.onclick = () => { releaseManual(); gate.reset(); apply(); }; return; }
  const down = () => { releaseManual(); manualKind = kind; apply(); manualTimer = setInterval(apply, 250); };
  button.onpointerdown = e => { e.preventDefault(); button.setPointerCapture(e.pointerId); down(); };
  button.onpointerup = releaseManual; button.onpointercancel = releaseManual; button.onlostpointercapture = releaseManual;
  button.onkeydown = e => { if ([' ','Enter'].includes(e.key) && !e.repeat) { e.preventDefault(); down(); } };
  button.onkeyup = e => { if ([' ','Enter'].includes(e.key)) { e.preventDefault(); releaseManual(); } }; button.onblur = releaseManual;
});
$('disconnect').onclick = async () => { try { stopCamera(); releaseManual(); playback.stop(); await api('disconnect', {}); if (phone) activeSession = false; state.connected = false; render(); notice('Disconnected. Use Reconnect or pair a device.'); } catch (e) { failure(e); } };
$('forget').onclick = async () => { try { stopCamera(); playback.stop(); await api('forget', {}); if (phone) activeSession = false; state.remembered = false; state.connected = false; render(); notice('Saved connection removed.'); } catch (e) { failure(e); } };
function saveSettings() {
  localStorage.setItem('gv-settings-v2', JSON.stringify(settings));
  document.documentElement.classList.toggle('dark', settings.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches));
  $('holdValue').textContent = (settings.hold / 1000).toFixed(2).replace(/0$/, '') + ' seconds'; gate.holdMs = settings.hold; render();
}
for (const id of ['mirror','showPreview','reconnect','feedback']) { $(id).checked = settings[id]; $(id).onchange = () => { settings[id] = $(id).checked; if (id === 'mirror') { gate.reset(); send('RESTORE'); } saveSettings(); }; }
$('hold').value = settings.hold; $('hold').oninput = () => { settings.hold = Number($('hold').value); gate.reset(); send('RESTORE'); saveSettings(); };
$('theme').value = settings.theme; $('theme').onchange = () => { settings.theme = $('theme').value; saveSettings(); };
$('feedbackLabel').textContent = phone ? 'Vibration feedback' : 'Sound feedback';
async function populateCameras() {
  let cameras;
  if (native) cameras = (await call('cameras')).cameras;
  else if (phone) cameras = [{ id: 'front', name: 'Front camera' }, { id: 'back', name: 'Rear camera' }];
  else { if (!navigator.mediaDevices) return; cameras = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput').map((d,i) => ({ id: d.deviceId, name: d.label || 'Camera ' + (i+1) })); cameras.unshift({ id:'',name:'Default webcam' }); }
  $('cameraSelect').textContent = ''; for (const c of cameras) { const option = document.createElement('option'); option.value = c.id; option.textContent = c.name; $('cameraSelect').appendChild(option); } $('cameraSelect').value = settings.camera;
}
$('cameraSelect').onchange = () => { stopCamera(); settings.camera = $('cameraSelect').value; saveSettings(); };
let audio;
function sound() { try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); const o=audio.createOscillator(), g=audio.createGain(); o.connect(g); g.connect(audio.destination); g.gain.value=.04; o.frequency.value=660; o.start(); o.stop(audio.currentTime+.07); } catch {} }
let feedbackGesture = '';
setInterval(() => { const g = state.laptop.gesture; if (phone && settings.feedback && g && g !== feedbackGesture && g !== names.NONE && mode === 'phone') call('feedback').catch(() => {}); feedbackGesture = g; }, 400);
document.addEventListener('visibilitychange', () => { if (document.hidden) { stopCamera(); stopScan(); releaseManual(); playback.stop(); } });
window.addEventListener('pagehide', () => { stopCamera(); releaseManual(); playback.stop(); });
async function init() {
  saveSettings(); render();
  if (native) { const info = await call('setup'); state.remembered = info.remembered; activeSession = info.remembered && settings.reconnect; if (activeSession) { try { await api('resume', {}); } catch {} } }
  else if (!preview) await refreshPair();
  await populateCameras(); render(); poll(); if (!phone) inferenceLoop();
}
init().catch(e => { failure(e); poll(); });

document.getElementById('resumeConnection').onclick = async () => { try { acceptState(await api('resume', {})); activeSession = true; notice('Connection resumed. Open the workspace on both devices.'); navigate('session'); } catch (e) { failure(e); } };
