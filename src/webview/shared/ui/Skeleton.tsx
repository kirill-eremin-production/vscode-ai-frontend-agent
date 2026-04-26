import clsx from 'clsx';

/**
 * Серый плейсхолдер с пульсацией для загружающегося контента.
 *
 * Варианты:
 *  - `text` — однострочный, высота под typography (1em);
 *  - `line` — фиксированная высота 8px (для прогрессов/карточек);
 *  - `block` — крупный блок с ratio под прямоугольник (по умолчанию 64×100%).
 *
 * Цвет фона — `currentColor` с прозрачностью, чтобы skeleton автоматически
 * подстраивался под тёмную/светлую тему без отдельного токена.
 */
export interface SkeletonProps {
  variant?: 'text' | 'line' | 'block';
  width?: string | number;
  height?: string | number;
  className?: string;
}

export function Skeleton(props: SkeletonProps) {
  const variant = props.variant ?? 'text';
  const fallbackHeight = variant === 'text' ? '1em' : variant === 'line' ? 8 : 64;
  const fallbackWidth = variant === 'block' ? '100%' : variant === 'line' ? '100%' : '8em';
  return (
    <span
      className={clsx('animate-pulse rounded-sm inline-block', props.className)}
      style={{
        width: props.width ?? fallbackWidth,
        height: props.height ?? fallbackHeight,
        backgroundColor: 'color-mix(in srgb, currentColor 18%, transparent)',
      }}
      aria-hidden="true"
    />
  );
}
