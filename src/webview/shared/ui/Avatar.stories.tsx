import type { Meta, StoryObj } from '@storybook/react-vite';
import { Avatar } from './Avatar';

const meta: Meta<typeof Avatar> = {
  title: 'Atoms/Avatar',
  component: Avatar,
  args: { role: 'product', size: 'md', shape: 'circle' },
  argTypes: {
    role: { control: 'inline-radio', options: ['product', 'architect', 'user', 'system'] },
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
    shape: { control: 'inline-radio', options: ['circle', 'square'] },
  },
};

export default meta;
type Story = StoryObj<typeof Avatar>;

export const Default: Story = {};

export const AllRoles: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 12 }}>
      <Avatar role="product" />
      <Avatar role="architect" />
      <Avatar role="user" />
      <Avatar role="system" />
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <Avatar role="architect" size="sm" />
      <Avatar role="architect" size="md" />
      <Avatar role="architect" size="lg" />
    </div>
  ),
};

export const Square: Story = { args: { shape: 'square' } };
