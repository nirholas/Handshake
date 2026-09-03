/**
 * The 2D house.
 *
 * Not a consolation prize. This is the accessibility path, the old-device path
 * and the "WebGL is blocked by policy" path, and it has to be able to do
 * everything the 3D scene can do: read the whole house and act on it. It reads
 * the SAME scene model, so a room that exists in one exists in the other and
 * the two cannot drift.
 *
 * It is also the automatic destination for a device that measurably cannot hold
 * a frame rate, which is why it is built to be genuinely good rather than
 * merely present.
 */

/** Domains a person can act on from here, and the two services each offers. */
const CONTROLS = {
	light: { on: ['light', 'turn_on', 'Turn on'], off: ['light', 'turn_off', 'Turn off'] },
	switch: { on: ['switch', 'turn_on', 'Turn on'], off: ['switch', 'turn_off', 'Turn off'] },
	fan: { on: ['fan', 'turn_on', 'Turn on'], off: ['fan', 'turn_off', 'Turn off'] },
	lock: { on: ['lock', 'unlock', 'Unlock'], off: ['lock', 'lock', 'Lock'] },
	cover: { on: ['cover', 'open_cover', 'Open'], off: ['cover', 'close_cover', 'Close'] },
	media_player: { on: ['media_player', 'media_play', 'Play'], off: ['media_player', 'media_pause', 'Pause'] },
	vacuum: { on: ['vacuum', 'start', 'Start'], off: ['vacuum', 'return_to_base', 'Send home'] },
};

/**
 * @param {HTMLElement} container
 * @param {object} options
 * @param {(request: { entityId: string, domain: string, service: string, name: string, roomId: string }) => void} options.onAct
 * @param {(roomId: string) => void} [options.onFocusRoom]
 */
