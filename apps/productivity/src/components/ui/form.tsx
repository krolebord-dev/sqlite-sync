import { Slot } from "@radix-ui/react-slot";
import { createFormHook, createFormHookContexts, useStore } from "@tanstack/react-form";
import { AsteriskIcon } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";
import { Checkbox } from "./checkbox";
import { ComboboxInput } from "./combobox-input";
import { DateTimeInput } from "./date-time-input";
import { Input } from "./input";
import { Label } from "./label";
import { RadioGroup, RadioGroupItem } from "./radio-group";
import { Select, SelectContent, SelectTrigger, SelectValue } from "./select";
import { Textarea } from "./textarea";

type ControlA11yProps = {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "aria-labelledby"?: string;
};

type FormItemContextValue = {
  controlId: string;
  itemId: string;
  labelId: string;
  messageId: string;
};

const FormItemContext = React.createContext<FormItemContextValue | null>(null);

const { fieldContext, formContext, useFieldContext, useFormContext } = createFormHookContexts();

function useFormItemContext() {
  const context = React.useContext(FormItemContext);

  if (!context) {
    throw new Error("Form components must be used within <FormItem />.");
  }

  return context;
}

function useFieldMessageState() {
  const field = useFieldContext<unknown>();
  const errors = useStore(field.store, (state) => state.meta.errors);
  const isTouched = useStore(field.store, (state) => state.meta.isTouched);
  const submissionAttempts = useStore(field.form.store, (state) => state.submissionAttempts);

  return {
    errors,
    showError: errors.length > 0 && (isTouched || submissionAttempts > 0),
  };
}

function getErrorMessage(error: unknown) {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }

  if (typeof error === "number" || typeof error === "boolean") {
    return String(error);
  }

  return "Invalid value";
}

export function FormItem({ className, id, ...props }: React.ComponentProps<"div"> & { id?: string }) {
  const fallbackId = React.useId();
  const baseId = id ?? fallbackId;

  return (
    <FormItemContext.Provider
      value={{
        controlId: `${baseId}-control`,
        itemId: `${baseId}-item`,
        labelId: `${baseId}-label`,
        messageId: `${baseId}-message`,
      }}
    >
      <div data-slot="form-item" id={`${baseId}-item`} className={cn("flex flex-col gap-1.5", className)} {...props} />
    </FormItemContext.Provider>
  );
}

type FieldContainerProps = {
  children: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  id?: string;
  labelText?: React.ReactNode;
  required?: boolean;
};

export function FieldContainer({ children, className, description, id, labelText, required }: FieldContainerProps) {
  return (
    <FormItem id={id} className={className}>
      {labelText ? <FieldLabel required={required}>{labelText}</FieldLabel> : null}
      <FormControl>{children}</FormControl>
      <FormMessage>{description}</FormMessage>
    </FormItem>
  );
}

export function FieldLabel({ required, ...props }: React.ComponentProps<typeof Label> & { required?: boolean }) {
  const { controlId, labelId } = useFormItemContext();
  const { showError } = useFieldMessageState();

  return (
    <FormLabel id={labelId} htmlFor={controlId} data-error={showError || undefined} required={required} {...props} />
  );
}

export function FormLabel({
  children,
  className,
  required,
  ...props
}: React.ComponentProps<typeof Label> & { required?: boolean }) {
  return (
    <Label
      data-slot="form-label"
      className={cn("flex items-center gap-1 text-sm data-[error=true]:text-destructive", className)}
      {...props}
    >
      {required ? <AsteriskIcon className="size-3.5 text-primary" /> : null}
      {children}
    </Label>
  );
}

export function FormControl(props: React.ComponentProps<typeof Slot>) {
  const { controlId, labelId, messageId } = useFormItemContext();
  const { showError } = useFieldMessageState();

  return (
    <Slot
      data-slot="form-control"
      id={controlId}
      aria-describedby={messageId}
      aria-invalid={showError || undefined}
      aria-labelledby={labelId}
      {...props}
    />
  );
}

export function FormMessage({ children, className, ...props }: React.ComponentProps<"p">) {
  const { messageId } = useFormItemContext();
  const { errors, showError } = useFieldMessageState();
  const body = showError ? getErrorMessage(errors[0]) : children;

  if (!body) {
    return null;
  }

  return (
    <p
      data-slot="form-message"
      id={messageId}
      role={showError ? "alert" : undefined}
      data-error={showError || undefined}
      className={cn("text-muted-foreground text-sm data-[error=true]:text-destructive", className)}
      {...props}
    >
      {body}
    </p>
  );
}

export function FormInput({ onBlur, onChange, value, ...props }: React.ComponentProps<typeof Input>) {
  const field = useFieldContext<string>();

  return (
    <Input
      value={value ?? field.state.value ?? ""}
      onChange={(event) => {
        field.handleChange(event.currentTarget.value);
        onChange?.(event);
      }}
      onBlur={(event) => {
        field.handleBlur();
        onBlur?.(event);
      }}
      {...props}
    />
  );
}

type FormSelectProps = React.ComponentProps<typeof Select> &
  ControlA11yProps & {
    placeholder?: string;
  };

