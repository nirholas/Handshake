import type { CSSProperties } from "react";

type CheckpointOption = {
  value: string;
  label: string;
};

type CheckpointSliderControlProps = {
  id: string;
  label: string;
  options: readonly CheckpointOption[];
  value: string;
  onChange: (value: string) => void;
};

export function CheckpointSliderControl({
  id,
  label,
  options,
  value,
  onChange,
}: CheckpointSliderControlProps) {
  const optionIndex = options.findIndex((option) => option.value === value);
  const selectedIndex = optionIndex >= 0 ? optionIndex : 0;
  const selectedOption = options[selectedIndex];
  const max = Math.max(0, options.length - 1);
  const progress = max === 0 ? 0 : selectedIndex / max;
  const sliderStyle = { "--slider-progress": progress } as CSSProperties;
  const setFromPointer = (clientX: number, element: HTMLDivElement) => {
    if (max === 0) return;
    const bounds = element.getBoundingClientRect();
    const trackWidth = Math.max(1, bounds.width - 12);
    const nextProgress = Math.min(1, Math.max(0, (clientX - bounds.left - 6) / trackWidth));
    const nextOption = options[Math.round(nextProgress * max)];
    if (nextOption && nextOption.value !== selectedOption?.value) onChange(nextOption.value);
  };

  return (
    <div
      className="control slider-control checkpoint-control inset-shadow"
      style={sliderStyle}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        setFromPointer(event.clientX, event.currentTarget);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          setFromPointer(event.clientX, event.currentTarget);
        }
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
    >
      <span className="slider-fill card" aria-hidden="true"><span className="slider-knob" /></span>
      <label htmlFor={id}>{label}</label>
      <output className="slider-value" htmlFor={id} aria-live="polite">{selectedOption?.label ?? ""}</output>
      <input
        id={id}
        type="range"
        min={0}
        max={max}
        step={1}
        value={selectedIndex}
        aria-valuetext={selectedOption?.label ?? ""}
        onKeyDown={(event) => {
          const direction = event.key === "ArrowRight" || event.key === "ArrowUp"
            ? 1
            : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0;
          const nextIndex = event.key === "Home"
            ? 0
            : event.key === "End" ? max : Math.min(max, Math.max(0, selectedIndex + direction));
          if (direction !== 0 || event.key === "Home" || event.key === "End") {
            event.preventDefault();
            const nextOption = options[nextIndex];
            if (nextOption) onChange(nextOption.value);
          }
        }}
        onChange={(event) => {
          const nextOption = options[Number(event.currentTarget.value)];
          if (nextOption) onChange(nextOption.value);
        }}
      />
    </div>
  );
}
