document.addEventListener('DOMContentLoaded', () => {
	const navContainer = document.getElementById('nav-container');
	if (!navContainer) return;
	if (!document.querySelector('link[href="/nav.css"]')) {
		const link = document.createElement('link');
		link.rel = 'stylesheet';
		link.href = '/nav.css';
		document.head.appendChild(link);
	}
	fetch('/nav.html')
		.then(response => response.text())
		.then(data => {
			navContainer.innerHTML = data;
			initNav(navContainer);
		});
});

function initNav(root) {
	initDropdowns(root);
	initBurger(root);
	initAuthHint(root);
}

function initDropdowns(root) {
	const triggers = root.querySelectorAll('.home-nav .nav-trigger');
	if (!triggers.length) return;

	function closeAll(except) {
		triggers.forEach((t) => {
			if (t !== except) t.setAttribute('aria-expanded', 'false');
		});
	}

	triggers.forEach((trigger) => {
		trigger.addEventListener('click', (e) => {
			e.stopPropagation();
			const open = trigger.getAttribute('aria-expanded') === 'true';
			closeAll(open ? null : trigger);
			trigger.setAttribute('aria-expanded', open ? 'false' : 'true');
			if (!open) {
				const first = trigger.nextElementSibling?.querySelector('a');
				first?.focus({ preventScroll: true });
			}
		});

		const menu = trigger.nextElementSibling;
		if (!menu) return;
		menu.addEventListener('keydown', (e) => {
			const items = Array.from(menu.querySelectorAll('a'));
			const idx = items.indexOf(document.activeElement);
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				items[(idx + 1) % items.length]?.focus({ preventScroll: true });
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				items[(idx - 1 + items.length) % items.length]?.focus({ preventScroll: true });
			} else if (e.key === 'Escape') {
				trigger.setAttribute('aria-expanded', 'false');
				trigger.focus({ preventScroll: true });
			}
		});
	});

	document.addEventListener('click', (e) => {
		if (!e.target.closest('.home-nav')) closeAll(null);
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') closeAll(null);
	});
}

function initBurger(root) {
	const burger = root.querySelector('#home-nav-burger');
	const navRoot = root.querySelector('#home-nav-root');
	if (!burger || !navRoot) return;

	const backdrop = document.createElement('div');
	backdrop.className = 'nav-backdrop';
	document.body.appendChild(backdrop);

	function close() {
		burger.setAttribute('aria-expanded', 'false');
		navRoot.classList.remove('is-open');
		backdrop.classList.remove('is-active');
		document.body.classList.remove('nav-open');
	}

	burger.addEventListener('click', (e) => {
		e.stopPropagation();
		const open = burger.getAttribute('aria-expanded') === 'true';
		burger.setAttribute('aria-expanded', open ? 'false' : 'true');
		navRoot.classList.toggle('is-open', !open);
		backdrop.classList.toggle('is-active', !open);
		document.body.classList.toggle('nav-open', !open);
	});

	backdrop.addEventListener('click', close);
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') close();
	});
}

function initAuthHint(root) {
	try {
		const raw = localStorage.getItem('3dagent:auth-hint');
		if (!raw) return;
		const { authed, name } = JSON.parse(raw);
		if (!authed) return;
		const cta = root.querySelector('#home-nav-cta');
		if (cta) { cta.textContent = 'Dashboard'; cta.href = '/dashboard'; }
		const myAgentsLi = root.querySelector('#home-nav-my-agents-li');
		if (myAgentsLi) myAgentsLi.hidden = false;
		const userLi = root.querySelector('#home-nav-user-li');
		const userEl = root.querySelector('#home-nav-user');
		if (userEl && userLi && name) { userEl.textContent = name; userLi.hidden = false; }
	} catch (_) {}
}