export function createHomeFallback(container, options = {}) {
	container.classList.add('hs-flat');
	container.innerHTML = '';
	const list = document.createElement('div');
	list.className = 'hs-flat-floors';
	container.appendChild(list);

	let model = null;
	let stale = false;
	let busy = new Set();

	function render() {
		if (!model) return;
		list.innerHTML = '';
		for (const floor of model.floors) {
			const section = document.createElement('section');
			section.className = 'hs-flat-floor';
			const heading = document.createElement('h2');
			heading.className = 'hs-flat-floor-name';
			heading.textContent = floor.name;
			section.appendChild(heading);

			const grid = document.createElement('div');
			grid.className = 'hs-flat-grid';
			for (const roomId of floor.roomIds) {
				const room = model.rooms.find((r) => r.id === roomId);
				if (room) grid.appendChild(roomCard(room));
			}
			section.appendChild(grid);
			list.appendChild(section);
		}
	}

	function roomCard(room) {
		const card = document.createElement('article');
		card.className = 'hs-card';
		card.dataset.roomId = room.id;
		if (stale) card.classList.add('is-stale');
		// The room's real light, as a real gradient: a dark room is dark here too.
		card.style.setProperty('--room-light', room.light.hex);
		card.style.setProperty('--room-glow', String(room.light.on ? Math.min(0.55, 0.12 + room.light.brightness * 0.4) : 0));

		const head = document.createElement('header');
		head.className = 'hs-card-head';
		const title = document.createElement('button');
		title.type = 'button';
		title.className = 'hs-card-title';
		title.textContent = room.name;
		title.addEventListener('click', () => options.onFocusRoom?.(room.id));
		head.appendChild(title);

		const meta = document.createElement('p');
		meta.className = 'hs-card-meta';
		const bits = [];
		bits.push(room.light.total ? `${room.light.count} of ${room.light.total} lights on` : 'no lights');
		if (room.climate) bits.push(`${room.climate.label} from ${room.climate.sources} ${room.climate.sources === 1 ? 'sensor' : 'sensors'}`);
		if (room.security) bits.push(room.security.secure ? 'secure' : `${room.security.unlocked.length + room.security.open.length} open`);
		meta.textContent = bits.join(' · ');
		head.appendChild(meta);
		card.appendChild(head);

		if (room.security && !room.security.secure) {
			const flag = document.createElement('p');
			flag.className = 'hs-card-flag';
			flag.textContent = describeOpen(room);
			card.appendChild(flag);
		}

		const items = document.createElement('ul');
		items.className = 'hs-card-items';
		for (const object of room.objects) items.appendChild(entityRow(object, room));
		card.appendChild(items);

		if (room.readouts.length) {
			const readouts = document.createElement('dl');
			readouts.className = 'hs-card-readouts';
			for (const readout of room.readouts) {
				const dt = document.createElement('dt');
				dt.textContent = readout.name;
				const dd = document.createElement('dd');
				dd.textContent = `${readout.value}${readout.unit ? ` ${readout.unit}` : ''}`;
				readouts.append(dt, dd);
			}
			card.appendChild(readouts);
		}

		if (room.hiddenCount) {
			const more = document.createElement('p');
			more.className = 'hs-card-more';
			more.textContent = `${room.hiddenCount} more ${room.hiddenCount === 1 ? 'device' : 'devices'} in this room`;
			card.appendChild(more);
		}
		return card;
	}

	function entityRow(object, room) {
		const row = document.createElement('li');
		row.className = 'hs-item';
		row.dataset.entityId = object.entityId;
		if (!object.available) row.classList.add('is-unavailable');

		const dot = document.createElement('span');
		dot.className = 'hs-item-dot';
		dot.dataset.kind = object.kind;
		dot.style.setProperty('--dot', dotColor(object, room));
		dot.setAttribute('aria-hidden', 'true');
		row.appendChild(dot);

		const name = document.createElement('span');
		name.className = 'hs-item-name';
		name.textContent = object.name;
		row.appendChild(name);

		const state = document.createElement('span');
		state.className = 'hs-item-state';
		state.textContent = object.available ? readableState(object) : 'unreachable';
		row.appendChild(state);

		const control = CONTROLS[object.domain];
		if (control && object.available) {
			const active = object.activity > 0.02;
			const [domain, service, label] = active ? control.off : control.on;
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'hs-item-act';
			button.textContent = busy.has(object.entityId) ? 'Working' : label;
			button.disabled = busy.has(object.entityId);
			button.setAttribute('aria-label', `${label} ${object.name} in ${room.name}`);
			button.addEventListener('click', () => {
				options.onAct?.({ entityId: object.entityId, domain, service, name: object.name, roomId: room.id });
			});
			row.appendChild(button);
		}
		return row;
	}

	function dotColor(object, room) {
		if (!object.available) return 'rgba(224, 90, 74, 0.55)';
		if (object.domain === 'light') return object.activity > 0 ? room.light.hex : 'rgba(255,255,255,0.16)';
		if (object.domain === 'lock') return object.activity > 0.5 ? '#e05a4a' : '#2fbf71';
		if (object.domain === 'cover' || object.domain === 'binary_sensor') return object.activity > 0.02 ? '#e0a33a' : 'rgba(255,255,255,0.16)';
		return object.activity > 0.4 ? '#8fa6ff' : 'rgba(255,255,255,0.16)';
	}

	function readableState(object) {
		if (object.domain === 'cover') {
			const position = Number(object.attributes?.current_position);
			if (Number.isFinite(position)) return position === 0 ? 'closed' : position === 100 ? 'open' : `${position}% open`;
		}
		if (object.domain === 'climate') {
			const current = Number(object.attributes?.current_temperature);
			if (Number.isFinite(current)) return `${object.state} · ${current}°`;
		}
		if (object.domain === 'light' && object.activity > 0) {
			const brightness = Number(object.attributes?.brightness);
			if (Number.isFinite(brightness)) return `on · ${Math.round((brightness / 255) * 100)}%`;
		}
		return String(object.state);
	}

	function describeOpen(room) {
		const names = [];
		for (const entityId of [...room.security.unlocked, ...room.security.open]) {
			const object = room.objects.find((o) => o.entityId === entityId);
			names.push(object ? object.name : entityId);
		}
		if (!names.length) return 'Something in this room is open.';
		const verb = room.security.unlocked.length ? 'unlocked' : 'open';
		return `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''} ${names.length === 1 ? 'is' : 'are'} ${verb}.`;
	}

	return {
		setModel(next) {
			model = next;
			render();
		},
		setStale(next) {
			stale = Boolean(next);
			container.classList.toggle('is-stale', stale);
			for (const card of list.querySelectorAll('.hs-card')) card.classList.toggle('is-stale', stale);
		},
		setBusy(entityIds) {
			busy = new Set(entityIds);
			render();
		},
		focusRoom(roomId) {
			const card = list.querySelector(`[data-room-id="${cssEscape(roomId)}"]`);
			card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
			card?.classList.add('is-focused');
			setTimeout(() => card?.classList.remove('is-focused'), 1800);
		},
		/** Same shape the WebGL scene exposes, so the page treats them alike. */
		setActing(next) {
			if (next?.roomId) this.focusRoom(next.roomId);
		},
		stats() {
			return { fps: 0, objects: model ? model.stats.drawn : 0, rooms: model ? model.rooms.length : 0, mode: '2d' };
		},
		dispose() {
			container.innerHTML = '';
			container.classList.remove('hs-flat');
		},
	};
}

function cssEscape(value) {
	return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
}

/**
 * Can this browser actually run the 3D scene? Asked once, answered honestly:
 * a context that fails to create, a software rasterizer, or a device the caller
 * already measured as too slow all route to the 2D house rather than to a black
 * canvas with a spinner over it.
 */
export function webglAvailable() {
	if (typeof document === 'undefined') return false;
	try {
		const canvas = document.createElement('canvas');
		const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
		if (!gl) return false;
		const lose = gl.getExtension('WEBGL_lose_context');
		lose?.loseContext();
		return true;
	} catch {
		return false;
	}
}
