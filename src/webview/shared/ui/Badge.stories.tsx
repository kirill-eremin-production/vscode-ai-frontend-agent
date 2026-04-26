import type { Meta, StoryObj } from '@storybook/react-vite';
import { Badge } from './Badge';

const meta: Meta<typeof Badge> = {
  title: 'Atoms/Badge',
  component: Badge,
  args: { children: 'badge' },
  argTypes: {
    variant: {
      control: 'inline-radio',
      options: ['neutral', 'accent', 'danger', 'warning', 'success'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof Badge>;

export const Default: Story = {};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <Badge variant="neutral">neutral</Badge>
      <Badge variant="accent">accent</Badge>
      <Badge variant="danger">danger</Badge>
      <Badge variant="warning">warning</Badge>
      <Badge variant="success">success</Badge>
    </div>
  ),
};
