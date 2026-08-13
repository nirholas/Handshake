// POST /api/genome/breed — the breeding transaction.
//
// Two agents breed into a genuinely new child agent that provably inherits a
// seed-recorded recombination of both parents (brain, voice, body, skills). The
// child gets a FRESH, distinct Solana + EVM wallet (fork's ownership invariant,
// extended to two parents); NEITHER parent's row or wallet is touched. The child's
// real artifacts are synthesized — a baked GLB body, blended ElevenLabs voice
// settings, a composed in-character brain — and its expressed skill licenses are
// granted on-chain, royalty-provenance recorded. The breeding seed + derived
// genome are persisted so the descent is re-derivable and forgery-detectable.
//
// Idempotent per breeding key: replaying the same (parents, seed) returns the same
// child instead of minting twins.

import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { isUuid } from '../_lib/validate.js';
import { requireCsrf } from '../_lib/csrf.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { withDbRetry } from '../_lib/db-retry.js';
import { provisionAgentWallets } from '../_lib/agent-wallet.js';
import { createAvatar, storageKeyFor } from '../_lib/avatars.js';
import { copyObject, headObject } from '../_lib/r2.js';
import { bakeAndUploadAppearance } from '../_lib/bake.js';
import { dispatchWebhooks } from '../_lib/webhook-dispatch.js';
import { recordEvent } from '../_lib/usage.js';
import { mintSkillLicenseOnchain, minterKeypair } from '../_lib/skill-license-onchain.js';
import {
	deriveGenome,
	makeSeed,
	hashGenome,
	composePersonaPrompt,
	voiceSettings,
	appearanceFromGenome,
	expressedSkills,
	pedigreeScore,
} from '../_lib/genome.js';
import {
	loadBreedingAgent,
	agentGenome,
	eligibilityFor,
	cooldownRemainingMs,
	publicGenome,
	verifyStudFeePayment,
} from '../_lib/genome-agent.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req, 'avatars:write');
	if (!auth) return error(res, 401, 'unauthorized', 'avatars:write scope required to breed');
	if (!(await requireCsrf(req, res, auth.userId))) return; // writes the 403 itself

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many breeding attempts — slow down');

	const body = await readJson(req);
	const parentAId = String(body.parent_a || body.parent_a_agent_id || '').trim();
	const parentBId = String(body.parent_b || body.parent_b_agent_id || '').trim();
	if (!isUuid(parentAId) || !isUuid(parentBId)) {
		return error(res, 400, 'validation_error', 'parent_a and parent_b agent ids are required');
	}
	if (parentAId === parentBId) return error(res, 400, 'validation_error', 'an agent cannot breed with itself');

	const seed = typeof body.seed === 'string' && body.seed ? body.seed.slice(0, 64) : makeSeed();
	// Idempotency: a provided key wins; else the canonical (sorted parents + seed)
	// so committing the same preview twice returns the same child, never twins.
	const breedingKey =
		(typeof body.idempotency_key === 'string' && body.idempotency_key.trim()) ||
		`${[parentAId, parentBId].sort().join(':')}:${seed}`;

	// Replay guard — return the existing child idempotently.
	const [existing] = await sql`
		select child_agent_id from genome_breedings where breeding_key = ${breedingKey} limit 1
	`;
	if (existing?.child_agent_id) {
		const child = await loadChildSummary(existing.child_agent_id);
		return json(res, 200, { child, deduped: true });
	}

	const [rowA, rowB] = await Promise.all([loadBreedingAgent(parentAId), loadBreedingAgent(parentBId)]);
	if (!rowA || !rowB) return error(res, 404, 'not_found', 'one or both parents not found');

	// Eligibility + cross-owner stud consent.
	const eligA = eligibilityFor(rowA, auth.userId);
	const eligB = eligibilityFor(rowB, auth.userId);
	if (!eligA.allowed) return error(res, 403, 'parent_ineligible', `parent A: ${eligA.reason}`, { parent: 'a', reason: eligA.reason });
	if (!eligB.allowed) return error(res, 403, 'parent_ineligible', `parent B: ${eligB.reason}`, { parent: 'b', reason: eligB.reason });

	// Cooldown FIRST, before the fee gate. Both parents must be off cooldown, which
	// keeps deep pedigrees scarce. Checking it after the 402 would have taken a real
	// $THREE settlement for a breeding this request was always going to refuse.
	const now = Date.now();
	const [coolA, coolB] = await Promise.all([cooldownRemainingMs(parentAId, now), cooldownRemainingMs(parentBId, now)]);
	const cool = Math.max(coolA, coolB);
	if (cool > 0) {
		return error(res, 409, 'breeding_cooldown', 'a parent is still on breeding cooldown', {
			cooldown_remaining_ms: cool,
			cooldown_remaining_min: Math.ceil(cool / 60000),
		});
	}

	const feeThree = (eligA.fee_three || 0) + (eligB.fee_three || 0);
	const consentOwner = eligA.cross_owner ? eligA.owner_id : eligB.cross_owner ? eligB.owner_id : null;
	const studFeeSig = (typeof body.stud_fee_signature === 'string' && body.stud_fee_signature.trim()) || '';
	let studFeeAtomics = '0';
	// A cross-owner stud with a fee must be paid in $THREE. The caller supplies a
	// real settlement signature, or we 402 with the exact terms (no breed on credit).
	if (feeThree > 0) {
		if (!studFeeSig) {
			return error(res, 402, 'stud_fee_required', `breeding with this stud costs ${feeThree} $THREE — settle and include stud_fee_signature`, {
				stud_fee_three: feeThree,
				coin: '$THREE',
			});
		}
		// Replay guard: one settlement pays for exactly one breeding. The breeding_key
		// dedupe above only covers an identical (parents, seed) retry; this blocks
		// reusing a single payment across distinct breedings with the same stud.
		const [usedSig] = await sql`
			select 1 from genome_breedings where stud_fee_signature = ${studFeeSig} limit 1
		`;
		if (usedSig) {
			return error(res, 409, 'stud_fee_replayed', 'that stud_fee_signature was already used to pay for another breeding');
		}
		// Verify on-chain that the fee was actually paid in $THREE to the cross-owner
		// stud's payout wallet. Presence of a signature is NOT proof of payment.
		const studWallets = [
			eligA.cross_owner ? rowA.meta?.solana_address : null,
			eligB.cross_owner ? rowB.meta?.solana_address : null,
		].filter(Boolean);
		const paid = await verifyStudFeePayment({
			signature: studFeeSig,
			recipientOwners: studWallets,
			feeThree,
			network: body.network === 'devnet' ? 'devnet' : 'mainnet',
		});
		if (!paid.ok) {
			return error(res, 402, 'stud_fee_unverified', paid.reason, {
				stud_fee_three: feeThree,
				coin: '$THREE',
				stud_wallets: studWallets,
			});
		}
		studFeeAtomics = paid.atomics || '0';
	}

	// Derive the child genome — deterministic, re-derivable from (parents, seed).
	const genomeA = agentGenome(rowA);
	const genomeB = agentGenome(rowB);
	const childGenome = deriveGenome({ parentA: genomeA, parentB: genomeB, seed });
	const childName = (typeof body.name === 'string' && body.name.trim().slice(0, 80)) || `${rowA.name} × ${rowB.name}`.slice(0, 80);
	const pedigree = pedigreeScore(childGenome);

	// ── Synthesize the child's real body (baked GLB) ────────────────────────────
	const baseAvatarId = childGenome.body.base_avatar_id || rowA.avatar_id || rowB.avatar_id || null;
	const childAvatar = await provisionChildAvatar({
		userId: auth.userId,
		baseAvatarId,
		fallbackStorageKey: rowA.avatar_storage_key || rowB.avatar_storage_key || null,
		appearance: appearanceFromGenome(childGenome),
		name: childName,
	});

	// ── Compose the child's real brain + voice ──────────────────────────────────
	const personaPrompt = composePersonaPrompt(childGenome, childName);
	const vSettings = voiceSettings(childGenome);
	const inheritedSkills = expressedSkills(childGenome);

	// Snapshot the EXACT parent genomes used. Verification re-derives from these
	// recorded inputs + seed, so a later edit to a parent's traits can never make a
	// genuine child fail to verify — the breed is provable from what it consumed.
	const bredFrom = {
		breeding_key: breedingKey,
		seed,
		parent_a: { agent_id: rowA.id, name: rowA.name, owner_id: rowA.user_id, genome: genomeA },
		parent_b: { agent_id: rowB.id, name: rowB.name, owner_id: rowB.user_id, genome: genomeB },
		generation: childGenome.generation,
	};
	const childMeta = {
		genome: childGenome,
		bred_from: bredFrom,
		genome_breeding: { breedable: true, stud: false, stud_fee_three: 0 },
	};

	// Insert the child agent. Its wallets are provisioned next — distinct keys,
	// no parent secret copied (provisionAgentWallets generates fresh material).
	let child;
	try {
		child = await withDbRetry(async () => {
			const [r] = await sql`
				insert into agent_identities (
					user_id, name, avatar_id, is_public,
					persona_prompt, persona_tone_tags,
					voice_provider, voice_id, voice_model, voice_settings,
					skills, meta, created_at, updated_at
				) values (
					${auth.userId}, ${childName}, ${childAvatar?.id || null}, false,
					${personaPrompt}, ${JSON.stringify(childGenome.brain.tone_tags)}::jsonb,
					${childGenome.voice.provider || 'browser'}, ${childGenome.voice.voice_id || null},
					${childGenome.voice.model || null}, ${JSON.stringify(vSettings)}::jsonb,
					${inheritedSkills}, ${JSON.stringify(childMeta)}::jsonb, now(), now()
				) returning id
			`;
			return r;
		});
	} catch (e) {
		console.error('[breed] child insert failed', { parents: [rowA.id, rowB.id], error: e?.message });
		return error(res, 500, 'breed_failed', 'failed to create child agent');
	}

	const wallets = await provisionAgentWallets(child.id);
	// OWNERSHIP INVARIANT (proved live): the child's fresh wallets must differ from
	// both parents'. provisionAgentWallets generates new random keys, but assert it
	// rather than trust it — a collision here would be a critical breach.
	const parentSolanas = [rowA.meta?.solana_address, rowB.meta?.solana_address].filter(Boolean);
	const parentEvms = [rowA.wallet_address, rowB.wallet_address, rowA.meta?.wallet_address, rowB.meta?.wallet_address].filter(Boolean);
	if (parentSolanas.includes(wallets.solana) || parentEvms.includes(wallets.evm)) {
		// Retire the row we just inserted. Aborting without it would leave a bred,
		// genome-carrying agent visible in listings and lineage walks that no
		// breeding record ever accounts for.
		await retireChild(child.id, 'ownership_invariant_violation');
		return error(res, 500, 'ownership_invariant_violation', 'child wallet collided with a parent, breeding aborted');
	}

	// ── Grant inherited skill licenses on-chain (royalty-provenance recorded) ───
	const skillGrants = await grantInheritedSkills({
		skills: inheritedSkills,
		childGenome,
		childWallet: wallets.solana,
		parentA: { id: rowA.id, genome: genomeA },
		parentB: { id: rowB.id, genome: genomeB },
		network: body.network === 'devnet' ? 'devnet' : 'mainnet',
	});
	if (skillGrants.length) {
		await sql`
			update agent_identities
			set meta = jsonb_set(meta, '{skill_grants}', ${JSON.stringify(skillGrants)}::jsonb, true)
			where id = ${child.id}
		`.catch(() => {});
	}

	// ── Persist the breeding event (the verifiable lineage record) ──────────────
	const genomeHash = childGenome.genome_hash || hashGenome(childGenome);
	let recorded = null;
	try {
		[recorded] = await sql`
			insert into genome_breedings (
				breeding_key, parent_a_agent_id, parent_b_agent_id, child_agent_id,
				seed, genome, genome_hash, generation, pedigree_tier, bred_by,
				stud_fee_atomics, stud_fee_signature, consent_owner, status
			) values (
				${breedingKey}, ${rowA.id}, ${rowB.id}, ${child.id},
				${seed}, ${JSON.stringify(childGenome)}::jsonb, ${genomeHash},
				${childGenome.generation}, ${pedigree.tier}, ${auth.userId},
				${studFeeAtomics}, ${studFeeSig || null}, ${consentOwner}, 'born'
			)
			on conflict (breeding_key) do nothing
			returning child_agent_id
		`;
	} catch (e) {
		// A unique violation on the settlement signature means a request racing this
		// one already spent the same $THREE payment. The replay SELECT above cannot
		// see an uncommitted sibling; the index can, and it is the only place this
		// can be decided atomically. Retire our child rather than let one payment
		// buy two.
		if (e?.code === '23505' && /stud_fee_signature/.test(String(e?.constraint || e?.message || ''))) {
			await retireChild(child.id, 'stud_fee_replayed');
			return error(res, 409, 'stud_fee_replayed', 'that stud_fee_signature was already used to pay for another breeding');
		}
		console.error('[breed] lineage record failed', { child: child.id, error: e?.message });
	}
	// No returned row means the breeding key conflicted: a concurrent request (a
	// double-submitted preview) recorded this exact pairing first. The header
	// promises no twins, so retire ours and hand back the child that won.
	if (recorded === undefined) {
		await retireChild(child.id, 'breeding_key_race');
		const [winner] = await sql`
			select child_agent_id from genome_breedings where breeding_key = ${breedingKey} limit 1
		`;
		return json(res, 200, { child: await loadChildSummary(winner?.child_agent_id || child.id), deduped: true });
	}

	dispatchWebhooks({
		userId: auth.userId,
		eventType: 'agent.bred',
		data: {
			child_agent_id: child.id,
			name: childName,
			generation: childGenome.generation,
			pedigree_tier: pedigree.tier,
			parents: [rowA.id, rowB.id],
		},
	}).catch(() => {});

	recordEvent({
		userId: auth.userId,
		apiKeyId: auth.apiKeyId,
		clientId: auth.clientId,
		avatarId: childAvatar?.id || null,
		kind: 'breed',
		meta: { parent_a: rowA.id, parent_b: rowB.id, generation: childGenome.generation, pedigree: pedigree.tier },
	});

	return json(res, 201, {
		child: {
			id: child.id,
			name: childName,
			wallet_address: wallets.evm,
			solana_address: wallets.solana,
			avatar_id: childAvatar?.id || null,
			generation: childGenome.generation,
			pedigree,
		},
		genome: publicGenome(childGenome, childName),
		genome_hash: genomeHash,
		seed,
		breeding_key: breedingKey,
		skill_grants: skillGrants,
		parents: { a: { id: rowA.id, name: rowA.name }, b: { id: rowB.id, name: rowB.name } },
	});
});

