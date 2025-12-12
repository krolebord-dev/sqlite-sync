import { createFileRoute, redirect } from '@tanstack/react-router';
import { lastOpenedList } from '@/utils/last-opened-list';

export const Route = createFileRoute('/_app/last-list')({
  loader: () => {
    const lastListId = lastOpenedList.get();
    if (!lastListId) {
      return null;
    }

    throw redirect({ to: '/list/$id', params: { id: lastListId } });
  },
});
