import { useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useSpinDelay } from 'spin-delay';
import { cn } from '@/utils/cn';

export function GlobalProgressIndicator() {
  const navigationState = useRouterState({
    select: (state) => state.status,
  });

  const navigating = useSpinDelay(navigationState !== 'idle', {
    delay: 200,
    minDuration: 200,
  });

  const ref = useRef<HTMLDivElement>(null);
  const [animationComplete, setAnimationComplete] = useState(true);

  useEffect(() => {
    if (!ref.current) return;
    if (navigating) setAnimationComplete(false);

    const animations = 'getAnimations' in ref.current ? ref.current?.getAnimations() : [];

    Promise.allSettled(animations).then(() => {
      if (navigating) return;
      setAnimationComplete(true);
    });
  }, [navigating]);

  return (
    <div aria-hidden={!navigating} className={cn('absolute inset-x-0 top-0 z-50 h-1')}>
      <div
        ref={ref}
        className={cn('h-full bg-primary transition-all ease-in-out', {
          'w-0 transition-none': navigationState === 'idle' && animationComplete,
          'w-1/2 duration-500': navigationState === 'pending',
          'w-full opacity-0 duration-300': navigationState === 'idle' && !animationComplete,
        })}
      />
    </div>
  );
}
