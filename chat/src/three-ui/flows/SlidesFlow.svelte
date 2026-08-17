<script>
  import { composerFill } from '../../stores.js';
  import Icon from '../../Icon.svelte';
  import { feArrowUpLeft, feLayout, feChevronDown } from '../../feather.js';

  const samplePrompts = [
    'Automate weekly team status reporting',
    'Build quarterly sales performance dashboard',
    'Create strategic business review presentation',
    'Design investor pitch deck with projections',
  ];

  // Each template is a real prompt preset: picking one writes its outline into
  // the composer and sends it, exactly like picking a sample prompt does.
  const templates = [
    { name: 'Pitch deck',      outline: 'problem, solution, market size, product demo, traction, business model, team, and the ask' },
    { name: 'Product launch',  outline: 'what shipped, who it is for, the before/after, a live demo, pricing, and rollout dates' },
    { name: 'Quarterly review',outline: 'goals set, results against them, wins, misses with root causes, and next quarter priorities' },
    { name: 'Sales narrative',  outline: 'the customer pain, the cost of the status quo, our approach, proof, and next steps' },
    { name: 'Technical design', outline: 'context, constraints, the proposed architecture, alternatives considered, risks, and rollout' },
    { name: 'Team onboarding',  outline: 'how the team works, the systems we run, who owns what, and the first-week checklist' },
    { name: 'Research readout', outline: 'the question, the method, what we found, what surprised us, and what we recommend' },
    { name: 'Board update',     outline: 'headline metrics, progress against plan, the top three risks, and decisions needed' },
  ];

  const slideCountOptions = ['4 - 8', '8 - 12', '12 - 16', '16 - 20'];
  let selectedSlideCount = '8 - 12';
  let slideCountOpen = false;

  /** The chosen length is part of every request, so the control actually steers output. */
  function withSlideCount(text) {
    return `${text}. Make it ${selectedSlideCount} slides.`;
  }

  function selectPrompt(prompt) {
    composerFill.set({ text: withSlideCount(prompt), submit: true, ifEmpty: false });
  }

  function selectTemplate(template) {
    composerFill.set({
      text: withSlideCount(`Build a ${template.name.toLowerCase()} covering ${template.outline}`),
      submit: true,
      ifEmpty: false,
    });
  }
</script>

<div class="w-full max-w-[760px] mx-auto">
  <h2 class="text-sm font-semibold text-ink mb-3 mt-10">Sample prompts</h2>
  <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
    {#each samplePrompts as prompt}
      <button
        class="bg-white border border-rule rounded-xl p-4 text-left h-[112px] flex flex-col justify-between hover:bg-paper transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ink"
        on:click={() => selectPrompt(prompt)}
      >
        <span class="text-sm text-ink line-clamp-2">{prompt}</span>
        <Icon icon={feArrowUpLeft} class="w-[14px] h-[14px] text-ink-faint self-end shrink-0" />
      </button>
    {/each}
  </div>

  <div class="flex items-center justify-between mb-3 mt-10">
    <h2 class="text-sm font-semibold text-ink">Choose a template</h2>
    <div class="relative">
      <button
        class="bg-white border border-rule rounded-full h-9 px-3 text-sm flex items-center gap-2 hover:bg-paper transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ink"
        aria-expanded={slideCountOpen}
        aria-label="Slide count: {selectedSlideCount}"
        on:click={() => (slideCountOpen = !slideCountOpen)}
      >
        <Icon icon={feLayout} class="w-4 h-4 text-ink-soft" />
        {selectedSlideCount}
        <Icon icon={feChevronDown} class="w-3 h-3 text-ink-soft" />
      </button>
      {#if slideCountOpen}
        <div class="absolute right-0 top-full mt-1 bg-white border border-rule rounded-xl shadow-pop z-10 min-w-[120px]">
          {#each slideCountOptions as option}
            <button
              class="block w-full px-4 py-2 text-sm text-left text-ink hover:bg-paper first:rounded-t-xl last:rounded-b-xl"
              aria-current={option === selectedSlideCount ? 'true' : undefined}
              on:click={() => { selectedSlideCount = option; slideCountOpen = false; }}
            >
              {option}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <div class="grid grid-cols-2 gap-4 pb-8 md:grid-cols-4">
    {#each templates as template}
      <button
        class="aspect-[4/3] bg-paper-deep rounded-xl flex flex-col items-center justify-center gap-1.5 px-2 text-center hover:bg-white hover:border hover:border-rule transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ink"
        on:click={() => selectTemplate(template)}
      >
        <span class="text-sm text-ink font-serif">{template.name}</span>
        <Icon icon={feArrowUpLeft} class="w-[14px] h-[14px] text-ink-faint" />
      </button>
    {/each}
  </div>
</div>
