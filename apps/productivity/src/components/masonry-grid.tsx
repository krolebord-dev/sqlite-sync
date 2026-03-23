import { Fragment, type Key, type ReactNode, useEffect, useState } from "react";

function useContainerWidth() {
  const [width, setWidth] = useState(0);
  const [element, ref] = useState<Element | null>();

  useEffect(() => {
    if (!element) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(element);
    return () => ro.disconnect();
  }, [element]);

  return [ref, width] as const;
}

function columnRange(colIdx: number, itemCount: number, columnCount: number) {
  const result = [];
  for (let i = colIdx; i < itemCount; i += columnCount) result.push(i);
  return result;
}

export function MasonryGrid<T>({
  items,
  itemKey,
  columnWidth,
  gap,
  renderItem,
}: {
  items: T[];
  itemKey: (item: T) => Key;
  columnWidth: number;
  gap?: number | string;
  renderItem: (item: T, index: number) => ReactNode;
}) {
  const [sizeRef, width] = useContainerWidth();
  const columnCount = Math.max(1, Math.floor(width / columnWidth));

  return (
    <div ref={sizeRef} className="flex" style={{ gap }}>
      {Array.from({ length: columnCount }, (_, colIdx) => (
        <div key={colIdx} className="flex flex-1 flex-col" style={{ gap }}>
          {columnRange(colIdx, items.length, columnCount).map((itemIdx) => (
            <Fragment key={itemKey(items[itemIdx])}>{renderItem(items[itemIdx], itemIdx)}</Fragment>
          ))}
        </div>
      ))}
    </div>
  );
}
