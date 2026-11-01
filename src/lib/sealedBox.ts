// libsodium's crypto_box_seal in pure JS (tweetnacl + blakejs), for GitHub Actions secrets. libsodium-wrappers needs
// wasm, which neither the web build's CSP nor the desktop CSP allows.
import nacl from 'tweetnacl'
import { blake2b } from 'blakejs'

const KEY_BYTES = nacl.box.publicKeyLength // 32

/** crypto_box_seal's nonce: blake2b(ephemeralPk || recipientPk) truncated to 24 bytes. */
function sealNonce(ephemeralPk: Uint8Array, recipientPk: Uint8Array) {
  const input = new Uint8Array(KEY_BYTES * 2)
  input.set(ephemeralPk)
  input.set(recipientPk, KEY_BYTES)
  return blake2b(input, undefined, nacl.box.nonceLength)
}

/** Seals `message` for `recipientPk` with a one-time key pair: ephemeralPk || box(message). Only the recipient can open it. */
export function sealBox(message: Uint8Array, recipientPk: Uint8Array): Uint8Array {
  if (recipientPk.length !== KEY_BYTES) throw new Error('The repository public key is not a 32-byte Curve25519 key.')
  const ephemeral = nacl.box.keyPair()
  const box = nacl.box(message, sealNonce(ephemeral.publicKey, recipientPk), recipientPk, ephemeral.secretKey)
  ephemeral.secretKey.fill(0)
  const out = new Uint8Array(KEY_BYTES + box.length)
  out.set(ephemeral.publicKey)
  out.set(box, KEY_BYTES)
  return out
}

/** crypto_box_seal_open: what GitHub does with an uploaded secret. Null when the box was not sealed for this key pair. */
export function openSealedBox(sealed: Uint8Array, recipientPk: Uint8Array, recipientSk: Uint8Array): Uint8Array | null {
  if (sealed.length < KEY_BYTES + nacl.box.overheadLength) return null
  const ephemeralPk = sealed.subarray(0, KEY_BYTES)
  return nacl.box.open(sealed.subarray(KEY_BYTES), sealNonce(ephemeralPk, recipientPk), ephemeralPk, recipientSk)
}

export function base64ToBytes(b64: string) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToBase64(bytes: Uint8Array) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

/** A secret value encrypted with the repository's Actions public key (base64 in, base64 out), as the secrets API expects. */
export function encryptSecret(value: string, publicKeyB64: string) {
  return bytesToBase64(sealBox(new TextEncoder().encode(value), base64ToBytes(publicKeyB64)))
}
