# Contributing to three.ws

Thanks for your interest in contributing! This guide covers everything you need to get started.

---

## Quick Start

```bash
git clone https://github.com/nirholas/three.ws.git
cd three.ws
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and verify the default model loads.

---

## How to Contribute

### Report a Bug

1. Check [existing issues](https://github.com/nirholas/three.ws/issues) to avoid duplicates
2. Open a [new issue](https://github.com/nirholas/three.ws/issues/new) with:
    - Browser and OS
    - Steps to reproduce
    - Expected vs. actual behavior
    - Console errors (if any)
    - The model file (if possible) or a link to a public glTF sample that triggers the issue

### Suggest a Feature

Open an issue with the **Feature Request** label. Describe:

- The use case (what problem does it solve?)
- Proposed behavior
- Any UI mockups or examples from other tools

### Submit a Pull Request

1. Fork the repository
2. Create a feature branch from `main`:
    ```bash
    git checkout -b feat/my-feature
    ```
3. Make your changes
4. Format your code:
    ```bash
    npx prettier --write .
    ```
5. Test locally with `npm run dev`
6. Commit with a clear message:
    ```bash
    git commit -m "feat: add opacity slider to display controls"
    ```
7. Push and open a PR against `main`

---

## Commit Messages

Use clear, descriptive commit messages. Conventional format is preferred:

| Prefix      | Use                                |
| ----------- | ---------------------------------- |
| `feat:`     | New feature                        |
| `fix:`      | Bug fix                            |
| `docs:`     | Documentation only                 |
| `style:`    | Formatting, no logic change        |
| `refactor:` | Code restructuring                 |
| `perf:`     | Performance improvement            |
| `chore:`    | Build, tooling, dependency updates |

---

## Code Guidelines

- **Formatting:** Run `npx prettier --write .` before committing
- **No new dependencies** without discussion — keep the bundle small
- **Browser compatibility:** Must work in Chrome, Firefox, and Edge. Safari support is best-effort
- **No server-side code** — the app must remain 100% client-side
- **Dispose resources** — any new Three.js objects (geometries, materials, textures) must be disposed in `Viewer.clear()`
- **Blob URL cleanup** — any `URL.createObjectURL()` must have a corresponding `URL.revokeObjectURL()`

---

## Project Structure

```
src/
├── app.js           # App controller (touch this for new URL params or dropzone changes)
├── viewer.js        # 3D renderer (touch this for scene, GUI, or display changes)
├── validator.js     # glTF validation (touch this for validation pipeline changes)
├── environments.js  # Environment map list (touch this to add HDR maps)
└── components/      # vhtml JSX components (string-based, no virtual DOM)
```

See [docs/architecture.md](docs/architecture.md) for a deep dive.

---

## Testing Your Changes

### Manual Testing Checklist

Before submitting a PR, verify:

- [ ] Default model (`cz.glb`) loads on page open
- [ ] Drag-and-drop works with a `.glb` file
- [ ] Drag-and-drop works with a multi-file `.gltf` (separate `.bin` + textures)
- [ ] URL loading works: `http://localhost:3000/#model=<url>`
- [ ] All GUI controls respond (display, lighting, animation if applicable)
- [ ] Validation toggle appears and clicking it opens a report
- [ ] Responsive layout works on a narrow viewport (≤ 700 px)
- [ ] No console errors after loading a model
- [ ] `window.VIEWER` debugging API still works

### Test Models

Use the [Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets):

| Model          | Tests                              |
| -------------- | ---------------------------------- |
| Damaged Helmet | PBR materials, environment mapping |
| Fox            | Skinned mesh, animation            |
| Flight Helmet  | Multi-texture, display controls    |
| Box            | Minimal model, basic rendering     |
| Animated Cube  | Animation playback                 |

---

## Areas for Contribution

Looking for something to work on? Here are areas that welcome contributions:

- **Bug fixes** — check the [issues page](https://github.com/nirholas/three.ws/issues)
- **New environment maps** — add more HDR options
- **Accessibility** — improve keyboard navigation and screen reader support
- **Performance** — reduce re-renders, optimize disposal, add lazy loading
- **Safari fixes** — improve drag-and-drop compatibility
- **Documentation** — improve guides, add tutorials, fix typos

---

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
