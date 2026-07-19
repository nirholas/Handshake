// `concierge_ask`, ask an AI concierge a question, grounded in a website or in
// content you provide. Read-only (from the caller's side; it only reads pages
// and calls the public answer endpoint).
//
// Give it a `url` and it fetches + harvests that page (title, headings, nav,
// main text) and answers grounded in it, "ask any website a question". Or give
// it `knowledge`/`content` directly to answer grounded in text you already have.
// Runs on the free three.ws Concierge lane: no key, no signer, no payment.

import { z } from 'zod';

import { defineTool, defineExecutor, toMcpTools } from '@three-ws/tool-sdk';

import { askConcierge, fetchPage } from '../lib/api.js';
import { harvestHtml } from '../lib/harvest.js';
import { THREE_WS_BASE } from '../config.js';

const DESCRIPTION =
	'Ask an AI concierge a question and get a grounded answer. Provide a "url" and it fetches that page and ' +
	'answers using its real content (title, headings, navigation, main text), the way to ask any website a ' +
	'question. Or skip the url and pass "knowledge"/"content" to answer grounded in text you already have. ' +
	'The model is instructed not to invent facts it cannot see. Runs on the free three.ws lane; no key required.';

const tool = defineTool({
	id: 'concierge-ask',
	title: "Ask a website's AI concierge a question",
	description: DESCRIPTION,
	version: '1.0.0',
	permissions: { network: ['*'] }, // fetches an arbitrary caller-supplied URL + the three.ws answer API
	apis: [
		{
			name: 'concierge_ask',
			title: "Ask a website's AI concierge a question",
			description: DESCRIPTION,
			annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
			parameters: z.object({
				question: z.string().min(1).max(2000).describe('The question to ask, in natural language.'),
				url: z
					.string()
					.url()
					.optional()
					.describe('A web page to ground the answer in. It is fetched and its readable text is harvested.'),
				siteName: z
					.string()
					.max(120)
					.optional()
					.describe('Display name of the site/product (used in the answer\'s framing). Inferred from the page when omitted.'),
				knowledge: z
					.string()
					.max(8000)
					.optional()
					.describe('Curated authoritative facts (FAQ, pricing, policies) to ground the answer in. Leads over harvested page text.'),
				content: z
					.string()
					.max(6000)
					.optional()
					.describe('Raw page/document text to ground the answer in when you are not passing a url.'),
				persona: z
					.string()
					.max(200)
					.optional()
					.describe('Optional tone instruction for the reply, e.g. "concise and technical".'),
				lang: z.string().max(20).optional().describe('BCP-47 language hint for the reply, e.g. "en", "es".'),
			}),
		},
	],
});

const executor = defineExecutor(tool, {
	async concierge_ask({ question, url, siteName, knowledge, content, persona, lang }) {
		if (!url && !knowledge && !content) {
			throw Object.assign(
				new Error('provide a "url" to ground the answer in a web page, or "knowledge"/"content" text'),
				{ code: 'bad_request' },
			);
		}

		let site;
		if (url) {
			const html = await fetchPage(url);
			site = harvestHtml(html, { url, siteName, knowledge });
			// Explicit content overrides/augments the harvested body when supplied.
			if (content) site.content = String(content).slice(0, 6000);
		} else {
			site = {
				url: '',
				name: siteName || '',
				title: '',
				description: '',
				headings: [],
				nav: [],
				knowledge: knowledge ? String(knowledge).slice(0, 8000) : '',
				content: content ? String(content).slice(0, 6000) : '',
			};
		}

		const { answer, provider, model } = await askConcierge({ question, site, persona, lang });
		return {
			ok: true,
			question,
			answer,
			grounded_in: {
				url: site.url || null,
				site: site.name || null,
				title: site.title || null,
				used_page_content: Boolean(site.content),
				used_knowledge: Boolean(site.knowledge),
			},
			provider,
			model,
			endpoint: `${THREE_WS_BASE}/api/concierge`,
		};
	},
});

export const def = toMcpTools(tool, executor)[0];
