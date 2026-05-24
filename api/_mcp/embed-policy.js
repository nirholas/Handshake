import { readEmbedPolicyByAvatarId } from '../_lib/embed-policy.js';

export async function readMcpPolicyByAvatar(avatarId) {
	return readEmbedPolicyByAvatarId(avatarId);
}
