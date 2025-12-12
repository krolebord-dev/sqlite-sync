import { redirect, useLoaderData } from '@tanstack/react-router';

export function useUser() {
  const context = useLoaderData({ from: '/_app' });
  if (!context.user) {
    throw redirect({ to: '/login' });
  }
  return context.user;
}
