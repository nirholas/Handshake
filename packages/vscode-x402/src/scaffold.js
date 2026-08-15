// Scaffold a new paid x402 endpoint that follows the repo's canonical
// paidEndpoint() pattern (api/_lib/x402-paid-endpoint.js). Generates a working
// handler file in the open workspace and opens it.

import * as vscode from 'vscode';

import { renderEndpoint } from './scaffold-template.js';

export async function scaffoldEndpoint() {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {
		vscode.window.showErrorMessage('Open a workspace folder to scaffold an endpoint into.');
		return;
	}

	const slug = await vscode.window.showInputBox({
		title: 'Scaffold paid endpoint — slug',
		prompt: 'URL slug, e.g. "summarize" → /api/x402/summarize',
		validateInput: (v) =>
			/^[a-z0-9][a-z0-9-]*$/.test((v || '').trim()) ? null : 'lowercase letters, digits, hyphens',
	});
	if (!slug) return;

	const priceUsd = await vscode.window.showInputBox({
		title: 'Price per call (USD)',
		value: '0.01',
		validateInput: (v) => (Number(v) > 0 ? null : 'must be a positive number'),
	});
	if (!priceUsd) return;

	const description = await vscode.window.showInputBox({
		title: 'Description',
		prompt: 'What does this endpoint do? (shown in the bazaar)',
		value: `${slug} service`,
	});
	if (description == null) return;

	const cleanSlug = slug.trim();
	const content = renderEndpoint({ slug: cleanSlug, priceUsd, description });

	const root = folders[0].uri;
	const target = vscode.Uri.joinPath(root, 'api', 'x402', `${cleanSlug}.js`);
	try {
		await vscode.workspace.fs.stat(target);
		const ow = await vscode.window.showWarningMessage(
			`api/x402/${cleanSlug}.js already exists. Overwrite?`,
			'Overwrite',
			'Cancel',
		);
		if (ow !== 'Overwrite') return;
	} catch {
		/* doesn't exist — good */
	}

	await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
	const doc = await vscode.workspace.openTextDocument(target);
	await vscode.window.showTextDocument(doc);
	vscode.window.showInformationMessage(
		`Scaffolded /api/x402/${cleanSlug} — it returns a wired echo response; replace the handler body with real work.`,
	);
}