export function FormSelect({
  children,
  id,
  onValueChange,
  placeholder,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  "aria-labelledby": ariaLabelledBy,
  ...props
}: FormSelectProps) {
  const field = useFieldContext<string>();

  return (
    <Select
      value={field.state.value === "" ? undefined : field.state.value}
      onValueChange={(nextValue) => {
        field.handleChange(nextValue);
        onValueChange?.(nextValue);
      }}
      {...props}
    >
      <SelectTrigger
        id={id}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        aria-labelledby={ariaLabelledBy}
        onBlur={() => field.handleBlur()}
        className="w-full"
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}

export function FormTextarea({ onBlur, onChange, value, ...props }: React.ComponentProps<typeof Textarea>) {
  const field = useFieldContext<string>();

  return (
    <Textarea
      value={value ?? field.state.value ?? ""}
      onChange={(event) => {
        field.handleChange(event.currentTarget.value);
        onChange?.(event);
      }}
      onBlur={(event) => {
        field.handleBlur();
        onBlur?.(event);
      }}
      {...props}
    />
  );
}

type FormRadioGroupProps = Omit<React.ComponentProps<typeof RadioGroup>, "onValueChange" | "value"> &
  ControlA11yProps & {
    options?: readonly { label: string; value: string }[];
    orientation?: "horizontal" | "vertical";
  };

export function FormRadioGroup({
  className,
  id,
  onBlur,
  options,
  orientation = "vertical",
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  "aria-labelledby": ariaLabelledBy,
  ...props
}: FormRadioGroupProps) {
  const field = useFieldContext<string>();

  return (
    <RadioGroup
      id={id}
      value={field.state.value ?? ""}
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid}
      aria-labelledby={ariaLabelledBy}
      onValueChange={field.handleChange}
      onBlur={(event) => {
        field.handleBlur();
        onBlur?.(event);
      }}
      className={cn(
        "flex flex-col gap-3",
        orientation === "horizontal" ? "md:flex-row md:flex-wrap md:gap-4" : null,
        className,
      )}
      {...props}
    >
      {options?.map((option) => {
        const itemId = `${id ?? "radio"}-${option.value}`;

        return (
          <div className="flex items-center gap-2" key={itemId}>
            <RadioGroupItem value={option.value} id={itemId} />
            <Label htmlFor={itemId} className="font-normal text-foreground text-sm">
              {option.label}
            </Label>
          </div>
        );
      })}
    </RadioGroup>
  );
}

type CheckboxItemProps = React.ComponentProps<typeof Checkbox> & {
  label: React.ReactNode;
};

export function CheckboxItem({ label, ...props }: CheckboxItemProps) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox {...props} />
      <Label htmlFor={props.id} className="font-normal text-foreground text-sm">
        {label}
      </Label>
    </div>
  );
}

type FormCheckboxProps = Omit<CheckboxItemProps, "checked" | "onCheckedChange">;

export function FormCheckbox(props: FormCheckboxProps) {
  const field = useFieldContext<boolean>();

  return (
    <CheckboxItem
      checked={field.state.value ?? false}
      onCheckedChange={(checked) => {
        field.handleChange(checked === true);
      }}
      onBlur={() => field.handleBlur()}
      {...props}
    />
  );
}

type CheckboxGroupOption = {
  label: string;
  value: string;
};

export type FormCheckboxGroupProps = ControlA11yProps & {
  className?: string;
  options: readonly CheckboxGroupOption[];
};

export function FormCheckboxGroup({
  className,
  id,
  options,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  "aria-labelledby": ariaLabelledBy,
}: FormCheckboxGroupProps) {
  const field = useFieldContext<string[]>();
  const checkedValues = field.state.value ?? [];

  return (
    <div
      id={id}
      role="group"
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid}
      aria-labelledby={ariaLabelledBy}
      className={cn("flex flex-col gap-2", className)}
    >
      {options.map((option) => {
        const itemId = `${id ?? "checkbox-group"}-${option.value}`;

        return (
          <CheckboxItem
            key={option.value}
            id={itemId}
            label={option.label}
            checked={checkedValues.includes(option.value)}
            onCheckedChange={(checked) => {
              if (checked === true) {
                field.handleChange(
                  checkedValues.includes(option.value) ? checkedValues : [...checkedValues, option.value],
                );
                return;
              }

              field.handleChange(checkedValues.filter((value) => value !== option.value));
            }}
            onBlur={() => field.handleBlur()}
          />
        );
      })}
    </div>
  );
}

type FormComboboxInputProps = Omit<React.ComponentProps<typeof ComboboxInput>, "value" | "onChange" | "onBlur">;

export function FormComboboxInput(props: FormComboboxInputProps) {
  const field = useFieldContext<string>();

  return (
    <ComboboxInput
      value={field.state.value ?? ""}
      onChange={(value) => field.handleChange(value)}
      onBlur={() => field.handleBlur()}
      {...props}
    />
  );
}

type FormDateTimeInputProps = Omit<React.ComponentProps<typeof DateTimeInput>, "value" | "onChange" | "onBlur">;

export function FormDateTimeInput(props: FormDateTimeInputProps) {
  const field = useFieldContext<string>();

  return (
    <DateTimeInput
      value={field.state.value ?? ""}
      onChange={(value) => field.handleChange(value)}
      onBlur={() => field.handleBlur()}
      {...props}
    />
  );
}

const { useAppForm, withForm } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: {
    CheckboxItem,
    FieldContainer,
    FieldLabel,
    FormCheckbox,
    FormCheckboxGroup,
    FormComboboxInput,
    FormControl,
    FormInput,
    FormDateTimeInput,
    FormItem,
    FormMessage,
    FormRadioGroup,
    FormSelect,
    FormTextarea,
  },
  formComponents: {
    FormLabel,
  },
});

export { useAppForm, useFieldContext, useFormContext, withForm };
