import nodemailer from 'nodemailer';
import { env } from '../../config/env';

let smtpAuthDisabled = false;

const transporter =
  env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS
    ? nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: {
          user: env.SMTP_USER,
          pass:
            env.SMTP_HOST.includes('gmail.com')
              ? env.SMTP_PASS.replace(/\s+/g, '')
              : env.SMTP_PASS,
        },
      })
    : null;

export async function sendOtpEmail(
  to: string,
  otp: string,
  purpose: 'email_verification' | 'password_reset'
): Promise<boolean> {
  if (!transporter || smtpAuthDisabled) {
    console.log(`[NEXUS OTP] SMTP unavailable. ${purpose} code for ${to}: ${otp}`);
    return false;
  }

  const subject =
    purpose === 'email_verification'
      ? 'NEXUS — Verify Your Email Address'
      : 'NEXUS — Password Reset Code';

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px;">
      <h2 style="margin: 0 0 12px; color: #0f172a; font-size: 18px;">NEXUS</h2>
      <p style="color: #334155; font-size: 14px; line-height: 1.5;">
        ${
          purpose === 'email_verification'
            ? 'Use the 6-digit verification code below to activate your NEXUS workspace account:'
            : 'Use the 6-digit verification code below to reset your NEXUS password:'
        }
      </p>
      <div style="margin: 20px 0; padding: 14px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; text-align: center; font-size: 28px; font-weight: 700; letter-spacing: 6px; color: #0f172a;">
        ${otp}
      </div>
      <p style="color: #64748b; font-size: 12px;">This code expires in 10 minutes. If you did not request this, you can safely ignore this email.</p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: env.SMTP_FROM,
      to,
      subject,
      html,
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/535|Username and Password not accepted|Invalid login/i.test(msg)) {
      smtpAuthDisabled = true;
    }
    console.warn(`[NEXUS OTP] SMTP delivery skipped (${msg}). Using in-app verification fallback.`);
    return false;
  }
}
