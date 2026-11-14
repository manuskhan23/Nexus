import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, buf) => (err ? reject(err) : resolve(buf)));
  });
  return `${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, keyHex] = storedHash.split(':');
  if (!salt || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, buf) => (err ? reject(err) : resolve(buf)));
  });
  if (expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(expected, derived);
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function generateNumericOtp(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

export function generateRefreshToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(48).toString('hex');
  return { raw, hash: hashToken(raw) };
}

export interface AccessTokenPayload {
  sub: string;
  email: string;
}

export function signAccessToken(userId: string, email: string): string {
  return jwt.sign({ sub: userId, email }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_SECRET) as AccessTokenPayload;
}

export interface EncryptedPayload {
  iv: string;
  tag: string;
  ciphertext: string;
}

export function encryptSecret(plaintext: string): EncryptedPayload {
  const key = Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: encrypted.toString('hex'),
  };
}

export function decryptSecret(payload: EncryptedPayload): string {
  const key = Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
