import { type ComponentProps, createContext, useContext } from 'react';
import {
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from './context-menu';
import {
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from './dropdown-menu';

export type DynamicMenuContentType = 'dropdown-menu' | 'context-menu';

const MenuContentTypeContext = createContext<DynamicMenuContentType>('dropdown-menu');

export function DynamicMenuContent({
  type,
  ...rest
}: { type: DynamicMenuContentType } & (
  | ComponentProps<typeof DropdownMenuContent>
  | ComponentProps<typeof ContextMenuContent>
)) {
  return (
    <MenuContentTypeContext.Provider value={type}>
      {type === 'dropdown-menu' ? <DropdownMenuContent {...rest} /> : <ContextMenuContent {...rest} />}
    </MenuContentTypeContext.Provider>
  );
}

export function DynamicMenuSeparator(
  props: ComponentProps<typeof DropdownMenuSeparator> | ComponentProps<typeof ContextMenuSeparator>,
) {
  const type = useContext(MenuContentTypeContext);
  return type === 'dropdown-menu' ? <DropdownMenuSeparator {...props} /> : <ContextMenuSeparator {...props} />;
}

export function DynamicMenuItem(
  props: ComponentProps<typeof DropdownMenuItem> | ComponentProps<typeof ContextMenuItem>,
) {
  const type = useContext(MenuContentTypeContext);
  return type === 'dropdown-menu' ? <DropdownMenuItem {...props} /> : <ContextMenuItem {...props} />;
}

export function DynamicMenuLabel(
  props: ComponentProps<typeof DropdownMenuLabel> | ComponentProps<typeof ContextMenuLabel>,
) {
  const type = useContext(MenuContentTypeContext);
  return type === 'dropdown-menu' ? <DropdownMenuLabel {...props} /> : <ContextMenuLabel {...props} />;
}

export function DynamicMenuGroup(
  props: ComponentProps<typeof DropdownMenuGroup> | ComponentProps<typeof ContextMenuGroup>,
) {
  const type = useContext(MenuContentTypeContext);
  return type === 'dropdown-menu' ? <DropdownMenuGroup {...props} /> : <ContextMenuGroup {...props} />;
}

export function DynamicMenuSubTrigger(
  props: ComponentProps<typeof DropdownMenuSubTrigger> | ComponentProps<typeof ContextMenuSubTrigger>,
) {
  const type = useContext(MenuContentTypeContext);
  return type === 'dropdown-menu' ? <DropdownMenuSubTrigger {...props} /> : <ContextMenuSubTrigger {...props} />;
}

export function DynamicMenuSubContent(
  props: ComponentProps<typeof DropdownMenuSubContent> | ComponentProps<typeof ContextMenuSubContent>,
) {
  const type = useContext(MenuContentTypeContext);
  return type === 'dropdown-menu' ? <DropdownMenuSubContent {...props} /> : <ContextMenuSubContent {...props} />;
}

export function DynamicMenuSub(props: ComponentProps<typeof DropdownMenuSub> | ComponentProps<typeof ContextMenuSub>) {
  const type = useContext(MenuContentTypeContext);
  return type === 'dropdown-menu' ? <DropdownMenuSub {...props} /> : <ContextMenuSub {...props} />;
}
