import { useEffect, useState } from 'react';

export function formatRemaining(ms: number) {
  if (ms <= 0) return 'expired';
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${days}d ${hours}h ${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export default function Countdown({
  endsAt,
  paused = false,
  remainingMs,
}: {
  endsAt: string;
  paused?: boolean;
  remainingMs?: number;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const remaining = paused
    ? Math.max(0, remainingMs ?? new Date(endsAt).getTime() - now)
    : new Date(endsAt).getTime() - now;
  return (
    <span className={remaining <= 0 ? 'text-[#dc2626] dark:text-[#f87171]' : undefined}>
      {formatRemaining(remaining)}
      {paused ? ' (paused)' : ''}
    </span>
  );
}
