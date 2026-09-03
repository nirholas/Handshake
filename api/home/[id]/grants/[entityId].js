// DELETE /api/home/:id/grants/:entityId: withdraw one standing allowance.
//
// The path form of the DELETE on ../grants.js, which is where the whole
// implementation lives: one handler, two ways in, so a REST client that models
// a grant as a resource and a form that posts an entity id cannot drift apart.
// Withdrawal is the half of a permission system that has to be trivially
// reachable, so it gets both spellings rather than the tidier one.

export { default } from '../grants.js';
