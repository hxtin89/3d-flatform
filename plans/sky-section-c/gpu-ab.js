// Pasted after harness.js. GPU A/B per sky switch: p25 of three 120-frame runs per arm.
window.__toggle = async (label, on) => {
  const b = [...document.querySelectorAll('button')].find(e => e.textContent.startsWith(label + ' ·'));
  if (!b) return 'missing ' + label;
  const isOn = b.textContent.endsWith('On');
  if (isOn !== on) b.click();
  return b.textContent;
};
window.__gpu = async (frames) => {
  const r = __three.renderer; const v = [];
  for (let i = 0; i < frames; i++) {
    await new Promise(res => requestAnimationFrame(() => res()));
    try { await r.resolveTimestampsAsync(); const t = r.info.render.timestamp; if (t > 0) v.push(t) } catch {}
  }
  v.sort((a, b) => a - b);
  const q = (f) => +v[Math.floor(v.length * f)]?.toFixed(2);
  return { n: v.length, p10: q(0.1), p25: q(0.25), med: q(0.5) };
};
window.__settle = async () => {
  for (let i = 0; i < 80 && (__wild.clouds?.debug?.().bakeActive); i++) await __wait(500);
  await __wait(2500);
};
window.__arms = window.__arms ?? [
  ['all on', null],
  ['haze off', 'Distance haze'],
  ['sun light off', '☀ Sun light'],
  ['clouds off', '☁ Sky clouds'],
  ['shadows off', '◑ Canopy shadows'],
  ['sky off', '◐ Physical sky'],
];
window.__gpuResult = null;
window.__gpuProgress = [];
window.__job = (async () => {
  const out = {};
  // Interleaved rounds, so slow drift (tiles still arriving, thermal) lands on every arm alike.
  for (let round = 0; round < 3; round++) {
    for (const [name, label] of __arms) {
      if (label) await __toggle(label, false);
      await __settle();
      const r = await __gpu(120);
      (out[name] ??= []).push(r.p25);
      __gpuProgress.push(`${round}:${name}:${r.p25}`);
      if (label) { await __toggle(label, true); }
    }
  }
  await __settle();
  window.__gpuResult = out;
  return out;
})();
'started'
