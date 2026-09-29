"use client";

import { LANGUAGE_OPTIONS } from "@/lib/generation/language";
import { COUNT_PRESETS } from "@/lib/generation/client";
import type { CardLanguage } from "@/lib/domain/types";

/** Language and card-count controls, shared by Upload and Generate more. */

export function LanguagePicker({
  value,
  onChange,
  disabled,
  prefix,
}: {
  value: CardLanguage;
  onChange: (language: CardLanguage) => void;
  disabled?: boolean;
  prefix: string;
}) {
  return (
    <fieldset className="mt-4">
      <legend className="text-xs font-semibold uppercase tracking-wide text-ink-500">Card language</legend>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        {LANGUAGE_OPTIONS.map((option) => (
          <label
            key={option.id}
            className={`flex min-h-[3.25rem] cursor-pointer items-center gap-3 rounded-xl border px-4 py-2 ${value === option.id ? "border-clinical-500 bg-clinical-50" : "border-ink-200 bg-white"}`}
          >
            <input
              type="radio"
              name={`${prefix}-language`}
              value={option.id}
              checked={value === option.id}
              disabled={disabled}
              onChange={() => onChange(option.id)}
              data-testid={`${prefix}-${option.id}`}
              className="h-5 w-5 accent-clinical-600"
            />
            <span className="flex flex-col">
              <span className="font-semibold text-ink-800">{option.label}</span>
              {option.native !== option.label && (
                <span dir={option.dir} lang={option.dir === "rtl" ? "ar" : undefined} className="text-sm text-ink-600">
                  {option.native}
                </span>
              )}
            </span>
          </label>
        ))}
      </div>
      {value !== "en" && (
        <p data-testid={`${prefix}-language-note`} className="mt-2 text-sm text-ink-500">
          {value === "ar"
            ? "Questions and answers are written in Arabic. Medical terms MedRecall's built-in vocabulary knows are given in Arabic with the English in brackets; other terms stay in English. "
            : "Questions and answers are written in Arabic; medical terminology stays in English. "}
          Sentences outside the patterns the built-in generator supports keep part of the lecture&apos;s English — the result says how many. Full
          translation of every sentence needs a configured generation provider.
        </p>
      )}
    </fieldset>
  );
}

/**
 * After generation in an Arabic mode: how many cards are Arabic sentences,
 * and how many kept part of the lecture's English. Never hidden.
 */
export function ArabicCoverageNote({
  language,
  coverage,
  testId,
}: {
  language: CardLanguage;
  coverage: { arabic: number; partial: number };
  testId: string;
}) {
  if (language === "en") return null;
  return (
    <p data-testid={testId} data-arabic={coverage.arabic} data-partial={coverage.partial} className="mt-1 text-sm text-emerald-900">
      {coverage.arabic} {coverage.arabic === 1 ? "card is" : "cards are"} written as Arabic sentences
      {coverage.partial > 0
        ? `; ${coverage.partial} ${coverage.partial === 1 ? "keeps" : "keep"} part of the lecture's English wording (outside the built-in generator's patterns — review or edit them).`
        : "."}
    </p>
  );
}

export function CountPicker({
  choice,
  custom,
  onChoice,
  onCustom,
  disabled,
  prefix,
}: {
  choice: string;
  custom: string;
  onChoice: (choice: string) => void;
  onCustom: (custom: string) => void;
  disabled?: boolean;
  prefix: string;
}) {
  const options: { id: string; label: string }[] = [
    ...COUNT_PRESETS.map((n) => ({ id: String(n), label: String(n) })),
    { id: "custom", label: "Custom" },
    { id: "auto", label: "Auto" },
  ];
  return (
    <fieldset className="mt-5">
      <legend className="text-xs font-semibold uppercase tracking-wide text-ink-500">How many cards</legend>
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map((option) => (
          <label
            key={option.id}
            className={`flex min-h-[3.25rem] cursor-pointer items-center gap-2 rounded-xl border px-4 ${choice === option.id ? "border-clinical-500 bg-clinical-50" : "border-ink-200 bg-white"}`}
          >
            <input
              type="radio"
              name={`${prefix}-count`}
              value={option.id}
              checked={choice === option.id}
              disabled={disabled}
              onChange={() => onChoice(option.id)}
              data-testid={`${prefix}-${option.id}`}
              className="h-5 w-5 accent-clinical-600"
            />
            <span className="font-semibold text-ink-800 tabular-nums">{option.label}</span>
          </label>
        ))}
        {choice === "custom" && (
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={500}
            value={custom}
            disabled={disabled}
            onChange={(e) => onCustom(e.target.value)}
            data-testid={`${prefix}-custom-value`}
            aria-label="Number of cards"
            className="min-h-[3.25rem] w-28 rounded-xl border border-ink-300 px-3 text-base tabular-nums"
          />
        )}
      </div>
      <p className="mt-2 text-sm text-ink-500">
        Auto covers the important material once. A larger number is met only when the lecture supports it — facts are never repeated to reach a count.
      </p>
    </fieldset>
  );
}
