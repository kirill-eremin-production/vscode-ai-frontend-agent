import type { Meta, StoryObj } from '@storybook/react-vite';
import { Settings } from 'lucide-react';
import { IconButton } from './IconButton';
import { Panel } from './Panel';

const meta: Meta<typeof Panel> = {
  title: 'Atoms/Panel',
  component: Panel,
};

export default meta;
type Story = StoryObj<typeof Panel>;

export const WithHeader: Story = {
  args: {
    header: 'Контекст',
    children: 'Здесь будет содержимое панели — карточки, списки, что угодно.',
  },
};

export const WithActions: Story = {
  args: {
    header: 'Сессия',
    headerActions: (
      <IconButton aria-label="Settings" icon={<Settings size={12} aria-hidden />} size="sm" />
    ),
    children: 'Контент с действиями в шапке.',
  },
};

export const Plain: Story = {
  args: {
    children: 'Без header — просто rounded-блок с фоном и бордером.',
  },
};
