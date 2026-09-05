import type { MouseEvent, ReactNode } from "react";
import { browseCategoryRoutePath, STATIC_ROUTE_PATHS } from "../routes.js";

type MainContentFooterProps = {
  onNavigate: (path: string) => void;
};

type FooterLinkProps = {
  children: ReactNode;
  href: string;
  onNavigate: (path: string) => void;
};

const PRODUCT_LINKS = [
  { href: STATIC_ROUTE_PATHS.browse, label: "Browse" },
  { href: STATIC_ROUTE_PATHS.installation, label: "Installation" },
  { href: STATIC_ROUTE_PATHS.mcp, label: "MCP" },
] as const;

const EXPLORE_LINKS = [
  { href: browseCategoryRoutePath("Three.js"), label: "Three.js Components" },
  { href: browseCategoryRoutePath("Landing Pages"), label: "Landing Page Templates" },
  { href: browseCategoryRoutePath("Hero"), label: "Hero Sections" },
  { href: browseCategoryRoutePath("Backgrounds"), label: "WebGL Backgrounds" },
] as const;

function FooterLink({ children, href, onNavigate }: FooterLinkProps) {
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(href);
  };

  return <a href={href} onClick={follow}>{children}</a>;
}

export function MainContentFooter({ onNavigate }: MainContentFooterProps) {
  return (
    <footer className="main-content-footer" data-main-content-footer aria-label="ThreeUI footer">
      <div className="main-content-footer__grid">
        <div className="main-content-footer__identity">
          <FooterLink href={STATIC_ROUTE_PATHS.browse} onNavigate={onNavigate}>
            <span className="main-content-footer__brand" aria-label="ThreeUI">
              <svg viewBox="0 0 32 32" aria-hidden="true">
                <circle cx="16" cy="16" r="14" />
                <path d="M5 12.2c4.3 4.2 8.2 4.8 12.4.9 4.1-3.7 7.7-4.5 9.6-2.9" />
                <path d="M5 19.7c4.3 4.2 8.2 4.8 12.4.9 4.1-3.7 7.7-4.5 9.6-2.9" />
              </svg>
              <strong>threeui</strong>
            </span>
          </FooterLink>
          <p>Procedural Three.js components, templates, and shaders for interactive websites.</p>
        </div>

        <nav className="main-content-footer__nav" aria-label="Product">
          <h2>Product</h2>
          {PRODUCT_LINKS.map((link) => (
            <FooterLink href={link.href} onNavigate={onNavigate} key={link.href}>{link.label}</FooterLink>
          ))}
          <a href="https://threeui.com/pricing">Pricing</a>
        </nav>

        <nav className="main-content-footer__nav" aria-label="Explore">
          <h2>Explore</h2>
          {EXPLORE_LINKS.map((link) => (
            <FooterLink href={link.href} onNavigate={onNavigate} key={link.href}>{link.label}</FooterLink>
          ))}
        </nav>

        <nav className="main-content-footer__nav" aria-label="Company and legal">
          <h2>More</h2>
          <a href="https://github.com/MengTo/threeui" target="_blank" rel="noreferrer">GitHub</a>
          <a href="https://threeui.com/affiliates">Affiliates</a>
          <a href="https://threeui.com/privacy">Privacy</a>
          <a href="https://threeui.com/terms">Terms</a>
        </nav>
      </div>

      <div className="main-content-footer__meta">
        <span>© {new Date().getFullYear()} ThreeUI</span>
        <span>Three.js · WebGL · GLSL</span>
      </div>
    </footer>
  );
}
