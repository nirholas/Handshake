import { useState, type CSSProperties, type FormEvent, type ReactNode } from "react";

import "./section-elements.css";

const testimonialIllustration = new URL("./assets/testimonials-illustration.svg", import.meta.url).href;
const testimonialKeyboard = new URL("./assets/testimonials-keyboard.svg", import.meta.url).href;
const testimonialDots = new URL("./assets/testimonials-dots.svg", import.meta.url).href;

export type SectionCompositionProps = {
  className?: string;
  style?: CSSProperties;
};

function classNames(base: string, className?: string) {
  return className ? `${base} ${className}` : base;
}

function GlassPill({ children }: { children: ReactNode }) {
  return (
    <span className="section-label">
      <span className="section-label__title">{children}</span>
      <span className="section-label__circle" aria-hidden="true" />
    </span>
  );
}

function SectionButton({ children = "Sign up", className = "", type = "button" }: { children?: ReactNode; className?: string; type?: "button" | "submit" }) {
  return (
    <button className={`section-button ${className}`.trim()} type={type}>
      <span className="section-button__title">{children}</span>
      <span className="section-button__circle" aria-hidden="true" />
    </button>
  );
}

/* the only section composition offered on both grounds, so it is the only one
   that takes a mode; the rest stay on the dark ground they were authored for */
export function DarkGlassButton({ className, style, mode = "dark" }: SectionCompositionProps & { mode?: "light" | "dark" }) {
  return (
    <div className={classNames("section-element section-element--glass-button", className)} data-mode={mode} style={style}>
      <SectionButton />
    </div>
  );
}

export function EditorialIntroSection({ className, style }: SectionCompositionProps) {
  return (
    <section className={classNames("section-element section-element--testimonial-intro", className)} style={style} aria-labelledby="section-testimonial-title">
      <div className="editorial-intro__graphic" aria-hidden="true">
        <img className="editorial-intro__dots" src={testimonialDots} alt="" width="368" height="368" />
        <div className="editorial-intro__device">
          <img src={testimonialIllustration} alt="" width="368" height="368" />
          <img className="editorial-intro__keyboard" src={testimonialKeyboard} alt="" width="148" height="17" />
        </div>
      </div>
      <div className="editorial-intro__copy">
        <GlassPill>Made for momentum</GlassPill>
        <h2 id="section-testimonial-title">Ideas, in motion.</h2>
        <p>A focused interface keeps every action clear and every handoff moving.</p>
      </div>
    </section>
  );
}

function EnvelopeIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.5 9.55v4.9c0 1.56 0 2.34-.3 2.94a2.75 2.75 0 0 1-1.21 1.21c-.6.3-1.38.3-2.94.3h-8.1c-1.56 0-2.34 0-2.94-.3a2.75 2.75 0 0 1-1.21-1.21c-.3-.6-.3-1.38-.3-2.94v-4.9c0-1.56 0-2.34.3-2.94A2.75 2.75 0 0 1 5.01 5.4c.6-.3 1.38-.3 2.94-.3h8.1c1.56 0 2.34 0 2.94.3a2.75 2.75 0 0 1 1.21 1.21c.3.6.3 1.38.3 2.94Z" />
      <path d="m3.55 6 6.61 5.14a3 3 0 0 0 3.68 0L20.45 6" fill="none" />
    </svg>
  );
}

export function NewsletterFooterSection({ className, style }: SectionCompositionProps) {
  const [subscribed, setSubscribed] = useState(false);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubscribed(true);
  };

  return (
    <footer className={classNames("section-element section-element--newsletter-footer", className)} style={style}>
      <div className="newsletter-footer__row">
        <div className="newsletter-footer__brand">
          <span className="newsletter-footer__mark" aria-label="Section marker"><span>01</span></span>
          <p>A monthly edit of thoughtful interfaces,<br />practical patterns, and new experiments.</p>
        </div>
        <form className={`newsletter-footer__form${subscribed ? " is-success" : ""}`} aria-label="Join the monthly design notes" onSubmit={submit}>
          <EnvelopeIcon />
          <input aria-label="Email address" type="email" placeholder="Email for monthly notes" required />
          <SectionButton className="newsletter-footer__button" type="submit">{subscribed ? "You're subscribed" : "Join the list"}</SectionButton>
          <span className="newsletter-footer__ring" aria-hidden="true" />
        </form>
      </div>
      <div className="newsletter-footer__wordmark" aria-label="Stay curious">STAY CURIOUS</div>
      <div className="newsletter-footer__legal">
        <span>© 2026. Built for thoughtful work.</span>
        <a href="#privacy">Privacy</a>
        <a href="#terms">Terms</a>
        <a href="#contact">Contact</a>
      </div>
    </footer>
  );
}
