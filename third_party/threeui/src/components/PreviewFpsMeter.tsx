import { useEffect, useRef } from "react";

type PreviewFpsMeterProps = {
  sampleKey: string;
};

export function PreviewFpsMeter({ sampleKey }: PreviewFpsMeterProps) {
  const meterRef = useRef<HTMLOutputElement>(null);

  useEffect(() => {
    const meter = meterRef.current;
    if (!meter) return undefined;

    let animationFrame = 0;
    let visible = true;
    let sampleStartedAt = 0;
    let previousFrameAt = 0;
    let sampledFrames = 0;
    let slowFrames = 0;

    const resetSample = () => {
      sampleStartedAt = 0;
      previousFrameAt = 0;
      sampledFrames = 0;
      slowFrames = 0;
    };

    const update = (now: number) => {
      if (!sampleStartedAt) {
        sampleStartedAt = now;
        previousFrameAt = now;
      } else {
        const frameDuration = now - previousFrameAt;
        previousFrameAt = now;
        sampledFrames += 1;
        if (frameDuration > 25) slowFrames += 1;

        const elapsed = now - sampleStartedAt;
        if (elapsed >= 1000) {
          const fps = sampledFrames * 1000 / elapsed;
          const roundedFps = Math.round(fps);
          const rating = fps >= 55 ? "good" : fps >= 45 ? "watch" : "slow";
          meter.value = String(roundedFps);
          meter.textContent = `${roundedFps} FPS`;
          meter.dataset.rating = rating;
          meter.title = `Live preview frame rate: ${roundedFps} FPS; ${slowFrames} frames over 25 ms in the last sample.`;
          resetSample();
        }
      }

      animationFrame = visible && !document.hidden ? window.requestAnimationFrame(update) : 0;
    };

    const start = () => {
      if (visible && !document.hidden && !animationFrame) {
        resetSample();
        animationFrame = window.requestAnimationFrame(update);
      }
    };
    const stop = () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      resetSample();
    };
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      if (visible) start();
      else stop();
    });
    const handleVisibilityChange = () => {
      if (document.hidden) stop();
      else start();
    };

    meter.textContent = "-- FPS";
    meter.dataset.rating = "pending";
    intersectionObserver.observe(meter);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    start();

    return () => {
      stop();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [sampleKey]);

  return <output className="preview-fps-meter" ref={meterRef} aria-label="Live preview frame rate">-- FPS</output>;
}
