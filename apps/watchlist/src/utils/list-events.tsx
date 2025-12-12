import { WebSocket } from 'partysocket';
import { createContext, useContext, useEffect, useState } from 'react';
import superjson from 'superjson';
import type { ListEvent } from '../../worker';

type ListEventsContextData = {
  socket: WebSocket | null;
};

const ListEventsContext = createContext<ListEventsContextData | null>(null);

type ListEventType = ListEvent['type'];

const handlersMap = new Map<ListEventType, Set<(event: ListEvent) => void>>();

function isListEvent(event: unknown): event is ListEvent {
  return typeof event === 'object' && event !== null && 'type' in event && typeof event.type === 'string';
}

export function ListEventsProvider({
  listId,
  sessionId,
  children,
}: {
  listId: string;
  sessionId: string;
  children: React.ReactNode;
}) {
  const [socket, setSocket] = useState<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(`/ws/list/${listId}?sessionId=${sessionId}`);

    setSocket(ws);

    const messageHandler = (e: MessageEvent) => {
      const event = superjson.parse(e.data) as ListEvent;

      if (!isListEvent(event)) {
        return;
      }

      const handlers = handlersMap.get(event.type);
      if (handlers) {
        for (const handler of handlers) {
          handler(event);
        }
      }
    };

    ws.addEventListener('message', messageHandler);

    return () => {
      ws.removeEventListener('message', messageHandler);
      ws.close();
    };
  }, [listId, sessionId]);

  return <ListEventsContext.Provider value={{ socket }}>{children}</ListEventsContext.Provider>;
}

export function useListSocket() {
  const data = useContext(ListEventsContext);
  return data?.socket;
}

export function useListEvent<Type extends ListEventType>(
  type: Type,
  handler: (event: Extract<ListEvent, { type: Type }>) => void,
) {
  useEffect(() => {
    const handlers = handlersMap.get(type);
    const handlerTyped = handler as unknown as (event: ListEvent) => void;

    if (!handlers) {
      handlersMap.set(type, new Set([handlerTyped]));
    } else {
      handlers.add(handlerTyped);
    }

    return () => {
      handlers?.delete(handlerTyped);
    };
  }, [type, handler]);
}
