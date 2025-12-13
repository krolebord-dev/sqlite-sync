import { zodResolver } from '@hookform/resolvers/zod';
import { CheckIcon, MailIcon, PenIcon, PlusIcon, XIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { type TrpcOutput, trpc } from '@/trpc';
import { useListItems } from '@/db/use-list-items';
import { formatDuration } from '@/utils/format-duration';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from './ui/sheet';
import { Skeleton } from './ui/skeleton';
import { Table, TableBody, TableCell, TableRow } from './ui/table';

type ListSettingsSheetProps = {
  listId: string;
  children: React.ReactNode;
  asChild?: boolean;
};

export function ListSettingsSheet({ listId, children, asChild }: ListSettingsSheetProps) {
  const [open, setOpen] = useState(false);

  const listDetails = trpc.list.getDetails.useQuery(
    { listId },
    {
      enabled: open,
    },
  );

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild={asChild}>{children}</SheetTrigger>
      <SheetContent side="left" noClose onOpenAutoFocus={(e) => e.preventDefault()}>
        <SheetHeader>
          <SheetTitle>List Settings</SheetTitle>
        </SheetHeader>
        <div className="h-4" />
        {listDetails.data ? (
          <ListSettingsForm list={listDetails.data} />
        ) : (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-8 w-1/2" />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

type ListSettingsFormProps = {
  list: TrpcOutput['list']['getDetails'];
};

function ListSettingsForm({ list }: ListSettingsFormProps) {
  return (
    <div className="flex h-full flex-col justify-between gap-12">
      <div className="flex flex-col gap-12">
        <ListNameForm listId={list.id} name={list.name} />
        <ListUsers listId={list.id} users={list.users} />
        <ListTags listId={list.id} tags={[]} />
      </div>
      <ListStats />
    </div>
  );
}

/**
 * Compute stats from local SQLite database
 */
function ListStats() {
  const items = useListItems();

  const stats = useMemo(() => {
    if (!items || items.length === 0) return null;

    const count = items.length;
    const watchedCount = items.filter((item) => item.watchedAt).length;
    const totalDuration = items.reduce((acc, item) => acc + (item.duration ?? 0), 0);
    const watchedDuration = items
      .filter((item) => item.watchedAt)
      .reduce((acc, item) => acc + (item.duration ?? 0), 0);
    const ratingsSum = items.reduce((acc, item) => acc + (item.rating ?? 0), 0);
    const ratingsCount = items.filter((item) => item.rating !== null).length;
    const averageRating = ratingsCount > 0 ? ratingsSum / ratingsCount : 0;

    return {
      count,
      watchedCount,
      totalDuration,
      watchedDuration,
      averageRating,
    };
  }, [items]);

  if (!stats) return null;

  return (
    <div className="flex flex-col pb-6 text-gray-500">
      <p>
        Watched: {stats.watchedCount} / {stats.count}
      </p>
      <p>
        Duration: {formatDuration(stats.watchedDuration)} / {formatDuration(stats.totalDuration)}
      </p>
      <p>Average rating: {Math.round(stats.averageRating)}</p>
    </div>
  );
}

const editListSchema = z.object({
  name: z.string().min(2),
});

type EditListSchema = z.infer<typeof editListSchema>;

type ListNameFormProps = {
  listId: string;
  name: string;
};
function ListNameForm({ listId, name }: ListNameFormProps) {
  const utils = trpc.useUtils();
  const editListMutation = trpc.list.editList.useMutation({
    onSuccess: (data, { newName }) => {
      if (data.listId) {
        utils.list.getLists.invalidate();
        utils.list.getDetails.invalidate({ listId });
        reset({
          name: newName,
        });
      }
    },
  });
  const {
    register,
    handleSubmit,
    reset,
    formState: { isDirty },
  } = useForm<EditListSchema>({
    resolver: zodResolver(editListSchema),
    defaultValues: {
      name,
    },
  });

  const onSubmit = (data: EditListSchema) => {
    editListMutation.mutate({ listId, newName: data.name });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-row gap-2">
      <Input {...register('name')} placeholder="Create a new list" />
      <Button
        type="submit"
        variant="outline"
        disabled={editListMutation.isPending || !isDirty}
        className="aspect-square p-0"
      >
        {editListMutation.isSuccess && !isDirty ? <CheckIcon className="size-4!" /> : <PenIcon className="size-4!" />}
      </Button>
    </form>
  );
}

const emailSchema = z.object({
  email: z.string().email(),
});

type EmailSchema = z.infer<typeof emailSchema>;

type ListUsersProps = {
  listId: string;
  users: {
    id: string;
    name: string;
    email: string;
  }[];
};
function ListUsers({ listId, users }: ListUsersProps) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { isValid, isDirty },
  } = useForm<EmailSchema>({
    resolver: zodResolver(emailSchema),
    defaultValues: {
      email: '',
    },
  });

  const inviteUserMutation = trpc.list.inviteUser.useMutation({
    onSuccess: (data) => {
      if (data.success) {
        reset();
      }
    },
  });

  const onSubmit = (data: EmailSchema) => {
    inviteUserMutation.mutate({ listId, email: data.email });
  };

  return (
    <div>
      <p>Collaborators</p>
      <div className="h-2" />
      <Table>
        <TableBody>
          {users.map((user) => (
            <TableRow key={user.id}>
              <TableCell className="p-2">
                <div className="max-w-[120px] truncate">{user.name}</div>
              </TableCell>
              <TableCell className="p-2">
                <div className="max-w-[180px] truncate">{user.email}</div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="h-2" />
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-row gap-2">
        <Input {...register('email')} placeholder="Invite by email" />
        <Button
          type="submit"
          variant="outline"
          disabled={inviteUserMutation.isPending || !isValid}
          className="aspect-square p-0"
        >
          {inviteUserMutation.isSuccess && !isDirty ? (
            <CheckIcon className="size-4!" />
          ) : (
            <MailIcon className="size-4!" />
          )}
        </Button>
      </form>
    </div>
  );
}

type ListTagsProps = {
  listId: string;
  tags: {
    id: string;
    name: string;
  }[];
};

function ListTags({ listId }: ListTagsProps) {
  const utils = trpc.useUtils();
  const [isEditing, setIsEditing] = useState(false);
  const [editingTagId, setEditingTagId] = useState<string | null>(null);

  const tags = trpc.list.getTags.useQuery({ listId });
  const createTagMutation = trpc.list.createTag.useMutation({
    onSuccess: () => {
      utils.list.getTags.invalidate({ listId });
    },
  });
  const updateTagMutation = trpc.list.updateTag.useMutation({
    onSuccess: () => {
      utils.list.getTags.invalidate({ listId });
      setEditingTagId(null);
    },
  });
  const deleteTagMutation = trpc.list.deleteTag.useMutation({
    onSuccess: () => {
      utils.list.getTags.invalidate({ listId });
    },
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { isValid },
  } = useForm<{ name: string }>({
    resolver: zodResolver(z.object({ name: z.string().min(1) })),
    defaultValues: {
      name: '',
    },
  });

  const onSubmit = (data: { name: string }) => {
    createTagMutation.mutate({ listId, name: data.name });
    reset();
  };

  const onUpdate = (tagId: string, name: string) => {
    updateTagMutation.mutate({ listId, tagId, name });
  };

  const onDelete = (tagId: string) => {
    deleteTagMutation.mutate({ listId, tagId });
  };

  return (
    <div>
      <p>Tags</p>
      <div className="h-2" />
      <div className="flex flex-wrap gap-2">
        {tags.data?.map((tag) => (
          <div key={tag.id} className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1">
            {editingTagId === tag.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const formData = new FormData(e.currentTarget);
                  const name = formData.get('name') as string;
                  if (name) {
                    onUpdate(tag.id, name);
                  }
                }}
                className="flex items-center gap-2"
              >
                <Input
                  name="name"
                  defaultValue={tag.name}
                  className="h-6 w-24 px-1 py-0"
                  autoFocus
                  onBlur={() => setEditingTagId(null)}
                />
                <Button type="submit" variant="ghost" size="icon" className="h-6 w-6">
                  <CheckIcon className="size-3!" />
                </Button>
              </form>
            ) : (
              <>
                <span className="cursor-pointer" onClick={() => setEditingTagId(tag.id)}>
                  {tag.name}
                </span>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => onDelete(tag.id)}>
                  <XIcon className="size-3!" />
                </Button>
              </>
            )}
          </div>
        ))}
        {isEditing ? (
          <form onSubmit={handleSubmit(onSubmit)} className="flex items-center gap-2">
            <Input
              {...register('name')}
              placeholder="Tag name"
              className="h-8 w-32"
              autoFocus
              onBlur={() => {
                if (!isValid) {
                  setIsEditing(false);
                  reset();
                }
              }}
            />
            <Button type="submit" variant="ghost" size="icon" className="h-8 w-8">
              <CheckIcon className="size-4!" />
            </Button>
          </form>
        ) : (
          <Button variant="outline" size="icon" className="h-8 w-8 rounded-full" onClick={() => setIsEditing(true)}>
            <PlusIcon className="size-4!" />
          </Button>
        )}
      </div>
    </div>
  );
}
