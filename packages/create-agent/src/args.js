/**
 * Command line surface for `npm create @three-ws/agent`.
 *
 * Split out of the executable so the parser can be tested directly: importing
 * the bin would run the whole generation.
 */

export const USAGE = `npm create @three-ws/agent "<what to make>" [options]

  "<what to make>"     describe a single full-body character
  --photo <url>        build from a public https reference image instead
  --out <dir>          where to write the project (default: a slug of the prompt)
  --name <name>        display name (default: derived from the description)
  --object             make an object or prop instead of a rigged character
  --no-download        skip writing agent.glb locally (keep the hosted URL only)
  --json               print the result as JSON and nothing else
  --origin <url>       API origin (default https://three.ws)
  -h, --help           this message

Examples
  npm create @three-ws/agent "a friendly cartoon astronaut in a glossy white suit"
  npm create @three-ws/agent "a knight in worn steel armor" --out ./knight
  npm create @three-ws/agent --photo https://example.com/me.jpg --name "Me"
  npm create @three-ws/agent "a small ceramic frog figurine" --object
`;

export function parseArgs(argv) {
	const opts = { rig: true, download: true };
	const words = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--photo' || arg === '--image') opts.imageUrl = argv[++i];
		else if (arg === '--out' || arg === '-o') opts.out = argv[++i];
		else if (arg === '--name') opts.name = argv[++i];
		else if (arg === '--object' || arg === '--prop') opts.rig = false;
		else if (arg === '--no-download') opts.download = false;
		else if (arg === '--json') opts.json = true;
		else if (arg === '--origin') opts.origin = argv[++i];
		else if (arg === '-h' || arg === '--help') opts.help = true;
		else if (arg.startsWith('-')) opts.unknown = arg;
		else words.push(arg);
	}
	if (words.length) opts.prompt = words.join(' ');
	return opts;
}
