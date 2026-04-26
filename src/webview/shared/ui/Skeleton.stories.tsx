import type { Meta, StoryObj } from '@storybook/react-vite';
import { Skeleton } from './Skeleton';

const meta: Meta<typeof Skeleton> = {
  title: 'Atoms/Skeleton',
  component: Skeleton,
};

export default meta;
type Story = StoryObj<typeof Skeleton>;

export const Variants: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 320 }}>
      <div>
        <div style={{ marginBottom: 4, fontSize: 11, opacity: 0.7 }}>text</div>
        <Skeleton variant="text" />
      </div>
      <div>
        <div style={{ marginBottom: 4, fontSize: 11, opacity: 0.7 }}>line</div>
        <Skeleton variant="line" />
      </div>
      <div>
        <div style={{ marginBottom: 4, fontSize: 11, opacity: 0.7 }}>block</div>
        <Skeleton variant="block" height={120} />
      </div>
    </div>
  ),
};

export const ListPlaceholder: Story = {
  render: () => (
    <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {[0, 1, 2].map((i) => (
        <li key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Skeleton width="40%" />
          <Skeleton variant="line" width="80%" />
        </li>
      ))}
    </ul>
  ),
};
