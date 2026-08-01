// okx-chat-bot: structured, single-line JSON logging.
//
// Cloud Run parses one JSON object per line into structured log fields, which is
// what makes `gcloud logging read ... textPayload:"<term>"` and the gcp-triage
// signature sweep work on this service like every other one in the fleet.
//
// Never log credential material: the wallet keyring, the OTP login URL's
// tempPubKey, and any AI-provider key stay out of every record here.

function emit(level, msg, meta) {
	const rec = { t: new Date().toISOString(), level, worker: 'okx-chat-bot', msg, ...(meta || {}) };
	const line = JSON.stringify(rec);
	if (level === 'error' || level === 'warn') console.error(line);
	else console.log(line);
}

export const log = {
	info: (msg, meta) => emit('info', msg, meta),
	warn: (msg, meta) => emit('warn', msg, meta),
	error: (msg, meta) => emit('error', msg, meta),
};
