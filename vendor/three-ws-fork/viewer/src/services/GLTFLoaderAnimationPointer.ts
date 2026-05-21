/* eslint-disable */
// @ts-nocheck

import {
  AnimationClip,
  ColorKeyframeTrack,
  InterpolateDiscrete,
  InterpolateLinear,
  NumberKeyframeTrack,
  PropertyBinding,
  QuaternionKeyframeTrack,
  VectorKeyframeTrack
} from 'three';

// DUPLICATED from GLTFLoader.js
const ANIMATION_TARGET_TYPE = {
  node: 'node',
  material: 'material',
  camera: 'camera',
  light: 'light'
};

const KHR_ANIMATION_POINTER = 'KHR_animation_pointer';

// DUPLICATED from GLTFLoader.js
const INTERPOLATION = {
  CUBICSPLINE: undefined, // We use a custom interpolant (GLTFCubicSplineInterpolation) for CUBICSPLINE tracks. Each
  // keyframe track will be initialized with a default interpolation type, then modified.
  LINEAR: InterpolateLinear,
  STEP: InterpolateDiscrete
};

// HACK monkey patching findNode to ensure we can map to other types required by KHR_animation_pointer.
const find = PropertyBinding.findNode;
const _animationPointerDebug = false;
let _havePatchedPropertyBindings = false;

/**
 * Animation Pointer Extension
 *
 * Draft Specification: https://github.com/ux3d/glTF/tree/extensions/KHR_animation_pointer/extensions/2.0/Khronos/KHR_animation_pointer
 */
class GLTFAnimationPointerExtension {
  constructor(parser) {
    this.parser = parser;
    this.name = KHR_ANIMATION_POINTER;
    this.animationPointerResolver = null;
  }

  setAnimationPointerResolver(animationPointerResolver) {
    this.animationPointerResolver = animationPointerResolver;
    return this;
  }

  _patchPropertyBindingFindNode() {
    if (_havePatchedPropertyBindings) return;
    _havePatchedPropertyBindings = true;

    // "node" is the Animator component in our case
    // "path" is the animated property path, just with translated material names.
    PropertyBinding.findNode = function (node, path) {
      if (path.startsWith('.materials.')) {
        if (_animationPointerDebug) console.log('FIND', path);

        const remainingPath = path.substring('.materials.'.length).substring(path.indexOf('.'));
        const nextIndex = remainingPath.indexOf('.');
        const uuid = nextIndex < 0 ? remainingPath : remainingPath.substring(0, nextIndex);

        let res = null;
        node.traverse((x) => {
          // NOTE: Changed x.type to x.isMesh for better competability
          if (res !== null || !x.isMesh) return;
          if (x.material && (x.material.uuid === uuid || x.material.name === uuid)) {
            res = x.material;
            if (_animationPointerDebug) console.log(res, remainingPath);
            if (res !== null) {
              if (remainingPath.endsWith('.map')) res = res.map;
              else if (remainingPath.endsWith('.emissiveMap')) res = res.emissiveMap;

              // TODO other texture slots only make sense if three.js actually supports them
              // (currently only .map can have repeat/offset)
            }
          }
        });

        return res;
      }
      if (path.startsWith('.nodes.') || path.startsWith('.lights.') || path.startsWith('.cameras.')) {
        const sections = path.split('.');
        let currentTarget;
        for (let i = 1; i < sections.length; i++) {
          const val = sections[i];
          const isUUID = val.length == 36;
          if (isUUID) {
            // access by UUID
            currentTarget = node.getObjectByProperty('uuid', val);
          } else if (currentTarget && currentTarget[val]) {
            // access by index
            const index = Number.parseInt(val);
            let key = val;
            if (index >= 0) key = index;
            currentTarget = currentTarget[key];
            if (_animationPointerDebug) console.log(currentTarget);
          } else {
            // access by node name
            const foundNode = node.getObjectByName(val);
            if (foundNode) currentTarget = foundNode;
          }
        }

        if (!currentTarget) {
          const originalFindResult = find(node, sections[2]);

          if (!originalFindResult)
            console.warn(`${KHR_ANIMATION_POINTER}: Property binding not found`, path, node, node.name, sections);

          return originalFindResult;
        }

        if (_animationPointerDebug) console.log('NODE', path, currentTarget);

        return currentTarget;
      }

      return find(node, path);
    };
  }

