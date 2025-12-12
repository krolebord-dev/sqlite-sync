import { cn } from '@/utils/cn';

export function VoteAverage({ voteAverage, className }: { voteAverage: number; className: string }) {
  const score = Math.round(voteAverage * 10);
  const { border, text } = getScoreStyles(voteAverage);
  return (
    <p
      className={cn(
        'flex size-8 select-none items-center justify-center rounded-full border-2 bg-black text-white',
        border,
        className,
      )}
    >
      <span className={cn(text)}>{score}</span>
    </p>
  );
}

function getScoreStyles(voteAverage: number) {
  if (voteAverage >= 7) {
    return {
      border: 'border-green-500',
      text: 'text-green-500',
    };
  }

  if (voteAverage >= 5) {
    return {
      border: 'border-yellow-500',
      text: 'text-yellow-500',
    };
  }

  return {
    border: 'border-red-500',
    text: 'text-red-500',
  };
}
