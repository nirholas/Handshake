import vhtml from 'vhtml';

/** @jsx vhtml */

function fmtBytes(n) {
	if (n == null) return 'n/a';
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtNumber(n) {
	if (n == null) return 'n/a';
	return Number(n).toLocaleString();
}

const SEVERITY_COLOR = {
	critical: '#f44336',
	warn: '#f9a825',
	info: '#2196f3',
};

const SEVERITY_LABEL = {
	critical: 'Critical',
	warn: 'Warning',
	info: 'Info',
};

export function InspectReport({ inspect, suggestions, reportJSON }) {
	const c = inspect.counts;
	const totalTextureBytes = inspect.textures.reduce((a, t) => a + (t.byteSize || 0), 0);
	return (
		<div class="report">
			<div class="report-head">
				{/* h2, not h1: this report renders inside a page that already owns one. */}
				<h2>Performance inspector</h2>
				{reportJSON && (
					<a class="report-download" href={reportJSON} download="gltf-inspect-report.json">
						Download JSON
					</a>
				)}
			</div>
			<p class="report-sub">
				Structural analysis from{' '}
				<a href="https://gltf-transform.dev" target="_blank" rel="noreferrer">
					glTF-Transform
				</a>
				. Surfaces what the Khronos validator does not: texture weights, draw-call shape,
				and compression opportunities.
			</p>

			<div class="inspect-grid">
				<div class="inspect-card">
					<div class="inspect-card-label">File</div>
					<div class="inspect-card-value">{fmtBytes(inspect.fileSize)}</div>
					<div class="inspect-card-foot">{inspect.container.toUpperCase()}</div>
				</div>
				<div class="inspect-card">
					<div class="inspect-card-label">Triangles</div>
					<div class="inspect-card-value">{fmtNumber(c.totalTriangles)}</div>
					<div class="inspect-card-foot">{fmtNumber(c.totalVertices)} verts</div>
				</div>
				<div class="inspect-card">
					<div class="inspect-card-label">Draw calls</div>
					<div class="inspect-card-value">{fmtNumber(c.meshes)}</div>
					<div class="inspect-card-foot">{fmtNumber(c.materials)} materials</div>
				</div>
				<div class="inspect-card">
					<div class="inspect-card-label">Textures</div>
					<div class="inspect-card-value">{fmtNumber(c.textures)}</div>
					<div class="inspect-card-foot">{fmtBytes(totalTextureBytes)}</div>
				</div>
				<div class="inspect-card">
					<div class="inspect-card-label">Animations</div>
					<div class="inspect-card-value">{fmtNumber(c.animations)}</div>
					<div class="inspect-card-foot">{fmtNumber(c.skins)} skins</div>
				</div>
				<div class="inspect-card">
					<div class="inspect-card-label">Scene graph</div>
					<div class="inspect-card-value">{fmtNumber(c.nodes)}</div>
					<div class="inspect-card-foot">{fmtNumber(c.scenes)} scene(s)</div>
				</div>
			</div>

			<h2 class="report-section-heading" style="border-left-color:#6a5cff">
				Optimization suggestions{' '}
				<span class="report-count">({suggestions.length})</span>
			</h2>
			<div class="inspect-suggestions">
				{suggestions.map((s) => (
					<div
						class={`inspect-suggestion sev-${s.severity}`}
						style={`border-left-color:${SEVERITY_COLOR[s.severity] || '#888'}`}
					>
						<div class="inspect-suggestion-head">
							<span
								class="inspect-suggestion-badge"
								style={`background:${SEVERITY_COLOR[s.severity] || '#888'}`}
							>
								{SEVERITY_LABEL[s.severity] || s.severity}
							</span>
							<code class="inspect-suggestion-id">{s.id}</code>
							{s.estimate && (
								<span class="inspect-suggestion-estimate">{s.estimate}</span>
							)}
						</div>
						<div class="inspect-suggestion-msg">{s.message}</div>
					</div>
				))}
			</div>

			{inspect.extensionsUsed.length > 0 && (
				<>
					<h2 class="report-section-heading" style="border-left-color:#888">
						Extensions used{' '}
						<span class="report-count">({inspect.extensionsUsed.length})</span>
					</h2>
					<ul class="inspect-ext-list">
						{inspect.extensionsUsed.map((ext) => (
							<li>
								<code>{ext}</code>
								{inspect.extensionsRequired.includes(ext) && (
									<span class="inspect-ext-required">required</span>
								)}
							</li>
						))}
					</ul>
				</>
			)}

			{inspect.textures.length > 0 && (
				<>
					<h2 class="report-section-heading" style="border-left-color:#888">
						Textures <span class="report-count">({inspect.textures.length})</span>
					</h2>
					<div class="report-table-wrap">
						<table class="report-table">
							<thead>
								<tr>
									<th>Name</th>
									<th>Type</th>
									<th>Dimensions</th>
									<th>Bytes</th>
								</tr>
							</thead>
							<tbody>
								{inspect.textures.map((t) => (
									<tr>
										<td>{t.name || <em>unnamed</em>}</td>
										<td>
											<code>{t.mimeType || 'n/a'}</code>
										</td>
										<td>
											{t.width}×{t.height}
										</td>
										<td>{fmtBytes(t.byteSize)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</>
			)}
		</div>
	);
}
