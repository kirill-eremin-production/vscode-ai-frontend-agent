import clsx from 'clsx';
import type { ReactNode } from 'react';

/**
 * Карточка с фоном `surface-elevated` и бордером — базовый контейнер
 * для группировки контента (заголовок + содержимое). Header опционален
 * и оформлен как тонкий strip с разделителем; если его нет — Panel
 * выглядит как обычный rounded-блок.
 */
export interface PanelProps {
  header?: ReactNode;
  /** Дополнительные элементы в правой части шапки (например, IconButton). */
  headerActions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Panel(props: PanelProps) {
  return (
    <section
      className={clsx(
        'rounded-sm border border-border bg-surface-elevated text-foreground',
        props.className
      )}
    >
      {props.header !== undefined && (
        <header className="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-border-subtle">
          <div className="text-[12px] font-semibold leading-none">{props.header}</div>
          {props.headerActions && (
            <div className="flex items-center gap-1">{props.headerActions}</div>
          )}
        </header>
      )}
      <div className="p-2">{props.children}</div>
    </section>
  );
}
