export const ARTICLE_HEADING_DECODE_POOL = "#%&@$/\\<>*+=~ABCDEFGHKMNPRSTUVWXYZ0123456789";

export type ArticleHeadingDecodeOptions = {
  duration: number;
  stagger: number;
  scrambleLength: number;
  preserveChance: number;
  tailChance: number;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const easeOut = (value: number) => 1 - Math.pow(1 - value, 2);

export function startArticleHeadingDecode(
  root: HTMLElement,
  options: ArticleHeadingDecodeOptions,
) {
  const frames = new Set<number>();
  const originals = new Map<Text, string>();
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const decodeElement = (element: HTMLElement, delay: number) => {
    if (reduced) return;

    const nodes: Array<{ node: Text; original: string }> = [];
    const walk = (node: Node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
          const text = child as Text;
          const original = text.textContent ?? "";
          originals.set(text, original);
          nodes.push({ node: text, original });
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          walk(child);
        }
      }
    };
    walk(element);

    const total = nodes.reduce((sum, node) => sum + node.original.length, 0);
    const start = performance.now() + delay;
    const frame = (now: number) => {
      const progress = clamp((now - start) / Math.max(1, options.duration), 0, 1);
      if (now < start) {
        const id = requestAnimationFrame(frame);
        frames.add(id);
        return;
      }

      let budget = Math.floor(easeOut(progress) * total);
      for (const textNode of nodes) {
        const length = textNode.original.length;
        const revealed = clamp(budget, 0, length);
        budget -= revealed;
        if (revealed >= length) {
          textNode.node.textContent = textNode.original;
          continue;
        }

        let output = textNode.original.slice(0, revealed);
        const scrambleLength = Math.min(length - revealed, Math.round(options.scrambleLength));
        for (let index = 0; index < scrambleLength; index += 1) {
          const original = textNode.original[revealed + index];
          output += original === " " || Math.random() < options.preserveChance
            ? original
            : ARTICLE_HEADING_DECODE_POOL[(Math.random() * ARTICLE_HEADING_DECODE_POOL.length) | 0];
        }
        output += textNode.original
          .slice(revealed + scrambleLength)
          .replace(/\S/g, (character) => Math.random() < options.tailChance
            ? ARTICLE_HEADING_DECODE_POOL[(Math.random() * ARTICLE_HEADING_DECODE_POOL.length) | 0]
            : character);
        textNode.node.textContent = output;
      }

      if (progress < 1) {
        const id = requestAnimationFrame(frame);
        frames.add(id);
      }
    };
    const id = requestAnimationFrame(frame);
    frames.add(id);
  };

  root.querySelectorAll<HTMLElement>("[data-article-heading]").forEach((element, index) => {
    decodeElement(element, index * options.stagger);
  });

  return () => {
    frames.forEach(cancelAnimationFrame);
    originals.forEach((original, node) => {
      node.textContent = original;
    });
  };
}
