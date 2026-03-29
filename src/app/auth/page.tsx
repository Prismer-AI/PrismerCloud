'use client';

import { useState, useEffect, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Eye, EyeOff, Github, Mail, Loader2, ArrowLeft } from 'lucide-react';
import { useApp } from '@/contexts/app-context';
import { useTheme } from '@/contexts/theme-context';
import { hashPassword } from '@/lib/utils';

type AuthMode = 'login' | 'register' | 'reset-password';

export default function AuthPage() {
  const router = useRouter();
  const { login, addToast } = useApp();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  
  const [mode, setMode] = useState<AuthMode>('login');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  
  // Form fields
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [codeVerified, setCodeVerified] = useState(false);
  const [githubClientId, setGithubClientId] = useState<string | null>(null);
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);
  const [isConfigLoading, setIsConfigLoading] = useState(true);

  // Load public OAuth configuration (client IDs) from server/Nacos
  useEffect(() => {
    let cancelled = false;

    const loadConfig = async () => {
      try {
        const res = await fetch('/api/config/oauth');
        if (!res.ok) {
          throw new Error('Failed to load OAuth configuration');
        }
        const data = await res.json();
        if (cancelled) return;
        setGithubClientId(data.githubClientId || null);
        setGoogleClientId(data.googleClientId || null);
      } catch (error: any) {
        if (!cancelled) {
          console.error('Failed to load OAuth config', error);
          addToast('Failed to load OAuth configuration', 'error');
        }
      } finally {
        if (!cancelled) {
          setIsConfigLoading(false);
        }
      }
    };

    loadConfig();

    return () => {
      cancelled = true;
    };
  }, [addToast]);

  // Handle login
  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    
    try {
      const passwordHash = await hashPassword(password);
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: passwordHash })
      });

      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error?.msg || 'Login failed');
      }

      login(data.user, data.token);
      addToast('Welcome back!', 'success');
      router.push('/dashboard');
    } catch (error: any) {
      addToast(error.message || 'Login failed', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  // Handle register
  const handleRegister = async (e: FormEvent) => {
    e.preventDefault();
    
    if (!codeVerified) {
      addToast('Please verify your email first', 'error');
      return;
    }

    if (password !== confirmPassword) {
      addToast('Passwords do not match', 'error');
      return;
    }

    setIsLoading(true);
    
    try {
      const passwordHash = await hashPassword(password);
      const confirmPasswordHash = await hashPassword(confirmPassword);
      
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password: passwordHash,
          confirm_password: confirmPasswordHash,
          code: verificationCode
        })
      });

      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error?.msg || 'Registration failed');
      }

      login(data.user, data.token);
      addToast('Account created successfully!', 'success');
      router.push('/dashboard');
    } catch (error: any) {
      addToast(error.message || 'Registration failed', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  // Handle reset password
  const handleResetPassword = async (e: FormEvent) => {
    e.preventDefault();
    
    if (!codeVerified) {
      addToast('Please verify your email first', 'error');
      return;
    }

    if (password !== confirmPassword) {
      addToast('Passwords do not match', 'error');
      return;
    }

    setIsLoading(true);
    
    try {
      const passwordHash = await hashPassword(password);
      const confirmPasswordHash = await hashPassword(confirmPassword);
      
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          code: verificationCode,
          password: passwordHash,
          confirm_password: confirmPasswordHash
        })
      });

      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error?.msg || 'Password reset failed');
      }

      addToast('Password reset successfully!', 'success');
      setMode('login');
      setPassword('');
      setConfirmPassword('');
      setCode('');
      setVerificationCode('');
      setCodeSent(false);
      setCodeVerified(false);
    } catch (error: any) {
      addToast(error.message || 'Password reset failed', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  // Send verification code
  const handleSendCode = async () => {
    if (!email) {
      addToast('Please enter your email', 'error');
      return;
    }

    setIsLoading(true);
    
    try {
      const type = mode === 'register' ? 'signup' : 'reset-password';
      const res = await fetch('/api/auth/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, type })
      });

      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error?.msg || 'Failed to send code');
      }

      setCodeSent(true);
      addToast(`Verification code sent to ${email}`, 'success');
    } catch (error: any) {
      addToast(error.message || 'Failed to send code', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  // Verify code
  const handleVerifyCode = async () => {
    if (!code) {
      addToast('Please enter verification code', 'error');
      return;
    }

    setIsLoading(true);
    
    try {
      const type = mode === 'register' ? 'signup' : 'reset-password';
      const res = await fetch('/api/auth/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code, type })
      });

      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error?.msg || 'Code verification failed');
      }

      setCodeVerified(true);
      setVerificationCode(code);
      addToast('Code verified successfully!', 'success');
    } catch (error: any) {
      addToast(error.message || 'Code verification failed', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  // Handle GitHub OAuth (real redirect flow, config from server/Nacos)
  const handleGitHubOAuth = async () => {
    if (isConfigLoading) {
      addToast('Loading OAuth configuration, please try again...', 'info');
      return;
    }

    if (!githubClientId) {
      addToast('GitHub client ID is not configured', 'error');
      return;
    }

    try {
      setIsLoading(true);
      const origin =
        typeof window !== 'undefined'
          ? window.location.origin
          : '';

      // NOTE: OAuth redirect URI must exactly match what is configured
      // in GitHub/Google OAuth App settings (including scheme, host and path).
      // We use /playground as the redirect endpoint to match OAuth provider config.
      const redirectUri = `${origin}/playground`;

      console.log('[OAuth][GitHub] clientId=', githubClientId, 'origin=', origin, 'redirectUri=', redirectUri);

      const params = new URLSearchParams({
        client_id: githubClientId,
        redirect_uri: redirectUri,
        scope: 'read:user user:email',
        allow_signup: 'true',
      });

      window.location.href = `https://github.com/login/oauth/authorize?${params.toString()}`;
    } catch (error: any) {
      addToast(error.message || 'Failed to start GitHub OAuth', 'error');
      setIsLoading(false);
    }
  };

  // Handle Google OAuth (implicit flow to get access_token, config from server/Nacos)
  const handleGoogleOAuth = async () => {
    if (isConfigLoading) {
      addToast('Loading OAuth configuration, please try again...', 'info');
      return;
    }

    if (!googleClientId) {
      addToast('Google client ID is not configured', 'error');
      return;
    }

    try {
      setIsLoading(true);
      const origin =
        typeof window !== 'undefined'
          ? window.location.origin
          : '';

      // Use /playground as redirect endpoint to match Google OAuth provider config
      const redirectUri = `${origin}/playground`;

      console.log('[OAuth][Google] clientId=', googleClientId, 'origin=', origin, 'redirectUri=', redirectUri);

      const params = new URLSearchParams({
        client_id: googleClientId,
        redirect_uri: redirectUri,
        response_type: 'token', // implicit flow to get access_token in hash
        scope: 'openid email profile',
        include_granted_scopes: 'true',
        prompt: 'consent',
      });

      window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    } catch (error: any) {
      addToast(error.message || 'Failed to start Google OAuth', 'error');
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-64px)] flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-20 h-20 mx-auto mb-6">
            <img 
              src={isDark ? '/animation-dark-small.webp' : '/animation-light-small.webp'} 
              alt="Prismer Cloud" 
              className="w-full h-full object-contain"
            />
          </div>
          <h1 className={`text-3xl font-bold mb-2 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
            {mode === 'login' && 'Welcome back'}
            {mode === 'register' && 'Create account'}
            {mode === 'reset-password' && 'Reset password'}
          </h1>
          <p className={isDark ? 'text-zinc-400' : 'text-zinc-600'}>
            {mode === 'login' && 'Sign in to access your dashboard and API keys'}
            {mode === 'register' && 'Start building with Prismer Cloud today'}
            {mode === 'reset-password' && 'Enter your email to reset your password'}
          </p>
        </div>

        {/* Card */}
        <div className={`backdrop-blur-xl border rounded-2xl p-8 shadow-2xl ${isDark ? 'bg-zinc-900/80 border-white/10' : 'bg-white border-zinc-200'}`}>
          {/* Back button for reset-password */}
          {mode === 'reset-password' && (
            <button
              onClick={() => setMode('login')}
              className={`flex items-center gap-2 mb-4 transition-colors ${isDark ? 'text-zinc-400 hover:text-white' : 'text-zinc-500 hover:text-zinc-900'}`}
            >
              <ArrowLeft className="w-4 h-4" />
              <span className="text-sm">Back to login</span>
            </button>
          )}

          {/* OAuth Buttons - only show for login/register */}
          {(mode === 'login' || mode === 'register') && (
            <>
              <div className="space-y-3 mb-6">
                <button 
                  onClick={handleGitHubOAuth}
                  disabled={isLoading}
                  className={`w-full flex items-center justify-center gap-3 px-4 py-3 border rounded-xl font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    isDark ? 'bg-zinc-800 hover:bg-zinc-700 border-white/10 text-white' : 'bg-zinc-100 hover:bg-zinc-200 border-zinc-300 text-zinc-900'
                  }`}
                >
                  <Github className="w-5 h-5" />
                  Continue with GitHub
                </button>
                <button 
                  onClick={handleGoogleOAuth}
                  disabled={isLoading}
                  className={`w-full flex items-center justify-center gap-3 px-4 py-3 border rounded-xl font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    isDark ? 'bg-zinc-800 hover:bg-zinc-700 border-white/10 text-white' : 'bg-zinc-100 hover:bg-zinc-200 border-zinc-300 text-zinc-900'
                  }`}
                >
                  <Mail className="w-5 h-5" />
                  Continue with Google
                </button>
              </div>

              {/* Divider */}
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className={`w-full border-t ${isDark ? 'border-white/10' : 'border-zinc-300'}`}></div>
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className={`px-2 ${isDark ? 'bg-zinc-900 text-zinc-500' : 'bg-white text-zinc-500'}`}>Or continue with email</span>
                </div>
              </div>
            </>
          )}

          {/* Form */}
          <form 
            onSubmit={mode === 'login' ? handleLogin : mode === 'register' ? handleRegister : handleResetPassword} 
            className="space-y-4"
          >
            <div>
              <label htmlFor="email" className={`block text-xs font-semibold mb-2 ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}>
                EMAIL ADDRESS
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="dev@example.com"
                className={`w-full border rounded-xl p-4 text-sm focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500/50 transition-all ${
                  isDark ? 'bg-black/50 border-white/10 text-white placeholder-zinc-600' : 'bg-zinc-50 border-zinc-300 text-zinc-900 placeholder-zinc-400'
                }`}
                required
                disabled={codeSent && mode !== 'login'}
              />
            </div>

            {/* Verification code section for register/reset */}
            {(mode === 'register' || mode === 'reset-password') && (
              <div className="space-y-3">
                {!codeSent ? (
                  <button
                    type="button"
                    onClick={handleSendCode}
                    disabled={isLoading || !email}
                    className={`w-full py-3 bg-violet-600/20 hover:bg-violet-600/30 border border-violet-500/30 rounded-xl font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${isDark ? 'text-violet-300' : 'text-violet-600'}`}
                  >
                    Send Verification Code
                  </button>
                ) : (
                  <>
                    <div>
                      <label htmlFor="code" className={`block text-xs font-semibold mb-2 ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}>
                        VERIFICATION CODE
                      </label>
                      <div className="flex gap-2">
                        <input
                          id="code"
                          type="text"
                          value={code}
                          onChange={(e) => setCode(e.target.value)}
                          placeholder="Enter 6-digit code"
                          className={`flex-1 border rounded-xl p-4 text-sm focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500/50 transition-all ${
                            isDark ? 'bg-black/50 border-white/10 text-white placeholder-zinc-600' : 'bg-zinc-50 border-zinc-300 text-zinc-900 placeholder-zinc-400'
                          }`}
                          maxLength={6}
                          required
                        />
                        {!codeVerified && (
                          <button
                            type="button"
                            onClick={handleVerifyCode}
                            disabled={isLoading || !code}
                            className="px-6 py-4 bg-violet-600 hover:bg-violet-700 text-white rounded-xl font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Verify
                          </button>
                        )}
                      </div>
                    </div>
                    {codeVerified && (
                      <div className="px-4 py-2 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-emerald-400 text-sm">
                        ✓ Email verified
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Password fields - only show if not verified for register/reset, or always for login */}
            {((mode === 'login') || (mode === 'register' && codeVerified) || (mode === 'reset-password' && codeVerified)) && (
              <>
                <div>
                  <label htmlFor="password" className={`block text-xs font-semibold mb-2 ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}>
                    PASSWORD
                  </label>
                  <div className="relative">
                    <input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••••••"
                      className={`w-full border rounded-xl p-4 pr-12 text-sm focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500/50 transition-all ${
                        isDark ? 'bg-black/50 border-white/10 text-white placeholder-zinc-600' : 'bg-zinc-50 border-zinc-300 text-zinc-900 placeholder-zinc-400'
                      }`}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className={`absolute right-4 top-4 transition-colors ${isDark ? 'text-zinc-500 hover:text-white' : 'text-zinc-400 hover:text-zinc-700'}`}
                    >
                      {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                    </button>
                  </div>
                </div>

                {(mode === 'register' || mode === 'reset-password') && (
                  <div>
                    <label htmlFor="confirm-password" className={`block text-xs font-semibold mb-2 ${isDark ? 'text-zinc-300' : 'text-zinc-600'}`}>
                      CONFIRM PASSWORD
                    </label>
                    <div className="relative">
                      <input
                        id="confirm-password"
                        type={showConfirmPassword ? 'text' : 'password'}
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="••••••••••••"
                        className={`w-full border rounded-xl p-4 pr-12 text-sm focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500/50 transition-all ${
                          isDark ? 'bg-black/50 border-white/10 text-white placeholder-zinc-600' : 'bg-zinc-50 border-zinc-300 text-zinc-900 placeholder-zinc-400'
                        }`}
                        required
                      />
                      <button
                        type="button"
                        onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                        className={`absolute right-4 top-4 transition-colors ${isDark ? 'text-zinc-500 hover:text-white' : 'text-zinc-400 hover:text-zinc-700'}`}
                      >
                        {showConfirmPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}

            {mode === 'login' && (
              <div className="flex justify-end">
                <button 
                  type="button" 
                  onClick={() => setMode('reset-password')}
                  className="text-xs text-violet-400 hover:text-violet-300 transition-colors"
                >
                  Forgot password?
                </button>
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading || (mode !== 'login' && !codeVerified)}
              className="w-full py-4 bg-gradient-to-r from-violet-600 to-cyan-600 hover:opacity-90 text-white rounded-xl font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  {mode === 'login' && 'Signing in...'}
                  {mode === 'register' && 'Creating account...'}
                  {mode === 'reset-password' && 'Resetting password...'}
                </>
              ) : (
                <>
                  {mode === 'login' && 'Sign In'}
                  {mode === 'register' && 'Create Account'}
                  {mode === 'reset-password' && 'Reset Password'}
                </>
              )}
            </button>
          </form>

          {/* Toggle */}
          {(mode === 'login' || mode === 'register') && (
            <p className={`text-center text-sm mt-6 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
              <button
                onClick={() => {
                  setMode(mode === 'login' ? 'register' : 'login');
                  setCode('');
                  setCodeSent(false);
                  setCodeVerified(false);
                }}
                className="text-violet-400 hover:text-violet-300 font-medium transition-colors"
              >
                {mode === 'login' ? 'Sign up' : 'Sign in'}
              </button>
            </p>
          )}
        </div>

        {/* Footer */}
        <p className={`text-center text-xs mt-6 ${isDark ? 'text-zinc-600' : 'text-zinc-500'}`}>
          By continuing, you agree to our{' '}
          <Link href="#" className={`transition-colors ${isDark ? 'text-zinc-400 hover:text-white' : 'text-zinc-600 hover:text-zinc-900'}`}>
            Terms of Service
          </Link>{' '}
          and{' '}
          <Link href="#" className={`transition-colors ${isDark ? 'text-zinc-400 hover:text-white' : 'text-zinc-600 hover:text-zinc-900'}`}>
            Privacy Policy
          </Link>
        </p>
      </div>
    </div>
  );
}
