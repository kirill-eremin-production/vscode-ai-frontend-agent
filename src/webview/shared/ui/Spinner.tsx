import clsx from 'clsx';
import { Loader2 } from 'lucide-react';

/**
 * Атомарный индикатор загрузки. Размер задаётся пропсом `size`, цвет
 * наследует `currentColor` — поэтому Spinner внутри Button'а или строки
 * текста сам подхватит правильный оттенок без дополнительных классов.
 *
 * Используем `Loader2` из lucide (вращается через CSS-анимацию `spin`),
 * а не самописный SVG: меньше LOC, легче менять иконку в будущем.
 */
export interface SpinnerProps {
  size?: 'xs' | 'sm' | 'md';
  className?: string;
  /** Подпись для скрин-ридеров. Если используется в составном компоненте
   *  с собственной подписью (LoadingState) — оставляем undefined и
   *  скрываем aria-атрибутом. */
  label?: string;
}

const SIZE_PX: Record<NonNullable<SpinnerProps['size']>, number> = {
  xs: 10,
  sm: 14,
  md: 20,
};

export function Spinner(props: SpinnerProps) {
  const size = props.size ?? 'sm';
  return (
    <Loader2
      size={SIZE_PX[size]}
      className={clsx('animate-spin', props.className)}
      role={props.label ? 'status' : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : true}
    />
  );
}
