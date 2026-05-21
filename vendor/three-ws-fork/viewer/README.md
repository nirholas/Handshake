# [three.ws viewer](https://three.ws/) [![GitHub license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/nirholas/three.ws/blob/main/vendor/three-ws-fork/viewer/LICENSE) [![npm version](https://img.shields.io/npm/v/@three-ws/viewer)](https://www.npmjs.com/package/@three-ws/viewer)
The three.ws viewer is a collection of components for showcasing three.ws avatars and 3D on the web!

Built with [`three.js`](https://github.com/mrdoob/three.js), [`react-three-fiber`](https://github.com/pmndrs/react-three-fiber), [`drei`](https://github.com/pmndrs/drei), [`three-stdlib`](https://github.com/pmndrs/three-stdlib) and [`react`](https://github.com/facebook/react/).

# Installation

The three.ws viewer is available as an [npm package](https://www.npmjs.com/package/@three-ws/viewer).
```sh
npm install @three-ws/viewer
```

# Documentation & examples

You can find all **code examples** of the components and their **documentation** on [our GitHub page](https://three.ws/).

Here is the first one to get you started:
```typescript jsx
import React from 'react';
import ReactDOM from 'react-dom';
import { Avatar } from '@three-ws/viewer';

const modelSrc = 'https://three.ws/male.glb';

function App() {
  return (
    <Avatar modelSrc={modelSrc} />
  );
}

ReactDOM.render(<App />, document.querySelector('#app'));
```

### Validation
Props such as `modelSrc`, `animationSrc`, `poseSrc` and `onLoadedAnimation.src` are **validated** before rendering on the scene.
Animation source props support both `.glb` and `.fbx` formats. All other props mentioned before only support `.glb`.

Examples on supported resource formats:
* URL resources
  * relative `/headwear.glb`
  * absolute `https://three.ws/male.glb?queryParams=allowed`
* Base64 strings
  * `data:application/octet-stream;base64`
  * `data:model/gltf-binary;base64`
* Binary input such as `model/gltf-binary`

## License

Visage is [MIT licensed](./LICENSE).
