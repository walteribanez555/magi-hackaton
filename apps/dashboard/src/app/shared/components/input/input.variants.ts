import { cva } from 'class-variance-authority';

/** Campo de texto: regla fina, sin sombra ni radio grande (diseño MagiCode). */
export const inputVariants = cva(
  'min-h-11 w-full min-w-0 rounded-[4px] border border-field bg-bg px-3 py-2.5 text-[15px] text-ink transition-colors outline-none placeholder:text-faint focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-critical aria-invalid:ring-2 aria-invalid:ring-critical/20',
);
