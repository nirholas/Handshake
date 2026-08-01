// Stand-in for the real `jsonSchemaFromZod` the Granite tools import. The
// reader never runs it: it recognizes the call by name and reads the zod shape
// that was passed in.

export function jsonSchemaFromZod(shape) {
	return shape;
}
