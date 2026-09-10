'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { API_BASE_URL } from '../../config';

export default function AuthPage() {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const endpoint = isLogin ? '/api/auth/login' : '/api/auth/register';
    const payload = isLogin ? { email, password } : { email, password, name };

    try {
      const res = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || 'Authentication failed');
      }

      localStorage.setItem('token', data.access_token);
      localStorage.setItem('user', JSON.stringify(data.user));
      router.push('/chat');
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-100 p-4 sm:p-6 font-sans relative overflow-hidden">
      {/* Background Decorative Lighting Effect */}
      <div className="absolute -top-40 -left-40 w-80 h-80 bg-amber-500/10 rounded-full blur-3xl pointer-events-none"></div>
      <div className="absolute -bottom-40 -right-40 w-80 h-80 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none"></div>

      <div className="w-full max-w-md p-6 sm:p-8 bg-slate-900/90 backdrop-blur-md rounded-2xl shadow-2xl border border-slate-800 relative z-10">
        {/* Plus UAE Branding Header */}
        <div className="flex flex-col items-center mb-8 text-center">
          <div className="inline-flex items-center gap-2 mb-2">
            <span className="w-3 h-3 rounded-full bg-amber-500 animate-pulse"></span>
            <span className="text-xl font-black tracking-widest text-amber-400 uppercase">
              PLUS UAE
            </span>
          </div>
          <p className="text-xs text-slate-400 tracking-wider uppercase font-medium">
            Enterprise Communications Portal
          </p>
        </div>

        <h2 className="text-xl sm:text-2xl font-bold mb-6 text-center text-slate-100">
          {isLogin ? 'Sign In to Workspace' : 'Create Enterprise Account'}
        </h2>

        {error && (
          <div className="mb-5 p-3 bg-red-950/40 text-red-400 border border-red-500/30 rounded-lg text-xs sm:text-sm font-medium">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {!isLogin && (
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
                Full Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                placeholder="e.g. Alex Morgan"
                className="w-full p-3 text-sm bg-slate-800/80 border border-slate-700 rounded-lg focus:outline-none focus:border-amber-500/50 text-slate-100 placeholder-slate-500 transition"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
              Work Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="name@plusuae.com"
              className="w-full p-3 text-sm bg-slate-800/80 border border-slate-700 rounded-lg focus:outline-none focus:border-amber-500/50 text-slate-100 placeholder-slate-500 transition"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="••••••••"
              className="w-full p-3 text-sm bg-slate-800/80 border border-slate-700 rounded-lg focus:outline-none focus:border-amber-500/50 text-slate-100 placeholder-slate-500 transition"
            />
          </div>

          <button
            type="submit"
            className="w-full py-3.5 bg-amber-500 text-slate-950 font-bold hover:bg-amber-400 transition-all rounded-lg mt-6 shadow-lg shadow-amber-500/10 active:scale-[0.99] text-sm"
          >
            {isLogin ? 'Sign In' : 'Register Account'}
          </button>
        </form>

        <div className="mt-6 pt-4 border-t border-slate-800/80 text-center">
          <button
            type="button"
            onClick={() => {
              setError('');
              setIsLogin(!isLogin);
            }}
            className="text-xs sm:text-sm text-slate-400 hover:text-amber-400 transition"
          >
            {isLogin
              ? "Don't have an enterprise account? Register"
              : 'Already have an account? Sign In'}
          </button>
        </div>
      </div>
    </div>
  );
}