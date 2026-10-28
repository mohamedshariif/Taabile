import { createElement, type ButtonHTMLAttributes, type FormEventHandler, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { ThemeSwitch } from './ThemeSwitch';

// Small building blocks used by every screen. Screens say WHAT they show (Button, Field, DataTable...);
// the look (Tailwind classes) lives only here, so changing it later is a one-file job.

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

// ── Text ──
export const PageTitle = ({ children }: { children: ReactNode }) => <h1 className="mb-3 text-2xl font-bold">{children}</h1>;
/** A heading for one part of a screen. `first` removes the space above it (the first heading inside a Card). */
export const SectionTitle = ({ children, first, className }: { children: ReactNode; first?: boolean; className?: string }) => (
  <h2 className={cx(first ? 'mb-1' : 'mt-6 mb-1', 'text-lg font-semibold', className)}>{children}</h2>
);
export const Muted = ({ children, small, className }: { children: ReactNode; small?: boolean; className?: string }) => (
  <p className={cx('text-muted', small && 'text-sm', className)}>{children}</p>
);
/** An error message. role="alert" makes screen readers announce it. */
export const ErrorText = ({ children, className }: { children: ReactNode; className?: string }) => (
  <p role="alert" className={cx('mt-2 text-danger', className)}>
    {children}
  </p>
);

// ── Buttons ──
type Variant = 'primary' | 'ghost' | 'danger' | 'link' | 'choice';
const VARIANT: Record<Variant, string> = {
  primary: 'bg-brand text-on-brand hover:opacity-90',
  ghost: 'border border-line bg-transparent text-ink hover:bg-page',
  danger: 'bg-danger text-white hover:opacity-90',
  link: 'bg-transparent font-medium text-muted hover:text-ink',
  choice: 'w-full justify-start border border-line bg-page text-left text-ink hover:border-brand',
};

/** type defaults to "button": a form only submits from a Button that says type="submit". */
export function Button({
  variant = 'primary',
  small,
  className,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; small?: boolean }) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex cursor-pointer items-center justify-center gap-1 rounded-lg font-semibold transition-opacity disabled:cursor-default disabled:opacity-60',
        // A link-style button has no side padding, so its text lines up with the text above it.
        variant === 'link' ? 'min-h-11 py-2' : small ? 'min-h-9 px-3 py-1 text-sm' : 'min-h-11 px-4 py-2',
        VARIANT[variant],
        className,
      )}
      {...rest}
    />
  );
}

// ── Form parts ──
const CONTROL =
  'mt-1 block w-full min-h-11 rounded-lg border border-line bg-page px-3 py-2 text-base text-ink placeholder:text-muted/70 disabled:opacity-60';

/**
 * A label above a control, with an optional hint underneath, or an error message instead of the hint:
 *   <Field label="Email" hint="..." error={problems.email}><Input/></Field>
 */
