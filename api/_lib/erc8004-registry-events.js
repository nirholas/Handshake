// Pure decoder for ERC-8004 Identity Registry logs.
//
// The crawler used to filter on the single `Registered` topic, which meant an
// agent's indexed row froze at its registration block forever. A live census of
// the registry contract on 2026-08-11 (4001 blocks on Base, 2001 on Ethereum
// and Ethereum Sepolia) found four event classes in the logs and only one of
// them indexed:
//
//   Base      66 logs → 7 Registered indexed  (28 MetadataUpdate, 24 MetadataSet,
//                                              7 Transfer, 7 Registered — 10.6% coverage)
//   Ethereum  93 logs → 15 Registered indexed (48 MetadataSet, 15 Transfer,
//                                              15 MetadataUpdate — 16.1% coverage)
//   Eth Sep   16 logs → 3 Registered indexed  (5 MetadataUpdate, 3 Transfer,
//                                              3 MetadataSet, 2 URIUpdated — 18.8%)
//
// The two topics that did not resolve against a local signature list were
// confirmed against the openchain.xyz signature database and their raw log
// shapes: MetadataSet(uint256,string,string,bytes) and URIUpdated(uint256,string,address).
//
// This module is deliberately free of DB and network access so the decode paths
// are unit-testable against captured mainnet logs.

import { id as keccakId, AbiCoder, getAddress } from 'ethers';

const ABI_CODER = AbiCoder.defaultAbiCoder();

/** Registered(uint256 indexed agentId, string tokenURI, address indexed owner) */
export const TOPIC_REGISTERED = keccakId('Registered(uint256,string,address)');
/** URIUpdated(uint256 indexed agentId, string tokenURI, address indexed owner) */
export const TOPIC_URI_UPDATED = keccakId('URIUpdated(uint256,string,address)');
/** MetadataSet(uint256 indexed agentId, string indexed key, string key, bytes value) */
export const TOPIC_METADATA_SET = keccakId('MetadataSet(uint256,string,string,bytes)');
/** Transfer(address indexed from, address indexed to, uint256 indexed tokenId) */
export const TOPIC_TRANSFER = keccakId('Transfer(address,address,uint256)');

/**
 * Every topic0 the crawler asks the RPC for, as an eth_getLogs topic OR-set.
 * EIP-4906 MetadataUpdate is deliberately absent: it is an unindexed
 * "refresh your cache" ping that carries no state the index does not already
 * get from URIUpdated / MetadataSet, and on Base it is the single noisiest
 * topic on the contract.
 */
export const REGISTRY_TOPICS = [
	TOPIC_REGISTERED,
	TOPIC_URI_UPDATED,
	TOPIC_METADATA_SET,
	TOPIC_TRANSFER,
];

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const addrFromTopic = (topic) => getAddress('0x' + topic.slice(-40)).toLowerCase();

const hexToInt = (hex) => (hex == null ? null : Number.parseInt(hex, 16));

/**
 * Decode one registry log into a normalized event.
 *
 * @param {{ topics: string[], data: string, blockNumber: string,
 *           transactionHash: string, logIndex?: string }} log raw eth_getLogs entry
 * @returns {null | {
 *   type: 'registered'|'uri_updated'|'metadata_set'|'transfer',
 *   eventName: string, eventClass: string, agentId: string,
 *   owner?: string, from?: string, to?: string, agentUri?: string,
 *   key?: string, value?: string, isMint?: boolean,
 *   blockNumber: number|null, logIndex: number, tx: string
 * }} null when the topic is not one we index or the payload will not decode.
 */
export function decodeRegistryLog(log) {
	if (!log || !Array.isArray(log.topics) || log.topics.length === 0) return null;
	const base = {
		blockNumber: hexToInt(log.blockNumber),
		logIndex: hexToInt(log.logIndex) ?? 0,
		tx: log.transactionHash,
	};

	switch (log.topics[0]) {
		case TOPIC_REGISTERED:
		case TOPIC_URI_UPDATED: {
			if (log.topics.length < 3) return null;
			const registered = log.topics[0] === TOPIC_REGISTERED;
			const [agentUri] = ABI_CODER.decode(['string'], log.data);
			return {
				...base,
				type: registered ? 'registered' : 'uri_updated',
				eventName: registered ? 'Registered' : 'URIUpdated',
				eventClass: registered ? 'registration' : 'metadata',
				agentId: BigInt(log.topics[1]).toString(),
				owner: addrFromTopic(log.topics[2]),
				agentUri: agentUri || null,
			};
		}

		case TOPIC_METADATA_SET: {
			if (log.topics.length < 2) return null;
			const [key, value] = ABI_CODER.decode(['string', 'bytes'], log.data);
			return {
				...base,
				type: 'metadata_set',
				eventName: 'MetadataSet',
				eventClass: 'metadata',
				agentId: BigInt(log.topics[1]).toString(),
				key,
				value: decodeMetadataValue(key, value),
			};
		}

		case TOPIC_TRANSFER: {
			// ERC-721 Transfer carries all three args indexed; a 3-topic log is the
			// ERC-20 shape and cannot belong to this registry.
			if (log.topics.length < 4) return null;
			const from = addrFromTopic(log.topics[1]);
			const to = addrFromTopic(log.topics[2]);
			return {
				...base,
				type: 'transfer',
				eventName: 'Transfer',
				eventClass: 'transfer',
				agentId: BigInt(log.topics[3]).toString(),
				from,
				to,
				// The mint leg of a registration duplicates the Registered event; the
				// caller records it as ownership provenance but must not treat it as
				// a change of hands.
				isMint: from === ZERO_ADDRESS,
			};
		}

		default:
			return null;
	}
}

/**
 * Render a MetadataSet value for storage. Address-valued keys (agentWallet is
 * the one the registry actually uses) are 20 raw bytes; everything else is
 * rendered as UTF-8 when it decodes cleanly and left as hex when it does not,
 * so a binary blob never lands in the index as replacement characters.
 * @param {string} key
 * @param {string} valueHex 0x-prefixed bytes from the log
 * @returns {string|null}
 */
export function decodeMetadataValue(key, valueHex) {
	if (typeof valueHex !== 'string' || !valueHex.startsWith('0x')) return null;
	const body = valueHex.slice(2);
	if (body.length === 0) return null;
	if (body.length === 40) {
		try {
			return getAddress('0x' + body).toLowerCase();
		} catch {
			return valueHex;
		}
	}
	const bytes = Uint8Array.from(body.match(/.{1,2}/g).map((b) => Number.parseInt(b, 16)));
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return valueHex;
	}
}
