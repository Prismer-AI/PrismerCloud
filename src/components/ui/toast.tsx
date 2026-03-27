'use client';

import { CheckCircle2, XCircle, Info, X } from 'lucide-react';
import { ToastMessage } from '@/types';

interface ToastContainerProps {
  toasts: ToastMessage[];
  removeToast: (id: number) => void;
}

export function ToastContainer({ toasts, removeToast }: ToastContainerProps) {
  return (
    <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-3 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl bg-zinc-900/90 backdrop-blur border border-white/10 shadow-2xl animate-in slide-in-from-right-10 fade-in duration-300 max-w-sm"
        >
          {t.type === 'success' && <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />}
          {t.type === 'error' && <XCircle className="w-5 h-5 text-red-400 shrink-0" />}
          {t.type === 'info' && <Info className="w-5 h-5 text-violet-400 shrink-0" />}
          <span className="text-sm font-medium text-white">{t.message}</span>
          <button
            onClick={() => removeToast(t.id)}
            className="ml-2 text-zinc-500 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

