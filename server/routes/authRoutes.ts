import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { AuthenticatedRequest, rateLimit, requireAuth } from '../middleware/auth';
import { OtpTokenModel, RefreshSessionModel, UserDoc, UserModel } from '../models';
import {
  generateNumericOtp,
  generateRefreshToken,
  hashPassword,
  hashToken,
  signAccessToken,
  verifyPassword,
} from '../services/auth/crypto';
import { sendOtpEmail } from '../services/auth/emailService';

const router = Router();
const REFRESH_COOKIE = 'nexus_refresh_token';
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sanitizeUser(u: UserDoc) {
  return {
    id: u._id,
    fullName: u.fullName,
    email: u.email,
    isEmailVerified: u.isEmailVerified,
    preferences: u.preferences,
  };
}

function getCookieOptions(req: any) {
  const isHttps =
    Boolean(req.secure) ||
    req.headers?.['x-forwarded-proto'] === 'https' ||
    env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isHttps,
    sameSite: (isHttps ? 'none' : 'lax') as 'none' | 'lax',
    ...(isHttps ? { partitioned: true } : {}),
    path: '/api/auth',
  };
}

function setRefreshCookie(req: any, res: any, rawToken: string) {
  res.cookie(REFRESH_COOKIE, rawToken, {
    ...getCookieOptions(req),
    maxAge: REFRESH_TTL_MS,
  });
}

async function createSession(req: any, res: any, user: UserDoc, userAgent?: string) {
  const accessToken = signAccessToken(user._id, user.email);
  const refresh = generateRefreshToken();
  await RefreshSessionModel.create({
    _id: crypto.randomUUID(),
    userId: user._id,
    tokenHash: refresh.hash,
    userAgent,
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
  });
  setRefreshCookie(req, res, refresh.raw);
  return { accessToken, refreshToken: refresh.raw, user: sanitizeUser(user) };
}

const registerSchema = z.object({
  fullName: z.string().trim().min(2, 'Full name must be at least 2 characters').max(100),
  email: z.string().trim().email('Enter a valid email address').toLowerCase(),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Password must include at least one uppercase letter')
    .regex(/[0-9]/, 'Password must include at least one number'),
});

router.post('/register', rateLimit(20, 15 * 60 * 1000), async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid registration input' });
    return;
  }

  const { fullName, email, password } = parsed.data;
  if (await UserModel.findOne({ email }).lean()) {
    res.status(409).json({ error: 'An account with this email already exists' });
    return;
  }

  const user = await UserModel.create({
    _id: crypto.randomUUID(),
    fullName,
    email,
    passwordHash: await hashPassword(password),
    isEmailVerified: false,
    preferences: {
      theme: 'system',
      defaultProviderMode: env.AI_PROVIDER_MODE,
      preferredProvider: env.DEFAULT_AI_PROVIDER,
      autoExecuteLowRisk: true,
      requireApprovalForModerate: true,
    },
  });

  const otp = generateNumericOtp();
  await OtpTokenModel.deleteMany({ userId: user._id, purpose: 'email_verification' });
  await OtpTokenModel.create({
    _id: crypto.randomUUID(),
    userId: user._id,
    email,
    purpose: 'email_verification',
    otpHash: hashToken(otp),
    attempts: 0,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  const sent = await sendOtpEmail(email, otp, 'email_verification');

  res.status(201).json({
    message: sent
      ? 'Account created. Check your email inbox for the 6-digit verification code.'
      : 'Account created. Enter the 6-digit verification code to continue.',
    email,
    ...(!sent && env.NODE_ENV !== 'production' ? { devOtpCode: otp } : {}),
  });
});

