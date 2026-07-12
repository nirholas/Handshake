/**
 * serve.mjs — zero-dependency static server for local preview of docs/.
 * Rewrites /slug → /slug/index.html so the built site works exactly as it
 * will on GitHub Pages. Run: npm run serve  (or npm run dev to build first).
 */
import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'docs')
const PORT = process.env.PORT ? Number(process.env.PORT) : 4173
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0])
    if (urlPath.endsWith('/')) urlPath += 'index.html'
    let filePath = path.join(ROOT, urlPath)
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden') }
    let data
    try {
      data = await fs.readFile(filePath)
    } catch {
      // try /path/index.html for extensionless routes
      if (!path.extname(filePath)) {
        filePath = path.join(filePath, 'index.html')
        data = await fs.readFile(filePath)
      } else {
        throw new Error('not found')
      }
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(filePath)] || 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<h1>404</h1><p><a href="/">Home</a></p>')
  }
})

server.listen(PORT, () => console.log(`learn-robinhood-chain preview → http://localhost:${PORT}`))
