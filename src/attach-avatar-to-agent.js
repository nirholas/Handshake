import { apiFetch } from './account.js';

/**
 * Associates an avatar with the caller's default agent. The /api/agents POST
 * endpoint doesn't accept `avatar_id`, so we get-or-create via /me and then
 * PUT to attach. Returns the updated agent record.
 *
 * Shared by /create and /create-review — kept in its own module so neither
 * page's top-level boot() runs when the other imports it.
 *
 * @param {string} avatarId
 * @param {string} [name] - Default agent name to use when no agent exists yet.
 * @returns {Promise<object>}
 */
export async function attachAvatarToAgent(avatarId, name) {
	const meRes = await apiFetch('/api/agents/me');
	const meData = await meRes.json();
	if (!meRes.ok) throw new Error(meData.error_description || 'Failed to load agent.');

	let agent = meData.agent;
	if (!agent) {
		const createRes = await apiFetch('/api/agents', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: name || 'My Agent' }),
		});
		const createData = await createRes.json();
		if (!createRes.ok)
			throw new Error(createData.error_description || 'Failed to create agent.');
		agent = createData.agent;
	}

	const putRes = await apiFetch('/api/agents/' + agent.id, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ avatar_id: avatarId }),
	});
	const putData = await putRes.json();
	if (!putRes.ok) throw new Error(putData.error_description || 'Failed to attach avatar.');
	return putData.agent;
}
