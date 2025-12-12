import { zodResolver } from '@hookform/resolvers/zod';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { AppHeader, ProjectSelector, UserAvatarDropdown } from '@/components/app-layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { trpc } from '@/trpc';

export const Route = createFileRoute('/_app/')({
  component: RouteComponent,
  loader: async ({ context: { trpc } }) => {
    await trpc.list.getLists.prefetch();
  },
  staticData: {
    hideSelect: true,
  },
});

function RouteComponent() {
  return (
    <>
      <AppHeader>
        <h1 className="font-bold text-2xl">watchlist</h1>
        <UserAvatarDropdown />
      </AppHeader>
      <div className="flex flex-col items-center gap-6 pt-6 sm:pt-14">
        <div className="flex flex-col gap-2">
          <p className="text-center font-semibold">Select a list</p>
          <ProjectSelector showCreate={false} />
        </div>
        <p>or</p>
        <CreateListForm />
      </div>
    </>
  );
}

const createListSchema = z.object({
  name: z.string().min(2),
});

type CreateListSchema = z.infer<typeof createListSchema>;

function CreateListForm() {
  const navigate = useNavigate();

  const utils = trpc.useUtils();
  const createListMutation = trpc.list.createList.useMutation({
    onSuccess: (data) => {
      if (data.listId) {
        utils.list.getLists.invalidate();
        navigate({ to: '/list/$id', params: { id: data.listId } });
      }
    },
  });
  const { register, handleSubmit } = useForm<CreateListSchema>({
    resolver: zodResolver(createListSchema),
  });

  const onSubmit = (data: CreateListSchema) => {
    createListMutation.mutate({ name: data.name });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-row gap-2">
      <Input {...register('name')} placeholder="Create a new list" />
      <Button type="submit" disabled={createListMutation.isPending} className="aspect-square p-0">
        <PlusIcon className="size-6!" />
      </Button>
    </form>
  );
}
