// The model's weight, always in view.
//
// While a viewer is the active editor the status bar shows triangles and file
// size, the two numbers that decide whether an asset ships. Clicking it opens
// the report.

import * as vscode from 'vscode';
import { onActiveViewerChanged } from './active-panel.js';
import { formatBytes } from './naming.js';

export function createStatusBar() {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
	item.name = 'three.ws 3D';
	item.command = 'threews3d.toggleReport';
	const sub = onActiveViewerChanged((panel) => render(item, panel));
	render(item, null);
	return {
		dispose() {
			sub.dispose();
			item.dispose();
		},
	};
}

function render(item, panel) {
	const stats = panel?.threews?.stats;
	if (!panel || !stats) {
		item.hide();
		return;
	}
	const parts = [`$(symbol-color) ${num(stats.triangles)} tris`];
	if (panel.threews.fileSize) parts.push(formatBytes(panel.threews.fileSize));
	if (stats.bones) parts.push(`${num(stats.bones)} bones`);
	if (stats.animations) parts.push(`${stats.animations} clip${stats.animations === 1 ? '' : 's'}`);
	item.text = parts.join(' · ');
	item.tooltip = new vscode.MarkdownString(
		[
			`**${panel.title}**`,
			'',
			`- Triangles: ${num(stats.triangles)}`,
			`- Meshes: ${num(stats.meshes)} · Materials: ${num(stats.materials)} · Textures: ${num(stats.textures)}`,
			stats.bones ? `- Bones: ${num(stats.bones)}` : '- No skeleton',
			`- Animations: ${num(stats.animations)}`,
			'',
			'Click to toggle the report.',
		].join('\n'),
	);
	item.show();
}

function num(n) {
	return Number(n || 0).toLocaleString('en-US');
}
