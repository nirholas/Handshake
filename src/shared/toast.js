// Shared toast notifications. One aria-live region, a real queue (a second
// toast stacks instead of clobbering the first), variants, and a dismiss
// action. Replaces the ~28-line singleton-div toast() that was copy-pasted
// into 40+ pages; import this instead of redefining it.

let region = null;
const MAX_VISIBLE = 3;

function ensureRegion() {
	if (region && document.body.contains(region)) return region;
	region = document.createElement('div');
	region.id = 'tw-toast-region';
	region.setAttribute('role', 'status');
	region.setAttribute('aria-live', 'polite');
	region.style.cssText = [
		'position:fixed', 'left:50%', 'bottom:32px', 'transform:translateX(-50%)',
		'display:flex', 'flex-direction:column-reverse', 'align-items:center', 'gap:8px',
		'z-index:9999', 'pointer-events:none', 'max-width:min(92vw,480px)',
	].join(';');
	document.body.appendChild(region);
	return region;
}

const VARIANT_BORDER = {
	info: 'var(--nxt-stroke-strong, rgba(255,255,255,0.18))',
	success: 'rgba(67,214,160,0.55)',
	error: 'rgba(255,122,138,0.6)',
};

/**
 * Show a toast.
 * @param {string} msg Plain text (assigned via textContent, never innerHTML).
 * @param {object} [opts]
 * @param {'info'|'success'|'error'} [opts.variant]
 * @param {number} [opts.duration] ms before auto-hide (errors default longer).
 * @returns {() => void} dismiss function.
 */
export function toast(msg, { variant = 'info', duration } = {}) {
	const host = ensureRegion();
	const ms = duration ?? (variant === 'error' ? 4200 : 1800);

	const el = document.createElement('div');
	el.textContent = String(msg ?? '');
	el.style.cssText = [
		'background:rgba(20,21,28,0.95)',
		`border:1px solid ${VARIANT_BORDER[variant] || VARIANT_BORDER.info}`,
		'color:var(--nxt-ink, #f2f3f7)', 'padding:9px 16px', 'border-radius:999px',
		'font-size:13px', 'line-height:1.4', 'opacity:0', 'transform:translateY(20px)',
		'transition:opacity .18s,transform .18s', 'backdrop-filter:blur(20px)',
		'-webkit-backdrop-filter:blur(20px)', 'box-shadow:0 8px 24px rgba(0,0,0,0.4)',
		'pointer-events:auto', 'cursor:pointer', 'overflow-wrap:anywhere',
	].join(';');
	el.title = 'Dismiss';

	// Cap the stack: retire the oldest visible toast to make room.
	while (host.children.length >= MAX_VISIBLE) host.firstChild.remove();
	host.appendChild(el);
	requestAnimationFrame(() => {
		el.style.opacity = '1';
		el.style.transform = 'translateY(0)';
	});

	let gone = false;
	const dismiss = () => {
		if (gone) return;
		gone = true;
		clearTimeout(timer);
		el.style.opacity = '0';
		el.style.transform = 'translateY(20px)';
		setTimeout(() => el.remove(), 200);
	};
	const timer = setTimeout(dismiss, ms);
	el.addEventListener('click', dismiss);
	return dismiss;
}

export const toastSuccess = (msg, opts) => toast(msg, { ...opts, variant: 'success' });
export const toastError = (msg, opts) => toast(msg, { ...opts, variant: 'error' });
