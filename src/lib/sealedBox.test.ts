import { describe, expect, it } from 'vitest'
import nacl from 'tweetnacl'
import { base64ToBytes, bytesToBase64, encryptSecret, openSealedBox, sealBox } from './sealedBox'

describe('sealed box (crypto_box_seal)', () => {
  it('seals a message the recipient secret key opens', () => {
    const recipient = nacl.box.keyPair()
    const message = new TextEncoder().encode('hunter2 – ünïcode ✓')
    const sealed = sealBox(message, recipient.publicKey)
    // ephemeral public key (32) + Poly1305 tag (16) + ciphertext
    expect(sealed.length).toBe(32 + 16 + message.length)
    const opened = openSealedBox(sealed, recipient.publicKey, recipient.secretKey)
    expect(opened && new TextDecoder().decode(opened)).toBe('hunter2 – ünïcode ✓')
  })

  it('uses a fresh ephemeral key every time and fails for anyone else', () => {
    const recipient = nacl.box.keyPair()
    const other = nacl.box.keyPair()
    const msg = new Uint8Array([1, 2, 3])
    const a = sealBox(msg, recipient.publicKey)
    const b = sealBox(msg, recipient.publicKey)
    expect(bytesToBase64(a)).not.toBe(bytesToBase64(b))
    expect(openSealedBox(a, other.publicKey, other.secretKey)).toBeNull()
    const tampered = a.slice()
    tampered[tampered.length - 1] ^= 1
    expect(openSealedBox(tampered, recipient.publicKey, recipient.secretKey)).toBeNull()
  })

  it('encrypts a secret value from and to base64, as the Actions secrets API uses', () => {
    const recipient = nacl.box.keyPair()
    const encrypted = encryptSecret('s3cret', bytesToBase64(recipient.publicKey))
    const opened = openSealedBox(base64ToBytes(encrypted), recipient.publicKey, recipient.secretKey)
    expect(opened && new TextDecoder().decode(opened)).toBe('s3cret')
    expect(() => encryptSecret('x', bytesToBase64(new Uint8Array(16)))).toThrow(/32-byte/)
  })
})
