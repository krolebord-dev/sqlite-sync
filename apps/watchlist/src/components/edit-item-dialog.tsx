import { zodResolver } from '@hookform/resolvers/zod';
import { format } from 'date-fns';
import { CalendarIcon, FilmIcon, TvIcon } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { type ControllerRenderProps, useForm } from 'react-hook-form';
import { z } from 'zod';
import type { TrpcOutput } from '@/trpc';
import { trpc } from '@/trpc';
import { cn } from '@/utils/cn';
import { useListStore } from '@/utils/list-store';
import { Button } from './ui/button';
import { Calendar } from './ui/calendar';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from './ui/form';
import { Input } from './ui/input';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Textarea } from './ui/textarea';

type ListItem = TrpcOutput['list']['getItems'][number];

const editItemSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  overview: z.string().optional(),
  duration: z.coerce.number().int().min(0).optional(),
  type: z.enum(['movie', 'tv']),
  episodeCount: z.coerce.number().int().min(0).optional(),
  watchedAt: z.date().nullable().optional(),
});

type EditItemFormValues = z.infer<typeof editItemSchema>;

type EditItemDialogProps = {
  items: ListItem[];
  listId: string;
};

type ItemTagsProps = {
  listId: string;
  itemId: string;
};

function ItemTags({ listId, itemId }: ItemTagsProps) {
  const utils = trpc.useUtils();
  const tags = trpc.list.getTags.useQuery({ listId });
  const itemTags = trpc.list.getItemTags.useQuery({ listId, itemId });
  const setItemTagsMutation = trpc.list.setItemTags.useMutation({
    onSuccess: () => {
      utils.list.getItemTags.invalidate({ listId, itemId });
    },
  });

  const selectedTagIds = new Set(itemTags.data?.map((tag) => tag.id));

  const toggleTag = (tagId: string) => {
    const newTagIds = new Set(selectedTagIds);
    if (newTagIds.has(tagId)) {
      newTagIds.delete(tagId);
    } else {
      newTagIds.add(tagId);
    }
    setItemTagsMutation.mutate({ listId, itemId, tagIds: Array.from(newTagIds) });
  };

  return (
    <div>
      <p className="mb-2 font-medium">Tags</p>
      <div className="flex flex-wrap gap-2">
        {tags.data?.map((tag) => {
          const isSelected = selectedTagIds.has(tag.id);
          return (
            <button
              key={tag.id}
              type="button"
              onClick={() => toggleTag(tag.id)}
              className={cn(
                'flex items-center gap-2 rounded-full border px-3 py-1 text-sm transition-colors',
                isSelected
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-card hover:bg-accent',
              )}
            >
              {tag.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function EditItemDialog({ items, listId }: EditItemDialogProps) {
  const editItemId = useListStore((state) => state.editItemId);
  const setEditItemId = useListStore((state) => state.setEditItemId);
  const utils = trpc.useUtils();

  const item = useMemo(() => items.find((item) => item.id === editItemId), [items, editItemId]);

  const form = useForm<EditItemFormValues>({
    resolver: zodResolver(editItemSchema),
    defaultValues: {
      title: '',
      overview: '',
      duration: 0,
      type: 'movie',
      episodeCount: 0,
      watchedAt: null,
    },
  });

  useEffect(() => {
    if (item) {
      form.reset({
        title: item.title,
        overview: item.overview || '',
        duration: item.duration || undefined,
        type: item.type || 'movie',
        episodeCount: item.episodeCount || undefined,
        watchedAt: item.watchedAt ? new Date(item.watchedAt) : null,
      });
    }
  }, [form, item]);

  const updateItemMutation = trpc.list.updateItem.useMutation({
    onSuccess: () => {
      utils.list.getItems.invalidate({ listId });
      setEditItemId(null);
    },
  });

  const onSubmit = (values: EditItemFormValues) => {
    if (!editItemId) return;

    updateItemMutation.mutate({
      listId,
      itemId: editItemId,
      title: values.title,
      overview: values.overview,
      duration: values.duration,
      type: values.type,
      episodeCount: values.episodeCount,
      watchedAt: values.watchedAt,
    });
  };

  const type = form.watch('type');

  return (
    <Dialog open={!!editItemId} onOpenChange={(open) => !open && setEditItemId(null)}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Edit Item</DialogTitle>
        </DialogHeader>
        {item && (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="type"
                render={({ field }: { field: ControllerRenderProps<EditItemFormValues, 'type'> }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="movie" className="flex items-center gap-2">
                          <span className="flex items-center gap-2">
                            <FilmIcon className="size-4" />
                            <span>Movie</span>
                          </span>
                        </SelectItem>
                        <SelectItem value="tv" className="flex items-center gap-2">
                          <span className="flex items-center gap-2">
                            <TvIcon className="size-4" />
                            <span>TV Show</span>
                          </span>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="title"
                render={({ field }: { field: ControllerRenderProps<EditItemFormValues, 'title'> }) => (
                  <FormItem>
                    <FormLabel>Title</FormLabel>
                    <FormControl>
                      <Input placeholder="Title" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="overview"
                render={({ field }: { field: ControllerRenderProps<EditItemFormValues, 'overview'> }) => (
                  <FormItem>
                    <FormLabel>Overview</FormLabel>
                    <FormControl>
                      <Textarea placeholder="Overview" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="duration"
                render={({ field }: { field: ControllerRenderProps<EditItemFormValues, 'duration'> }) => (
                  <FormItem>
                    <FormLabel>Duration (minutes)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        placeholder="Duration"
                        {...field}
                        value={field.value || ''}
                        onChange={(e) => {
                          const value = e.target.value === '' ? undefined : Number.parseInt(e.target.value, 10);
                          field.onChange(value);
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {type === 'tv' && (
                <FormField
                  control={form.control}
                  name="episodeCount"
                  render={({ field }: { field: ControllerRenderProps<EditItemFormValues, 'episodeCount'> }) => (
                    <FormItem>
                      <FormLabel>Number of Episodes</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          placeholder="Episodes"
                          {...field}
                          value={field.value || ''}
                          onChange={(e) => {
                            const value = e.target.value === '' ? undefined : Number.parseInt(e.target.value, 10);
                            field.onChange(value);
                          }}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
              <FormField
                control={form.control}
                name="watchedAt"
                render={({ field }: { field: ControllerRenderProps<EditItemFormValues, 'watchedAt'> }) => (
                  <FormItem className="flex flex-col">
                    <FormLabel>Watched Date</FormLabel>
                    <Popover>
                      <PopoverTrigger asChild>
                        <FormControl>
                          <Button
                            variant="outline"
                            className={cn('w-full pl-3 text-left font-normal', !field.value && 'text-muted-foreground')}
                          >
                            {field.value ? format(field.value, 'PPP') : <span>Not watched</span>}
                            <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                          </Button>
                        </FormControl>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={field.value || undefined}
                          onSelect={(date) => field.onChange(date)}
                          disabled={(date) => date > new Date()}
                          initialFocus
                        />
                        <div className="border-border border-t p-3">
                          <Button
                            variant="ghost"
                            className="w-full justify-center"
                            onClick={() => field.onChange(null)}
                          >
                            Clear
                          </Button>
                        </div>
                      </PopoverContent>
                    </Popover>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <ItemTags listId={listId} itemId={item.id} />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditItemId(null)}
                  disabled={updateItemMutation.isPending}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={updateItemMutation.isPending}>
                  Save
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}
