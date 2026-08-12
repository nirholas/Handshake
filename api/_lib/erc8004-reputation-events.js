// Pure decoder for ERC-8004 Reputation Registry logs.
//
// The EVM crawl used to watch only the Identity Registry, which meant the
// entire reputation dimension of an agent's life never reached the index on
// EVM chains even though the same contract family is CREATE2-deployed at one
// address per network class. A live probe on 2026-08-12 found the reputation
// registry live on Base, Ethereum, Base Sepolia and Sepolia, and a census of
// the last ~10k Base blocks found 24 NewFeedback logs that the index dropped
// outright.
//
// Every topic hash and log shape below is confirmed against
// erc-8004/erc-8004-contracts (contracts/ReputationRegistryUpgradeable.sol)
// and against live Base mainnet logs captured 2026-08-12. This module is
// deliberately free of DB and network access so the decode paths are
// unit-testable against captured mainnet logs.

import { id as keccakId, AbiCoder, getAddress } from 'ethers';

const ABI_CODER = AbiCoder.defaultAbiCoder();

/** Canonical CREATE2 reputation registry, one address per network class. */
export const REPUTATION_REGISTRY_MAINNET = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';
export const REPUTATION_REGISTRY_TESTNET = '0x8004B663056A597Dffe9eCcC1965A193B7388713';

/** NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash) */
export const TOPIC_NEW_FEEDBACK = keccakId(
	'NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)',
);
/** FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex) */
export const TOPIC_FEEDBACK_REVOKED = keccakId('FeedbackRevoked(uint256,address,uint64)');
/** ResponseAppended(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, address indexed responder, string responseURI, bytes32 responseHash) */
export const TOPIC_RESPONSE_APPENDED = keccakId('ResponseAppended(uint256,address,uint64,address,string,bytes32)');

/** Every topic0 the crawler asks the reputation registry RPC for. */
export const REPUTATION_TOPICS = [
	TOPIC_NEW_FEEDBACK,
	TOPIC_FEEDBACK_REVOKED,
	TOPIC_RESPONSE_APPENDED,
];

const addrFromTopic = (topic) => {
	const addr = '0x' + topic.slice(-40);
	if (addr === ZERO_ADDR) return ZERO_ADDR;
	return getAddress(addr).toLowerCase();
};

const hexToInt = (hex) => (hex == null ? null : Number.parseInt(hex, 16));

/**
 * The reputation registry address for a network class, lowercased for log
 * comparisons (eth_getLogs echoes the address in whatever case the node chose).
 * @param {boolean} testnet
 * @returns {string}
 */
export function reputationRegistryFor(testnet) {
	return (testnet ? REPUTATION_REGISTRY_TESTNET : REPUTATION_REGISTRY_MAINNET).toLowerCase();
}

const ZERO_HASH = '0x' + '0'.repeat(64);
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

/**
 * Decode one reputation registry log into a normalized event.
 *
 * @param {{ topics: string[], data: string, blockNumber: string,
 *           transactionHash: string, logIndex?: string }} log raw eth_getLogs entry
 * @returns {null | {
 *   type: 'feedback'|'feedback_revoked'|'feedback_response',
 *   eventName: string, eventClass: 'reputation', agentId: string,
 *   client?: string, responder?: string, feedbackIndex?: number,
 *   value?: string, valueDecimals?: number, tag1?: string, tag2?: string,
 *   endpoint?: string, feedbackUri?: string, responseUri?: string,
 *   blockNumber: number|null, logIndex: number, tx: string
 * }} null when the topic is not one we index or the payload will not decode.
 */
export function decodeReputationLog(log) {
	if (!log || !Array.isArray(log.topics) || log.topics.length === 0) return null;
	const base = {
		blockNumber: hexToInt(log.blockNumber),
		logIndex: hexToInt(log.logIndex) ?? 0,
		tx: log.transactionHash,
	};

	switch (log.topics[0]) {
		case TOPIC_NEW_FEEDBACK: {
			// topic1 agentId, topic2 clientAddress, topic3 keccak(tag1).
			if (log.topics.length < 3) return null;
			const [feedbackIndex, value, valueDecimals, tag1, tag2, endpoint, feedbackUri, feedbackHash] =
				ABI_CODER.decode(
					['uint64', 'int128', 'uint8', 'string', 'string', 'string', 'string', 'bytes32'],
					log.data,
				);
			return {
				...base,
				type: 'feedback',
				eventName: 'NewFeedback',
				eventClass: 'reputation',
				agentId: BigInt(log.topics[1]).toString(),
				client: addrFromTopic(log.topics[2]),
				feedbackIndex: Number(feedbackIndex),
				// int128 overflows a JS number in theory; store as a decimal string
				// so nothing is rounded on the way into the index.
				value: value.toString(),
				valueDecimals: Number(valueDecimals),
				tag1: tag1 || null,
				tag2: tag2 || null,
				endpoint: endpoint || null,
				feedbackUri: feedbackUri || null,
				feedbackHash: feedbackHash === ZERO_HASH ? null : feedbackHash,
			};
		}

		case TOPIC_FEEDBACK_REVOKED: {
			// topic1 agentId, topic2 clientAddress, topic3 feedbackIndex.
			if (log.topics.length < 4) return null;
			return {
				...base,
				type: 'feedback_revoked',
				eventName: 'FeedbackRevoked',
				eventClass: 'reputation',
				agentId: BigInt(log.topics[1]).toString(),
				client: addrFromTopic(log.topics[2]),
				feedbackIndex: Number(BigInt(log.topics[3])),
			};
		}

		case TOPIC_RESPONSE_APPENDED: {
			// topic1 agentId, topic2 clientAddress, topic3 responder.
			if (log.topics.length < 4) return null;
			const [feedbackIndex, responseUri, responseHash] = ABI_CODER.decode(
				['uint64', 'string', 'bytes32'],
				log.data,
			);
			return {
				...base,
				type: 'feedback_response',
				eventName: 'ResponseAppended',
				eventClass: 'reputation',
				agentId: BigInt(log.topics[1]).toString(),
				client: addrFromTopic(log.topics[2]),
				responder: addrFromTopic(log.topics[3]),
				feedbackIndex: Number(feedbackIndex),
				responseUri: responseUri || null,
				responseHash: responseHash === ZERO_HASH ? null : responseHash,
			};
		}

		default:
			return null;
	}
}
