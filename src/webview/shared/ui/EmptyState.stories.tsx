import type { Meta, StoryObj } from '@storybook/react-vite';
import { Inbox, Sparkles } from 'lucide-react';
import { Button } from './Button';
import { EmptyState } from './EmptyState';

const meta: Meta<typeof EmptyState> = {
  title: 'Atoms/EmptyState',
  component: EmptyState,
};

export default meta;
type Story = StoryObj<typeof EmptyState>;

export const NoRuns: Story = {
  args: {
    icon: Sparkles,
    title: 'Запустите первый ран',
    description: 'Опишите задачу — продакт уточнит требования, архитектор спланирует подход.',
    cta: <Button variant="primary">Создать ран</Button>,
  },
};

export const EmptyList: Story = {
  args: {
    icon: Inbox,
    title: 'Пусто',
    description: 'Здесь пока ничего нет.',
  },
};
