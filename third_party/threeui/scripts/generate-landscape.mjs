import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(packageRoot, "src", "shaders", "japanese-tower", "Towers.html");
const outputPath = join(packageRoot, "public", "landscape.html");

const landscapeOnlyStyle = `<style data-threeui-landscape>
header,
.col-l,
.col-r,
.tag,
.plaque,
.bigpct,
footer,
.bg-grid2,
.bg-rings,
.bg-wash {
  display: none !important;
}

html,
body,
#app {
  width: 100% !important;
  height: 100% !important;
  min-height: 0 !important;
  overflow: hidden !important;
}

#stage {
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  cursor: grab;
}

#stage.dragging {
  cursor: grabbing;
}
</style>`;

const landscapeSelector = `const LANDSCAPE_PRESETS={
  sunrise:{time:'morning',weather:'clear'},
  noon:{time:'noon',weather:'clear'},
  sunset:{time:'sunset',weather:'clear'},
  night:{time:'night',weather:'clear'},
  rain:{time:'noon',weather:'rain'},
  storm:{time:'sunset',weather:'storm'},
  snow:{time:'noon',weather:'snow'}
};
const LANDSCAPE_TIME_INDEX={morning:0,sunrise:0,noon:1,sunset:2,night:3};
const LANDSCAPE_WEATHER_INDEX={clear:0,rain:1,storm:2,snow:3};
const landscapeParams=new URLSearchParams(location.search);
const requestedLandscape=landscapeParams.get('variant')||'sunrise';
const landscapePreset=LANDSCAPE_PRESETS[requestedLandscape]||LANDSCAPE_PRESETS.sunrise;
const requestedTime=(landscapeParams.get('time')||landscapePreset.time).toLowerCase();
const requestedWeather=(landscapeParams.get('weather')||landscapePreset.weather).toLowerCase();
const landscapeStyle=STYLES[0];
CAPS=[];
STAGES=landscapeStyle.stages.map((x,k)=>({t:STAGE_T[k],cn:x[0],en:x[1],to:x[2]}));
scafGroups=[];
playing=false;
applyTime(DUR);
ground.visible=false;
capMesh.visible=false;
applyWeather(LANDSCAPE_WEATHER_INDEX[requestedWeather]??0,true);
applyTheme(LANDSCAPE_TIME_INDEX[requestedTime]??0,true);
if(requestedWeather==='snow'){
  snowPack=0.72;
  refreshLook();
}
document.documentElement.setAttribute('data-landscape-variant',requestedLandscape);
document.documentElement.setAttribute('data-landscape-weather',requestedWeather);
window.__landscapeState={variant:requestedLandscape,time:THEMES[themeIdx].id,weather:WEATHER[wxIdx].id,towerVisible:false};`;

function replaceExact(source, needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`Landscape adapter could not find ${label}.`);
  return source.replace(needle, replacement);
}

let output = await readFile(sourcePath, "utf8");
output = replaceExact(output, "<title>Towers</title>", "<title>Landscape — Time & Weather</title>", "the source title");
output = replaceExact(output, "</head>", `${landscapeOnlyStyle}</head>`, "the document head");
output = replaceExact(output, "let actx=null,soundOn=true", "let actx=null,soundOn=false", "the audio default");
output = replaceExact(
  output,
  "const UNITS_TALL=14.56,CAM_H=7.065,CAM_D=80;",
  "const UNITS_TALL=34,CAM_H=3.4,CAM_D=80;",
  "the authored camera constants",
);
output = replaceExact(output, "const UNITS_WIDE=10.4;", "const UNITS_WIDE=48;", "the authored horizontal fit");
output = replaceExact(output, "const CAM_FLOOR=3.4;", "const CAM_FLOOR=CAM_H;", "the authored camera floor");
output = replaceExact(output, "(CAM_FLOOR-7.065)/80", "(CAM_FLOOR-CAM_H)/CAM_D", "the authored elevation clamp");
output = replaceExact(
  output,
  "applyStyle(0);\napplyWeather(0,true);\napplyTheme(0,true);",
  landscapeSelector,
  "the authored initial environment",
);

await writeFile(outputPath, output);
