import clsx from 'clsx';
import { ChevronRight } from 'lucide-react';
import * as RadixCollapsible from '@radix-ui/react-collapsible';
import type { ReactNode } from 'react';

/**
 * Раскрывающийся блок поверх Radix-примитива. Шеврон поворачивается на
 * 90° при `data-state=open` (Tailwind CSS-anim selector). Сама анимация
 * высоты — это уже забота tool-карточек (#0021), там решат, нужна она
 * или нет; здесь компонент остаётся «честным» аккордеоном без сюрпризов.
 *
 * Контролируется через `open`/`onOpenChange`, или работает uncontrolled
 * через `defaultOpen` — стандартный Radix-контракт.
 */
export interface CollapsibleProps {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

export function Collapsible(props: CollapsibleProps) {
  return (
    <RadixCollapsible.Root
      open={props.open}
      defaultOpen={props.defaultOpen}
      onOpenChange={props.onOpenChange}
      className={clsx('flex flex-col', props.className)}
    >
      <RadixCollapsible.Trigger
        className={clsx(
          'group flex items-center gap-1.5 text-left text-[12px] text-foreground',
          'hover:bg-[var(--vscode-list-hoverBackground)] rounded-sm px-1 py-0.5',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-1'
        )}
      >
        <ChevronRight
          size={12}
          aria-hidden
          className="transition-transform group-data-[state=open]:rotate-90"
        />
        <span className="flex-1">{props.trigger}</span>
      </RadixCollapsible.Trigger>
      <RadixCollapsible.Content className="pl-4 pt-1">{props.children}</RadixCollapsible.Content>
    </RadixCollapsible.Root>
  );
}