// Copy the dominant parent's GLB into the child's namespace, register a fresh
// avatar row (source='genome', parent_avatar_id=base), then bake the inherited
// appearance into a real composite child GLB. Degrades gracefully — a copy/bake
// hiccup never blocks the birth, but the child still references a real model.
async function provisionChildAvatar({ userId, baseAvatarId, fallbackStorageKey, appearance, name }) {
	try {
		let base = null;
		if (baseAvatarId) {
			[base] = await sql`
				select id, name, storage_key, content_type, size_bytes
				from avatars where id = ${baseAvatarId} and deleted_at is null limit 1
			`;
		}
		const baseStorageKey = base?.storage_key || fallbackStorageKey;
		if (!baseStorageKey) return null;

		const slugBase =
			(name || 'offspring').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'offspring';
		let newStorageKey = storageKeyFor({ userId, slug: slugBase });
		const copied = await copyObject({ fromKey: baseStorageKey, toKey: newStorageKey });
		if (!copied) newStorageKey = baseStorageKey; // hosted URL — reference through
		if (copied) {
			const head = await headObject(newStorageKey);
			if (!head) newStorageKey = baseStorageKey;
		}

		const avatar = await createAvatar({
			userId,
			input: {
				name,
				description: 'Bred via Agent Genome — a recombination of two parent agents.',
				size_bytes: Number(base?.size_bytes || 0),
				content_type: base?.content_type || 'model/gltf-binary',
				source: 'genome',
				source_meta: { bred: true, base_avatar_id: baseAvatarId || null },
				visibility: 'unlisted',
				tags: ['bred'],
				checksum_sha256: null,
				parent_avatar_id: baseAvatarId || null,
				appearance,
			},
			storageKey: newStorageKey,
		});

		// Bake the inherited morphs/colors/accessories into a real composite GLB.
		try {
			const baked = await bakeAndUploadAppearance({ baseStorageKey: newStorageKey, appearance });
			if (baked?.baked_storage_key) {
				await sql`
					update avatars set baked_storage_key = ${baked.baked_storage_key},
						appearance_hash = ${baked.appearance_hash}, baked_at = now(), updated_at = now()
					where id = ${avatar.id}
				`.catch(() => {});
			}
		} catch (e) {
			console.warn('[breed] bake failed, child uses copied base GLB', e?.message);
		}
		return avatar;
	} catch (e) {
		console.error('[breed] child avatar provision failed', e?.message);
		return null;
	}
}

