import { cva, type VariantProps } from 'class-variance-authority';

import { mergeClasses } from '@/shared/utils/merge-classes';

/**
 * Botón estilo zard (coolfix-v2) adaptado al diseño de MagiCode: esquinas casi rectas,
 * tinta sólida para la acción principal, regla fina para la secundaria, sin sombras.
 */
export const buttonVariants = cva(
  mergeClasses(
    "group/button inline-flex shrink-0 cursor-pointer items-center justify-center rounded-[4px] border border-transparent text-sm font-medium whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ),
  {
    variants: {
      zType: {
        default: 'bg-ink text-on-ink hover:opacity-90',
        destructive: 'border-critical text-critical hover:bg-critical/10',
        outline: 'border-field bg-bg text-ink hover:border-ink',
        secondary: 'bg-track text-ink hover:bg-rule',
        ghost: 'text-ink hover:bg-track',
        link: 'min-h-0! h-auto! px-0! py-2 font-normal! text-accent underline-offset-4 hover:text-accent-hover hover:underline',
      },
      zSize: {
        default: 'min-h-11 gap-2 px-5 text-[15px] font-semibold',
        xs: "h-7 gap-1 px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-2.5 text-[13px] [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-10 gap-2 px-4 text-[15px]',
        icon: 'size-9',
        'icon-xs': "size-7 [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
      },
      zShape: {
        default: 'rounded-[4px]',
        circle: 'rounded-full',
        square: 'rounded-none',
      },
      zLoading: {
        true: 'pointer-events-none opacity-60',
      },
      zDisabled: {
        true: 'pointer-events-none opacity-50',
      },
    },
    defaultVariants: {
      zType: 'default',
      zSize: 'default',
      zShape: 'default',
    },
  },
);
export type ZardButtonShapeVariants = NonNullable<VariantProps<typeof buttonVariants>['zShape']>;
export type ZardButtonSizeVariants = NonNullable<VariantProps<typeof buttonVariants>['zSize']>;
export type ZardButtonTypeVariants = NonNullable<VariantProps<typeof buttonVariants>['zType']>;
