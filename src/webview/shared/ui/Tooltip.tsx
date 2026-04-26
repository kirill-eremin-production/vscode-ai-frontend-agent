import clsx from 'clsx';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactElement, ReactNode } from 'react';

/**
 * Тонкая обёртка над `@radix-ui/react-tooltip`. Скрывает boilerplate
 * (Provider/Root/Trigger/Portal/Content) — для большинства мест нужна
 * простая «иконка → подсказка», и таскать всю иерархию каждый раз
 * не хочется.
 *
 * Если когда-то понадобится сложная анимация или нестандартный portal —
 * добавляем `unstyled` пропс и даём сырой Radix-API наружу. Пока YAGNI.
 *
 * Trigger обязан быть `ReactElement` (не строкой/фрагментом) — Radix
 * клонирует элемент через `asChild` и навешивает aria-описание.
 */
export interface TooltipProps {
  content: ReactNode;
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Задержка появления, мс. По умолчанию 200 — стандарт Radix. */
  delayDuration?: number;
}

export function Tooltip(props: TooltipProps) {
  return (
    <RadixTooltip.Provider delayDuration={props.delayDuration ?? 200}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{props.children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            side={props.side ?? 'top'}
            sideOffset={4}
            className={clsx(
              'z-50 max-w-xs rounded-sm px-2 py-1 text-[11px] leading-snug',
              'bg-surface-overlay text-foreground border border-border-subtle shadow-md',
              'data-[state=delayed-open]:animate-in data-[state=closed]:animate-out fade-in-0 fade-out-0'
            )}
          >
            {props.content}
            <RadixTooltip.Arrow className="fill-[var(--vscode-menu-background)]" />
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
