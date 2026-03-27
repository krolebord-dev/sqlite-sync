import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Calendar } from "./calendar";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { TimeInput } from "./time-input";

type DateTimeInputProps = {
  /** Value in `yyyy-MM-dd'T'HH:mm` format (same as datetime-local) */
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "aria-labelledby"?: string;
};

function toDate(value: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

function toTimeString(value: string): string {
  if (!value) return "00:00";
  const match = value.match(/T(\d{2}:\d{2})/);
  return match?.[1] ?? "00:00";
}

function combineDateAndTime(date: Date, time: string): string {
  return `${format(date, "yyyy-MM-dd")}T${time}`;
}

export function DateTimeInput({
  value,
  onChange,
  onBlur,
  id,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  "aria-labelledby": ariaLabelledBy,
}: DateTimeInputProps) {
  const [open, setOpen] = React.useState(false);
  const selected = toDate(value);
  const time = toTimeString(value);

  function handleDateSelect(day: Date | undefined) {
    if (!day) return;
    onChange(combineDateAndTime(day, time));
  }

  function handleTimeChange(newTime: string) {
    if (!selected) {
      onChange(combineDateAndTime(new Date(), newTime));
      return;
    }
    onChange(combineDateAndTime(selected, newTime));
  }

  const displayDate = selected ? format(selected, "MMM d, yyyy") : "Pick a date";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          aria-describedby={ariaDescribedBy}
          aria-invalid={ariaInvalid || undefined}
          aria-labelledby={ariaLabelledBy}
          onBlur={onBlur}
          className={cn("h-9 w-full justify-start px-3 font-normal", !selected && "text-muted-foreground")}
        >
          <CalendarIcon className="size-4 text-muted-foreground" />
          <span className="truncate">{displayDate}</span>
          <span className="ml-auto font-mono tabular-nums text-muted-foreground text-xs">{time}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          onSelect={handleDateSelect}
          defaultMonth={selected}
          className="border-b"
        />
        <div className="px-3 py-2">
          <TimeInput value={time} onChange={handleTimeChange} className="w-full" />
        </div>
      </PopoverContent>
    </Popover>
  );
}
