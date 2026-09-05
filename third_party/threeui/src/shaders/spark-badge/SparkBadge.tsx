import { useEffect, useRef, useState } from "react";
export type SparkBadgeVariant = "badge";
export type SparkBadgeProps = { className?: string; sourceUrl?: string; variant?: SparkBadgeVariant };
export function SparkBadge({ className = "", sourceUrl = "/spark-badge.html" }: SparkBadgeProps) {
  const hostRef = useRef<HTMLDivElement>(null); const intersectsRef = useRef(true); const [mounted, setMounted] = useState(true); const [ready, setReady] = useState(false);
  useEffect(() => { const host = hostRef.current; if (!host) return; const sync = () => setMounted(intersectsRef.current && document.visibilityState !== "hidden"); const observer = new IntersectionObserver(([entry]) => { intersectsRef.current = entry.isIntersecting; sync(); }, { rootMargin: "80px" }); observer.observe(host); document.addEventListener("visibilitychange", sync); return () => { observer.disconnect(); document.removeEventListener("visibilitychange", sync); }; }, []);
  useEffect(() => { if (!mounted) setReady(false); }, [mounted]);
  return <div ref={hostRef} className={`spark-badge${className ? ` ${className}` : ""}`} data-state={!mounted ? "paused" : ready ? "ready" : "loading"} data-variant="badge">{mounted ? <iframe className={`spark-badge__frame${ready ? " is-ready" : ""}`} title="Animated credential badge in rain" src={sourceUrl} sandbox="allow-scripts" loading="eager" onLoad={() => setReady(true)} /> : null}</div>;
}
