/**
 * The glance card as an Adaptive Card.
 *
 * The Windows 11 widgets board renders Adaptive Cards, not HTML: the PWA
 * manifest points at a template (`ms_ac_template`) and the service worker
 * feeds it data, and the host does the binding. Other hosts would rather be
 * handed a card that is already bound.
 *
 * Both come from ONE layout function so the template and the bound card can
 * never drift: `field()` either emits a binding expression or the real value.
 */

const FALLBACK_IMAGE = 'https://three.ws/pwa-192x192.png';

export const ADAPTIVE_VERSION = '1.6';

function layout(field) {
	return {
		type: 'AdaptiveCard',
		$schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
		version: ADAPTIVE_VERSION,
		body: [
			{
				type: 'ColumnSet',
				columns: [
					{
						type: 'Column',
						width: 'auto',
						items: [
							{
								type: 'Image',
								url: field('image', FALLBACK_IMAGE),
								size: 'Small',
								style: 'RoundedCorners',
								altText: field('name'),
							},
						],
					},
					{
						type: 'Column',
						width: 'stretch',
						items: [
							{ type: 'TextBlock', text: field('name'), weight: 'Bolder', size: 'Medium', wrap: false },
							{
								type: 'TextBlock',
								text: field('headline'),
								isSubtle: true,
								size: 'Small',
								wrap: true,
								maxLines: 2,
								spacing: 'None',
							},
						],
					},
				],
			},
			{
				type: 'ColumnSet',
				spacing: 'Medium',
				columns: [
					{
						type: 'Column',
						width: 'auto',
						items: [
							{
								type: 'TextBlock',
								text: field('metric.value'),
								size: 'ExtraLarge',
								weight: 'Bolder',
								spacing: 'None',
							},
						],
					},
					{
						type: 'Column',
						width: 'stretch',
						verticalContentAlignment: 'Bottom',
						items: [
							{
								type: 'TextBlock',
								text: field('metric.label'),
								isSubtle: true,
								size: 'Small',
								spacing: 'None',
							},
						],
					},
				],
			},
			{
				type: 'FactSet',
				spacing: 'Small',
				facts: [
					{ title: field('stats.0.label'), value: field('stats.0.value') },
					{ title: field('stats.1.label'), value: field('stats.1.value') },
					{ title: field('stats.2.label'), value: field('stats.2.value') },
				],
			},
		],
		actions: [
			{ type: 'Action.OpenUrl', title: 'Open agent', url: field('url') },
			{ type: 'Action.OpenUrl', title: 'New agent', url: field('createUrl', 'https://three.ws/create') },
		],
	};
}

/** The unbound template the Windows widgets board fetches once. */
export function adaptiveTemplate() {
	return layout((path, fallback) =>
		fallback ? `\${if(${path}, ${path}, '${fallback}')}` : `\${${path}}`,
	);
}

/** The same card with this agent's values already in it. */
export function adaptiveCardFor(card) {
	return layout((path, fallback) => {
		const value = path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), card);
		if (value === null || value === undefined || value === '') return fallback ?? '';
		return typeof value === 'number' ? String(value) : value;
	});
}
