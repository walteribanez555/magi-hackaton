import { cva, type VariantProps } from 'class-variance-authority';

/**
 * Tabla estilo zard (coolfix-v2) con la piel del diseño MagiCode: cabecera en 12px apagada,
 * filas separadas por una regla de 1px, cifras tabulares. Sin zebra ni hover de fondo.
 */
export const tableVariants = cva('w-full border-collapse text-sm tabular-nums', {
  variants: {
    zType: {
      default: '',
      striped: '',
      bordered: '',
    },
    zSize: {
      default: '[&_td]:py-3.5',
      compact: '[&_td]:py-3',
      comfortable: '[&_td]:py-4',
    },
  },
  defaultVariants: {
    zType: 'default',
    zSize: 'default',
  },
});

export const tableHeaderVariants = cva('');

export const tableBodyVariants = cva('');

export const tableRowVariants = cva('border-t border-rule align-top data-[state=selected]:bg-selected');

export const tableHeadVariants = cva(
  'px-3 pt-3 pb-2 text-left align-bottom text-xs font-medium whitespace-nowrap text-muted first:pl-0 last:pr-0',
);

export const tableCellVariants = cva('px-3 align-top first:pl-0 last:pr-0');

export const tableCaptionVariants = cva('mt-3 text-left text-[13px] text-muted caption-bottom');

export const tableFooterVariants = cva('border-t border-ink font-medium');

export type ZardTableSizeVariants = NonNullable<VariantProps<typeof tableVariants>['zSize']>;
export type ZardTableTypeVariants = NonNullable<VariantProps<typeof tableVariants>['zType']>;
