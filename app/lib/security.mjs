import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export function randomToken(len = 32) {
  const bytes = randomBytes(len);
  let out = '';
  for (const b of bytes) out += B62[b % 62];
  return out;
}

export function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(pw), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, saltB64, hashB64] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const want = Buffer.from(hashB64, 'base64');
  const got = scryptSync(String(pw), Buffer.from(saltB64, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(want, got);
}

export function makeSigner(secret) {
  return {
    sign(payload) {
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const mac = createHmac('sha256', secret).update(body).digest('base64url');
      return `${body}.${mac}`;
    },
    verify(token) {
      if (!token || typeof token !== 'string' || !token.includes('.')) return null;
      const [body, mac] = token.split('.');
      const want = createHmac('sha256', secret).update(body).digest('base64url');
      if (!mac || mac.length !== want.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
      try {
        const p = JSON.parse(Buffer.from(body, 'base64url').toString());
        return p.exp && p.exp > Date.now() ? p : null;
      } catch {
        return null;
      }
    },
  };
}

// AES-256-GCM for upstream API keys stored in the database.
export function makeCrypto(secret) {
  const key = createHash('sha256').update('aipool-enc:' + secret).digest();
  return {
    encrypt(text) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
      return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
    },
    decrypt(blob) {
      const [v, iv, tag, enc] = String(blob).split('.');
      if (v !== 'v1') throw new Error('unknown ciphertext version');
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
    },
  };
}
