// crypto-util.js — AES-256-GCM encrypt/decrypt for at-rest secrets (e.g. SN passwords).
// Key is taken from ASDLC_ENCRYPT_KEY env var (any string; SHA-256 hashed to 32 bytes).
// If the env var is absent the value is stored as plain:<value> and decrypted trivially —
// this lets the feature work in dev without forcing key setup, but logs a warning.
'use strict';

const crypto = require('crypto');

const RAW_KEY = process.env.ASDLC_ENCRYPT_KEY;
if (!RAW_KEY) {
  console.warn('[crypto-util] ASDLC_ENCRYPT_KEY is not set — SN passwords will be stored unencrypted. Set this env var for production use.');
}

// Derive a 32-byte key from an arbitrary-length passphrase.
const KEY = RAW_KEY ? crypto.createHash('sha256').update(RAW_KEY).digest() : null;

const PLAIN_PREFIX = 'plain:';
const ENC_VERSION  = 'v1:';  // iv(24 hex) : tag(32 hex) : ciphertext(hex)

/**
 * Encrypt plaintext → stored string.
 * Returns the original string un-encrypted (prefixed) when no key is configured.
 */
function encrypt(plaintext) {
  if (!KEY) return PLAIN_PREFIX + plaintext;
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_VERSION + iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted.toString('hex');
}

/**
 * Decrypt a stored string back to plaintext.
 * Returns null if stored is null/undefined/empty.
 */
function decrypt(stored) {
  if (!stored) return null;
  if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length);
  if (!stored.startsWith(ENC_VERSION)) return stored; // legacy unversioned plain value
  if (!KEY) {
    console.warn('[crypto-util] Cannot decrypt — ASDLC_ENCRYPT_KEY is not set.');
    return null;
  }
  const parts = stored.slice(ENC_VERSION.length).split(':');
  if (parts.length !== 3) return null;
  const [ivHex, tagHex, ctHex] = parts;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(ctHex, 'hex')).toString('utf8') + decipher.final('utf8');
  } catch {
    console.error('[crypto-util] Decryption failed — wrong key or corrupted value.');
    return null;
  }
}

module.exports = { encrypt, decrypt };
