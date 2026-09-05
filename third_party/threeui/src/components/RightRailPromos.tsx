import { FULL_THREEUI_COLLECTION_COUNT } from "../data/mainCatalogSummary";

type RightRailPromosProps = {
  onPricing: () => void;
};

export function RightRailPromos({ onPricing }: RightRailPromosProps) {
  return (
    <div className="rail-promos">
      <button className="pro-promo card" onClick={onPricing}>
        <span className="rail-section-label">GET PRO</span>
        <strong>Premium landing pages + shaders.</strong>
        <span className="pro-promo-link">
          <span className="pro-promo-divider" aria-hidden="true">|</span>
          Full {FULL_THREEUI_COLLECTION_COUNT} collection
        </span>
      </button>

      <section className="sponsor-block" aria-labelledby="sponsors-title">
        <h2 className="rail-section-label" id="sponsors-title">Sponsors</h2>
        <a
          className="sponsor-slot inset-shadow"
          href="mailto:support@designcode.io?subject=ThreeUI%20sponsorship"
          aria-label="Ask about the open ThreeUI sponsor slot"
        >
          <span>Open sponsor slot</span>
        </a>
        <a
          className="become-sponsor"
          href="mailto:support@designcode.io?subject=ThreeUI%20sponsorship"
        >
          Become a sponsor <span aria-hidden="true">→</span>
        </a>
      </section>
    </div>
  );
}