  /* DUPLICATE of functionality in GLTFLoader */
  loadAnimationTargetFromChannel(animationChannel) {
    const { target } = animationChannel;
    const name = target.node !== undefined ? target.node : target.id; // NOTE: target.id is deprecated.
    return this.parser.getDependency('node', name);
  }

  loadAnimationTargetFromChannelWithAnimationPointer(animationChannel) {
    if (!this._havePatchedPropertyBindings) this._patchPropertyBindingFindNode();

    const { target } = animationChannel;
    const useExtension =
      target.extensions && target.extensions[KHR_ANIMATION_POINTER] && target.path && target.path === 'pointer';
    if (!useExtension) return null;

    let targetProperty;

    // check if this is a extension animation
    let type = ANIMATION_TARGET_TYPE.node;
    let targetId;

    if (useExtension) {
      const ext = target.extensions[KHR_ANIMATION_POINTER];
      let path = ext.pointer;
      if (_animationPointerDebug) console.log(`Original path: ${path}`, target);

      if (!path) {
        console.warn('Invalid path', ext, target);
        return;
      }

      if (path.startsWith('/materials/')) type = ANIMATION_TARGET_TYPE.material;
      else if (path.startsWith('/extensions/KHR_lights_punctual/lights/')) type = ANIMATION_TARGET_TYPE.light;
      else if (path.startsWith('/cameras/')) type = ANIMATION_TARGET_TYPE.camera;

      targetId = this._tryResolveTargetId(path, type);
      if (targetId === null || isNaN(targetId)) {
        console.warn(`Failed resolving animation node id: ${targetId}`, path);
        return;
      }

      if (_animationPointerDebug) console.log(`Resolved node ID for ${type}`, targetId);

      // TODO could be parsed better
      switch (type) {
        case ANIMATION_TARGET_TYPE.material:
          const pathIndex = `/materials/${targetId.toString()}/`.length;
          const pathStart = path.substring(0, pathIndex);
          targetProperty = path.substring(pathIndex);

          switch (targetProperty) {
            // Core Spec PBR Properties
            case 'pbrMetallicRoughness/baseColorFactor':
              targetProperty = 'color';
              break;
            case 'pbrMetallicRoughness/roughnessFactor':
              targetProperty = 'roughness';
              break;
            case 'pbrMetallicRoughness/metallicFactor':
              targetProperty = 'metalness';
              break;
            case 'emissiveFactor':
              targetProperty = 'emissive';
              break;
            case 'alphaCutoff':
              targetProperty = 'alphaTest';
              break;
            case 'occlusionTexture/strength':
              targetProperty = 'aoMapIntensity';
              break;
            case 'normalTexture/scale':
              targetProperty = 'normalScale';
              break;

            // Core Spec + KHR_texture_transform
            case 'pbrMetallicRoughness/baseColorTexture/extensions/KHR_texture_transform/scale':
              targetProperty = 'map/repeat';
              break;
            case 'pbrMetallicRoughness/baseColorTexture/extensions/KHR_texture_transform/offset':
              targetProperty = 'map/offset';
              break;

            // UV transforms for anything but map doesn't seem to currently be supported in three.js
            case 'emissiveTexture/extensions/KHR_texture_transform/scale':
              targetProperty = 'emissiveMap/repeat';
              break;
            case 'emissiveTexture/extensions/KHR_texture_transform/offset':
              targetProperty = 'emissiveMap/offset';
              break;

            // KHR_materials_emissive_strength
            case 'extensions/KHR_materials_emissive_strength/emissiveStrength':
              targetProperty = 'emissiveIntensity';
              break;

            // KHR_materials_transmission
            case 'extensions/KHR_materials_transmission/transmissionFactor':
              targetProperty = 'transmission';
              break;

            // KHR_materials_ior
            case 'extensions/KHR_materials_ior/ior':
              targetProperty = 'ior';
              break;

            // KHR_materials_volume
            case 'extensions/KHR_materials_volume/thicknessFactor':
              targetProperty = 'thickness';
              break;
            case 'extensions/KHR_materials_volume/attenuationColor':
              targetProperty = 'attenuationColor';
              break;
            case 'extensions/KHR_materials_volume/attenuationDistance':
              targetProperty = 'attenuationDistance';
              break;

            // KHR_materials_iridescence
            case 'extensions/KHR_materials_iridescence/iridescenceFactor':
              targetProperty = 'iridescence';
              break;
            case 'extensions/KHR_materials_iridescence/iridescenceIor':
              targetProperty = 'iridescenceIOR';
              break;
            case 'extensions/KHR_materials_iridescence/iridescenceThicknessMinimum':
              targetProperty = 'iridescenceThicknessRange[0]';
              break;
            case 'extensions/KHR_materials_iridescence/iridescenceThicknessMaximum':
              targetProperty = 'iridescenceThicknessRange[1]';
              break;

            // KHR_materials_clearcoat
            case 'extensions/KHR_materials_clearcoat/clearcoatFactor':
              targetProperty = 'clearcoat';
              break;
            case 'extensions/KHR_materials_clearcoat/clearcoatRoughnessFactor':
              targetProperty = 'clearcoatRoughness';
              break;

            // KHR_materials_sheen
            case 'extensions/KHR_materials_sheen/sheenColorFactor':
              targetProperty = 'sheenColor';
              break;
            case 'extensions/KHR_materials_sheen/sheenRoughnessFactor':
              targetProperty = 'sheenRoughness';
              break;

            // KHR_materials_specular
            case 'extensions/KHR_materials_specular/specularFactor':
              targetProperty = 'specularIntensity';
              break;
            case 'extensions/KHR_materials_specular/specularColorFactor':
              targetProperty = 'specularColor';
              break;
          }

          path = pathStart + targetProperty;
          if (_animationPointerDebug) console.log('PROPERTY PATH', pathStart, targetProperty, path);
          break;

        case ANIMATION_TARGET_TYPE.node:
          const pathIndexNode = `/nodes/${targetId.toString()}/`.length;
          const pathStartNode = path.substring(0, pathIndexNode);
          targetProperty = path.substring(pathIndexNode);

          switch (targetProperty) {
            case 'translation':
              targetProperty = 'position';
              break;
            case 'rotation':
              targetProperty = 'quaternion';
              break;
            case 'scale':
              targetProperty = 'scale';
              break;
            case 'weights':
              targetProperty = 'morphTargetInfluences';
              break;
          }

          path = pathStartNode + targetProperty;
          break;

        case ANIMATION_TARGET_TYPE.light:
          const pathIndexLight = `/extensions/KHR_lights_punctual/lights/${targetId.toString()}/`.length;
          targetProperty = path.substring(pathIndexLight);

          switch (targetProperty) {
            case 'color':
              break;
            case 'intensity':
              break;
            case 'spot/innerConeAngle':
              // TODO would need to set .penumbra, but requires calculations on every animation change (?)
              targetProperty = 'penumbra';
              break;
            case 'spot/outerConeAngle':
              targetProperty = 'angle';
              break;
            case 'range':
              targetProperty = 'distance';
              break;
          }

          path = `/lights/${targetId.toString()}/${targetProperty}`;
          break;

        case ANIMATION_TARGET_TYPE.camera:
          const pathIndexCamera = `/cameras/${targetId.toString()}/`.length;
          const pathStartCamera = path.substring(0, pathIndexCamera);
          targetProperty = path.substring(pathIndexCamera);

          switch (targetProperty) {
            case 'perspective/yfov':
              targetProperty = 'fov';
              break;
            case 'perspective/znear':
            case 'orthographic/znear':
              targetProperty = 'near';
              break;
            case 'perspective/zfar':
            case 'orthographic/zfar':
              targetProperty = 'far';
              break;
            case 'perspective/aspect':
              targetProperty = 'aspect';
              break;
            // these two write to the same target property since three.js orthographic camera only supports 'zoom'.
            // TODO should there be a warning for either of them? E.g. a warning for "xmag" so that "yfov" + "ymag" work by default?
            case 'orthographic/xmag':
              targetProperty = 'zoom';
              break;
            case 'orthographic/ymag':
              targetProperty = 'zoom';
              break;
          }

          path = pathStartCamera + targetProperty;
          break;
      }

      const pointerResolver = this.animationPointerResolver;
      if (pointerResolver && pointerResolver.resolvePath) {
        path = pointerResolver.resolvePath(path);
      }

      target.extensions[KHR_ANIMATION_POINTER].pointer = path;
    }

    if (targetId === null || isNaN(targetId)) {
      console.warn(`Failed resolving animation node id: ${targetId}`, target);
      return;
    }

    let depPromise;

    if (type === ANIMATION_TARGET_TYPE.node) depPromise = this.parser.getDependency('node', targetId);
    else if (type === ANIMATION_TARGET_TYPE.material) depPromise = this.parser.getDependency('material', targetId);
    else if (type === ANIMATION_TARGET_TYPE.light) depPromise = this.parser.getDependency('light', targetId);
    else if (type === ANIMATION_TARGET_TYPE.camera) depPromise = this.parser.getDependency('camera', targetId);
    else console.error('Unhandled type', type);

    return depPromise;
  }

