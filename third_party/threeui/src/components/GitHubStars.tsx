import { useEffect, useState } from "react";
import { GitHubIcon } from "./icons";

const GITHUB_REPOSITORY = "MengTo/threeui";
const GITHUB_REPOSITORY_URL = `https://github.com/${GITHUB_REPOSITORY}`;
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPOSITORY}`;

function formatStars(stars: number) {
  return new Intl.NumberFormat("en", {
    notation: stars >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(stars);
}

export function GitHubStars() {
  const [stars, setStars] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    fetch(GITHUB_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() as Promise<{ stargazers_count?: number }> : undefined))
      .then((repository) => {
        if (typeof repository?.stargazers_count === "number") {
          setStars(repository.stargazers_count);
        }
      })
      .catch(() => undefined);

    return () => controller.abort();
  }, []);

  return (
    <a
      className="github-stars inset-shadow"
      href={GITHUB_REPOSITORY_URL}
      target="_blank"
      rel="noreferrer"
      aria-label={`View ThreeUI on GitHub, ${stars} stars`}
    >
      <GitHubIcon />
      <span>{formatStars(stars)}</span>
    </a>
  );
}
