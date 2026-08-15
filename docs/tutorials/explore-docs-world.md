# Tutorial: explore the docs as a 3D world

Time: about 5 minutes. You need a browser and nothing else. By the end you will have walked the documentation, read a page inside the scene, and entered the world wearing a custom avatar.

## 1. Enter the world

Open [three.ws/docs/world](https://three.ws/docs/world).

![The spawn plaza, with the ring of section pavilions around it.](figure:page:/docs/world?settle=9000)

You spawn in a plaza. Around you is a ring of fourteen glowing pavilions, one per section of the [classic docs](/docs) sidebar: Start here, Creation studios, Trading & markets, SDK / API reference, and so on. The label above each pavilion tells you its section and how many pages it holds.

If your device cannot run WebGL you will see a notice with a button to the classic docs instead. Nothing is lost either way; both surfaces render the same markdown files.

## 2. Walk to a pavilion

- **Desktop:** WASD or arrow keys to walk, hold Shift to run, drag the mouse to look around, scroll to zoom.
- **Phone or tablet:** a joystick appears when you touch the lower-left of the screen; drag anywhere else to look.

Walk toward any pavilion. When you are close, a pulsing prompt appears at the bottom of the screen:

```text
[E] Enter Start here
```

Press E (or tap the prompt, or tap the pavilion itself). A panel opens listing every page in that section.

## 3. Read a page in-world

Pick a page from the panel. The reader slides in with the live document, the same `/docs/<page>.md` file the classic docs serve. Links to other docs open inside the reader, and Previous / Next at the bottom walk the whole documentation in sidebar order.

Two escape hatches sit in the reader header:

- **Open in classic docs ↗** jumps to the same page at `/docs/<page>`.
- **✕** (or Esc) drops you back into the world where you were standing.

Notice the URL while you read: it becomes `/docs/world#<page>`. That link is shareable; anyone who opens it spawns at the right pavilion with the page already open. Try it:

```text
https://three.ws/docs/world#forge
```

## 4. Use the index instead of walking

The **☰ Index** chip (top left) lists all fourteen sections. Picking one teleports you to its pavilion and opens its page list. This is also a fully keyboard-accessible path through the world: Tab to the chip, Enter, arrow through the list.

## 5. Search when you already know the page

Walking is the point of this surface, but hunting fourteen pavilions for a page you can already name is not. Press `/` (or Ctrl+K, Cmd+K on a Mac) anywhere in the world and a search palette opens over the scene, ranking every documented page. Typos are tolerated: the palette uses the same fuzzy scorer as the rest of the platform, so `marketpalce` still finds the marketplace page.

Each result offers two actions:

- **Enter** reads the page now, and stands your avatar at its pavilion so closing the reader leaves you where that page lives.
- **Shift+Enter** has the world walk you there, routing around the other pavilions and opening the page on arrival.

Pages you opened recently are listed first when the box is empty.

## 6. Change the camera

Press C (or the camera chip, top right) to cycle the four platform camera modes: Follow, Cinematic, First Person, Top Down. These are the same modes `/walk` and `/play` use, and your choice is remembered.

## 7. Bring your own avatar

By default you walk as the base mannequin. Any rigged humanoid GLB can replace it via the `avatar` query parameter:

```text
https://three.ws/docs/world?avatar=https://three.ws/avatars/michelle.glb
```

Make one with the [Forge](/create) or the [Avatar Studio](/avatar-studio), copy its GLB URL, and hand it to the world. Bone names are mapped automatically (Mixamo, Avaturn, VRM, and friends), exactly as described in [Animations](/docs/animations).

## Where to next

- [Docs World reference](../docs-world.md): controls table, device behaviour, contributor notes.
- [What is three.ws?](../start-here.md): the guided tour of the whole platform, readable in either surface.
- Add a page to the docs yourself: edit `docs/nav.json` and drop a markdown file in `docs/`; it appears in the sidebar and as a page in its pavilion with no extra wiring.
