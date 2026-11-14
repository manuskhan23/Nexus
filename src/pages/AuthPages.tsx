import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ThemeToggle } from '../components/ThemeToggle';
import { apiRequest } from '../services/api';
import { AuthUser, useAuthStore } from '../stores/authStore';

export function LoginPage() {
  const navigate = useNavigate();
  const setSession = useAuthStore((s) => s.setSession);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await apiRequest<{ user: AuthUser; accessToken: string; refreshToken?: string }>(
        '/api/auth/login',
        {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        }
      );
      setSession(data.user, data.accessToken, data.refreshToken);
      navigate('/dashboard');
    } catch (err: any) {
      if (err.data?.code === 'EMAIL_NOT_VERIFIED') {
        navigate(`/verify-otp?email=${encodeURIComponent(email)}`);
        return;
      }
      setError(err.message || 'Sign in failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleDemoSignIn() {
    setError('');
    setLoading(true);
    try {
      const data = await apiRequest<{ user: AuthUser; accessToken: string; refreshToken?: string }>(
        '/api/auth/demo',
        {
          method: 'POST',
        }
      );
      setSession(data.user, data.accessToken, data.refreshToken);
      navigate('/dashboard');
    } catch (err: any) {
      setError(err.message || 'Demo workspace unavailable');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col justify-between bg-slate-50 dark:bg-zinc-950 p-6 text-slate-900 dark:text-zinc-100">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between gap-8">
        <span className="text-base font-bold tracking-tight whitespace-nowrap shrink-0">NEXUS</span>
        <ThemeToggle compact />
      </header>

      <div className="mx-auto my-8 w-full max-w-md rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-8">
        <h1 className="text-xl font-semibold tracking-tight">Sign in to NEXUS</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-zinc-400">
          Autonomous digital agent workspace with Gemini and Groq routing
        </p>

        {error && (
          <div className="mt-4 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3 py-2.5 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1.5">
              Email Address
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
              className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1.5">
              Password
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-slate-900 dark:bg-zinc-100 py-2.5 px-4 text-sm font-medium text-white dark:text-zinc-900 hover:bg-slate-800 dark:hover:bg-zinc-200 transition-colors cursor-pointer disabled:opacity-50"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div className="my-5 flex items-center gap-3 text-xs text-slate-400 dark:text-zinc-500">
          <div className="h-px flex-1 bg-slate-200 dark:bg-zinc-800" />
          <span>or</span>
          <div className="h-px flex-1 bg-slate-200 dark:bg-zinc-800" />
        </div>

        <button
          type="button"
          onClick={handleDemoSignIn}
          disabled={loading}
          className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800/60 py-2.5 px-4 text-sm font-medium text-slate-900 dark:text-zinc-100 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-50"
        >
          Continue with Demo Workspace
        </button>

        <div className="mt-6 flex items-center justify-between text-xs text-slate-600 dark:text-zinc-400">
          <Link to="/register" className="hover:underline">
            Create an account
          </Link>
          <Link to="/forgot-password" className="hover:underline">
            Forgot password?
          </Link>
        </div>
      </div>

      <footer className="mx-auto w-full max-w-5xl text-xs text-slate-500 dark:text-zinc-500">
        NEXUS Agent Platform
      </footer>
    </div>
  );
}

export function RegisterPage() {
  const navigate = useNavigate();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await apiRequest<{ email: string; devOtpCode?: string }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ fullName, email, password }),
      });
      const params = new URLSearchParams({ email: data.email });
      if (data.devOtpCode) params.set('previewOtp', data.devOtpCode);
      navigate(`/verify-otp?${params.toString()}`);
    } catch (err: any) {
      setError(err.message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-zinc-950 p-6 text-slate-900 dark:text-zinc-100">
      <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-8">
        <h1 className="text-xl font-semibold tracking-tight">Create your NEXUS account</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-zinc-400">
          Verify your email with a 6-digit code to activate your workspace.
        </p>

        {error && (
          <div className="mt-4 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3 py-2.5 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1.5">
              Full Name
            </label>
            <input
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Ada Lovelace"
              className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1.5">
              Email Address
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ada@example.com"
              className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1.5">
              Password (8+ chars, 1 uppercase, 1 number)
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/40"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-slate-900 dark:bg-zinc-100 py-2.5 px-4 text-sm font-medium text-white dark:text-zinc-900 hover:bg-slate-800 dark:hover:bg-zinc-200 transition-colors cursor-pointer disabled:opacity-50"
          >
            {loading ? 'Creating account...' : 'Create Account'}
          </button>
        </form>

        <p className="mt-5 text-center text-xs text-slate-600 dark:text-zinc-400">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-slate-900 dark:text-zinc-100 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

export function VerifyOtpPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const setSession = useAuthStore((s) => s.setSession);
  const [email, setEmail] = useState(searchParams.get('email') || '');
  const [otp, setOtp] = useState(searchParams.get('previewOtp') || '');
  const [previewOtp, setPreviewOtp] = useState(searchParams.get('previewOtp') || '');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await apiRequest<{ user: AuthUser; accessToken: string; refreshToken?: string }>(
        '/api/auth/verify-otp',
        {
          method: 'POST',
          body: JSON.stringify({ email, otp }),
        }
      );
      setSession(data.user, data.accessToken, data.refreshToken);
      navigate('/dashboard');
    } catch (err: any) {
      setError(err.message || 'Verification failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    setError('');
    setInfo('');
    try {
      const data = await apiRequest<{ message: string; devOtpCode?: string }>(
        '/api/auth/resend-otp',
        {
          method: 'POST',
          body: JSON.stringify({ email }),
        }
      );
      setInfo(data.message);
      if (data.devOtpCode) {
        setPreviewOtp(data.devOtpCode);
        setOtp(data.devOtpCode);
      }
    } catch (err: any) {
      setError(err.message || 'Unable to resend code');
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-zinc-950 p-6 text-slate-900 dark:text-zinc-100">
      <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-8">
        <h1 className="text-xl font-semibold tracking-tight">Verify your email</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-zinc-400">
          Enter the 6-digit verification code issued for your account.
        </p>

        {previewOtp && (
          <div className="mt-4 rounded-lg border border-blue-200 dark:border-blue-900/60 bg-blue-50 dark:bg-blue-950/30 px-3 py-2.5 text-xs text-blue-800 dark:text-blue-200">
            Development verification code: <span className="font-mono font-semibold tabular-nums">{previewOtp}</span>
          </div>
        )}
        {error && (
          <div className="mt-4 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3 py-2.5 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}
        {info && (
          <div className="mt-4 rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2.5 text-sm text-emerald-700 dark:text-emerald-300">
            {info}
          </div>
        )}

        <form onSubmit={handleVerify} className="mt-5 space-y-4">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email address"
            className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm"
          />
          <input
            type="text"
            maxLength={6}
            required
            value={otp}
            onChange={(e) => setOtp(e.target.value)}
            placeholder="000000"
            className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2.5 text-center font-mono text-lg tracking-widest tabular-nums"
          />
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-slate-900 dark:bg-zinc-100 py-2.5 px-4 text-sm font-medium text-white dark:text-zinc-900 cursor-pointer disabled:opacity-50"
          >
            {loading ? 'Verifying...' : 'Verify & Continue'}
          </button>
        </form>

        <button
          type="button"
          onClick={handleResend}
          className="mt-4 w-full text-center text-xs text-slate-600 dark:text-zinc-400 hover:underline cursor-pointer"
        >
          Resend verification code
        </button>
      </div>
    </div>
  );
}

export function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<'request' | 'reset'>('request');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [previewOtp, setPreviewOtp] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function handleRequest(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const data = await apiRequest<{ message: string; devOtpCode?: string }>(
        '/api/auth/forgot-password',
        {
          method: 'POST',
          body: JSON.stringify({ email }),
        }
      );
      setMessage(data.message);
      if (data.devOtpCode) {
        setPreviewOtp(data.devOtpCode);
        setOtp(data.devOtpCode);
      }
      setStep('reset');
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await apiRequest('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ email, otp, newPassword }),
      });
      navigate('/login');
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-zinc-950 p-6 text-slate-900 dark:text-zinc-100">
      <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-8">
        <h1 className="text-xl font-semibold tracking-tight">Reset your password</h1>
        {message && (
          <p className="mt-2 text-sm text-slate-600 dark:text-zinc-400">{message}</p>
        )}
        {previewOtp && (
          <div className="mt-3 rounded-lg border border-blue-200 dark:border-blue-900/60 bg-blue-50 dark:bg-blue-950/30 px-3 py-2 text-xs text-blue-800 dark:text-blue-200">
            Development reset code: <span className="font-mono font-semibold tabular-nums">{previewOtp}</span>
          </div>
        )}
        {error && (
          <div className="mt-3 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {step === 'request' ? (
          <form onSubmit={handleRequest} className="mt-5 space-y-4">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Account email address"
              className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm"
            />
            <button
              type="submit"
              className="w-full rounded-lg bg-slate-900 dark:bg-zinc-100 py-2.5 text-sm font-medium text-white dark:text-zinc-900 cursor-pointer"
            >
              Send Reset Code
            </button>
          </form>
        ) : (
          <form onSubmit={handleReset} className="mt-5 space-y-4">
            <input
              type="text"
              maxLength={6}
              required
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              placeholder="6-digit code"
              className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm font-mono tabular-nums"
            />
            <input
              type="password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password (8+ chars, 1 uppercase, 1 number)"
              className="w-full rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm"
            />
            <button
              type="submit"
              className="w-full rounded-lg bg-slate-900 dark:bg-zinc-100 py-2.5 text-sm font-medium text-white dark:text-zinc-900 cursor-pointer"
            >
              Update Password
            </button>
          </form>
        )}

        <div className="mt-5 text-center text-xs text-slate-600 dark:text-zinc-400">
          <Link to="/login" className="hover:underline">
            Back to Sign In
          </Link>
        </div>
      </div>
    </div>
  );
}
