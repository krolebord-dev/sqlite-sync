import { useAutoAnimate } from '@formkit/auto-animate/react';
import { Description } from '@radix-ui/react-dialog';
import { keepPreviousData } from '@tanstack/react-query';
import { format } from 'date-fns';
import { CheckIcon, XIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { type TrpcOutput, trpc } from '@/trpc';
import { useListDb } from '@/db';
import { cn } from '@/utils/cn';
import { useThrottle } from '@/utils/use-throttle';
import { VoteAverage } from './movie-card';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from './ui/dialog';
import { Input } from './ui/input';

type AddMovieDialogProps = {
  listId: string;
  asChild?: boolean;
  children: React.ReactNode;
  alreadyAddedItems?: number[];
};

export function AddMovieDialog({ listId, asChild, children, alreadyAddedItems }: AddMovieDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const close = () => setIsOpen(false);

  const [animateRef] = useAutoAnimate();
  const inputRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState('');
  const searchQuery = useThrottle(search, 200);

  const [addedItems, setAddedItems] = useState<number[]>(alreadyAddedItems ?? []);
  const [loadingItems, setLoadingItems] = useState<number[]>([]);

  const { data } = trpc.search.findMovie.useQuery(
    { q: searchQuery },
    {
      enabled: !!searchQuery && isOpen,
      placeholderData: keepPreviousData,
    },
  );

  const searchItems = searchQuery ? data : [];

  const { addItem } = useListDb();
  const utils = trpc.useUtils();

  const handleAddMovie = async (movie: Exclude<typeof searchItems, undefined>[number], isKeyboard: boolean) => {
    const { tmdbId, type } = movie;

    // Mark as loading
    setLoadingItems((prev) => [...prev, tmdbId]);

    try {
      // Fetch full metadata from TMDB
      const metadata = await utils.search.getTmdbMetadata.fetch({ tmdbId, type });

      if (metadata) {
        // Add item to local SQLite database
        addItem({
          type: metadata.type,
          tmdb_id: metadata.tmdbId,
          title: metadata.title,
          poster_url: metadata.posterUrl,
          overview: metadata.overview,
          duration: metadata.duration,
          episode_count: metadata.episodeCount,
          rating: metadata.rating,
          release_date: metadata.releaseDate,
          watched_at: null,
          priority: 0,
        });

        setAddedItems((prev) => [...prev, tmdbId]);
      }
    } catch (error) {
      console.error('Failed to add item:', error);
    } finally {
      setLoadingItems((prev) => prev.filter((id) => id !== tmdbId));
    }

    if (isKeyboard) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild={asChild}>{children}</DialogTrigger>
      <DialogContent
        noClose
        className="flex h-screen max-h-[calc(100dvh)] w-screen flex-col content-start items-start justify-start p-2 sm:h-[80vh] sm:max-w-[480px] sm:p-4 md:max-w-[700px] lg:max-w-[900px]"
      >
        <DialogTitle hidden>Add a movie</DialogTitle>
        <Description hidden>Add a movie to your list</Description>
        <div className="flex w-full flex-row items-center gap-3">
          <Input
            placeholder="Search for a movie"
            className="min-h-10"
            autoFocus
            onChange={(e) => setSearch(e.target.value)}
            ref={inputRef}
          />
          <button type="button" tabIndex={-1} onClick={close}>
            <XIcon />
          </button>
        </div>
        <div
          ref={animateRef}
          className="scrollbar flex w-full flex-row flex-wrap content-start items-start justify-center gap-4 overflow-y-auto overflow-x-hidden py-1"
        >
          {searchItems?.map((result) => (
            <SearchCard
              className="w-[40vw] sm:w-48"
              key={result.tmdbId}
              movie={result}
              onClick={({ isKeyboard }) => handleAddMovie(result, isKeyboard)}
              isAdded={addedItems.includes(result.tmdbId)}
              isLoading={loadingItems.includes(result.tmdbId)}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

type Movie = TrpcOutput['search']['findMovie'][number];

function SearchCard({
  movie,
  onClick,
  isAdded = false,
  isLoading = false,
  className,
}: {
  movie: Movie;
  onClick?: (event: { isKeyboard: boolean }) => void;
  isAdded?: boolean;
  isLoading?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        'group relative overflow-hidden rounded-md border border-border bg-card shadow-xs',
        'ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        className,
        onClick && 'cursor-pointer',
      )}
      disabled={isAdded || isLoading}
      tabIndex={isAdded || isLoading ? -1 : 0}
      onClick={(e) => {
        if (!onClick) return;

        const isKeyboard = e.clientX === 0 && e.clientY === 0;
        onClick({ isKeyboard });
      }}
    >
      <img
        className="rounded-md object-cover"
        src={`https://image.tmdb.org/t/p/w300${movie.posterPath}`}
        alt={movie.title}
      />
      <div
        className={cn(
          'absolute top-0 right-0 bottom-0 left-0 flex items-center justify-center bg-black/20 opacity-0 transition-all duration-300 group-hover:opacity-100',
          (isAdded || isLoading) && 'bg-black/50 opacity-100',
        )}
      >
        {isLoading && (
          <div className="size-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        )}
        {isAdded && !isLoading && <CheckIcon className="size-10 text-primary text-purple-500" />}
      </div>
      {!!movie.releaseDate && (
        <p className="absolute top-1 left-1 select-none rounded-full bg-black px-3 py-1 text-white">
          {format(new Date(movie.releaseDate), 'y')}
        </p>
      )}
      <VoteAverage className="absolute top-1 right-1" voteAverage={movie.voteAverage} />
      <div className="absolute right-0 bottom-0 left-0 flex flex-col">
        <div className="h-8 bg-linear-to-b from-transparent to-black/70" />
        <h3 className="bg-black/70 px-2 pb-2 font-semibold text-lg">{movie.title}</h3>
      </div>
    </button>
  );
}