export function Field({ label, hint, error, children, className }: { label: string; hint?: string; error?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="block font-semibold">{label}</span>
      {children}
      {error ? (
        <span role="alert" className="mt-1 block text-sm font-normal text-danger">{error}</span>
      ) : (
        hint && <span className="mt-1 block text-sm font-normal text-muted">{hint}</span>
      )}
    </label>
  );
}
export const Input = ({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) => <input className={cx(CONTROL, className)} {...rest} />;
export const Select = ({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) => <select className={cx(CONTROL, className)} {...rest} />;

/** A tick box or switch with its label. Big enough to tap. */
export function Check({ label, children, className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode }) {
  return (
    <label className={cx('flex min-h-9 cursor-pointer items-center gap-3 py-1 font-medium', className)}>
      <input type="checkbox" className="size-5 shrink-0 accent-brand" {...rest} />
      <span className="flex flex-wrap items-center gap-2">{label}</span>
      {children}
    </label>
  );
}

// ── Containers ──
type CardProps = HTMLAttributes<HTMLElement> & { as?: 'div' | 'section' | 'form' | 'fieldset'; disabled?: boolean; onSubmit?: FormEventHandler<HTMLFormElement> };
/** The white box that groups one thing on a screen. as="form" or as="fieldset" when it should be one. */
export function Card({ as = 'section', className, ...rest }: CardProps) {
  return createElement(as, { className: cx('my-4 min-w-0 rounded-xl border border-line bg-card p-4 sm:p-5', className), ...rest });
}
/** Wraps a group of controls inside a Card with a small legend, e.g. "Where will they work?". */
export const Group = ({ legend, children }: { legend: string; children: ReactNode }) => (
  <fieldset className="my-3 rounded-lg border border-line px-3 pb-2">
    <legend className="px-1 font-semibold">{legend}</legend>
    {children}
  </fieldset>
);
/** Fields that sit side by side on a wide screen and stack on a phone. */
export const FieldRow = ({ children }: { children: ReactNode }) => <div className="my-3 grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]">{children}</div>;
/** A page centred on the screen (sign-in, invitation). */
export const Center = ({ children, theme }: { children: ReactNode; theme?: boolean }) => (
  <div className="relative grid min-h-screen place-items-center p-4">
    {theme && <div className="absolute top-3 right-3"><ThemeSwitch /></div>}
    {children}
  </div>
);

// ── Small status label ──
const TONE = {
  ok: 'border-brand text-brand',
  off: 'border-line text-muted',
  wait: 'border-warn text-warn',
} as const;
export const Badge = ({ tone, children }: { tone: keyof typeof TONE; children: ReactNode }) => (
  <span className={cx('inline-block rounded-full border px-2 py-px text-xs font-bold', TONE[tone])}>{children}</span>
);

// ── Table that becomes a list of cards on a phone ──
export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  /** The main line of a row. On a phone it is the card's title. */
  primary?: boolean;
  /** Buttons / links. Right-aligned in the table, shown at the bottom of the card on a phone. */
  actions?: boolean;
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  dim,
  empty = 'Nothing here yet.',
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  dim?: (row: T) => boolean;
  empty?: string;
}) {
  const main = columns.find((c) => c.primary) ?? columns[0]!;
  const details = columns.filter((c) => c !== main && !c.actions);
  const actions = columns.find((c) => c.actions);
  if (rows.length === 0) return <p className="my-2 rounded-xl border border-line bg-card p-4 text-muted">{empty}</p>;
  return (
    <>
      {/* Wide screens: a normal table */}
      <div className="my-2 hidden overflow-hidden rounded-xl border border-line bg-card md:block">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-line">
              {columns.map((c) => (
                <th key={c.header} className="px-3 py-2.5 text-xs font-semibold tracking-wide text-muted uppercase">
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={rowKey(r)} className={cx('border-b border-line last:border-0', dim?.(r) && 'opacity-60')}>
                {columns.map((c) => (
                  <td key={c.header} className={cx('px-3 py-2.5 align-middle', c.actions && 'text-right whitespace-nowrap')}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Phones: one card per row, nothing wider than the screen */}
      <ul className="my-2 space-y-3 md:hidden">
        {rows.map((r) => (
          <li key={rowKey(r)} className={cx('rounded-xl border border-line bg-card p-4', dim?.(r) && 'opacity-60')}>
            <div className="font-semibold wrap-break-word">{main.cell(r)}</div>
            {details.length > 0 && (
              <dl className="mt-2 space-y-1 text-sm">
                {details.map((c) => (
                  <div key={c.header} className="flex justify-between gap-4">
                    <dt className="shrink-0 text-muted">{c.header}</dt>
                    <dd className="text-right wrap-break-word">{c.cell(r)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {actions && <div className="mt-3 flex flex-wrap items-center justify-end gap-2">{actions.cell(r)}</div>}
          </li>
        ))}
      </ul>
    </>
  );
}