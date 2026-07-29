// Forge: "what we actually asked the model".
//
// Text→3D on the reference-image lanes does not send the user's words to the
// painter. api/forge.js runs a Granite art-director pass first (subject-classed
// briefing, per-part PBR materials, composition constraints) and the REWRITE is
// what conditions the reference view the mesh is reconstructed from. That step
// used to be invisible: two very different results from "a red fox" and "a
// low-poly red fox" had no visible cause.
//
// This module reveals the real rewrite after a generation, straight from the
// `directed_prompt` field on the /api/forge response. It is never reconstructed
// client-side and never approximated: no field, no panel. Copy takes it to the
// clipboard; "Use as my prompt" drops it into the composer so the next run can
// build on it (the user still presses Generate).
//
// Decoupled like the other result-panel modules: src/forge.js dispatches
// `forge:directed-prompt` with { prompt, directedPrompt, model } (or a null
// directedPrompt to hide the panel), and this owns everything below that.

const panel = document.getElementById('forge-directed');
const rawEl = document.getElementById('forge-directed-raw');
const textEl = document.getElementById('forge-directed-text');
const modelEl = document.getElementById('forge-directed-model');
const copyBtn = document.getElementById('forge-directed-copy');
const useBtn = document.getElementById('forge-directed-use');
const statusEl = document.getElementById('forge-directed-status');

if (panel && rawEl && textEl && copyBtn && useBtn) {
	let current = '';
	let statusTimer = null;

	function say(message) {
		if (!statusEl) return;
		statusEl.textContent = message;
		if (statusTimer) clearTimeout(statusTimer);
		statusTimer = setTimeout(() => {
			statusEl.textContent = '';
		}, 2600);
	}

	function hide() {
		current = '';
		panel.hidden = true;
		panel.open = false;
		if (statusEl) statusEl.textContent = '';
	}

	document.addEventListener('forge:directed-prompt', (event) => {
		const detail = event.detail || {};
		const directed = typeof detail.directedPrompt === 'string' ? detail.directedPrompt.trim() : '';
		const raw = typeof detail.prompt === 'string' ? detail.prompt.trim() : '';
		if (!directed || directed === raw) {
			hide();
			return;
		}
		current = directed;
		rawEl.textContent = raw || '(no prompt: this run started from an image)';
		textEl.textContent = directed;
		if (modelEl) {
			const model = typeof detail.model === 'string' ? detail.model.trim() : '';
			modelEl.textContent = model ? `via ${model}` : '';
			modelEl.hidden = !model;
		}
		panel.hidden = false;
		// Collapsed by default: it is context, not the headline. The user opens it.
		panel.open = false;
		if (statusEl) statusEl.textContent = '';
	});

	copyBtn.addEventListener('click', async () => {
		if (!current) return;
		try {
			await navigator.clipboard.writeText(current);
			say('Copied to your clipboard');
		} catch {
			// Clipboard permission denied or an insecure context: select the text so
			// the user can copy it by hand instead of hitting a dead button.
			const range = document.createRange();
			range.selectNodeContents(textEl);
			const sel = window.getSelection();
			sel?.removeAllRanges();
			sel?.addRange(range);
			say('Selected the prompt: press Ctrl/Cmd+C to copy');
		}
	});

	useBtn.addEventListener('click', () => {
		if (!current) return;
		const box = document.getElementById('prompt');
		if (!box) return;
		// Go through the real text tab so the composer ends up in the state the
		// user would have reached by clicking it themselves.
		document.querySelector('#mode-switch button[data-mode="text"]')?.click();
		// The composer caps prompts at its own maxlength; respect it rather than
		// silently handing over a value the field would truncate on submit.
		const max = Number(box.getAttribute('maxlength')) || 1000;
		box.value = current.slice(0, max);
		box.dispatchEvent(new Event('input', { bubbles: true }));
		box.focus();
		box.setSelectionRange(box.value.length, box.value.length);
		box.scrollIntoView({ behavior: 'smooth', block: 'center' });
		say('Loaded into the composer. Edit it, then Generate.');
	});
}
