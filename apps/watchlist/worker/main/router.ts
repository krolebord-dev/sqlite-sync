import { authRouter } from './routers/auth.router';
import { listRouter } from './routers/list.router';
import { searchRouter } from './routers/search.router';
import { router } from './trpc';

export const mainRouter = router({
  auth: authRouter,

  list: listRouter,

  search: searchRouter,
});

export type MainRouter = typeof mainRouter;