  createAnimationTracksWithAnimationPointer(node, inputAccessor, outputAccessor, sampler, target) {
    const useExtension =
      target.extensions && target.extensions[KHR_ANIMATION_POINTER] && target.path && target.path === 'pointer';
    if (!useExtension) return null;

    let animationPointerPropertyPath = target.extensions[KHR_ANIMATION_POINTER].pointer;
    if (!animationPointerPropertyPath) return null;

    const tracks = [];

    animationPointerPropertyPath = animationPointerPropertyPath.replaceAll('/', '.');
    // replace node/material/camera/light ID by UUID
    const parts = animationPointerPropertyPath.split('.');
    parts[2] = node.name !== undefined && node.name !== null ? node.name : node.uuid;
    animationPointerPropertyPath = parts.join('.');
    if (_animationPointerDebug) console.log(node, inputAccessor, outputAccessor, target, animationPointerPropertyPath);

    let TypedKeyframeTrack;

    switch (outputAccessor.itemSize) {
      case 1:
        TypedKeyframeTrack = NumberKeyframeTrack;
        break;
      case 2:
      case 3:
        TypedKeyframeTrack = VectorKeyframeTrack;
        break;
      case 4:
        if (animationPointerPropertyPath.endsWith('.quaternion')) TypedKeyframeTrack = QuaternionKeyframeTrack;
        else TypedKeyframeTrack = ColorKeyframeTrack;

        break;
    }

    const interpolation =
      sampler.interpolation !== undefined ? INTERPOLATION[sampler.interpolation] : InterpolateLinear;

    let outputArray = this.parser._getArrayFromAccessor(outputAccessor);

    // convert fov values from radians to degrees
    if (animationPointerPropertyPath.endsWith('.fov')) {
      outputArray = outputArray.map((value) => (value / Math.PI) * 180);
    }

    const track = new TypedKeyframeTrack(animationPointerPropertyPath, inputAccessor.array, outputArray, interpolation);

    // Override interpolation with custom factory method.
    if (interpolation === 'CUBICSPLINE') {
      this.parser._createCubicSplineTrackInterpolant(track);
    }

    tracks.push(track);

    // glTF has opacity animation as last component of baseColorFactor,
    // so we need to split that up here and create a separate opacity track if that is animated.
    if (
      animationPointerPropertyPath &&
      outputAccessor.itemSize === 4 &&
      animationPointerPropertyPath.startsWith('.materials.') &&
      animationPointerPropertyPath.endsWith('.color')
    ) {
      const opacityArray = new Float32Array(outputArray.length / 4);

      for (let j = 0, jl = outputArray.length / 4; j < jl; j += 1) {
        opacityArray[j] = outputArray[j * 4 + 3];
      }

      const opacityTrack = new TypedKeyframeTrack(
        animationPointerPropertyPath.replace('.color', '.opacity'),
        inputAccessor.array,
        opacityArray,
        interpolation
      );

      // Override interpolation with custom factory method.
      if (interpolation === 'CUBICSPLINE') {
        this.parser._createCubicSplineTrackInterpolant(track);
      }

      tracks.push(opacityTrack);
    }

    return tracks;
  }

