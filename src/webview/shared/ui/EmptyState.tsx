import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Empty-state блок: крупная lucide-иконка + заголовок + описание + опц. CTA.
 * Используется в main-area #0018 («Запустите первый ран»), на пустых
 * списках и на канвасе до старта рана.
 *
 * Иконка передаётся компонентом-классом (`LucideIcon`), а не jsx-узлом —
 * чтобы потребитель не задавал `size`/`color` сам и не разъезжалась
 * визуальная норма.
 */
export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  cta?: ReactNode;
  className?: string;
}

export function EmptyState(props: EmptyStateProps) {
  const Icon = props.icon;
  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center text-center gap-2 px-4 py-8 text-muted',
        props.className
      )}
    >
      <Icon size={48} aria-hidden className="opacity-50" />
      <h3 className="text-foreground text-[13px] font-semibold m-0">{props.title}</h3>
      {props.description && (
        <p className="text-[11px] leading-snug max-w-[36ch] m-0">{props.description}</p>
      )}
      {props.cta && <div className="mt-2">{props.cta}</div>}
    </div>
  );
}
