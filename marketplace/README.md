# marketplace/ — Claude Code plugin marketplace

The plugin marketplace this repo serves to Claude Code users. Adding
`nirholas/three.ws` as a marketplace makes every plugin under
[plugins/](plugins/) installable by name:

```
/plugin marketplace add nirholas/three.ws
/plugin install three-ws-3d@three-ws
```

## Plugins

| Plugin | What it does |
| --- | --- |
| [three-ws-3d](plugins/three-ws-3d/) | Generate textured 3D models and rigged avatars from text or images inside Claude Code — free text→3D lane plus the paid x402 tools (`text_to_avatar`, `mesh_forge`, `rig_mesh`, `forge_avatar`), each returning a GLB URL + three.ws viewer link. Bundles the three.ws MCP server. |
| [three-ws-developer](plugins/three-ws-developer/) | Developer tooling for building ON three.ws: scaffold an agent, configure `@three-ws/mcp-server`, get runnable code for the paid MCP tools. |

Each plugin directory is self-contained: `.claude-plugin/plugin.json`
(manifest), `skills/*/SKILL.md` (the skills it contributes), `commands/`
(slash commands), and its own README with install and usage details.

## Adding a plugin

1. Create `plugins/<name>/` with a `.claude-plugin/plugin.json` manifest and a
   README following the two existing plugins' structure.
2. Skills go in `skills/<skill-name>/SKILL.md`; commands in `commands/*.md`.
3. Anything that calls paid three.ws tools must quote the real USDC price in
   its skill description, the same way `three-ws-3d`'s skills do.

Related surfaces: the MCP server itself lives in [mcp-server/](../mcp-server/),
and the pump.fun skills collection in [pump-fun-skills/](../pump-fun-skills/).