  _tryResolveTargetId(path, type) {
    let name = '';
    if (type === 'node') {
      name = path.substring('/nodes/'.length);
    } else if (type === 'material') {
      name = path.substring('/materials/'.length);
    } else if (type === 'light') {
      name = path.substring('/extensions/KHR_lights_punctual/lights/'.length);
    } else if (type === 'camera') {
      name = path.substring('/cameras/'.length);
    }

    name = name.substring(0, name.indexOf('/'));
    const index = Number.parseInt(name);
    return index;
  }

  /* MOSTLY DUPLICATE of GLTFLoader.loadAnimation, but also tries to resolve KHR_animation_pointer. */
  /**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#animations
   * @param {number} animationIndex
   * @return {Promise<AnimationClip>}
   */
  loadAnimation(animationIndex) {
    const me = this;
    const { json } = this.parser;
    const { parser } = this;

    const animationDef = json.animations[animationIndex];
    const animationName = animationDef.name ? animationDef.name : `animation_${animationIndex}`;

    const pendingNodes = [];
    const pendingInputAccessors = [];
    const pendingOutputAccessors = [];
    const pendingSamplers = [];
    const pendingTargets = [];

    for (let i = 0, il = animationDef.channels.length; i < il; i++) {
      const channel = animationDef.channels[i];
      const sampler = animationDef.samplers[channel.sampler];
      const { target } = channel;
      const input = animationDef.parameters !== undefined ? animationDef.parameters[sampler.input] : sampler.input;
      const output = animationDef.parameters !== undefined ? animationDef.parameters[sampler.output] : sampler.output;

      let nodeDependency = me.loadAnimationTargetFromChannelWithAnimationPointer(channel);
      if (!nodeDependency) nodeDependency = me.loadAnimationTargetFromChannel(channel);

      pendingNodes.push(nodeDependency);
      pendingInputAccessors.push(parser.getDependency('accessor', input));
      pendingOutputAccessors.push(parser.getDependency('accessor', output));
      pendingSamplers.push(sampler);
      pendingTargets.push(target);
    }

    return Promise.all([
      Promise.all(pendingNodes),
      Promise.all(pendingInputAccessors),
      Promise.all(pendingOutputAccessors),
      Promise.all(pendingSamplers),
      Promise.all(pendingTargets)
    ]).then((dependencies) => {
      const nodes = dependencies[0];
      const inputAccessors = dependencies[1];
      const outputAccessors = dependencies[2];
      const samplers = dependencies[3];
      const targets = dependencies[4];

      const tracks = [];

      for (let i = 0, il = nodes.length; i < il; i++) {
        const node = nodes[i];
        const inputAccessor = inputAccessors[i];
        const outputAccessor = outputAccessors[i];
        const sampler = samplers[i];
        const target = targets[i];

        if (node === undefined) continue;

        if (node.updateMatrix) {
          node.updateMatrix();
          node.matrixAutoUpdate = true;
        }

        let createdTracks = me.createAnimationTracksWithAnimationPointer(
          node,
          inputAccessor,
          outputAccessor,
          sampler,
          target
        );
        if (!createdTracks)
          createdTracks = parser._createAnimationTracks(node, inputAccessor, outputAccessor, sampler, target);

        if (createdTracks) {
          for (let k = 0; k < createdTracks.length; k++) {
            tracks.push(createdTracks[k]);
          }
        }
      }

      return new AnimationClip(animationName, undefined, tracks);
    });
  }
}

export { GLTFAnimationPointerExtension };
