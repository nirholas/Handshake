/*
 * @three-ws/companion - give a person's notifications a body.
 *
 * Three things live here, and they compose:
 *
 *   1. `createCompanionClient()` talks to the hosted companion: push a message
 *      in, listen for triaged deliveries out (SSE, reconnecting).
 *   2. `scoreByRules()` / `decide()` make the same interrupt-or-not judgement
 *      the server makes, locally, with no key and no network. That is what lets
 *      a machine triage its own mail and send only the one line worth hearing.
 *   3. `createCompanionStage()` puts a 3D body on a page and has it say the
 *      line out loud, in the sender's own avatar when they have one.
 *
 * Quick start (Node or browser):
 *
 *   import { createCompanionClient } from '@three-ws/companion';
 *   const companion = createCompanionClient({ token: process.env.COMPANION_TOKEN });
 *   await companion.send({ title: 'Deploy finished', sender: 'CI', priority: 'high' });
 *
 * Quick start (a page that should show it):
 *
 *   import { createCompanionClient, createCompanionStage } from '@three-ws/companion';
 *   createCompanionStage({ client: createCompanionClient({ token }) }).listen();
 *
 * The token comes from https://three.ws/companion. It is per person, it can be
 * rotated there at any time, and it is the only credential any of this needs.
 */

export { createCompanionClient, CompanionError, readSse } from './client.js';
export { createCompanionStage, holdMsFor } from './stage.js';
export {
	scoreByRules,
	defaultLine,
	decide,
	inQuietHours,
	shorten,
	minutesUntil,
	clampScore,
	LANE_BASELINE,
	DEFAULT_BASELINE,
} from './triage-rules.js';

export const VERSION = '0.1.0';