// Grant each expressed inherited skill to the child on-chain. Provenance (which
// parent the allele came from, or emergent fusion) is recorded so skill royalties
// owed upstream still resolve. Degrades to a recorded-intent grant if the on-chain
// minter isn't configured for this environment — never fabricates a signature.
async function grantInheritedSkills({ skills, childGenome, childWallet, parentA, parentB, network }) {
	if (!skills.length) return [];
	const minterReady = !!minterKeypair() && !!childWallet;
	const expA = new Set(expressedSkills(parentA.genome));
	const expB = new Set(expressedSkills(parentB.genome));
	const alleleBySkill = new Map(childGenome.skills.map((s) => [s.skill, s]));

	const grants = [];
	for (const skill of skills) {
		const allele = alleleBySkill.get(skill);
		const inheritedFrom = [];
		if (expA.has(skill)) inheritedFrom.push(parentA.id);
		if (expB.has(skill)) inheritedFrom.push(parentB.id);
		const grant = {
			skill,
			inherited_from: inheritedFrom,
			emergent: allele?.source === 'emergent' ? allele.emergent_from || true : false,
			network,
			status: 'pending',
			signature: null,
		};
		if (minterReady) {
			try {
				const r = await mintSkillLicenseOnchain({ ownerWallet: childWallet, agentMint: childWallet, skill, network });
				grant.status = r.alreadyMinted ? 'already_minted' : 'minted';
				grant.signature = r.signature || null;
				grant.license = r.skillLicense || null;
			} catch (e) {
				grant.status = 'grant_deferred';
				grant.reason = e?.code || 'mint_failed';
			}
		} else {
			grant.status = 'grant_deferred';
			grant.reason = 'minter_unconfigured';
		}
		grants.push(grant);
	}
	return grants;
}

