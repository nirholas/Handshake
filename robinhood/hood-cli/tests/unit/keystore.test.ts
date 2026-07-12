import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { writeKeystore, decryptKeystore, keystoreAddress, keystoreExists, passwordsMatch } from '../../src/keystore.js'

const dirs: string[] = []
function tmpKeystorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hood-cli-keystore-'))
  dirs.push(dir)
  return join(dir, 'keystore.json')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('keystore encrypt/decrypt round trip', () => {
  it('recovers the exact private key with the right password', () => {
    const path = tmpKeystorePath()
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    writeKeystore(path, pk, account.address, 'correct horse battery staple')

    const recovered = decryptKeystore(path, 'correct horse battery staple')
    expect(recovered.toLowerCase()).toBe(pk.toLowerCase())
  })

  it('refuses to decrypt with the wrong password', () => {
    const path = tmpKeystorePath()
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    writeKeystore(path, pk, account.address, 'correct horse battery staple')

    expect(() => decryptKeystore(path, 'wrong password entirely')).toThrow(/Wrong wallet password/)
  })

  it('rejects a password shorter than 8 characters', () => {
    const path = tmpKeystorePath()
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    expect(() => writeKeystore(path, pk, account.address, 'short')).toThrow(/at least 8 characters/)
  })

  it('exposes the address without needing the password', () => {
    const path = tmpKeystorePath()
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    writeKeystore(path, pk, account.address, 'correct horse battery staple')

    expect(keystoreAddress(path).toLowerCase()).toBe(account.address.toLowerCase())
  })

  it('writes the file with owner-only permissions (0600)', () => {
    const path = tmpKeystorePath()
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    writeKeystore(path, pk, account.address, 'correct horse battery staple')

    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('reports existence correctly', () => {
    const path = tmpKeystorePath()
    expect(keystoreExists(path)).toBe(false)
    const pk = generatePrivateKey()
    writeKeystore(path, pk, privateKeyToAccount(pk).address, 'correct horse battery staple')
    expect(keystoreExists(path)).toBe(true)
  })

  it('throws a clear error reading a missing keystore', () => {
    expect(() => keystoreAddress('/nonexistent/path/keystore.json')).toThrow(/No keystore/)
  })
})

describe('passwordsMatch', () => {
  it('matches identical strings', () => {
    expect(passwordsMatch('abc123', 'abc123')).toBe(true)
  })
  it('rejects different strings', () => {
    expect(passwordsMatch('abc123', 'abc124')).toBe(false)
  })
  it('rejects different-length strings', () => {
    expect(passwordsMatch('abc', 'abcdef')).toBe(false)
  })
})
