import crypto from 'node:crypto';

export type PasswordPolicyResult = { ok: true } | { ok: false; errors: string[] };

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validatePassword(password: string): PasswordPolicyResult {
  const errors: string[] = [];
  const p = password ?? '';

  if (p.length < 8) errors.push('A password deve ter pelo menos 8 caracteres.');
  if (p.length > 72) errors.push('A password deve ter no máximo 72 caracteres.');
  if (/\s/.test(p)) errors.push('A password não deve conter espaços.');
  if (!/[a-z]/.test(p)) errors.push('A password deve incluir pelo menos 1 letra minúscula.');
  if (!/[A-Z]/.test(p)) errors.push('A password deve incluir pelo menos 1 letra maiúscula.');
  if (!/[0-9]/.test(p)) errors.push('A password deve incluir pelo menos 1 número.');
  if (!/[^A-Za-z0-9]/.test(p)) errors.push('A password deve incluir pelo menos 1 símbolo.');

  return errors.length ? { ok: false, errors } : { ok: true };
}

type HashResult = { saltB64: string; hashB64: string };

export async function hashPassword(password: string): Promise<HashResult> {
  const salt = crypto.randomBytes(16);
  const keyLen = 64;
  const hash = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, keyLen, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey as Buffer);
    });
  });
  return { saltB64: salt.toString('base64'), hashB64: hash.toString('base64') };
}

export async function verifyPassword(password: string, saltB64: string, hashB64: string): Promise<boolean> {
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const keyLen = expected.length;

  const actual = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, keyLen, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey as Buffer);
    });
  });

  return crypto.timingSafeEqual(actual, expected);
}

export function newToken(): string {
  // 32 bytes => 43 chars base64url
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
