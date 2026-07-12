/**
 * Password-encrypted wallet keystore. The private key is encrypted with
 * AES-256-GCM under a scrypt-derived key and written to disk; the plaintext key
 * never touches the config or the filesystem. This is the same primitive set as
 * the Web3 Secret Storage spec (scrypt KDF + authenticated cipher), kept
 * minimal and dependency-free on Node's built-in `crypto`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes, scryptSync, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto'
import { walletError } from './errors.js'

interface KeystoreFile {
  version: 1
  address: `0x${string}`
  kdf: 'scrypt'
  kdfparams: { N: number; r: number; p: number; keylen: number; salt: string }
  cipher: 'aes-256-gcm'
  iv: string
  ciphertext: string
  tag: string
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32 } as const

function deriveKey(password: string, salt: Buffer): Buffer {
  // maxmem raised so N=2^15 doesn't hit the default 32MB ceiling.
  return scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 128 * 1024 * 1024,
  })
}

/** Encrypt a private key under `password` and write the keystore to `path`. */
export function writeKeystore(path: string, privateKey: `0x${string}`, address: `0x${string}`, password: string): void {
  if (password.length < 8) throw walletError('Wallet password must be at least 8 characters.')
  const salt = randomBytes(32)
  const iv = randomBytes(12)
  const key = deriveKey(password, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(privateKey.replace(/^0x/, ''), 'hex')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  const file: KeystoreFile = {
    version: 1,
    address,
    kdf: 'scrypt',
    kdfparams: { ...SCRYPT, salt: salt.toString('hex') },
    cipher: 'aes-256-gcm',
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: tag.toString('hex'),
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 })
}

/** Read the address a keystore holds without decrypting it. */
export function keystoreAddress(path: string): `0x${string}` {
  const file = readKeystoreFile(path)
  return file.address
}

/** Decrypt the private key from a keystore. Throws on a wrong password. */
export function decryptKeystore(path: string, password: string): `0x${string}` {
  const file = readKeystoreFile(path)
  const salt = Buffer.from(file.kdfparams.salt, 'hex')
  const key = deriveKey(password, salt)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'hex'))
  decipher.setAuthTag(Buffer.from(file.tag, 'hex'))
  try {
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(file.ciphertext, 'hex')),
      decipher.final(),
    ])
    return `0x${plaintext.toString('hex')}`
  } catch {
    throw walletError('Wrong wallet password.', 'The keystore could not be decrypted.')
  }
}

/** Constant-time equality helper (used when confirming a password twice). */
export function passwordsMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export function keystoreExists(path: string): boolean {
  return existsSync(path)
}

function readKeystoreFile(path: string): KeystoreFile {
  if (!existsSync(path)) throw walletError(`No keystore at ${path}.`, 'Create one with `hood config set wallet`.')
  try {
    const file = JSON.parse(readFileSync(path, 'utf8')) as KeystoreFile
    if (file.version !== 1 || file.cipher !== 'aes-256-gcm') throw new Error('unsupported keystore')
    return file
  } catch (err) {
    if (err instanceof Error && err.name === 'CliError') throw err
    throw walletError(`Keystore at ${path} is corrupt or unsupported.`)
  }
}
