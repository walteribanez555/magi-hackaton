import { cva, type VariantProps } from 'class-variance-authority';

export const skeletonVariants = cva('bg-track animate-pulse rounded-none motion-reduce:animate-none');
export type ZardSkeletonVariants = VariantProps<typeof skeletonVariants>;
