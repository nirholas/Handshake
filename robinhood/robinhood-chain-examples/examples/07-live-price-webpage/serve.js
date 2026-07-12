/**
 * Zero-dependency static server for index.html — just so `npm start` works.
 * The page itself needs no server: opening index.html in a browser (or hosting
 * it on GitHub Pages) works identically, because every read is a client-side
 * JSON-RPC call to the public Robinhood Chain RPC.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const dir = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.PORT) || 8007

createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url
  try {
    const body = await readFile(join(dir, path.split('?')[0]))
    res.writeHead(200, { 'content-type': path.endsWith('.html') ? 'text/html' : 'text/plain' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(port, () => console.log(`Live prices → http://localhost:${port}`))
