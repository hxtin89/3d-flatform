// Pasted into the page after a reload. Boots, lands, rain off, defines the capture helpers.
const W = (ms) => new Promise(r => setTimeout(r, ms));
window.__wait = W;
window.__setupDone = false;
(async () => {
  for (let i = 0; i < 240 && !document.querySelector('#loader.is-ready'); i++) await W(500);
  await W(800);
  document.querySelector('#loaderStart')?.click();
  await W(2000);
  for (let i = 0; i < 120 && window.__wild?.flight; i++) await W(500);
  await W(1500);
  const V = __three.camera.position.constructor;
  window.__pose = (azDeg, pitchDeg, zEnu = null, xyEnu = null) => {
    const cam = __three.camera; const o = __wild.origin;
    const e = cam.position.clone().applyMatrix4(o.enuInverseRender);
    if (zEnu != null) e.z = zEnu;
    if (xyEnu) { e.x = xyEnu[0]; e.y = xyEnu[1]; }
    const az = azDeg * Math.PI / 180, pitch = pitchDeg * Math.PI / 180;
    const d = new V(Math.sin(az) * Math.cos(pitch), Math.cos(az) * Math.cos(pitch), Math.sin(pitch));
    const p = e.clone().applyMatrix4(o.enuFrameRender);
    const t = e.clone().add(d.clone().multiplyScalar(1000)).applyMatrix4(o.enuFrameRender);
    __wild.controls.enabled = false;
    cam.position.copy(p); cam.up.copy(new V(0, 0, 1).transformDirection(o.enuFrameRender)); cam.lookAt(t); cam.updateMatrixWorld();
    return e.toArray().map(v => Math.round(v));
  };
  window.__cap = async (name, scale = 0.6) => {
    const c = __three.renderer.domElement;
    __three.depthOfField.render();
    const off = document.createElement('canvas'); off.width = Math.round(c.width * scale); off.height = Math.round(c.height * scale);
    off.getContext('2d').drawImage(c, 0, 0, off.width, off.height);
    const blob = await new Promise(res => off.toBlob(res, 'image/jpeg', 0.88));
    await fetch('http://127.0.0.1:5231/save?name=' + name + '.jpg', { method: 'POST', body: blob });
    return blob.size;
  };
  window.__bakeDone = async (maxMs = 60000) => {
    const t0 = performance.now(); await W(1500);
    while (performance.now() - t0 < maxMs) { const d = __wild.clouds.debug(); if (!d.pending && !d.bakeActive && d.blend >= 1 && d.finished > 0) break; await W(500) }
    await W(2500);
  };
  window.__preset = async (name) => { const s = document.querySelector('#skyCloudPreset'); s.value = name; s.dispatchEvent(new Event('change', { bubbles: true })); s.dispatchEvent(new Event('input', { bubbles: true })); await __bakeDone(); return s.value };
  window.__time = async (min) => { const s = document.querySelector('#peruTimeSlider'); s.value = String(min); s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); await __bakeDone(); return s.value };
  window.__sunAz = () => { const s = __three.uniforms.sunDirectionEnu.value; return Math.round(Math.atan2(s.x, s.y) * 180 / Math.PI) };
  const rain = document.querySelector('#rainToggle');
  if (rain && !/Off/.test(rain.textContent)) rain.click();
  __pose(250, 3, 110);
  await __bakeDone(20000);
  window.__setupDone = true;
})();
'started'
