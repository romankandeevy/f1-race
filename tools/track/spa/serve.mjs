// Отдаёт папку tools/track/spa (parts.mjs, out/spa-data.json) по http://127.0.0.1:8799 (с CORS) — чтобы код в Forma (model3d_run) мог взять готовые числа.
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
const dir = path.dirname(fileURLToPath(import.meta.url))
http.createServer((req, res) => {
  const f = path.join(dir, decodeURIComponent(req.url.split('?')[0]))
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'Content-Type': f.endsWith('.json') ? 'application/json' : /\.m?js$/.test(f) ? 'text/javascript' : 'application/octet-stream', 'Cache-Control': 'no-store' })
  fs.createReadStream(f).pipe(res)
}).listen(8799, '127.0.0.1', () => console.log('serve', dir))
