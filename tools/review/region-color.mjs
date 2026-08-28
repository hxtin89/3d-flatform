import { chromium } from 'playwright'
import { readFile } from 'node:fs/promises'
const [, , path, X, Y, W, H] = process.argv
const b64 = (await readFile(path)).toString('base64')
const br = await chromium.launch(); const pg = await br.newPage()
await pg.setContent('<canvas id="c"></canvas>')
console.log(await pg.evaluate(async ({ b64, X, Y, W, H }) => {
  const img = new Image(); await new Promise(r => { img.onload = r; img.src = 'data:image/png;base64,' + b64 })
  const cv = document.getElementById('c'); cv.width = img.width; cv.height = img.height
  const x = cv.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0)
  const d = x.getImageData(0, 0, cv.width, cv.height).data
  let n = 0, y0 = 1e9, y1 = -1, x0 = 1e9, x1 = -1
  for (let yy = +Y; yy < +Y + +H; yy++) for (let xx = +X; xx < +X + +W; xx++) {
    const i = (yy * cv.width + xx) * 4
    if (Math.abs(d[i] - 220) < 3 && Math.abs(d[i+1] - 220) < 3 && Math.abs(d[i+2] - 220) < 3) {
      n++; if (yy<y0)y0=yy; if(yy>y1)y1=yy; if(xx<x0)x0=xx; if(xx>x1)x1=xx
    }
  }
  return n ? `frame-grey ${n}px  bbox ${x0},${y0}..${x1},${y1}` : 'no frame grey in region'
}, { b64, X, Y, W, H }))
await br.close()
