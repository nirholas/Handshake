<script>
  import { websiteCategory, composerFill } from '../../stores.js';
  import Icon from '../../Icon.svelte';
  import {
    feLayout,
    fePieChart,
    feImage,
    feHome,
    feCloud,
    feLink,
    feArrowUpLeft,
  } from '../../feather.js';

  const categories = [
    { id: 'landing',   label: 'Landing Page', icon: feLayout },
    { id: 'dashboard', label: 'Dashboard',    icon: fePieChart },
    { id: 'portfolio', label: 'Portfolio',    icon: feImage },
    { id: 'corporate', label: 'Corporate',    icon: feHome },
    { id: 'saas',      label: 'SaaS',         icon: feCloud },
    { id: 'linkbio',   label: 'Link in bio',  icon: feLink },
  ];

  const ideasByCategory = {
    landing:   ['Product launch landing page', 'SaaS marketing landing page', 'Event signup landing page'],
    dashboard: ['Analytics dashboard', 'Sales tracking dashboard', 'HR dashboard'],
    portfolio: ['Build full-stack developer portfolio', 'Product designer portfolio website', 'Photographer showcase portfolio page'],
    corporate: ['Law firm corporate site', 'Consulting agency website', 'Real estate corporate site'],
    saas:      ['SaaS product home page', 'Pricing page for B2B SaaS', 'Feature comparison page'],
    linkbio:   ['Creator link-in-bio page', 'Musician fan hub', 'Restaurant menu link page'],
  };

  const starterByCategory = {
    landing:   'Build a landing page for ',
    dashboard: 'Build a dashboard for ',
    portfolio: 'Build a portfolio website for ',
    corporate: 'Build a corporate website for ',
    saas:      'Build a SaaS marketing site for ',
    linkbio:   'Create a link-in-bio page for ',
  };

  let referenceOpen = false;
  let referenceUrl = '';

  /** Append a site the model should take its cues from to whatever is composed. */
  function addReference() {
    const url = referenceUrl.trim();
    if (!url) return;
    composerFill.set({
      text: `Use ${url} as the visual reference. `,
      submit: false,
      ifEmpty: false,
      append: true,
    });
    referenceUrl = '';
    referenceOpen = false;
  }

  function pick(id) {
    const isDeselecting = $websiteCategory === id;
    websiteCategory.set(isDeselecting ? null : id);
    if (!isDeselecting) {
      composerFill.set({ text: starterByCategory[id], submit: false, ifEmpty: true });
    }
  }

  function selectIdea(idea) {
    composerFill.set({ text: idea, submit: true, ifEmpty: false });
  }
</script>

<div class="mt-8 max-w-[760px] mx-auto px-1">
  <div class="flex items-center justify-between">
    <h3 class="text-sm font-semibold text-ink">What would you like to build?</h3>
    <button
      class="inline-flex items-center gap-1.5 text-sm text-ink hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ink rounded"
      aria-expanded={referenceOpen}
      on:click={() => (referenceOpen = !referenceOpen)}
    >
      <Icon icon={feLink} size={14} /> Add website reference
    </button>
  </div>

  {#if referenceOpen}
    <form class="mt-3 flex gap-2" on:submit|preventDefault={addReference}>
      <input
        type="url"
        bind:value={referenceUrl}
        placeholder="https://a-site-you-like.com"
        aria-label="Website to use as a visual reference"
        class="h-9 flex-1 rounded-full border border-rule bg-white px-4 text-sm text-ink placeholder-ink-faint focus:border-ink focus:outline-none"
      />
      <button
        type="submit"
        disabled={!referenceUrl.trim()}
        class="h-9 shrink-0 rounded-full bg-black px-4 text-sm font-medium text-white transition-colors hover:bg-[#333] disabled:cursor-not-allowed disabled:opacity-40"
      >
        Add
      </button>
    </form>
  {/if}

  <div class="mt-4 flex gap-2 overflow-x-auto scrollbar-none">
    {#each categories as c}
      <button
        class="three-ui-chip whitespace-nowrap {$websiteCategory === c.id ? 'three-ui-chip-selected' : ''}"
        on:click={() => pick(c.id)}
      >
        <Icon icon={c.icon} size={16} />
        {c.label}
      </button>
    {/each}
  </div>

  {#if $websiteCategory && ideasByCategory[$websiteCategory]}
    <div class="mt-6">
      <h3 class="text-sm font-semibold mb-3">Explore ideas</h3>
      <div class="flex flex-wrap gap-2">
        {#each ideasByCategory[$websiteCategory] as idea}
          <button class="three-ui-chip" on:click={() => selectIdea(idea)}>
            <span>{idea}</span>
            <Icon icon={feArrowUpLeft} size={14} class="text-ink-faint" />
          </button>
        {/each}
      </div>
    </div>
  {/if}
</div>