router.post('/verify-otp', rateLimit(15, 10 * 60 * 1000), async (req, res) => {
  const schema = z.object({
    email: z.string().trim().email().toLowerCase(),
    otp: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid OTP payload' });
    return;
  }

  const { email, otp } = parsed.data;
  const record = await OtpTokenModel.findOne({ email, purpose: 'email_verification' });
  if (!record || record.expiresAt.getTime() < Date.now()) {
    res.status(400).json({ error: 'Verification code expired or not found' });
    return;
  }

  if (record.attempts >= 5) {
    res.status(429).json({ error: 'Maximum OTP attempts reached. Request a new code.' });
    return;
  }

  if (record.otpHash !== hashToken(otp)) {
    record.attempts += 1;
    await record.save();
    res.status(400).json({ error: 'Incorrect verification code' });
    return;
  }

  const user = await UserModel.findByIdAndUpdate(
    record.userId,
    { isEmailVerified: true },
    { new: true }
  );
  await OtpTokenModel.deleteMany({ userId: record.userId, purpose: 'email_verification' });

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const session = await createSession(req, res, user, req.headers['user-agent']);
  res.json(session);
});

router.post('/resend-otp', rateLimit(10, 10 * 60 * 1000), async (req, res) => {
  const schema = z.object({ email: z.string().trim().email().toLowerCase() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Valid email is required' });
    return;
  }

  const user = await UserModel.findOne({ email: parsed.data.email });
  if (!user || user.isEmailVerified) {
    res.json({ message: 'If an unverified account exists, a new code has been issued.' });
    return;
  }

  const otp = generateNumericOtp();
  await OtpTokenModel.deleteMany({ userId: user._id, purpose: 'email_verification' });
  await OtpTokenModel.create({
    _id: crypto.randomUUID(),
    userId: user._id,
    email: user.email,
    purpose: 'email_verification',
    otpHash: hashToken(otp),
    attempts: 0,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  const sent = await sendOtpEmail(user.email, otp, 'email_verification');

  res.json({
    message: sent ? 'Verification code sent to your email.' : 'Verification code re-issued.',
    ...(!sent && env.NODE_ENV !== 'production' ? { devOtpCode: otp } : {}),
  });
});

router.post('/login', rateLimit(25, 15 * 60 * 1000), async (req, res) => {
  const schema = z.object({
    email: z.string().trim().email().toLowerCase(),
    password: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  const { email, password } = parsed.data;
  const user = await UserModel.findOne({ email });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  if (!user.isEmailVerified) {
    res.status(403).json({
      error: 'Email verification required before signing in.',
      code: 'EMAIL_NOT_VERIFIED',
    });
    return;
  }

  const session = await createSession(req, res, user, req.headers['user-agent']);
  res.json(session);
});

router.post('/demo', async (req, res) => {
  const demoUser = await UserModel.findOne({ email: 'demo@nexus.ai' });
  if (!demoUser) {
    res.status(404).json({ error: 'Demo workspace unavailable' });
    return;
  }
  const session = await createSession(req, res, demoUser, req.headers['user-agent']);
  res.json(session);
});

router.post('/refresh', async (req, res) => {
  const raw =
    req.cookies?.[REFRESH_COOKIE] ||
    (typeof req.body?.refreshToken === 'string' ? req.body.refreshToken.trim() : '');
  if (!raw) {
    res.status(401).json({ error: 'No refresh session' });
    return;
  }

  const tokenHash = hashToken(raw);
  const existing = await RefreshSessionModel.findOne({ tokenHash });
  if (!existing || existing.expiresAt.getTime() < Date.now()) {
    res.clearCookie(REFRESH_COOKIE, getCookieOptions(req));
    res.status(401).json({ error: 'Session expired' });
    return;
  }

  const user = await UserModel.findById(existing.userId);
  // Allow a brief 15s grace window in case concurrent requests refresh simultaneously
  existing.expiresAt = new Date(Math.min(existing.expiresAt.getTime(), Date.now() + 15_000));
  await existing.save().catch(() => undefined);

  if (!user) {
    res.status(401).json({ error: 'User not found' });
    return;
  }

  const session = await createSession(req, res, user, req.headers['user-agent']);
  res.json(session);
});

router.post('/logout', async (req, res) => {
  const raw =
    req.cookies?.[REFRESH_COOKIE] ||
    (typeof req.body?.refreshToken === 'string' ? req.body.refreshToken.trim() : '');
  if (raw) {
    await RefreshSessionModel.deleteOne({ tokenHash: hashToken(raw) });
  }
  res.clearCookie(REFRESH_COOKIE, getCookieOptions(req));
  res.json({ message: 'Signed out' });
});

router.post('/forgot-password', rateLimit(10, 10 * 60 * 1000), async (req, res) => {
  const schema = z.object({ email: z.string().trim().email().toLowerCase() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Valid email is required' });
    return;
  }

  const user = await UserModel.findOne({ email: parsed.data.email });
  let devOtpCode: string | undefined;
  if (user) {
    const otp = generateNumericOtp();
    await OtpTokenModel.deleteMany({ userId: user._id, purpose: 'password_reset' });
    await OtpTokenModel.create({
      _id: crypto.randomUUID(),
      userId: user._id,
      email: user.email,
      purpose: 'password_reset',
      otpHash: hashToken(otp),
      attempts: 0,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const sent = await sendOtpEmail(user.email, otp, 'password_reset');
    if (!sent && env.NODE_ENV !== 'production') devOtpCode = otp;
  }

  res.json({
    message: 'If an account with that email exists, a password reset code has been sent.',
    ...(devOtpCode ? { devOtpCode } : {}),
  });
});

router.post('/reset-password', rateLimit(10, 10 * 60 * 1000), async (req, res) => {
  const schema = z.object({
    email: z.string().trim().email().toLowerCase(),
    otp: z.string().regex(/^\d{6}$/),
    newPassword: z
      .string()
      .min(8)
      .regex(/[A-Z]/)
      .regex(/[0-9]/),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Provide a valid email, 6-digit code, and strong password.' });
    return;
  }

  const { email, otp, newPassword } = parsed.data;
  const record = await OtpTokenModel.findOne({ email, purpose: 'password_reset' });
  if (!record || record.expiresAt.getTime() < Date.now() || record.attempts >= 5) {
    res.status(400).json({ error: 'Invalid or expired reset code' });
    return;
  }

  if (record.otpHash !== hashToken(otp)) {
    record.attempts += 1;
    await record.save();
    res.status(400).json({ error: 'Incorrect reset code' });
    return;
  }

  const passwordHash = await hashPassword(newPassword);
  await UserModel.findByIdAndUpdate(record.userId, { passwordHash });
  await OtpTokenModel.deleteMany({ userId: record.userId, purpose: 'password_reset' });
  await RefreshSessionModel.deleteMany({ userId: record.userId });

  res.json({ message: 'Password updated. You may now sign in.' });
});

router.get('/me', requireAuth, (req: AuthenticatedRequest, res) => {
  res.json({ user: sanitizeUser(req.user!) });
});

router.patch('/preferences', requireAuth, async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    fullName: z.string().trim().min(2).max(100).optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
    defaultProviderMode: z.enum(['automatic', 'gemini_only', 'groq_only']).optional(),
    preferredProvider: z.enum(['gemini', 'groq']).optional(),
    autoExecuteLowRisk: z.boolean().optional(),
    requireApprovalForModerate: z.boolean().optional(),
    autoLearnFromErrors: z.boolean().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid preference update' });
    return;
  }

  const user = req.user!;
  const p = parsed.data;
  if (p.fullName) user.fullName = p.fullName;
  if (p.theme) user.preferences.theme = p.theme;
  if (p.defaultProviderMode) user.preferences.defaultProviderMode = p.defaultProviderMode;
  if (p.preferredProvider) user.preferences.preferredProvider = p.preferredProvider;
  if (typeof p.autoExecuteLowRisk === 'boolean') {
    user.preferences.autoExecuteLowRisk = p.autoExecuteLowRisk;
  }
  if (typeof p.requireApprovalForModerate === 'boolean') {
    user.preferences.requireApprovalForModerate = p.requireApprovalForModerate;
  }
  if (typeof p.autoLearnFromErrors === 'boolean') {
    user.preferences.autoLearnFromErrors = p.autoLearnFromErrors;
  }
  await user.save();

  res.json({ user: sanitizeUser(user) });
});

export default router;
