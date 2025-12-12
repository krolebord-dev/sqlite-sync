import { useParams } from '@tanstack/react-router';

export function useListId() {
  const { id } = useParams({ from: '/_app/list/$id' });

  return id;
}
