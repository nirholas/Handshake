# Most Popular 3D GitHub Repositories

> Live snapshot pulled from the GitHub Search API on **2026-05-30**. Star counts are in thousands (k) and drift over time — re-run the methodology below to refresh.

## How this list was built

A sweep of 22 3D-related GitHub topics and keyword queries (`3d`, `threejs`, `webgl`, `webgpu`, `computer-graphics`, `rendering`, `raytracing`, `gaussian-splatting`, `nerf`, `point-cloud`, `3d-reconstruction`, `3d-printing`, `gltf`, `opengl`, `vulkan`, `mesh`, and more), 2 pages each. That yielded **3,284 unique repositories**, which were deduped and ranked by stars. A 3D-signal filter plus a hand-curated denylist removed false positives that ride in on broad topics — console emulators, 2D-only engines, ML-inference libraries that merely use WebGL, video tools, VPN/"service mesh" projects, and the like — leaving **~2,780 genuine 3D repos**. The top 200 are listed below.

> Note: classification is inherently fuzzy at the margins. A few entries (e.g. `raylib`, `libgdx`, `MonoGame`) are general game frameworks with strong 3D support; learning resources and "awesome-*" lists are included because they are central to the 3D ecosystem.

## Quick read for three.ws

- **three.js (#1, ~113k)** dwarfs everything else in web 3D — it is the foundation this platform is built on.
- The **pmndrs / React ecosystem** dominates the React side: `react-three-fiber` (#5), `drei` (#42), `uikit` (#179). Framework wrappers exist for every stack: `troisjs/trois` + `Tresjs/tres` (Vue), `threlte` (Svelte), `gre/gl-react` (React shaders).
- The fastest-growing cluster is **NeRF + Gaussian Splatting** — `gaussian-splatting` (#10), `instant-ngp` (#16), `nerfstudio` (#33), `supersplat` (#48), `gsplat` (#96), plus generative 3D (`TRELLIS`, `Hunyuan3D`, `stable-dreamfusion`). This is where web-3D capture is heading and worth tracking for the platform roadmap.

## Top categories at a glance

| Category | Notable repos in the top 200 |
| --- | --- |
| Web / JS 3D libraries | three.js, react-three-fiber, Babylon.js, playcanvas, cesium, deck.gl, model-viewer, regl, orillusion, galacean, troisjs, threlte, claygl |
| Native / game engines | godot, raylib, libgdx, GDevelop, cocos, o3de, stride, FlaxEngine, Piccolo, panda3d, urho3d, mach, SpartanEngine, LumixEngine |
| Low-level graphics & GPU | filament, wgpu, bgfx, glfw, Vulkan samples, The-Forge, Silk.NET, vulkano, magnum, DiligentEngine, glad, glew, rust-gpu |
| NeRF / Gaussian Splatting / gen-3D | gaussian-splatting, instant-ngp, nerfstudio, supersplat, gsplat, multinerf, neuralangelo, SuGaR, 4DGaussians, TRELLIS, Hunyuan3D, stable-dreamfusion |
| 3D ML / point clouds / reconstruction | Open3D, PCL, openMVG, openMVS, OpenSfM, mmdetection3d, OpenPCDet, pointnet, kaolin, Pointcept, AliceVision, map-anything |
| Modeling / CAD / content tools | FreeCAD, blender, openscad, meshlab, blockbench, material-maker, cadquery, chili3d, dust3d, armorpaint, f3d, Online3DViewer |
| Mesh / asset pipeline | assimp, meshoptimizer, draco, tinyobjloader, trimesh, cglm, yocto-gl |
| 3D printing | Marlin, OrcaSlicer, Cura, Slic3r |
| Shaders & learning | 3d-game-shaders-for-beginners, tinyrenderer, raytracing.github.io, webgl-fundamentals, glslViewer, SHADERed, lygia, slang |

## Top 200 by stars

| # | Repository | Stars (k) | Language | Description |
| --- | --- | --- | --- | --- |
| 1 | [mrdoob/three.js](https://github.com/mrdoob/three.js) | 112.8 | JavaScript | JavaScript 3D Library. |
| 2 | [godotengine/godot](https://github.com/godotengine/godot) | 111.3 | C++ | Godot Engine – Multi-platform 2D and 3D game engine |
| 3 | [raysan5/raylib](https://github.com/raysan5/raylib) | 33.2 | C | A simple and easy-to-use library to enjoy videogames programming |
| 4 | [FreeCAD/FreeCAD](https://github.com/FreeCAD/FreeCAD) | 31.2 | C++ | Official source code of FreeCAD, a free and opensource multiplatform 3D parametric modeler |
| 5 | [pmndrs/react-three-fiber](https://github.com/pmndrs/react-three-fiber) | 31 | TypeScript | 🇨🇭 A React renderer for Three.js |
| 6 | [BabylonJS/Babylon.js](https://github.com/BabylonJS/Babylon.js) | 25.6 | TypeScript | Babylon.js is a powerful, beautiful, simple, and open game and rendering engine packed int |
| 7 | [libgdx/libgdx](https://github.com/libgdx/libgdx) | 25.1 | Java | Desktop/Android/HTML5/iOS Java game development framework |
| 8 | [ssloy/tinyrenderer](https://github.com/ssloy/tinyrenderer) | 23.6 | C++ | A brief computer graphics / rendering course |
| 9 | [4ian/GDevelop](https://github.com/4ian/GDevelop) | 23.3 | JavaScript | 🎮 Open-source, cross-platform 2D/3D/multiplayer game engine designed for everyone. |
| 10 | [graphdeco-inria/gaussian-splatting](https://github.com/graphdeco-inria/gaussian-splatting) | 22.2 | Python | Original reference implementation of "3D Gaussian Splatting for Real-Time Radiance Field R |
| 11 | [google/filament](https://github.com/google/filament) | 20.1 | C++ | Filament is a real-time physically based rendering engine for Android, iOS, Windows, Linux |
| 12 | [lettier/3d-game-shaders-for-beginners](https://github.com/lettier/3d-game-shaders-for-beginners) | 19.6 | C++ | 🎮 A step-by-step guide to implementing SSAO, depth of field, lighting, normal mapping, and |
| 13 | [blender/blender](https://github.com/blender/blender) | 18.6 | C++ | Official mirror of Blender |
| 14 | [aframevr/aframe](https://github.com/aframevr/aframe) | 17.5 | JavaScript | :a: Web framework for building virtual reality experiences. |
| 15 | [MarlinFirmware/Marlin](https://github.com/MarlinFirmware/Marlin) | 17.4 | C++ | Marlin is a firmware for RepRap 3D printers optimized for both 8 and 32 bit microcontrolle |
| 16 | [NVlabs/instant-ngp](https://github.com/NVlabs/instant-ngp) | 17.4 | Cuda | Instant neural graphics primitives: lightning fast NeRF and more |
| 17 | [gfx-rs/wgpu](https://github.com/gfx-rs/wgpu) | 17.2 | Rust | A cross-platform, safe, pure-Rust graphics API. |
| 18 | [bkaradzic/bgfx](https://github.com/bkaradzic/bgfx) | 17.1 | C | Cross-platform, graphics API agnostic, "Bring Your Own Engine/Framework" style rendering l |
| 19 | [PavelDoGreat/WebGL-Fluid-Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation) | 16.4 | JavaScript | Play with fluids in your browser (works even on mobile) |
| 20 | [playcanvas/engine](https://github.com/playcanvas/engine) | 15.9 | JavaScript | Powerful web graphics runtime built on WebGL, WebGPU, WebXR and glTF |
| 21 | [OpenRCT2/OpenRCT2](https://github.com/OpenRCT2/OpenRCT2) | 15.7 | C++ | An open source re-implementation of RollerCoaster Tycoon 2 🎢 |
| 22 | [CesiumGS/cesium](https://github.com/CesiumGS/cesium) | 15.3 | JavaScript | An open-source JavaScript library for world-class 3D globes and maps :earth_americas: |
| 23 | [glfw/glfw](https://github.com/glfw/glfw) | 15 | C | A multi-platform library for OpenGL, OpenGL ES, Vulkan, window and input |
| 24 | [OrcaSlicer/OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer) | 14.4 | C++ | G-code generator for 3D printers (Bambu, Prusa, Voron, VzBot, RatRig, Creality, etc.) |
| 25 | [visgl/deck.gl](https://github.com/visgl/deck.gl) | 14.2 | TypeScript | WebGL2 powered visualization framework |
| 26 | [MonoGame/MonoGame](https://github.com/MonoGame/MonoGame) | 13.9 | C# | One framework for creating powerful cross-platform games. |
| 27 | [Tencent-Hunyuan/Hunyuan3D-2](https://github.com/Tencent-Hunyuan/Hunyuan3D-2) | 13.9 | Python | High-Resolution 3D Assets Generation with Large Scale Hunyuan3D Diffusion Models. |
| 28 | [isl-org/Open3D](https://github.com/isl-org/Open3D) | 13.6 | C++ | Open3D: A Modern Library for 3D Data Processing |
| 29 | [assimp/assimp](https://github.com/assimp/assimp) | 13 | C++ | The official Open-Asset-Importer-Library Repository. Loads 40+ 3D-file-formats into one un |
| 30 | [microsoft/TRELLIS](https://github.com/microsoft/TRELLIS) | 12.8 | Python | Official repo for paper "Structured 3D Latents for Scalable and Versatile 3D Generation" ( |
| 31 | [alicevision/Meshroom](https://github.com/alicevision/Meshroom) | 12.8 | Python | Node-based Visual Programming Toolbox |
| 32 | [SaschaWillems/Vulkan](https://github.com/SaschaWillems/Vulkan) | 12 | GLSL | C++ examples for the Vulkan graphics API |
| 33 | [nerfstudio-project/nerfstudio](https://github.com/nerfstudio-project/nerfstudio) | 11.6 | Python | A collaboration friendly studio for NeRFs |
| 34 | [fogleman/Craft](https://github.com/fogleman/Craft) | 11 | C | A simple Minecraft clone written in C using modern OpenGL (shaders). |
| 35 | [PointCloudLibrary/pcl](https://github.com/PointCloudLibrary/pcl) | 11 | C++ | Point Cloud Library (PCL) |
| 36 | [bmild/nerf](https://github.com/bmild/nerf) | 10.9 | Jupyter Notebook | Code release for NeRF (Neural Radiance Fields) |
| 37 | [baldurk/renderdoc](https://github.com/baldurk/renderdoc) | 10.7 | C++ | RenderDoc is a stand-alone graphics debugging tool. |
| 38 | [metafizzy/zdog](https://github.com/metafizzy/zdog) | 10.6 | JavaScript | Flat, round, designer-friendly pseudo-3D engine for canvas & SVG |
| 39 | [openframeworks/openFrameworks](https://github.com/openframeworks/openFrameworks) | 10.4 | C++ | openFrameworks is a community-developed cross platform toolkit for creative coding in C++. |
| 40 | [RayTracing/raytracing.github.io](https://github.com/RayTracing/raytracing.github.io) | 10.4 | HTML | Main Web Site (Online Books) |
| 41 | [timzhang642/3D-Machine-Learning](https://github.com/timzhang642/3D-Machine-Learning) | 10.2 | — | A resource repository for 3D machine learning |
| 42 | [pmndrs/drei](https://github.com/pmndrs/drei) | 9.7 | JavaScript | 🥉 useful helpers for react-three-fiber |
| 43 | [cocos/cocos-engine](https://github.com/cocos/cocos-engine) | 9.6 | C++ | Cocos simplifies game creation and distribution with Cocos Creator, a free, open-source, c |
| 44 | [openscad/openscad](https://github.com/openscad/openscad) | 9.5 | C++ | OpenSCAD - The Programmers Solid 3D CAD Modeller   |
| 45 | [o3de/o3de](https://github.com/o3de/o3de) | 9.2 | C++ | Open 3D Engine (O3DE) is an Apache 2.0-licensed multi-platform 3D engine that enables deve |
| 46 | [domlysz/BlenderGIS](https://github.com/domlysz/BlenderGIS) | 9 | Python | Blender addons to make the bridge between Blender and geographic data |
| 47 | [ashawkey/stable-dreamfusion](https://github.com/ashawkey/stable-dreamfusion) | 8.8 | Python | Text-to-3D & Image-to-3D & Mesh Exportation with NeRF + Diffusion. |
| 48 | [playcanvas/supersplat](https://github.com/playcanvas/supersplat) | 8.8 | TypeScript | 3D Gaussian Splat Editor |
| 49 | [MrNeRF/awesome-3D-gaussian-splatting](https://github.com/MrNeRF/awesome-3D-gaussian-splatting) | 8.7 | HTML | Curated list of papers and resources focused on 3D Gaussian Splatting, intended to keep pa |
| 50 | [google/model-viewer](https://github.com/google/model-viewer) | 8.1 | TypeScript | Easily display interactive 3D models on the web and in AR!  |
| 51 | [a1studmuffin/SpaceshipGenerator](https://github.com/a1studmuffin/SpaceshipGenerator) | 7.8 | Python | A Blender script to procedurally generate 3D spaceships |
| 52 | [zeux/meshoptimizer](https://github.com/zeux/meshoptimizer) | 7.7 | C++ | Mesh optimization library that makes meshes smaller and faster to render |
| 53 | [stride3d/stride](https://github.com/stride3d/stride) | 7.6 | C# | Stride (formerly Xenko), a free and open-source cross-platform C# game engine. |
| 54 | [google/draco](https://github.com/google/draco) | 7.3 | C++ | Draco is a library for compressing and decompressing 3D geometric meshes and point clouds. |
| 55 | [veloren/veloren](https://github.com/veloren/veloren) | 7.3 | Rust | [mirror of https://gitlab.com/veloren/veloren] An open world, open source voxel RPG inspir |
| 56 | [turanszkij/WickedEngine](https://github.com/turanszkij/WickedEngine) | 7.1 | C | 3D engine with modern graphics |
| 57 | [adrianhajdin/project_3D_developer_portfolio](https://github.com/adrianhajdin/project_3D_developer_portfolio) | 7.1 | JavaScript | The most impressive websites in the world use 3D graphics and animations to bring their co |
| 58 | [Ultimaker/Cura](https://github.com/Ultimaker/Cura) | 7 | Python | 3D printer / slicing GUI built on top of the Uranium framework |
| 59 | [agmmnn/awesome-blender](https://github.com/agmmnn/awesome-blender) | 6.9 | — | 🪐 A curated list of awesome Blender addons, tools, tutorials; and 3D resources for everyon |
| 60 | [FlaxEngine/FlaxEngine](https://github.com/FlaxEngine/FlaxEngine) | 6.8 | C++ | Flax Engine – multi-platform 3D game engine |
| 61 | [awesome-NeRF/awesome-NeRF](https://github.com/awesome-NeRF/awesome-NeRF) | 6.8 | TeX | A curated list of awesome neural radiance fields papers |
| 62 | [BoomingTech/Piccolo](https://github.com/BoomingTech/Piccolo) | 6.6 | C++ | Piccolo (formerly Pilot) – mini game engine for games104 |
| 63 | [tengbao/vanta](https://github.com/tengbao/vanta) | 6.6 | JavaScript | Animated 3D backgrounds for your website |
| 64 | [open-mmlab/mmdetection3d](https://github.com/open-mmlab/mmdetection3d) | 6.4 | Python | OpenMMLab's next-generation platform for general 3D object detection. |
| 65 | [openMVG/openMVG](https://github.com/openMVG/openMVG) | 6.4 | C++ | open Multiple View Geometry library. Basis for 3D computer vision and Structure from Motio |
| 66 | [HackerPoet/NonEuclidean](https://github.com/HackerPoet/NonEuclidean) | 6.4 | C++ | A Non-Euclidean Rendering Engine for 3D scenes. |
| 67 | [OpenDroneMap/ODM](https://github.com/OpenDroneMap/ODM) | 6.1 | Python | A command line toolkit to generate maps, point clouds, 3D models and DEMs from drone, ball |
| 68 | [vasturiano/3d-force-graph](https://github.com/vasturiano/3d-force-graph) | 6.1 | HTML | 3D force-directed graph component using ThreeJS/WebGL |
| 69 | [AR-js-org/AR.js](https://github.com/AR-js-org/AR.js) | 5.9 | JavaScript | Image tracking, Location Based AR, Marker tracking. All on the Web. |
| 70 | [CGAL/cgal](https://github.com/CGAL/cgal) | 5.9 | C++ | The public CGAL repository, see the README below |
| 71 | [Redot-Engine/redot-engine](https://github.com/Redot-Engine/redot-engine) | 5.9 | C++ | Redot Engine – Multi-platform 2D and 3D game engine |
| 72 | [galacean/engine](https://github.com/galacean/engine) | 5.8 | TypeScript | A typescript interactive engine, support 2D, 3D, animation, physics, built on WebGL and gl |
| 73 | [cnr-isti-vclab/meshlab](https://github.com/cnr-isti-vclab/meshlab) | 5.7 | C++ | The open source mesh processing system |
| 74 | [open-mmlab/OpenPCDet](https://github.com/open-mmlab/OpenPCDet) | 5.6 | Python | OpenPCDet Toolbox for LiDAR-based 3D Object Detection. |
| 75 | [ConfettiFX/The-Forge](https://github.com/ConfettiFX/The-Forge) | 5.6 | C++ | The Forge Cross-Platform Framework PC Windows, Steamdeck (native), Ray Tracing, macOS / iO |
| 76 | [regl-project/regl](https://github.com/regl-project/regl) | 5.5 | JavaScript | 👑 Functional WebGL |
| 77 | [JannisX11/blockbench](https://github.com/JannisX11/blockbench) | 5.5 | JavaScript | Blockbench - A low poly 3D model editor |
| 78 | [RodZill4/material-maker](https://github.com/RodZill4/material-maker) | 5.5 | GDScript | A procedural textures authoring and 3D model painting tool based on the Godot game engine |
| 79 | [charlesq34/pointnet](https://github.com/charlesq34/pointnet) | 5.4 | Python | PointNet: Deep Learning on Point Sets for 3D Classification and Segmentation |
| 80 | [dimforge/rapier](https://github.com/dimforge/rapier) | 5.4 | Rust | 2D and 3D physics engines focused on performance. |
| 81 | [gfx-rs/gfx](https://github.com/gfx-rs/gfx) | 5.4 | Rust | [maintenance mode] A low-overhead Vulkan-like GPU API for Rust. |
| 82 | [gpuweb/gpuweb](https://github.com/gpuweb/gpuweb) | 5.4 | Bikeshed | Where the GPU for the Web work happens! |
| 83 | [LWJGL/lwjgl3](https://github.com/LWJGL/lwjgl3) | 5.3 | Java | LWJGL is a Java library that enables cross-platform access to popular native APIs useful i |
| 84 | [shader-slang/slang](https://github.com/shader-slang/slang) | 5.3 | C++ | Making it easier to work with shaders |
| 85 | [ssloy/tinyraytracer](https://github.com/ssloy/tinyraytracer) | 5.3 | C++ | A brief computer graphics / rendering course |
| 86 | [jagenjo/webglstudio.js](https://github.com/jagenjo/webglstudio.js) | 5.3 | JavaScript | A full open source 3D graphics editor in the browser, with scene editor, coding pad, graph |
| 87 | [shuding/cobe](https://github.com/shuding/cobe) | 5.3 | TypeScript | 5KB WebGL globe lib. |
| 88 | [patriciogonzalezvivo/glslViewer](https://github.com/patriciogonzalezvivo/glslViewer) | 5.3 | C++ | Console-based GLSL Sandbox for 2D/3D shaders |
| 89 | [KhronosGroup/Vulkan-Samples](https://github.com/KhronosGroup/Vulkan-Samples) | 5.3 | C++ | One stop solution for all Vulkan samples |
| 90 | [CadQuery/cadquery](https://github.com/CadQuery/cadquery) | 5.2 | Python | A python parametric CAD scripting framework based on OCCT |
| 91 | [crosire/reshade](https://github.com/crosire/reshade) | 5.2 | C++ | A generic post-processing injector for games and video software. |
| 92 | [Orillusion/orillusion](https://github.com/Orillusion/orillusion) | 5.2 | TypeScript | Orillusion is a pure Web3D rendering engine which is fully developed based on the WebGPU s |
| 93 | [tensorspace-team/tensorspace](https://github.com/tensorspace-team/tensorspace) | 5.2 | JavaScript | Neural network 3D visualization framework, build interactive and intuitive model in browse |
| 94 | [mosra/magnum](https://github.com/mosra/magnum) | 5.2 | C++ | Lightweight and modular C++11 graphics middleware for games and data visualization |
| 95 | [panda3d/panda3d](https://github.com/panda3d/panda3d) | 5.1 | C++ | Powerful, mature open-source cross-platform game engine for Python and C++, developed by D |
| 96 | [nerfstudio-project/gsplat](https://github.com/nerfstudio-project/gsplat) | 5.1 | Python | CUDA accelerated rasterization of gaussian splatting |
| 97 | [ProjectPhysX/FluidX3D](https://github.com/ProjectPhysX/FluidX3D) | 5.1 | C++ | The fastest and most memory efficient lattice Boltzmann CFD software, running on all GPUs  |
| 98 | [NVIDIAGameWorks/kaolin](https://github.com/NVIDIAGameWorks/kaolin) | 5.1 | Python | A PyTorch Library for Accelerating 3D Deep Learning Research |
| 99 | [vulkano-rs/vulkano](https://github.com/vulkano-rs/vulkano) | 5.1 | Rust | Safe and rich Rust wrapper around the Vulkan API |
| 100 | [dotnet/Silk.NET](https://github.com/dotnet/Silk.NET) | 5.1 | C# | The high-speed OpenGL, OpenCL, OpenAL, OpenXR, GLFW, SDL, Vulkan, Assimp, WebGPU, and Dire |
| 101 | [yfeng95/PRNet](https://github.com/yfeng95/PRNet) | 5 | Python | Joint 3D Face Reconstruction and Dense Alignment with Position Map Regression Network (ECC |
| 102 | [gfxfundamentals/webgl-fundamentals](https://github.com/gfxfundamentals/webgl-fundamentals) | 5 | HTML | WebGL lessons that start with the basics |
| 103 | [schteppe/cannon.js](https://github.com/schteppe/cannon.js) | 5 | JavaScript | A lightweight 3D physics engine written in JavaScript. |
| 104 | [yanx27/Pointnet_Pointnet2_pytorch](https://github.com/yanx27/Pointnet_Pointnet2_pytorch) | 4.9 | Python | PointNet and PointNet++ implemented by pytorch (pure python) and on ModelNet, ShapeNet and |
| 105 | [gameplay3d/gameplay](https://github.com/gameplay3d/gameplay) | 4.9 | C++ | Open-source, cross-platform, C++ game engine for creating 2D/3D games. |
| 106 | [dfranx/SHADERed](https://github.com/dfranx/SHADERed) | 4.8 | C++ | Lightweight, cross-platform & full-featured shader IDE |
| 107 | [hexops/mach](https://github.com/hexops/mach) | 4.7 | Zig | zig game engine & graphics toolkit - mirror of https://code.hexops.com/hexops/mach |
| 108 | [urho3d/urho3d](https://github.com/urho3d/urho3d) | 4.7 | C++ | Game engine |
| 109 | [ArthurBrussee/brush](https://github.com/ArthurBrussee/brush) | 4.6 | Rust | 3D Reconstruction for all |
| 110 | [NVlabs/neuralangelo](https://github.com/NVlabs/neuralangelo) | 4.6 | Python | Official implementation of "Neuralangelo: High-Fidelity Neural Surface Reconstruction" (CV |
| 111 | [OGRECave/ogre](https://github.com/OGRECave/ogre) | 4.6 | C++ | high-performance rendering backend (C++, Python, C#, Java) |
| 112 | [xiangechen/chili3d](https://github.com/xiangechen/chili3d) | 4.6 | TypeScript | A browser-based 3D CAD application for online model design and editing |
| 113 | [CloudCompare/CloudCompare](https://github.com/CloudCompare/CloudCompare) | 4.6 | C++ | CloudCompare main repository |
| 114 | [Dav1dde/glad](https://github.com/Dav1dde/glad) | 4.5 | C | Multi-Language Vulkan/GL/GLES/EGL/GLX/WGL Loader-Generator based on the official specs. |
| 115 | [AaronJackson/vrn](https://github.com/AaronJackson/vrn) | 4.5 | MATLAB | :man:  Code for "Large Pose 3D Face Reconstruction from a Single Image via Direct Volumetr |
| 116 | [NVlabs/tiny-cuda-nn](https://github.com/NVlabs/tiny-cuda-nn) | 4.5 | C++ | Lightning fast C++/CUDA neural network framework |
| 117 | [troisjs/trois](https://github.com/troisjs/trois) | 4.5 | TypeScript | ✨ ThreeJS + VueJS 3 + ViteJS ⚡ |
| 118 | [tomlooman/ActionRoguelike](https://github.com/tomlooman/ActionRoguelike) | 4.5 | C++ | Co-op Action Roguelike in Unreal Engine C++ |
| 119 | [f3d-app/f3d](https://github.com/f3d-app/f3d) | 4.4 | C++ | Fast and minimalist 3D viewer. |
| 120 | [openMVG/awesome_3DReconstruction_list](https://github.com/openMVG/awesome_3DReconstruction_list) | 4.4 | — | A curated list of papers & resources linked to 3D reconstruction from images. |
| 121 | [DiligentGraphics/DiligentEngine](https://github.com/DiligentGraphics/DiligentEngine) | 4.3 | Batchfile | A modern cross-platform low-level graphics library and rendering framework |
| 122 | [Yochengliu/awesome-point-cloud-analysis](https://github.com/Yochengliu/awesome-point-cloud-analysis) | 4.2 | — | A list of papers and datasets about point cloud analysis (processing) |
| 123 | [hku-mars/FAST-LIVO2](https://github.com/hku-mars/FAST-LIVO2) | 4.1 | C++ | FAST-LIVO2: Fast, Direct LiDAR-Inertial-Visual Odometry |
| 124 | [antvis/L7](https://github.com/antvis/L7) | 4 | TypeScript | 🌎 Large-scale WebGL-powered Geospatial Data Visualization analysis engine. |
| 125 | [cdcseacave/openMVS](https://github.com/cdcseacave/openMVS) | 4 | C++ | open Multi-View Stereo reconstruction library |
| 126 | [gdquest-demos/godot-shaders](https://github.com/gdquest-demos/godot-shaders) | 4 | GDShader | A large library of free and open-source shaders for the Godot game engine. Here, you'll ge |
| 127 | [WebODM/WebODM](https://github.com/WebODM/WebODM) | 3.9 | Python | User-friendly, commercial-grade software for processing aerial imagery. ✈️ Download it for |
| 128 | [spring/spring](https://github.com/spring/spring) | 3.9 | C++ | A powerful free cross-platform RTS game engine. - Report issues at https://springrts.com/m |
| 129 | [AmbientRun/Ambient](https://github.com/AmbientRun/Ambient) | 3.9 | Rust | The multiplayer game engine |
| 130 | [armory3d/armorpaint](https://github.com/armory3d/armorpaint) | 3.9 | C | 3D Content Creation Tools |
| 131 | [QianMo/Real-Time-Rendering-4th-Bibliography-Collection](https://github.com/QianMo/Real-Time-Rendering-4th-Bibliography-Collection) | 3.8 | HTML | Real-Time Rendering 4th (RTR4) 参考文献合集典藏   Collection of <Real-Time Rendering 4th (RTR4)> B |
| 132 | [nem0/LumixEngine](https://github.com/nem0/LumixEngine) | 3.8 | C++ | 3D C++ Game Engine - yet another open source game engine |
| 133 | [tinyobjloader/tinyobjloader](https://github.com/tinyobjloader/tinyobjloader) | 3.8 | C++ | Tiny but powerful single file wavefront obj loader |
| 134 | [google-research/multinerf](https://github.com/google-research/multinerf) | 3.8 | Python | A Code Release for Mip-NeRF 360, Ref-NeRF, and RawNeRF |
| 135 | [lightningpixel/modly](https://github.com/lightningpixel/modly) | 3.8 | TypeScript | Desktop app to generate 3D models from images using local AI — runs entirely on your GPU |
| 136 | [mapillary/OpenSfM](https://github.com/mapillary/OpenSfM) | 3.8 | Python | Open source Structure-from-Motion pipeline |
| 137 | [IrisShaders/Iris](https://github.com/IrisShaders/Iris) | 3.7 | Java | A modern shaders mod for Minecraft compatible with existing OptiFine shader packs |
| 138 | [KhronosGroup/Vulkan-Hpp](https://github.com/KhronosGroup/Vulkan-Hpp) | 3.7 | C++ | Open-Source Vulkan C++ API |
| 139 | [cleardusk/3DDFA](https://github.com/cleardusk/3DDFA) | 3.7 | Python | The PyTorch improved version of TPAMI 2017 paper: Face Alignment in Full Pose Range: A 3D  |
| 140 | [vinjn/awesome-vulkan](https://github.com/vinjn/awesome-vulkan) | 3.7 | — | Awesome Vulkan ecosystem |
| 141 | [Overv/VulkanTutorial](https://github.com/Overv/VulkanTutorial) | 3.7 | C++ | Tutorial for the Vulkan graphics and compute API |
| 142 | [charlesq34/pointnet2](https://github.com/charlesq34/pointnet2) | 3.7 | Python | PointNet++: Deep Hierarchical Feature Learning on Point Sets in a Metric Space |
| 143 | [keenanwoodall/Deform](https://github.com/keenanwoodall/Deform) | 3.6 | C# | A fully-featured deformer system for Unity that lets you stack effects to animate models i |
| 144 | [hustvl/4DGaussians](https://github.com/hustvl/4DGaussians) | 3.6 | Jupyter Notebook | [CVPR 2024] 4D Gaussian Splatting for Real-Time Dynamic Scene Rendering |
| 145 | [slic3r/Slic3r](https://github.com/slic3r/Slic3r) | 3.6 | C++ | Open Source toolpath generator for 3D printers |
| 146 | [glium/glium](https://github.com/glium/glium) | 3.6 | Rust | Safe OpenGL wrapper for the Rust language. |
| 147 | [openscenegraph/OpenSceneGraph](https://github.com/openscenegraph/OpenSceneGraph) | 3.6 | C++ | OpenSceneGraph git repository |
| 148 | [Tresjs/tres](https://github.com/Tresjs/tres) | 3.6 | Vue | Declarative ThreeJS using Vue Components |
| 149 | [mikedh/trimesh](https://github.com/mikedh/trimesh) | 3.6 | Python | Python library for loading and using triangular meshes. |
| 150 | [ThisisGame/cpp-game-engine-book](https://github.com/ThisisGame/cpp-game-engine-book) | 3.6 | C++ | 从零编写游戏引擎教程 Writing a game engine tutorial from scratch |
| 151 | [vispy/vispy](https://github.com/vispy/vispy) | 3.6 | Python | Main repository for Vispy |
| 152 | [DLR-RM/BlenderProc](https://github.com/DLR-RM/BlenderProc) | 3.6 | Python | A procedural Blender pipeline for photorealistic training image generation |
| 153 | [QianMo/X-PostProcessing-Library](https://github.com/QianMo/X-PostProcessing-Library) | 3.5 | C# | Unity Post Processing Stack Library   Unity引擎的高品质后处理库 |
| 154 | [kovacsv/Online3DViewer](https://github.com/kovacsv/Online3DViewer) | 3.5 | JavaScript | A solution to visualize and explore 3D models in your browser. |
| 155 | [opentk/opentk](https://github.com/opentk/opentk) | 3.5 | C# | The Open Toolkit library is a fast, low-level C# wrapper for OpenGL, OpenAL & OpenCL. It a |
| 156 | [OpenXRay/xray-16](https://github.com/OpenXRay/xray-16) | 3.5 | C++ | Improved version of the X-Ray Engine, the game engine used in the world-famous S.T.A.L.K.E |
| 157 | [Tencent-Hunyuan/Hunyuan3D-2.1](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1) | 3.5 | Python | From Images to High-Fidelity 3D Assets with Production-Ready PBR Material |
| 158 | [Tencent-Hunyuan/Hunyuan3D-1](https://github.com/Tencent-Hunyuan/Hunyuan3D-1) | 3.5 | Python | Tencent Hunyuan3D-1.0: A Unified Framework for Text-to-3D and Image-to-3D Generation |
| 159 | [AtomicGameEngine/AtomicGameEngine](https://github.com/AtomicGameEngine/AtomicGameEngine) | 3.4 | C++ | The Atomic Game Engine is a multi-platform 2D and 3D engine with a consistent API in C++,  |
| 160 | [HamishMW/portfolio](https://github.com/HamishMW/portfolio) | 3.4 | JavaScript | My personal portfolio website built using React and three js |
| 161 | [alicevision/AliceVision](https://github.com/alicevision/AliceVision) | 3.4 | C++ | 3D Computer Vision Framework |
| 162 | [facebookresearch/map-anything](https://github.com/facebookresearch/map-anything) | 3.4 | Python | MapAnything: Universal Feed-Forward Metric 3D Reconstruction |
| 163 | [Anttwo/SuGaR](https://github.com/Anttwo/SuGaR) | 3.4 | C++ | [CVPR 2024] Official PyTorch implementation of SuGaR: Surface-Aligned Gaussian Splatting f |
| 164 | [gkjohnson/three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | 3.4 | JavaScript | A BVH implementation to speed up raycasting and enable spatial queries against three.js me |
| 165 | [fogleman/ln](https://github.com/fogleman/ln) | 3.4 | Go | 3D line art engine. |
| 166 | [GPUOpen-LibrariesAndSDKs/VulkanMemoryAllocator](https://github.com/GPUOpen-LibrariesAndSDKs/VulkanMemoryAllocator) | 3.4 | C | Easy to integrate Vulkan memory allocation library |
| 167 | [patriciogonzalezvivo/lygia](https://github.com/patriciogonzalezvivo/lygia) | 3.3 | GLSL | LYGIA, it's a granular and multi-language (GLSL, HLSL, Metal,  WGSL,  WEGL and CUDA) shade |
| 168 | [luigifreda/pyslam](https://github.com/luigifreda/pyslam) | 3.3 | Python | pySLAM is a hybrid Python/C++ Visual SLAM pipeline supporting monocular, stereo, and RGB-D |
| 169 | [aras-p/UnityGaussianSplatting](https://github.com/aras-p/UnityGaussianSplatting) | 3.3 | C# | Toy Gaussian Splatting visualization in Unity |
| 170 | [hlorus/CAD_Sketcher](https://github.com/hlorus/CAD_Sketcher) | 3.3 | Python | Constraint-based geometry sketcher for blender |
| 171 | [vrm-c/UniVRM](https://github.com/vrm-c/UniVRM) | 3.3 | C# | UniVRM is a gltf-based VRM format implementation for Unity. English is here https://vrm.de |
| 172 | [armory3d/armory](https://github.com/armory3d/armory) | 3.3 | C++ | 3D Engine with Blender Integration |
| 173 | [huxingyi/dust3d](https://github.com/huxingyi/dust3d) | 3.3 | C++ | Dust3D is a cross-platform 3D modeling software that makes it easy to create low poly 3D m |
| 174 | [threlte/threlte](https://github.com/threlte/threlte) | 3.3 | Svelte | 3D framework for Svelte |
| 175 | [nidorx/matcaps](https://github.com/nidorx/matcaps) | 3.3 | JavaScript | Huge library of matcap PNG textures organized by color |
| 176 | [cryinkfly/Autodesk-Fusion-360-for-Linux](https://github.com/cryinkfly/Autodesk-Fusion-360-for-Linux) | 3.2 | Shell | This is a project, where I give you a way to use Autodesk Fusion 360 on Linux! |
| 177 | [hbb1/2d-gaussian-splatting](https://github.com/hbb1/2d-gaussian-splatting) | 3.2 | Python | [SIGGRAPH'24] 2D Gaussian Splatting for Geometrically Accurate Radiance Fields |
| 178 | [lo-th/Oimo.js](https://github.com/lo-th/Oimo.js) | 3.2 | JavaScript | Lightweight 3d physics engine for javascript |
| 179 | [pmndrs/uikit](https://github.com/pmndrs/uikit) | 3.2 | TypeScript | 🎨 user interfaces for react-three-fiber |
| 180 | [vasturiano/react-force-graph](https://github.com/vasturiano/react-force-graph) | 3.2 | HTML | React component for 2D, 3D, VR and AR force directed graphs |
| 181 | [cleardusk/3DDFA_V2](https://github.com/cleardusk/3DDFA_V2) | 3.1 | Python | The official PyTorch implementation of Towards Fast, Accurate and Stable 3D Dense Face Ali |
| 182 | [MrNeRF/LichtFeld-Studio](https://github.com/MrNeRF/LichtFeld-Studio) | 3.1 | C++ | Train, inspect, edit, automate, and export 3D Gaussian Splatting scenes from a single nati |
| 183 | [Rust-GPU/rust-gpu](https://github.com/Rust-GPU/rust-gpu) | 3.1 | Rust | 🐉 Making Rust a first-class language and ecosystem for GPU shaders 🚧 |
| 184 | [g3n/engine](https://github.com/g3n/engine) | 3.1 | Go | Go 3D Game Engine (http://g3n.rocks) |
| 185 | [bradley/Blotter](https://github.com/bradley/Blotter) | 3.1 | JavaScript | A JavaScript API for drawing unconventional text effects on the web. |
| 186 | [Pointcept/Pointcept](https://github.com/Pointcept/Pointcept) | 3.1 | Python | Pointcept: Perceive the world with sparse points, a codebase for point cloud perception re |
| 187 | [PanosK92/SpartanEngine](https://github.com/PanosK92/SpartanEngine) | 3 | C++ | A game engine with a fully bindless, GPU-driven renderer featuring real-time path-traced g |
| 188 | [vasturiano/globe.gl](https://github.com/vasturiano/globe.gl) | 3 | HTML | UI component for Globe Data Visualization using ThreeJS/WebGL |
| 189 | [korlibs/korge](https://github.com/korlibs/korge) | 3 | Kotlin | A Kotlin Multiplatform Game Engine |
| 190 | [gre/gl-react](https://github.com/gre/gl-react) | 3 | TypeScript | gl-react – React library to write and compose WebGL shaders |
| 191 | [Awesome3DGS/3D-Gaussian-Splatting-Papers](https://github.com/Awesome3DGS/3D-Gaussian-Splatting-Papers) | 3 | Python | 3D高斯论文，持续更新，欢迎交流讨论。 |
| 192 | [greggman/twgl.js](https://github.com/greggman/twgl.js) | 3 | JavaScript | A Tiny WebGL helper Library |
| 193 | [avianphysics/avian](https://github.com/avianphysics/avian) | 3 | Rust | ECS-driven 2D and 3D physics engine for the Bevy game engine. |
| 194 | [recp/cglm](https://github.com/recp/cglm) | 2.9 | C | 📽 Highly Optimized 2D / 3D Graphics Math (glm) for C |
| 195 | [xelatihy/yocto-gl](https://github.com/xelatihy/yocto-gl) | 2.9 | C++ | Yocto/GL: Tiny C++ Libraries for Data-Driven Physically-based Graphics |
| 196 | [zhulf0804/3D-PointCloud](https://github.com/zhulf0804/3D-PointCloud) | 2.9 | Python | Papers and Datasets  about Point Cloud. |
| 197 | [jeeliz/jeelizFaceFilter](https://github.com/jeeliz/jeelizFaceFilter) | 2.9 | JavaScript | 🎭 Lightweight WebGL & JavaScript library for real-time multi-face detection, tracking and  |
| 198 | [nigels-com/glew](https://github.com/nigels-com/glew) | 2.9 | C | The OpenGL Extension Wrangler Library |
| 199 | [pissang/claygl](https://github.com/pissang/claygl) | 2.9 | JavaScript | A WebGL graphic library for building scalable Web3D applications |
| 200 | [gildor2/UEViewer](https://github.com/gildor2/UEViewer) | 2.9 | C++ | Viewer and exporter for Unreal Engine 1-4 assets (UE Viewer). |

## Reproduce / refresh this list

```bash
# Requires: gh (authenticated) + jq
queries=( "topic:3d" "topic:threejs" "topic:webgl" "topic:webgpu" "topic:3d-graphics" \
  "topic:computer-graphics" "topic:graphics" "topic:rendering" "topic:raytracing" \
  "topic:game-engine 3d" "topic:gaussian-splatting" "topic:nerf" "topic:point-cloud" \
  "topic:3d-reconstruction" "topic:3d-printing" "topic:gltf" "topic:3d-models" \
  "topic:opengl" "topic:vulkan" "topic:mesh" "3d engine" "3d rendering" )
rm -f all.json
for q in "${queries[@]}"; do for page in 1 2; do
  gh api -X GET search/repositories -f q="$q" -f sort=stars -f order=desc \
    -f per_page=100 -f page=$page \
    --jq '.items[] | {full_name, stars: .stargazers_count, desc: .description, lang: .language, topics: .topics, url: .html_url}' \
    >> all.json; sleep 1
done; done
# dedupe + rank
jq -s 'group_by(.full_name) | map(.[0]) | sort_by(-.stars)' all.json > dedup.json
```

Apply a 3D-signal regex filter over `description + topics` and a denylist of non-3D false positives (emulators, 2D engines, ML-inference libs, video/VPN tools), then take the top N. See git history for the exact filter used.
