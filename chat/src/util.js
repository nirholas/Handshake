/**
 * Reads an image file, resizes it if necessary, and returns it as a Data URL.
 *
 * @param {File} file - The image file to read and resize.
 * @returns {Promise<string>} - A promise that resolves to the Data URL of the (resized) image.
 */
export function readFileAsDataURL(file) {
	const MAX_DIMENSION = 1568; // Maximum allowed size for the longest edge

	return new Promise((resolve, reject) => {
		// Ensure the file is an image
		if (!file.type.startsWith('image/')) {
			reject(new Error('The provided file is not an image.'));
			return;
		}

		const reader = new FileReader();

		// Load the file as a Data URL
		reader.onload = () => {
			const img = new Image();

			img.onload = () => {
				let { width, height } = img;

				// Determine the scaling factor if resizing is needed
				const scalingFactor = calculateScalingFactor(width, height, MAX_DIMENSION);

				if (scalingFactor < 1) {
					width = Math.round(width * scalingFactor);
					height = Math.round(height * scalingFactor);
				}

				// Create a canvas to draw the (resized) image
				const canvas = document.createElement('canvas');
				canvas.width = width;
				canvas.height = height;

				const ctx = canvas.getContext('2d');

				// Draw the image onto the canvas with the new dimensions
				ctx.drawImage(img, 0, 0, width, height);

				// Convert the canvas to a Data URL (you can specify image format and quality if needed)
				canvas.toDataURL(file.type, 0.92); // 0.92 is the default quality for JPEG

				// Resolve the promise with the Data URL
				resolve(canvas.toDataURL(file.type));
			};

			img.onerror = () => {
				reject(new Error('Failed to load the image.'));
			};

			img.src = reader.result;
		};

		reader.onerror = () => {
			reject(new Error('Failed to read the file.'));
		};

		reader.readAsDataURL(file);
	});
}

/**
 * Calculates the scaling factor to resize the image so that its longest edge is within the max dimension.
 *
 * @param {number} width - The original width of the image.
 * @param {number} height - The original height of the image.
 * @param {number} maxDimension - The maximum allowed size for the longest edge.
 * @returns {number} - The scaling factor (<=1). Returns 1 if no resizing is needed.
 */
function calculateScalingFactor(width, height, maxDimension) {
	const longestEdge = Math.max(width, height);
	if (longestEdge <= maxDimension) {
		return 1; // No resizing needed
	}
	return maxDimension / longestEdge;
}

export function debounce(func, wait) {
	const timers = new Map();

	return function (...args) {
		const id = args[0].id; // Assuming the first argument has an `id` property

		if (timers.has(id)) {
			clearTimeout(timers.get(id));
		}

		const timer = setTimeout(() => {
			func.apply(this, args);
			timers.delete(id);
		}, wait);

		timers.set(id, timer);
	};
}

/**
 * Strip a Markdown code fence (```json … ``` or ``` … ```) that some models
 * wrap around tool-call arguments, returning the inner payload.
 *
 * @param {string} text
 * @returns {string}
 */
function stripCodeFence(text) {
	const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
	return fenced ? fenced[1] : text;
}

/**
 * Normalize a tool call's `arguments` into a plain object, tolerating the
 * range of shapes real model providers emit:
 *   - a JSON string (the OpenAI streaming default)
 *   - an already-parsed object (e.g. GPT OSS 120B sends the object in one chunk)
 *   - an empty / whitespace-only string (a tool that takes no arguments)
 *   - a JSON payload wrapped in a Markdown ```json code fence
 *
 * @param {unknown} raw
 * @returns {Record<string, any>} the parsed arguments object
 * @throws {Error} with a clean, user-readable message when the payload is
 *   genuinely unparseable. The raw payload is attached as `err.payload`.
 */
export function parseToolCallArguments(raw) {
	// Already an object (and not null): providers that hand back parsed args.
	if (raw !== null && typeof raw === 'object') {
		return raw;
	}

	if (typeof raw !== 'string') {
		// null / undefined / number: treat as "no arguments".
		return {};
	}

	const trimmed = stripCodeFence(raw.trim()).trim();
	if (trimmed === '') {
		return {};
	}

	try {
		const parsed = JSON.parse(trimmed);
		// A bare JSON scalar (e.g. `"foo"` or `5`) isn't a valid arguments object.
		if (parsed === null || typeof parsed !== 'object') {
			throw new Error('arguments did not decode to an object');
		}
		return parsed;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const wrapped = new Error(message);
		// @ts-ignore: attach the offending payload for diagnostics/UI.
		wrapped.payload = raw;
		throw wrapped;
	}
}

/**
 * Serialize a tool call's `arguments` back into the JSON string the OpenAI
 * Chat Completions API expects, without double-encoding a value that is
 * already a string (which can happen if a prior parse failed mid-turn).
 *
 * @param {unknown} args
 * @returns {string}
 */
export function serializeToolCallArguments(args) {
	if (typeof args === 'string') {
		return args;
	}
	return JSON.stringify(args ?? {});
}
