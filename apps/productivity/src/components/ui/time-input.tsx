import { ClockIcon } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

type TimeInputProps = {
  /** Value in "HH:mm" format */
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  id?: string;
  className?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "aria-labelledby"?: string;
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function parseTime(value: string): { hours: number; minutes: number } {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return { hours: 0, minutes: 0 };
  return {
    hours: clamp(Number(match[1]), 0, 23),
    minutes: clamp(Number(match[2]), 0, 59),
  };
}

export function TimeInput({
  value,
  onChange,
  onBlur,
  id,
  className,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  "aria-labelledby": ariaLabelledBy,
}: TimeInputProps) {
  const { hours, minutes } = parseTime(value);
  const hoursRef = React.useRef<HTMLInputElement>(null);
  const minutesRef = React.useRef<HTMLInputElement>(null);

  function emit(h: number, m: number) {
    onChange(`${pad(clamp(h, 0, 23))}:${pad(clamp(m, 0, 59))}`);
  }

  function handleHoursKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      emit(hours >= 23 ? 0 : hours + 1, minutes);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      emit(hours <= 0 ? 23 : hours - 1, minutes);
    } else if (e.key === "ArrowRight" && e.currentTarget.selectionStart === e.currentTarget.value.length) {
      e.preventDefault();
      minutesRef.current?.focus();
      minutesRef.current?.select();
    }
  }

  function handleMinutesKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      emit(hours, minutes >= 59 ? 0 : minutes + 1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      emit(hours, minutes <= 0 ? 59 : minutes - 1);
    } else if (e.key === "ArrowLeft" && e.currentTarget.selectionStart === 0) {
      e.preventDefault();
      hoursRef.current?.focus();
      hoursRef.current?.select();
    } else if (e.key === "Backspace" && e.currentTarget.value === "") {
      e.preventDefault();
      hoursRef.current?.focus();
      hoursRef.current?.select();
    }
  }

  function handleHoursChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value.replace(/\D/g, "");
    if (raw === "") {
      emit(0, minutes);
      return;
    }
    const n = Number.parseInt(raw, 10);
    emit(n, minutes);
    if (n > 2 || raw.length >= 2) {
      minutesRef.current?.focus();
      minutesRef.current?.select();
    }
  }

  function handleMinutesChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value.replace(/\D/g, "");
    if (raw === "") {
      emit(hours, 0);
      return;
    }
    emit(hours, Number.parseInt(raw, 10));
  }

  function handleWheel(e: React.WheelEvent<HTMLInputElement>, field: "hours" | "minutes") {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1 : -1;
    if (field === "hours") {
      const next = hours + delta;
      emit(next > 23 ? 0 : next < 0 ? 23 : next, minutes);
    } else {
      const next = minutes + delta;
      emit(hours, next > 59 ? 0 : next < 0 ? 59 : next);
    }
  }

  return (
    <div
      role="group"
      id={id}
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid || undefined}
      aria-labelledby={ariaLabelledBy}
      className={cn(
        "inline-flex h-9 items-center gap-0.5 rounded-md border border-input bg-transparent px-3 shadow-xs transition-all focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:aria-invalid:ring-destructive/40",
        className,
      )}
    >
      <ClockIcon className="size-4 shrink-0 text-muted-foreground" />
      <input
        ref={hoursRef}
        type="text"
        inputMode="numeric"
        value={pad(hours)}
        onChange={handleHoursChange}
        onKeyDown={handleHoursKeyDown}
        onWheel={(e) => handleWheel(e, "hours")}
        onFocus={(e) => e.target.select()}
        onBlur={onBlur}
        aria-label="Hours"
        className="w-6 bg-transparent text-center font-mono tabular-nums text-sm outline-none selection:bg-primary/20"
        maxLength={2}
      />
      <span className="font-mono text-muted-foreground text-sm select-none">:</span>
      <input
        ref={minutesRef}
        type="text"
        inputMode="numeric"
        value={pad(minutes)}
        onChange={handleMinutesChange}
        onKeyDown={handleMinutesKeyDown}
        onWheel={(e) => handleWheel(e, "minutes")}
        onFocus={(e) => e.target.select()}
        onBlur={onBlur}
        aria-label="Minutes"
        className="w-6 bg-transparent text-center font-mono tabular-nums text-sm outline-none selection:bg-primary/20"
        maxLength={2}
      />
    </div>
  );
}