// Withdraw a child that was inserted but must not exist: a wallet-collision abort,
// or a lost race for the breeding key. Soft-delete keeps the row for forensics
// while removing it from every listing, lineage walk, and cooldown calculation.
async function retireChild(childAgentId, reason) {
	try {
		await sql`
			update agent_identities
			set deleted_at = now(), updated_at = now(),
			    meta = jsonb_set(coalesce(meta, '{}'::jsonb), '{bred_from,retired}', ${JSON.stringify(reason)}::jsonb, true)
			where id = ${childAgentId} and deleted_at is null
		`;
	} catch (e) {
		console.error('[breed] child retire failed', { child: childAgentId, reason, error: e?.message });
	}
}

async function loadChildSummary(childAgentId) {
	const [r] = await sql`
		select id, name, avatar_id, meta from agent_identities where id = ${childAgentId} limit 1
	`;
	if (!r) return { id: childAgentId };
	return {
		id: r.id,
		name: r.name,
		avatar_id: r.avatar_id,
		solana_address: r.meta?.solana_address || null,
		wallet_address: r.meta?.wallet_address || null,
		generation: r.meta?.genome?.generation ?? null,
	};
}

async function resolveAuth(req, requiredScope) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, source: 'session' };
	const bearer = await authenticateBearer(extractBearer(req));
	if (!bearer) return null;
	if (!hasScope(bearer.scope, requiredScope)) return null;
	return bearer;
}
