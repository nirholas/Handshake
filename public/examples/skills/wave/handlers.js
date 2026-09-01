// wave: starter skill. Composes two built-in runtime tools into one new tool:
// the `wave` gesture (src/runtime/tools.js) and `ctx.speak` TTS. Use this as
// the template for your own skills: same four-file layout as the siblings.

export async function waveAndGreet(args, ctx) {
	await ctx.call('wave', {});
	const greeting = args?.greeting ?? ctx?.skillConfig?.greeting ?? 'Hey there!';
	await ctx.speak(greeting);
	return { ok: true, data: { waved: true, greeting } };
}
