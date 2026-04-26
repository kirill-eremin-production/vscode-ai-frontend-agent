/**
 * Барель-реэкспорт компонентной библиотеки атомов (#0016).
 *
 * Импортируем как `import { Button, Spinner } from '@shared/ui'` —
 * один путь, никаких глубоких подключений к внутренним файлам. Это
 * страхует от случайной зависимости от приватных хелперов и упрощает
 * рефакторинг (переименовать `Spinner.tsx` можно без правки потребителей).
 */
export { Avatar } from './Avatar';
export type { AvatarProps, AvatarShape, AvatarSize } from './Avatar';

export { Badge } from './Badge';
export type { BadgeProps, BadgeVariant } from './Badge';

export { Button } from './Button';
export type { ButtonProps, ButtonSize, ButtonVariant } from './Button';

export { Collapsible } from './Collapsible';
export type { CollapsibleProps } from './Collapsible';

export { EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';

export { IconButton } from './IconButton';
export type { IconButtonProps, IconButtonSize, IconButtonVariant } from './IconButton';

export { LoadingState } from './LoadingState';
export type { LoadingStateProps } from './LoadingState';

export { Panel } from './Panel';
export type { PanelProps } from './Panel';

export { Skeleton } from './Skeleton';
export type { SkeletonProps } from './Skeleton';

export { Spinner } from './Spinner';
export type { SpinnerProps } from './Spinner';

export { Tooltip } from './Tooltip';
export type { TooltipProps } from './Tooltip';

export { roleIcons } from './role-icons';
export type { Role } from './role-icons';
