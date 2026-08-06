import { useId, type CSSProperties } from "react"
import { Slider } from "@/components/ui/slider"

export type FilterSliderStep<T extends string> = {
  value: T
  label: string
  valueLabel: string
}

export function FilterSlider<T extends string>({
  label,
  ariaLabel,
  showLabel = true,
  value,
  steps,
  disabled = false,
  onChange,
}: {
  label: string
  ariaLabel?: string
  showLabel?: boolean
  value: T
  steps: FilterSliderStep<T>[]
  disabled?: boolean
  onChange: (value: T) => void
}) {
  const controlId = useId()
  const controlLabel = ariaLabel ?? label
  const currentIndex = Math.max(0, steps.findIndex((step) => step.value === value))
  const currentStep = steps[currentIndex] ?? steps[0]
  const progress = steps.length <= 1 ? 0 : (currentIndex / (steps.length - 1)) * 100
  const neutral = value === "any"

  return (
    <div
      className={`fd-filter-slider ${neutral ? "is-neutral" : ""} ${disabled ? "is-disabled" : ""}`}
      style={{
        "--fd-filter-slider-progress": `${progress}%`,
        "--fd-filter-slider-steps": steps.length,
      } as CSSProperties}
    >
      <div className={`fd-filter-slider__head ${showLabel ? "" : "fd-filter-slider__head--value-only"}`}>
        <label htmlFor={controlId} className={showLabel ? "fd-filter-slider__label" : "fd-sr-only"}>{label}</label>
        <span className="fd-filter-slider__value">{currentStep?.valueLabel}</span>
      </div>
      <Slider
        id={controlId}
        min={0}
        max={Math.max(0, steps.length - 1)}
        step={1}
        value={[currentIndex]}
        disabled={disabled}
        aria-label={controlLabel}
        aria-valuetext={currentStep?.valueLabel}
        className="fd-filter-slider__range"
        onValueChange={([nextIndex]) => {
          const next = steps[nextIndex ?? currentIndex]
          if (next) onChange(next.value)
        }}
      />
      <div className="fd-filter-slider__marks" aria-hidden="true">
        {steps.map((step, index) => (
          <span
            key={step.value}
            className={`fd-filter-slider__mark ${step.value === value ? "is-active" : ""}`}
            style={{
              "--fd-filter-slider-mark-position": `${steps.length <= 1 ? 0 : (index / (steps.length - 1)) * 100}%`,
            } as CSSProperties}
          >
            {step.label}
          </span>
        ))}
      </div>
    </div>
  )
}
