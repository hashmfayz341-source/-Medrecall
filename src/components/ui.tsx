"use client";

import Link from "next/link";
import type { MasteryState } from "@/lib/domain/types";

/**
 * Shared presentational pieces.
 *
 * Touch targets are sized for an iPad held in the hand: every interactive
 * element clears 44px, and primary actions are considerably larger.
 */

export function Card({
  children,
  className = "",
  ...rest
}: React.HTMLAttributes<HTMLElement>) {
  return (
    <section
      {...rest}
      className={`rounded-2xl border border-ink-200 bg-white p-6 shadow-sm sm:p-7 ${className}`}
    >
      {children}
    </section>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-500">
      {children}
    </h2>
  );
}

const buttonBase =
  "inline-flex min-h-[3.25rem] items-center justify-center gap-2 rounded-xl px-7 text-base font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-clinical-600 disabled:cursor-not-allowed disabled:opacity-45";

const variants = {
  primary: "bg-clinical-600 text-white hover:bg-clinical-700",
  secondary: "border border-ink-300 bg-white text-ink-700 hover:bg-ink-100",
  danger: "border border-red-300 bg-white text-red-700 hover:bg-red-50",
} as const;

export function Button({
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof variants;
}) {
  return (
    <button
      {...props}
      className={`${buttonBase} ${variants[variant]} ${className}`}
    />
  );
}

export function ButtonLink({
  href,
  variant = "primary",
  className = "",
  children,
  ...rest
}: {
  href: string;
  variant?: keyof typeof variants;
  className?: string;
  children: React.ReactNode;
} & Omit<React.ComponentPropsWithoutRef<typeof Link>, "href" | "className">) {
  return (
    <Link
      {...rest}
      href={href}
      className={`${buttonBase} ${variants[variant]} ${className}`}
    >
      {children}
    </Link>
  );
}

const masteryStyles: Record<MasteryState, string> = {
  NEW: "bg-ink-100 text-ink-600 border-ink-200",
  LEARNING: "bg-amber-50 text-amber-800 border-amber-200",
  WEAK: "bg-red-50 text-red-700 border-red-200",
  STABLE: "bg-clinical-50 text-clinical-800 border-clinical-200",
  STRONG: "bg-emerald-50 text-emerald-800 border-emerald-200",
};

export function MasteryBadge({ state }: { state: MasteryState }) {
  return (
    <span
      data-testid={`mastery-${state}`}
      className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${masteryStyles[state]}`}
    >
      {state}
    </span>
  );
}

export function SourceRefLine({
  documentTitle,
  pageNumber,
  excerpt,
}: {
  documentTitle: string;
  pageNumber: number;
  excerpt: string;
}) {
  return (
    <details className="group mt-4 rounded-xl border border-ink-200 bg-ink-50 p-4">
      <summary className="min-h-[2.75rem] cursor-pointer list-none text-sm font-semibold text-clinical-700 marker:hidden">
        View source · {documentTitle}, page {pageNumber}
      </summary>
      <blockquote className="mt-3 border-l-4 border-clinical-300 pl-4 text-[0.95rem] leading-relaxed text-ink-600">
        {excerpt}
      </blockquote>
    </details>
  );
}

export function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string | number;
  tone?: "default" | "warn";
}) {
  return (
    <div className="rounded-xl border border-ink-200 bg-white px-5 py-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">
        {label}
      </div>
      <div
        className={`mt-1 text-3xl font-bold tabular-nums ${
          tone === "warn" ? "text-red-600" : "text-ink-800"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
