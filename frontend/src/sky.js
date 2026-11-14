import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import * as topojson from 'topojson-client';
import { geoEquirectangular, geoPath } from 'd3-geo';
import landTopology from 'world-atlas/land-110m.json';
import countriesTopology from 'world-atlas/countries-110m.json';

// ─── Constants for Auto Reset & Alignment (FIX 2) ───────────────────────────
export const RESET_DELAY_MS = 1500;
export const RESET_DURATION_MS = 1100;
export const RESET_FACING = 'india'; // 'india' or 'target'
export const GLOBE_TILT_DEG = 0;

// ─── Utility ──────────────────────────────────────────────────────────────────
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ─── Mathematical SLERP on a Sphere ───────────────────────────────────────────
function slerpSphere(v1, v2, t, radius) {
  const dot = Math.max(-1.0, Math.min(1.0, v1.dot(v2)));
  const omega = Math.acos(dot);
  if (omega < 0.0001) return v1.clone().multiplyScalar(radius);
  const sinOmega = Math.sin(omega);
  const s1 = Math.sin((1.0 - t) * omega) / sinOmega;
  const s2 = Math.sin(t * omega) / sinOmega;
  return new THREE.Vector3(
    v1.x * s1 + v2.x * s2,
    v1.y * s1 + v2.y * s2,
    v1.z * s1 + v2.z * s2
  ).normalize().multiplyScalar(radius);
}

// ─── Fibonacci Sphere Sampling ────────────────────────────────────────────────
function fibonacciSphere(n) {
  const pts = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    pts.push(new THREE.Vector3(r * Math.sin(theta), y, r * Math.cos(theta)));
  }
  return pts;
}

// ─── Geographic / Celestial to Vector3 (Spherical Earth) ──────────────────────
export function raDecToVec3(ra, dec, r = 1.0) {
  const phi   = (dec * Math.PI) / 180;
  const lambda = (ra  * Math.PI) / 180;
  return new THREE.Vector3(
    r * Math.cos(phi) * Math.sin(lambda),
    r * Math.sin(phi),
    r * Math.cos(phi) * Math.cos(lambda)
  );
}

// ─── Vector3 to Geographic / Celestial (Spherical Earth) ──────────────────────
export function vec3ToRaDec(v) {
  const norm = v.clone().normalize();
  const dec = Math.asin(Math.max(-1, Math.min(1, norm.y))) * (180 / Math.PI);
  let ra = Math.atan2(norm.x, norm.z) * (180 / Math.PI);
  if (ra < 0) ra += 360;
  return { ra, dec };
}

// ─── Real Earth Land & Water Geometry Generation ──────────────────────────────
function generateRealEarthGeometry(radius) {
  const landFeature = topojson.feature(landTopology, landTopology.objects.land);

  const W = 2048;
  const H = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);

  const projection = geoEquirectangular()
    .scale(W / (2 * Math.PI))
    .translate([W / 2, H / 2]);

  const path = geoPath(projection, ctx);
  ctx.beginPath();
  path(landFeature);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  const imgData = ctx.getImageData(0, 0, W, H).data;

  function getPixelData(lon, lat) {
    let px = Math.floor(((lon + 180) / 360) * W);
    let py = Math.floor(((90 - lat) / 180) * H);
    px = Math.max(0, Math.min(W - 1, px));
    py = Math.max(0, Math.min(H - 1, py));
    const idx = (py * W + px) * 4;
    return { px, py, isLand: imgData[idx] > 128 };
  }

  function checkNearWater(px, py) {
    const d = 3;
    const offsets = [
      [-d, 0], [d, 0], [0, -d], [0, d],
      [-d, -d], [d, d], [-d, d], [d, -d]
    ];
    for (let k = 0; k < offsets.length; k++) {
      const nx = (px + offsets[k][0] + W) % W;
      const ny = Math.max(0, Math.min(H - 1, py + offsets[k][1]));
      if (imgData[(ny * W + nx) * 4] <= 128) {
        return true;
      }
    }
    return false;
  }

  const candidateCount = 90000;
  const golden = Math.PI * (3 - Math.sqrt(5));

  const positions = [];
  const randomPos = [];
  const normals   = [];
  const rands     = [];
  const lands     = [];
  const coasts    = [];
  const clusters  = [];

  for (let i = 0; i < candidateCount; i++) {
    const y = 1 - (i / (candidateCount - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;

    const lat = Math.asin(Math.max(-1, Math.min(1, y))) * (180 / Math.PI);
    const x = r * Math.sin(theta);
    const z = r * Math.cos(theta);
    const lon = Math.atan2(x, z) * (180 / Math.PI);

    const { px, py, isLand } = getPixelData(lon, lat);

    // Land keeps 100% of points, ocean keeps ~6%
    const keep = isLand ? true : (Math.random() < 0.06);
    if (!keep) continue;

    positions.push(x * radius, y * radius, z * radius);
    normals.push(x, y, z);
    rands.push(Math.random());
    lands.push(isLand ? 1.0 : 0.0);

    const isCoast = isLand ? (checkNearWater(px, py) ? 1.0 : 0.0) : 0.0;
    coasts.push(isCoast);

    let clusterVal = 0.0;
    if (isLand) {
      let waterHits = 0;
      const testDistances = [4, 8, 14];
      for (const td of testDistances) {
        if (imgData[(py * W + ((px + td + W) % W)) * 4] <= 128) waterHits++;
        if (imgData[(py * W + ((px - td + W) % W)) * 4] <= 128) waterHits++;
        const nyP = Math.min(H - 1, py + td);
        if (imgData[(nyP * W + px) * 4] <= 128) waterHits++;
        const nyM = Math.max(0, py - td);
        if (imgData[(nyM * W + px) * 4] <= 128) waterHits++;
      }
      clusterVal = Math.max(0.0, 1.0 - (waterHits / 12.0));
    }
    clusters.push(clusterVal);

    const rDist = radius * (2.2 + Math.random() * 3.2);
    const rTheta = Math.random() * Math.PI * 2;
    const rPhi = Math.acos(2 * Math.random() - 1);
    randomPos.push(
      rDist * Math.sin(rPhi) * Math.cos(rTheta),
      rDist * Math.sin(rPhi) * Math.sin(rTheta),
      rDist * Math.cos(rPhi)
    );
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',   new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aRandomPos', new THREE.Float32BufferAttribute(randomPos, 3));
  geo.setAttribute('normal',     new THREE.Float32BufferAttribute(normals,   3));
  geo.setAttribute('aRand',      new THREE.Float32BufferAttribute(rands,     1));
  geo.setAttribute('aLand',      new THREE.Float32BufferAttribute(lands,     1));
  geo.setAttribute('aCoast',     new THREE.Float32BufferAttribute(coasts,    1));
  geo.setAttribute('aCluster',   new THREE.Float32BufferAttribute(clusters,  1));
  return geo;
}

// ─── Country Borders Geometry from countries-110m.json ────────────────────────
function generateCountryBordersGeometry(radius) {
  const bordersMesh = topojson.mesh(countriesTopology, countriesTopology.objects.countries, (a, b) => a !== b);

  const borderPositions = [];
  const borderRandomPos = [];
  const borderNormals   = [];

  for (const line of bordersMesh.coordinates) {
    for (let i = 0; i < line.length - 1; i++) {
      let lon1 = line[i][0];
      let lat1 = line[i][1];
      let lon2 = line[i + 1][0];
      let lat2 = line[i + 1][1];

      if (Math.abs(lon2 - lon1) > 180) {
        if (lon2 > lon1) lon1 += 360;
        else lon2 += 360;
      }

      const avgLatRad = ((lat1 + lat2) * 0.5 * Math.PI) / 180;
      const cosLat = Math.cos(avgLatRad);
      const dLon = (lon2 - lon1) * cosLat;
      const dLat = lat2 - lat1;
      const distDeg = Math.hypot(dLon, dLat);

      const steps = Math.max(1, Math.ceil(distDeg / 0.5));
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        const curLon = lon1 + t * (lon2 - lon1);
        const curLat = lat1 + t * (lat2 - lat1);

        const phi = (curLat * Math.PI) / 180;
        const lambda = (curLon * Math.PI) / 180;

        const rSphere = radius * 1.002;
        const nx = Math.cos(phi) * Math.sin(lambda);
        const ny = Math.sin(phi);
        const nz = Math.cos(phi) * Math.cos(lambda);

        borderPositions.push(nx * rSphere, ny * rSphere, nz * rSphere);
        borderNormals.push(nx, ny, nz);

        const rDist = radius * (2.2 + Math.random() * 3.2);
        const rTheta = Math.random() * Math.PI * 2;
        const rPhi = Math.acos(2 * Math.random() - 1);
        borderRandomPos.push(
          rDist * Math.sin(rPhi) * Math.cos(rTheta),
          rDist * Math.sin(rPhi) * Math.sin(rTheta),
          rDist * Math.cos(rPhi)
        );
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',   new THREE.Float32BufferAttribute(borderPositions, 3));
  geo.setAttribute('aRandomPos', new THREE.Float32BufferAttribute(borderRandomPos, 3));
  geo.setAttribute('normal',     new THREE.Float32BufferAttribute(borderNormals,   3));
  return geo;
}

// ─── Globe Shaders ────────────────────────────────────────────────────────────
const GLOBE_VERT = /* glsl */`
uniform float uDPR;
uniform float uAssemble;
attribute vec3 aRandomPos;
attribute float aRand;
attribute float aLand;
attribute float aCoast;
attribute float aCluster;
varying float vFacing;
varying float vLand;
varying float vCoast;
varying float vCluster;

void main() {
  float t = clamp(uAssemble, 0.0, 1.0);
  float ease = t * t * (3.0 - 2.0 * t);
  vec3 curPos = mix(aRandomPos, position, ease);

  vec4 mvPos = modelViewMatrix * vec4(curPos, 1.0);
  vec3 norm_mv = normalize(normalMatrix * normal);
  vec3 viewDir = normalize(-mvPos.xyz);
  float dotNV = dot(norm_mv, viewDir);

  vFacing = dotNV;
  vLand = aLand;
  vCoast = aCoast;
  vCluster = aCluster;

  gl_Position = projectionMatrix * mvPos;

  float sz = mix(0.95, 1.25, aRand);
  if (aLand > 0.5) {
    if (aCluster > 0.6) sz += 0.2;
  } else {
    sz = 0.75;
  }
  gl_PointSize = sz * uDPR * mix(0.4, 1.0, ease);
}
`;

const GLOBE_FRAG = /* glsl */`
uniform float uColorScale;
varying float vFacing;
varying float vLand;
varying float vCoast;
varying float vCluster;

void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float d = length(uv);
  if (d > 0.48) discard;

  float edge = 1.0 - smoothstep(0.42, 0.48, d);

  if (vFacing < 0.02) discard;

  vec3 col;
  float alpha;

  if (vLand > 0.5) {
    // Land dots main color #7ea6d1: RGB(126, 166, 209)
    vec3 colLand = vec3(0.4941, 0.6510, 0.8196);
    // Brightest clusters #b9d4ee: RGB(185, 212, 238)
    vec3 colCore = vec3(0.7255, 0.8314, 0.9333);

    // Only densest interior clusters blend to #b9d4ee
    float coreWeight = smoothstep(0.75, 0.98, vCluster);
    col = mix(colLand, colCore, coreWeight);
    alpha = mix(0.50, 0.85, coreWeight);

    // Land points next to water get +0.2 alpha
    if (vCoast > 0.5) {
      alpha += 0.20;
    }

    // Reduce only the color's RGB intensity to compensate for additive blending/bloom
    // so land average matches RGB(120, 165, 215) with no pixel above 235 in all 3 channels
    col.r = min(col.r * 0.42, 0.49);
    col.g = min(col.g * 0.74, 0.73);
    col.b = min(col.b * 1.32, 1.00);
    col *= uColorScale;
  } else {
    col = vec3(0.25, 0.38, 0.52) * uColorScale;
    alpha = 0.04;
  }

  gl_FragColor = vec4(col, alpha * edge);
}
`;

// ─── Border Shaders ───────────────────────────────────────────────────────────
const BORDER_VERT = /* glsl */`
uniform float uDPR;
uniform float uAssemble;
attribute vec3 aRandomPos;
varying float vFacing;

void main() {
  float t = clamp(uAssemble, 0.0, 1.0);
  float ease = t * t * (3.0 - 2.0 * t);
  vec3 curPos = mix(aRandomPos, position, ease);

  vec4 mvPos = modelViewMatrix * vec4(curPos, 1.0);
  vec3 norm_mv = normalize(normalMatrix * normal);
  vec3 viewDir = normalize(-mvPos.xyz);
  vFacing = dot(norm_mv, viewDir);

  gl_Position = projectionMatrix * mvPos;
  gl_PointSize = 1.05 * uDPR * mix(0.4, 1.0, ease);
}
`;

const BORDER_FRAG = /* glsl */`
varying float vFacing;

void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float d = length(uv);
  if (d > 0.48) discard;
  if (vFacing < 0.02) discard;

  float edge = 1.0 - smoothstep(0.40, 0.48, d);
  // Same color as land #7ea6d1, alpha 0.3
  vec3 colLand = vec3(0.4941, 0.6510, 0.8196);
  gl_FragColor = vec4(colLand, 0.30 * edge);
}
`;

// ─── Globe Dust ───────────────────────────────────────────────────────────────
const DUST_VERT = /* glsl */`
uniform float uTime;
uniform float uDPR;
uniform float uAssemble;
attribute vec3 aDir;
attribute float aSpeed;
attribute float aMaxR;
attribute float aPhase;
attribute float aSize;
varying float vAlpha;

void main() {
  float cycle = fract(uTime * aSpeed + aPhase);
  float r = 1.002 + cycle * (aMaxR - 1.002);
  vec3 pos = aDir * r;

  float fade = smoothstep(0.0, 0.15, cycle) * (1.0 - smoothstep(0.55, 1.0, cycle));
  float twinkle = 0.35 + 0.65 * sin(uTime * 3.2 + aPhase * 6.28);
  vAlpha = fade * twinkle * 0.35 * clamp(uAssemble, 0.0, 1.0);

  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPos;
  gl_PointSize = aSize * (1.0 + 0.35 * twinkle) * uDPR;
}
`;

const DUST_FRAG = /* glsl */`
varying float vAlpha;
void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  if (length(uv) > 0.48) discard;
  float sharp = 1.0 - smoothstep(0.38, 0.48, length(uv));
  gl_FragColor = vec4(0.70, 0.85, 1.0, vAlpha * sharp);
}
`;

function buildGlobeDust(count = 2500, dpr = 1) {
  const dirs = [];
  const speeds = [];
  const maxRs = [];
  const phases = [];
  const sizes = [];

  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1;
    const t = Math.random() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    dirs.push(r * Math.sin(t), u, r * Math.cos(t));

    speeds.push(0.035 + Math.random() * 0.055);
    maxRs.push(1.08 + Math.random() * 0.18);
    phases.push(Math.random());
    sizes.push(0.9 + Math.random() * 0.5);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aDir',     new THREE.Float32BufferAttribute(dirs,   3));
  geo.setAttribute('aSpeed',   new THREE.Float32BufferAttribute(speeds, 1));
  geo.setAttribute('aMaxR',    new THREE.Float32BufferAttribute(maxRs,  1));
  geo.setAttribute('aPhase',   new THREE.Float32BufferAttribute(phases, 1));
  geo.setAttribute('aSize',    new THREE.Float32BufferAttribute(sizes,  1));

  const mat = new THREE.ShaderMaterial({
    vertexShader: DUST_VERT,
    fragmentShader: DUST_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime:     { value: 0 },
      uDPR:      { value: dpr },
      uAssemble: { value: 0 },
    },
  });
  return new THREE.Points(geo, mat);
}

// ─── Rim Glow ─────────────────────────────────────────────────────────────────
const RIM_VERT = /* glsl */`
varying float vFresnel;
void main() {
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  vec3 norm_mv = normalize(normalMatrix * normal);
  vec3 viewDir = normalize(-mvPos.xyz);
  vFresnel = 1.0 - abs(dot(norm_mv, viewDir));
  gl_Position = projectionMatrix * mvPos;
}
`;

const RIM_FRAG = /* glsl */`
varying float vFresnel;
void main() {
  float glow = pow(clamp(vFresnel, 0.0, 1.0), 8.0) * 0.05;
  gl_FragColor = vec4(0.20, 0.45, 0.75, glow);
}
`;

// ─── RA/Dec Grid ──────────────────────────────────────────────────────────────
const ARC_VERT = /* glsl */`
varying float vFacing;
void main() {
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  vec3 norm_mv = normalize(normalMatrix * normalize(position));
  vec3 viewDir = normalize(-mvPos.xyz);
  vFacing = dot(norm_mv, viewDir);
  gl_Position = projectionMatrix * mvPos;
}
`;

const ARC_FRAG = /* glsl */`
uniform vec4 uColor;
varying float vFacing;
void main() {
  if (vFacing < 0.01) discard;
  gl_FragColor = uColor;
}
`;

function buildGrid(radius) {
  const seg = 90;
  const positions = [];

  function addLine(p1, p2) {
    positions.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
  }

  for (let ra = 0; ra < 360; ra += 30) {
    const phi = (ra * Math.PI) / 180;
    for (let i = 0; i < seg; i++) {
      const dec1 = ((i / seg) - 0.5) * Math.PI * 0.98;
      const dec2 = (((i + 1) / seg) - 0.5) * Math.PI * 0.98;
      const p1 = new THREE.Vector3(
        radius * Math.cos(dec1) * Math.sin(phi),
        radius * Math.sin(dec1),
        radius * Math.cos(dec1) * Math.cos(phi)
      );
      const p2 = new THREE.Vector3(
        radius * Math.cos(dec2) * Math.sin(phi),
        radius * Math.sin(dec2),
        radius * Math.cos(dec2) * Math.cos(phi)
      );
      addLine(p1, p2);
    }
  }

  for (let dec = -60; dec <= 60; dec += 30) {
    const phi2 = (dec * Math.PI) / 180;
    const rRing = radius * Math.cos(phi2);
    const yRing = radius * Math.sin(phi2);
    for (let i = 0; i < seg * 2; i++) {
      const ra1 = (i / (seg * 2)) * Math.PI * 2;
      const ra2 = ((i + 1) / (seg * 2)) * Math.PI * 2;
      const p1 = new THREE.Vector3(rRing * Math.sin(ra1), yRing, rRing * Math.cos(ra1));
      const p2 = new THREE.Vector3(rRing * Math.sin(ra2), yRing, rRing * Math.cos(ra2));
      addLine(p1, p2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const mat = new THREE.ShaderMaterial({
    vertexShader: ARC_VERT,
    fragmentShader: ARC_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Vector4(1.0, 1.0, 1.0, 0.08) },
    },
  });
  return new THREE.LineSegments(geo, mat);
}

// ─── Orbit Rings ──────────────────────────────────────────────────────────────
function sampleEllipseArcLength(ra, rb, count) {
  const steps = 3600;
  const angles = new Float32Array(steps + 1);
  const cumDist = new Float32Array(steps + 1);
  cumDist[0] = 0;
  let prevX = ra, prevZ = 0;

  for (let i = 1; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    angles[i] = t;
    const x = ra * Math.cos(t);
    const z = rb * Math.sin(t);
    const dx = x - prevX, dz = z - prevZ;
    cumDist[i] = cumDist[i - 1] + Math.sqrt(dx * dx + dz * dz);
    prevX = x; prevZ = z;
  }
  const totalLength = cumDist[steps];

  const positions = new Float32Array(count * 3);
  let stepIdx = 0;
  for (let k = 0; k < count; k++) {
    const targetDist = (k / count) * totalLength;
    while (stepIdx < steps && cumDist[stepIdx] < targetDist) {
      stepIdx++;
    }
    const i0 = Math.max(0, stepIdx - 1);
    const i1 = stepIdx;
    const segLen = cumDist[i1] - cumDist[i0];
    const frac = segLen > 1e-6 ? (targetDist - cumDist[i0]) / segLen : 0;
    const t = angles[i0] + frac * (angles[i1] - angles[i0]);
    positions[k * 3]     = ra * Math.cos(t);
    positions[k * 3 + 1] = 0;
    positions[k * 3 + 2] = rb * Math.sin(t);
  }
  return positions;
}

const ORBIT_VERT = /* glsl */`
uniform float uDPR;
varying float vBehind;

void main() {
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPos;
  gl_PointSize = 1.8 * uDPR;

  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vBehind = worldPos.z < 0.0 ? 1.0 : 0.0;
}
`;

const ORBIT_FRAG = /* glsl */`
varying float vBehind;

void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float d = length(uv);
  if (d > 0.48) discard;
  float sharp = 1.0 - smoothstep(0.40, 0.48, d);

  float alpha = ((vBehind > 0.5) ? 0.08 : 0.32) * sharp;
  gl_FragColor = vec4(0.914, 0.933, 0.961, alpha);
}
`;

function buildOrbitRing(ra, rb, count, dpr) {
  const positions = sampleEllipseArcLength(ra, rb, count);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.ShaderMaterial({
    vertexShader: ORBIT_VERT,
    fragmentShader: ORBIT_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uDPR: { value: dpr } },
  });
  return new THREE.Points(geo, mat);
}

function createCrosshairTexture() {
  const size = 16;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = 'rgba(233, 238, 245, 0.70)';
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.moveTo(3, 8); ctx.lineTo(13, 8);
  ctx.moveTo(8, 3); ctx.lineTo(8, 13);
  ctx.stroke();

  return new THREE.CanvasTexture(canvas);
}

function createSatelliteTexture() {
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2, cy = size / 2;

  const haloGrad = ctx.createRadialGradient(cx, cy, 2, cx, cy, 18);
  haloGrad.addColorStop(0.0, 'rgba(79, 195, 247, 1.0)');
  haloGrad.addColorStop(0.35, 'rgba(79, 195, 247, 0.65)');
  haloGrad.addColorStop(0.7, 'rgba(79, 195, 247, 0.20)');
  haloGrad.addColorStop(1.0, 'rgba(79, 195, 247, 0.0)');
  ctx.fillStyle = haloGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, 18, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  return new THREE.CanvasTexture(canvas);
}

function buildFragments() {
  const group = new THREE.Group();
  const configs = [
    { pos: [-2.1, -1.3,  0.2], size: [0.08, 0.026], rotSpeed: [0.22, 0.14] },
    { pos: [ 2.2, -1.3,  0.2], size: [0.07, 0.024], rotSpeed: [-0.18, 0.20] },
    { pos: [-2.3,  1.1, -0.1], size: [0.06, 0.020], rotSpeed: [0.15, -0.12] },
    { pos: [ 2.0,  1.2,  0.1], size: [0.08, 0.025], rotSpeed: [-0.14, -0.18] },
    { pos: [-0.6, -1.8,  0.3], size: [0.07, 0.022], rotSpeed: [0.20, 0.16] },
  ];

  const meshes = configs.map(cfg => {
    const geo = new THREE.PlaneGeometry(cfg.size[0], cfg.size[1]);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xe9eef5,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(...cfg.pos);
    mesh.userData = { rotSpeed: cfg.rotSpeed };
    group.add(mesh);
    return mesh;
  });

  return { group, meshes };
}

function createMarkerEl(id) {
  const wrapper = document.createElement('div');
  wrapper.className = 'sky-marker';
  wrapper.dataset.id = id;
  wrapper.style.cssText = `
    position: absolute;
    width: 0px;
    height: 0px;
    transform: translate(-50%, -50%);
    pointer-events: auto;
    z-index: 10;
    cursor: pointer;
  `;

  const dot = document.createElement('div');
  dot.className = 'marker-core';
  dot.style.cssText = `
    position: absolute;
    width: 5px;
    height: 5px;
    background: #ff3b3b;
    border-radius: 50%;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    box-shadow: 0 0 10px 2px #ff3b3b, 0 0 4px #ffffff;
  `;
  wrapper.appendChild(dot);

  const rings = [
    { size: 14, delay: 0.0 },
    { size: 24, delay: 0.4 },
    { size: 36, delay: 0.8 },
  ];
  rings.forEach(({ size, delay }) => {
    const ring = document.createElement('div');
    ring.style.cssText = `
      position: absolute;
      width: ${size}px;
      height: ${size}px;
      border: 1.5px solid #ff3b3b;
      border-radius: 50%;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) scale(1);
      animation: skyPulse 2s ease-out infinite;
      animation-delay: ${delay}s;
      box-sizing: border-box;
      pointer-events: none;
    `;
    wrapper.appendChild(ring);
  });

  return wrapper;
}

function injectStyles() {
  if (document.getElementById('sky-styles')) return;
  const style = document.createElement('style');
  style.id = 'sky-styles';
  style.textContent = `
    @keyframes skyPulse {
      0%   { transform: translate(-50%, -50%) scale(0.6); opacity: 0.95; }
      100% { transform: translate(-50%, -50%) scale(1.6); opacity: 0.0; }
    }
  `;
  document.head.appendChild(style);
}

export function getSkyPoint(raDeg, decDeg, R = 1.0) {
  const raRad = (raDeg * Math.PI) / 180;
  const decRad = (decDeg * Math.PI) / 180;
  return new THREE.Vector3(
    R * Math.cos(decRad) * Math.cos(raRad),
    R * Math.sin(decRad),
    -R * Math.cos(decRad) * Math.sin(raRad)
  );
}

// ─── Main Export: initSky ─────────────────────────────────────────────────────
export function initSky(canvas, { overlay, onGlobeClick, onTargetLock, onProbeMarkerChange }) {
  injectStyles();

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W   = () => canvas.clientWidth;
  const H   = () => canvas.clientHeight;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(dpr);
  renderer.setSize(W(), H());
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const fovDeg = 35;
  const camera = new THREE.PerspectiveCamera(fovDeg, W() / H(), 0.1, 100);

  const SPHERE_R = 1.0;
  const CAM_DIST = SPHERE_R / (0.70 * Math.tan((fovDeg * Math.PI) / 360));
  camera.position.set(0, 0, CAM_DIST);

  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(dpr);
  composer.setSize(W(), H());

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(W(), H()),
    0.3,
    0.2,
    0.7
  );
  composer.addPass(bloomPass);

  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  // ── Hover Parallax Group ────────────────────────────────────────────────────
  const parallaxGroup = new THREE.Group();
  scene.add(parallaxGroup);

  // ── Crisp Post-Bloom Overlay Scene (zero bloom smearing, depthTest: false) ───
  const crispScene = new THREE.Scene();
  const crispParallaxGroup = new THREE.Group();
  crispScene.add(crispParallaxGroup);
  const crispUserOrientationGroup = new THREE.Group();
  crispParallaxGroup.add(crispUserOrientationGroup);

  // ── Arcball Quaternion Orientation Group (Q_user outside) ───────────────────
  const userOrientationGroup = new THREE.Group();
  const Q_user = new THREE.Quaternion();
  parallaxGroup.add(userOrientationGroup);

  // ── 5. Fixed Axial Tilt Group (GLOBE_TILT_DEG = 0 for normal view on load) ─
  const tiltedGroup = new THREE.Group();
  tiltedGroup.rotation.z = -GLOBE_TILT_DEG * (Math.PI / 180);
  userOrientationGroup.add(tiltedGroup);

  // ── 5. Spin Group Under Tilted Group ────────────────────────────────────────
  const spinGroup = new THREE.Group();
  // Initial orientation: India (lon 78E, lat 20N) faces camera
  spinGroup.rotation.y = -78 * (Math.PI / 180);
  tiltedGroup.add(spinGroup);

  // Invisible Sphere for Raycasting
  const hitGeo = new THREE.SphereGeometry(SPHERE_R, 32, 32);
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  const hitSphere = new THREE.Mesh(hitGeo, hitMat);
  spinGroup.add(hitSphere);

  // Solid Pure Black Occluder Sphere
  const occluderGeo = new THREE.SphereGeometry(SPHERE_R * 0.994, 64, 64);
  const occluderMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    depthWrite: true,
    depthTest: true,
  });
  const occluderMesh = new THREE.Mesh(occluderGeo, occluderMat);
  occluderMesh.renderOrder = 0;
  spinGroup.add(occluderMesh);

  // ── Real Earth Land Points Geometry (world-atlas 110m) ──────────────────────
  const globeGeo = generateRealEarthGeometry(SPHERE_R);
  const globeMat = new THREE.ShaderMaterial({
    vertexShader: GLOBE_VERT,
    fragmentShader: GLOBE_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uDPR:        { value: dpr },
      uAssemble:   { value: 0.0 },
      uColorScale: { value: 0.96 },
    },
  });
  const globePoints = new THREE.Points(globeGeo, globeMat);
  spinGroup.add(globePoints);
  window.__globeMat = globeMat;

  // ── Country Borders (countries-110m.json, dotted lines every 0.5 deg) ───────
  const bordersGeo = generateCountryBordersGeometry(SPHERE_R);
  const bordersMat = new THREE.ShaderMaterial({
    vertexShader: BORDER_VERT,
    fragmentShader: BORDER_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uDPR:      { value: dpr },
      uAssemble: { value: 0.0 },
    },
  });
  const bordersPoints = new THREE.Points(bordersGeo, bordersMat);
  spinGroup.add(bordersPoints);

  // ── Globe Dust ──────────────────────────────────────────────────────────────
  const globeDust = buildGlobeDust(2500, dpr);
  spinGroup.add(globeDust);

  // ── Rim Glow ────────────────────────────────────────────────────────────────
  const rimGeo = new THREE.SphereGeometry(SPHERE_R * 1.006, 64, 64);
  const rimMat = new THREE.ShaderMaterial({
    vertexShader: RIM_VERT,
    fragmentShader: RIM_FRAG,
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  spinGroup.add(new THREE.Mesh(rimGeo, rimMat));

  // ── RA/Dec Grid ─────────────────────────────────────────────────────────────
  const gridMesh = buildGrid(SPHERE_R * 1.015);
  spinGroup.add(gridMesh);

  // ── Orbit Rings & Rotating Satellite Sprites ────────────────────────────────
  const satTexture = createSatelliteTexture();
  const crosshairTex = createCrosshairTexture();
  const worldHeight = (2.0 * SPHERE_R) / 0.70;
  const pxToWorld = worldHeight / (H() || 800);
  const satWorldSize = 18 * pxToWorld;
  const crossWorldSize = 14 * pxToWorld;

  const orbitConfigs = [
    { ra: 1.35, rb: 1.15, tiltX:  0.55, tiltZ:  0.25, count: 750,  rotSpeed:  0.065 },
    { ra: 1.60, rb: 1.35, tiltX: -0.35, tiltZ:  0.65, count: 850,  rotSpeed: -0.045 },
    { ra: 1.90, rb: 1.60, tiltX:  0.75, tiltZ: -0.40, count: 950,  rotSpeed:  0.075 },
    { ra: 2.45, rb: 1.75, tiltX: -0.65, tiltZ: -0.30, count: 1100, rotSpeed: -0.035 },
    { ra: 2.85, rb: 2.10, tiltX:  0.45, tiltZ:  0.85, count: 1200, rotSpeed:  0.055 },
  ];

  const landingOrbitGroup = new THREE.Group();
  userOrientationGroup.add(landingOrbitGroup);

  const ringMeshes = orbitConfigs.map(cfg => {
    const r = SPHERE_R;
    const ringGroup = new THREE.Group();
    ringGroup.rotation.x = cfg.tiltX;
    ringGroup.rotation.z = cfg.tiltZ;
    landingOrbitGroup.add(ringGroup);

    const ringPoints = buildOrbitRing(cfg.ra * r, cfg.rb * r, cfg.count, dpr);
    ringGroup.add(ringPoints);

    const nCross = 2;
    for (let c = 0; c < nCross; c++) {
      const ang = (c / nCross) * Math.PI * 2 + 0.5;
      const cMat = new THREE.SpriteMaterial({
        map: crosshairTex,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        opacity: 0.45,
      });
      const cSprite = new THREE.Sprite(cMat);
      cSprite.scale.set(crossWorldSize, crossWorldSize, 1.0);
      cSprite.position.set(cfg.ra * r * Math.cos(ang), 0, cfg.rb * r * Math.sin(ang));
      ringGroup.add(cSprite);
    }

    return { group: ringGroup, ra: cfg.ra * r, rb: cfg.rb * r, rotSpeed: cfg.rotSpeed };
  });

  const satelliteConfigs = [
    { ringIdx: 0, speed:  0.30, angle: 0.2 },
    { ringIdx: 0, speed: -0.22, angle: 3.4 },
    { ringIdx: 1, speed:  0.20, angle: 1.5 },
    { ringIdx: 1, speed:  0.28, angle: 4.8 },
    { ringIdx: 2, speed:  0.12, angle: 0.8 },
    { ringIdx: 2, speed: -0.15, angle: 3.9 },
    { ringIdx: 3, speed:  0.18, angle: 2.2 },
    { ringIdx: 4, speed:  0.11, angle: 5.1 },
  ];

  const satellites = satelliteConfigs.map(sc => {
    const ring = ringMeshes[sc.ringIdx];
    const satMat = new THREE.SpriteMaterial({
      map: satTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.95,
    });
    const sprite = new THREE.Sprite(satMat);
    sprite.scale.set(satWorldSize, satWorldSize, 1.0);
    ring.group.add(sprite);

    return {
      sprite,
      ring,
      speed: sc.speed,
      angle: sc.angle,
    };
  });

  const wideGroup = new THREE.Group();
  wideGroup.rotation.x = 0.15;
  wideGroup.rotation.z = 0.08;
  landingOrbitGroup.add(wideGroup);
  const widePoints = buildOrbitRing(SPHERE_R * 3.2, SPHERE_R * 2.7, 1300, dpr);
  wideGroup.add(widePoints);
  const wideRotSpeed = -0.040;

  const { group: fragGroup, meshes: fragMeshes } = buildFragments();
  landingOrbitGroup.add(fragGroup);

  // ── Markers & Dashed Arc Links ──────────────────────────────────────────────
  let targetMarker = { id: 'WISE 0855', ra: 133.795, dec: -7.245 };
  let companionMarkers = [
    { id: 'SURVEY 01', ra: 165.20, dec: 28.50 },
    { id: 'SURVEY 02', ra: 105.40, dec: -38.10 },
    { id: 'SURVEY 03', ra: 82.80,  dec: 12.30 },
  ];

  const markerDomMap = new Map();

  function ensureMarkerDom(id) {
    if (!markerDomMap.has(id)) {
      const el = createMarkerEl(id);
      overlay.appendChild(el);
      markerDomMap.set(id, el);
    }
    return markerDomMap.get(id);
  }

  function setMarkers(list) {
    if (list && list.length > 0) {
      targetMarker = { id: list[0].id, ra: list[0].ra, dec: list[0].dec };
    }
  }

  const arcLines = [];
  const ARC_SEGMENTS = 40;
  for (let a = 0; a < 3; a++) {
    const geo = new THREE.BufferGeometry();
    const posArr = new Float32Array(ARC_SEGMENTS * 6);
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    const mat = new THREE.ShaderMaterial({
      vertexShader: ARC_VERT,
      fragmentShader: ARC_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Vector4(1.0, 0.35, 0.35, 0.55) },
      },
    });
    const line = new THREE.LineSegments(geo, mat);
    spinGroup.add(line);
    arcLines.push(line);
  }

  function updateArcLine(lineMesh, v1, v2, radius) {
    const posAttr = lineMesh.geometry.attributes.position;
    const arr = posAttr.array;
    let ptr = 0;
    for (let i = 0; i < ARC_SEGMENTS; i++) {
      if ((i % 4) < 2) {
        const pA = slerpSphere(v1, v2, i / ARC_SEGMENTS, radius);
        const pB = slerpSphere(v1, v2, (i + 1) / ARC_SEGMENTS, radius);
        arr[ptr++] = pA.x; arr[ptr++] = pA.y; arr[ptr++] = pA.z;
        arr[ptr++] = pB.x; arr[ptr++] = pB.y; arr[ptr++] = pB.z;
      } else {
        arr[ptr++] = 0; arr[ptr++] = 0; arr[ptr++] = 0;
        arr[ptr++] = 0; arr[ptr++] = 0; arr[ptr++] = 0;
      }
    }
    posAttr.needsUpdate = true;
  }

  // ── Projection Helpers ────────────────────────────────────────────────────
  const _ndc = new THREE.Vector3();
  function projectToScreen(worldPos) {
    _ndc.copy(worldPos).project(camera);
    return {
      x: (_ndc.x *  0.5 + 0.5) * W(),
      y: (_ndc.y * -0.5 + 0.5) * H(),
      behind: _ndc.z > 1.0,
    };
  }

  // ─── PROBE SCREEN: SKY SPHERE SYSTEM ────────────────────────────────────────
  const skySphereGroup = new THREE.Group();
  userOrientationGroup.add(skySphereGroup);
  skySphereGroup.visible = false;

  // 1. Dotted Sky Sphere Wireframe (RA meridians & Dec parallels every 15 deg)
  const skyWireGeo = new THREE.BufferGeometry();
  const skyWirePos = [];

  // RA Meridians every 15 deg (24 meridians), Dec from -88 to +88 step 2 deg
  for (let ra = 0; ra < 360; ra += 15) {
    if (ra === 0) continue; // 0h meridian is drawn separately as brighter white
    for (let dec = -88; dec <= 88; dec += 2) {
      const p = getSkyPoint(ra, dec, SPHERE_R);
      skyWirePos.push(p.x, p.y, p.z);
    }
  }

  // Dec Parallels every 15 deg from -75 to +75 (excluding 0, which is celestial equator)
  for (let dec = -75; dec <= 75; dec += 15) {
    if (dec === 0) continue;
    for (let ra = 0; ra < 360; ra += 2) {
      const p = getSkyPoint(ra, dec, SPHERE_R);
      skyWirePos.push(p.x, p.y, p.z);
    }
  }
  skyWireGeo.setAttribute('position', new THREE.Float32BufferAttribute(skyWirePos, 3));
  const skyWireMat = new THREE.PointsMaterial({
    color: 0xe9eef5,
    size: 1.5 * dpr,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.102,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const skyWirePoints = new THREE.Points(skyWireGeo, skyWireMat);
  skySphereGroup.add(skyWirePoints);

  // 2. Celestial Equator Ring (cyan dotted ring, dec = 0, brightness x0.65)
  const eqGeo = new THREE.BufferGeometry();
  const eqPos = [];
  for (let ra = 0; ra < 360; ra += 0.5) {
    const p = getSkyPoint(ra, 0, SPHERE_R);
    eqPos.push(p.x, p.y, p.z);
  }
  eqGeo.setAttribute('position', new THREE.Float32BufferAttribute(eqPos, 3));
  const eqMat = new THREE.PointsMaterial({
    color: 0x337fa0, // Brightness scaled x0.65 from 0x4fc3f7
    size: 2.0 * dpr,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.85 * 0.65, // Brightness scaled x0.65
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const eqPoints = new THREE.Points(eqGeo, eqMat);
  skySphereGroup.add(eqPoints);

  // 3. Ecliptic Ring (amber dotted great circle tilted 23.44 deg, brightness x0.65)
  const eclGeo = new THREE.BufferGeometry();
  const eclPos = [];
  const eclTiltRad = 23.44 * (Math.PI / 180);
  for (let t = 0; t < 360; t += 0.5) {
    const tRad = (t * Math.PI) / 180;
    eclPos.push(
      SPHERE_R * Math.cos(tRad),
      SPHERE_R * Math.sin(tRad) * Math.sin(eclTiltRad),
      -SPHERE_R * Math.sin(tRad) * Math.cos(eclTiltRad)
    );
  }
  eclGeo.setAttribute('position', new THREE.Float32BufferAttribute(eclPos, 3));
  const eclMat = new THREE.PointsMaterial({
    color: 0x976a0f, // Brightness scaled x0.65 from 0xe8a317
    size: 2.0 * dpr,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.85 * 0.65, // Brightness scaled x0.65
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const eclPoints = new THREE.Points(eclGeo, eclMat);
  skySphereGroup.add(eclPoints);

  // 4. 0h Meridian (dim white pole-to-pole at ra = 0, brightness x0.50)
  const zeroHGeo = new THREE.BufferGeometry();
  const zeroHPos = [];
  for (let dec = -90; dec <= 90; dec += 0.5) {
    const p = getSkyPoint(0, dec, SPHERE_R);
    zeroHPos.push(p.x, p.y, p.z);
  }
  zeroHGeo.setAttribute('position', new THREE.Float32BufferAttribute(zeroHPos, 3));
  const zeroHMat = new THREE.PointsMaterial({
    color: 0x808080, // Dim white (x0.50 of 0xffffff)
    size: 2.0 * dpr,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.85 * 0.50, // Brightness scaled x0.50
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const zeroHPoints = new THREE.Points(zeroHGeo, zeroHMat);
  skySphereGroup.add(zeroHPoints);

  // 5. Earth Polar Axis Line (shortened to extend only 10% past sphere)
  const axisGeo = new THREE.BufferGeometry();
  const axisPos = [];
  const axisMax = SPHERE_R * 1.10; // Exactly 10% past sphere (was 1.35)
  for (let y = -axisMax; y <= axisMax; y += 0.03) {
    axisPos.push(0, y, 0);
  }
  axisGeo.setAttribute('position', new THREE.Float32BufferAttribute(axisPos, 3));
  const axisMat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 1.6 * dpr,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.50,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const axisPoints = new THREE.Points(axisGeo, axisMat);
  skySphereGroup.add(axisPoints);

  // 6. Dynamic Marker Meridian (thin dotted line pole to pole along marker RA)
  const N_MER = 180;
  const markerMeridianGeo = new THREE.BufferGeometry();
  markerMeridianGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((N_MER + 1) * 3), 3));
  const markerMeridianMat = new THREE.PointsMaterial({
    color: 0x4fc3f7,
    size: 1.4 * dpr,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.35,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const markerMeridianPoints = new THREE.Points(markerMeridianGeo, markerMeridianMat);
  skySphereGroup.add(markerMeridianPoints);

  // ── 7. CRISP POST-BLOOM DIRECTION ARROW, ARCS & MARKER (depthTest: false) ────
  // Section H: Line-of-sight arrow is GREEN (#3dff8a), 4px solid line
  const losLineGeo = new LineGeometry();
  losLineGeo.setPositions([0, 0.34, 0, 0, 0.91, 0]);
  const losLineMat = new LineMaterial({
    color: 0x3dff8a, // GREEN #3dff8a
    linewidth: 4,    // 4px solid line
    resolution: new THREE.Vector2(W(), H()),
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 1.0,
  });
  const losLine2 = new Line2(losLineGeo, losLineMat);
  crispUserOrientationGroup.add(losLine2);

  // Flowing chevrons in lighter green (#70ffab) every 0.06 units moving at 0.5 units/s toward target
  const MAX_CHEVRONS = 16;
  const chevronPositions = new Float32Array(MAX_CHEVRONS * 8 * 3);
  const chevronGeo = new THREE.BufferGeometry();
  chevronGeo.setAttribute('position', new THREE.BufferAttribute(chevronPositions, 3));
  const chevronMat = new THREE.LineBasicMaterial({
    color: 0x70ffab, // Lighter green #70ffab
    linewidth: 2,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 1.0,
  });
  const chevronLines = new THREE.LineSegments(chevronGeo, chevronMat);
  crispUserOrientationGroup.add(chevronLines);

  // Larger Arrowhead cone (radius 0.03, length 0.09), GREEN #3dff8a (NO white edges/rings)
  const coneRadius = 0.03;
  const coneLength = 0.09;
  const coneGeo = new THREE.ConeGeometry(coneRadius, coneLength, 16);
  coneGeo.translate(0, coneLength * 0.5, 0); // Base at 0, apex tip at +coneLength
  const coneMat = new THREE.MeshBasicMaterial({
    color: 0x3dff8a, // Bright green #3dff8a, NO white edges/rings
    depthTest: false,
    depthWrite: false,
  });
  const losArrowCone = new THREE.Mesh(coneGeo, coneMat);
  crispUserOrientationGroup.add(losArrowCone);

  // Section E FLY Fading Dotted Trail
  const MAX_FLY_TRAIL = 64;
  const flyTrailPositions = new Float32Array(MAX_FLY_TRAIL * 3);
  const flyTrailGeo = new THREE.BufferGeometry();
  flyTrailGeo.setAttribute('position', new THREE.BufferAttribute(flyTrailPositions, 3));
  const flyTrailMat = new THREE.PointsMaterial({
    color: 0x3dff8a,
    size: 3 * dpr,
    sizeAttenuation: false,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.0,
  });
  const flyTrailPoints = new THREE.Points(flyTrailGeo, flyTrailMat);
  crispUserOrientationGroup.add(flyTrailPoints);

  // Crisp RA Arc (2px thick cyan solid arc along equator, depthTest: false)
  const N_RA = 64;
  const raLineGeo = new LineGeometry();
  const raLineMat = new LineMaterial({
    color: 0x4fc3f7,
    linewidth: 2,
    resolution: new THREE.Vector2(W(), H()),
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.95,
  });
  const crispRaLine = new Line2(raLineGeo, raLineMat);
  crispUserOrientationGroup.add(crispRaLine);

  // Crisp DEC Arc (2px thick red solid arc along marker meridian, depthTest: false)
  const N_DEC = 64;
  const decLineGeo = new LineGeometry();
  const decLineMat = new LineMaterial({
    color: 0xff3b3b,
    linewidth: 2,
    resolution: new THREE.Vector2(W(), H()),
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.95,
  });
  const crispDecLine = new Line2(decLineGeo, decLineMat);
  crispUserOrientationGroup.add(crispDecLine);

  // Crisp 3D Target Marker (red dot + concentric ring, depthTest: false)
  const crispMarkerGroup = new THREE.Group();
  const dotGeo = new THREE.CircleGeometry(0.016, 16);
  const dotMat = new THREE.MeshBasicMaterial({ color: 0xff3b3b, depthTest: false, depthWrite: false });
  const dotMesh = new THREE.Mesh(dotGeo, dotMat);
  crispMarkerGroup.add(dotMesh);
  const ring1Geo = new THREE.RingGeometry(0.032, 0.036, 24);
  const ring1Mat = new THREE.MeshBasicMaterial({ color: 0xff3b3b, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  const ring1Mesh = new THREE.Mesh(ring1Geo, ring1Mat);
  crispMarkerGroup.add(ring1Mesh);
  crispUserOrientationGroup.add(crispMarkerGroup);

  // Invisible Sphere for Raycasting in Probe Mode
  const skyHitSphere = new THREE.Mesh(
    new THREE.SphereGeometry(SPHERE_R, 32, 32),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  skyHitSphere.visible = false;
  skySphereGroup.add(skyHitSphere);

  // DOM Elements for Projected Sky Labels & Marker
  function createSkyLabel(text, extraClass = '') {
    const el = document.createElement('div');
    el.className = `sky-label ${extraClass}`.trim();
    el.textContent = text;
    el.style.display = 'none';
    overlay.appendChild(el);
    return el;
  }

  const lblCelestialEquator    = createSkyLabel('[ CELESTIAL EQUATOR ]');
  const lblNorthCelestialPole  = createSkyLabel('[ N CELESTIAL POLE ]');
  const lbl0h                  = createSkyLabel('[ 0h ]', 'white');
  const lblEcliptic            = createSkyLabel('[ ECLIPTIC ]', 'amber');
  const lblAxisN               = createSkyLabel('[ N ]', 'white');
  const lblRaArc               = createSkyLabel('RA 8h 55m');
  const lblDecArc              = createSkyLabel('DEC -7.2 deg', 'red');
  const lblLineOfSight         = createSkyLabel('LINE OF SIGHT', 'green');

  // Red Marker DOM Element (with 24px hit area)
  const probeMarkerDom = document.createElement('div');
  probeMarkerDom.id = 'probe-sky-marker';
  probeMarkerDom.className = 'probe-sky-marker';
  probeMarkerDom.innerHTML = `
    <div class="marker-center-dot"></div>
    <div class="marker-pulse-ring"></div>
  `;
  probeMarkerDom.style.display = 'none';
  overlay.appendChild(probeMarkerDom);

  const probeBehindBadge = document.getElementById('probe-behind-badge');
  const probeTargetTag   = document.getElementById('probe-target-tag');

  let currentProbeRa = 269.452;
  let currentProbeDec = 4.693;
  let currentMarkerVecU = new THREE.Vector3(0, 0, 1);
  let probeMarkerScreenPos = { x: 0, y: 0, facing: 1.0, behind: false };
  let isDraggingMarker = false;

  function updateProbeSkyElements(raDeg, decDeg) {
    const u = getSkyPoint(raDeg, decDeg, 1.0).normalize();
    currentMarkerVecU.copy(u);
    const P = u.clone().multiplyScalar(SPHERE_R);

    // 1. Solid White Line2 from Earth's surface (0.34) to arrowhead cone base (0.91)
    const pStart = u.clone().multiplyScalar(0.34 * SPHERE_R);
    const pEnd   = u.clone().multiplyScalar(0.91 * SPHERE_R);
    losLineGeo.setPositions([
      pStart.x, pStart.y, pStart.z,
      pEnd.x, pEnd.y, pEnd.z,
    ]);

    // 2. Large Arrowhead Cone (radius 0.03, length 0.09) pointing toward target P
    losArrowCone.position.copy(pEnd);
    losArrowCone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), u);

    // 3. Crisp 3D Target Marker at P
    crispMarkerGroup.position.copy(P);
    crispMarkerGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), u);

    // 4. Update Crisp RA Arc along celestial equator from 0h to marker's meridian
    const raFlat = [];
    for (let i = 0; i <= N_RA; i++) {
      const curRa = raDeg * (i / N_RA);
      const curPt = getSkyPoint(curRa, 0, SPHERE_R * 1.002);
      raFlat.push(curPt.x, curPt.y, curPt.z);
    }
    raLineGeo.setPositions(raFlat);

    // 5. Update Crisp DEC Arc along marker meridian from equator to marker Dec
    const decFlat = [];
    for (let i = 0; i <= N_DEC; i++) {
      const curDec = decDeg * (i / N_DEC);
      const curPt = getSkyPoint(raDeg, curDec, SPHERE_R * 1.003);
      decFlat.push(curPt.x, curPt.y, curPt.z);
    }
    decLineGeo.setPositions(decFlat);

    // 6. Update Marker Meridian (thin dotted line pole to pole)
    const merPos = markerMeridianGeo.attributes.position.array;
    for (let i = 0; i <= N_MER; i++) {
      const dec = -90 + (180 * i / N_MER);
      const curPt = getSkyPoint(raDeg, dec, SPHERE_R * 1.001);
      merPos[i * 3]     = curPt.x;
      merPos[i * 3 + 1] = curPt.y;
      merPos[i * 3 + 2] = curPt.z;
    }
    markerMeridianGeo.attributes.position.needsUpdate = true;

    // 7. Update Arc Labels
    const raHours = raDeg / 15;
    const rH = Math.floor(raHours);
    const rM = Math.floor((raHours - rH) * 60);
    const pad2 = (n) => String(n).padStart(2, '0');
    lblRaArc.textContent = `RA ${rH}h ${rM}m`;
    lblDecArc.textContent = `DEC ${(decDeg >= 0 ? '+' : '')}${decDeg.toFixed(1)} deg`;

    if (probeTargetTag) {
      probeTargetTag.textContent = `TARGET RA ${pad2(rH)}h ${pad2(rM)}m / DEC ${(decDeg >= 0 ? '+' : '')}${decDeg.toFixed(1)}`;
    }
  }

  function setProbeCoordinates(raDeg, decDeg) {
    currentProbeRa = ((raDeg % 360) + 360) % 360;
    currentProbeDec = Math.max(-90, Math.min(90, decDeg));
    updateProbeSkyElements(currentProbeRa, currentProbeDec);
  }

  // Initial probe coordinates setup
  setProbeCoordinates(currentProbeRa, currentProbeDec);

  // Mode Transition Variables (landing <-> probe)
  let currentScreenMode = 'landing';
  let modeProgress = 0.0;
  let modeTransitionStart = 0;
  let modeTransitionDur = 700;
  let modeTransitionFrom = 0.0;
  let modeTransitionTo = 0.0;
  let isTransitioningMode = false;

  function setScreenMode(mode, duration = 700) {
    if (mode === currentScreenMode && !isTransitioningMode) return;
    currentScreenMode = mode;
    isTransitioningMode = true;
    modeTransitionStart = performance.now();
    modeTransitionDur = duration;
    modeTransitionFrom = modeProgress;
    modeTransitionTo = (mode === 'probe' ? 1.0 : (mode === 'viewer' ? 0.0 : 0.0));
    if (mode === 'probe') {
      if (cursorReticle) cursorReticle.style.display = 'none';
      if (reticleLabel) reticleLabel.style.display = 'none';
      wrap.style.cursor = 'auto';
      skySphereGroup.visible = true;
      centerOnTarget(currentProbeRa, currentProbeDec, duration);
      angVelX = 0;
      angVelY = 0;
    } else if (mode === 'viewer') {
      if (cursorReticle) cursorReticle.style.display = 'none';
      if (reticleLabel) reticleLabel.style.display = 'none';
      wrap.style.cursor = 'auto';
      skySphereGroup.visible = false;
      hideAllSkyLabels();
      centerOnTarget(currentProbeRa, currentProbeDec, 0);
      angVelX = 0;
      angVelY = 0;
    } else {
      Q_user.identity();
      userOrientationGroup.quaternion.copy(Q_user);
      angVelX = 0;
      angVelY = 0;
    }
  }

  function updateSkyLabel(el, localPos, clampYMin = 0) {
    if (!el || modeProgress < 0.05) {
      if (el) el.style.display = 'none';
      return;
    }
    const worldPos = localPos.clone().applyMatrix4(userOrientationGroup.matrixWorld);
    const frontDot = worldPos.clone().normalize().dot(camera.position.clone().normalize());
    const { x, y, behind } = projectToScreen(worldPos);

    if (frontDot > -0.05 && !behind) {
      el.style.display = 'block';
      el.style.left = x + 'px';
      el.style.top  = (clampYMin > 0 ? Math.max(clampYMin, y) : y) + 'px';
      el.style.opacity = modeProgress;
    } else {
      el.style.display = 'none';
    }
  }

  function hideAllSkyLabels() {
    [lblCelestialEquator, lblNorthCelestialPole, lbl0h, lblEcliptic, lblAxisN, lblRaArc, lblDecArc, lblLineOfSight, probeMarkerDom].forEach(el => {
      if (el) el.style.display = 'none';
    });
    if (probeBehindBadge) probeBehindBadge.style.display = 'none';
    if (probeTargetTag) probeTargetTag.style.display = 'none';
  }

  // ── Raycasting: Celestial RA/Dec under Cursor ─────────────────────────────
  const raycaster = new THREE.Raycaster();
  const mouseNDC = new THREE.Vector2();

  function getCelestialCoords(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    mouseNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    mouseNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouseNDC, camera);
    const intersects = raycaster.intersectObject(hitSphere);
    if (intersects.length > 0) {
      const hit = intersects[0];
      const localPt = hit.point.clone().applyMatrix4(spinGroup.matrixWorld.clone().invert()).normalize();
      const dec = Math.asin(Math.max(-1, Math.min(1, localPt.y))) * (180 / Math.PI);
      let ra = Math.atan2(localPt.x, localPt.z) * (180 / Math.PI);
      if (ra < 0) ra += 360;
      return { ra, dec, hitPoint: hit.point };
    }
    return null;
  }

  // ── Drag & Inertia Controller (Arcball Quaternion Q_user) ─────────────────
  const SCREEN_AXIS_X = new THREE.Vector3(1, 0, 0);
  const SCREEN_AXIS_Y = new THREE.Vector3(0, 1, 0);

  let isDragging = false;
  let startX = 0, startY = 0;
  let lastX = 0, lastY = 0;
  let angVelX = 0, angVelY = 0;

  let targetTiltX = 0, targetTiltY = 0;
  let curTiltX = 0, curTiltY = 0;

  let targetZoom = 1.0;
  let curZoom = 1.0;

  const cursorReticle = document.getElementById('cursor-reticle');
  const reticleLabel = document.getElementById('reticle-label');
  const wrap = canvas.parentElement || canvas;

  let lastUserInputTime = performance.now();
  let hasTarget = false;
  let isResettingView = false;
  let resetStart = 0;
  const resetFromQ = new THREE.Quaternion();
  const resetToQ = new THREE.Quaternion();
  let resetFromSpin = 0;
  let resetToSpin = 0;
  let spinRampStart = -99999;
  const spinRampDur = 3000;
  let isFlowActive = false;
  let hasPendingReset = false;

  function registerUserInput() {
    lastUserInputTime = performance.now();
    hasPendingReset = true;
    if (isResettingView) {
      isResettingView = false;
    }
    if (easingOrientation) {
      easingOrientation = false;
    }
  }

  function setTargetExists(exists = true) {
    hasTarget = exists;
    lastUserInputTime = performance.now();
  }

  // Wheel & Touch listeners to register user input
  window.addEventListener('wheel', () => registerUserInput(), { passive: true });
  window.addEventListener('touchstart', (e) => {
    if (e.target && e.target.closest && (
      e.target.closest('#probe-panel') ||
      e.target.closest('.probe-panel') ||
      e.target.closest('button, input, select, textarea')
    )) {
      return;
    }
    registerUserInput();
  }, { passive: true });

  wrap.addEventListener('pointerdown', (e) => {
    if (e.target && e.target.closest && (
      e.target.closest('#probe-panel') ||
      e.target.closest('.probe-panel') ||
      e.target.closest('button, input, select, textarea, .custom-slider-hitarea, .custom-slider-track, .custom-slider-thumb')
    )) {
      return;
    }
    registerUserInput();

    // In probe mode, check if clicking the red marker (24px hit area)
    if (modeProgress > 0.5 && probeMarkerScreenPos.facing > -0.05 && !probeMarkerScreenPos.behind) {
      const dist = Math.hypot(e.clientX - probeMarkerScreenPos.x, e.clientY - probeMarkerScreenPos.y);
      if (dist <= 24) {
        isDraggingMarker = true;
        isDragging = false;
        probeMarkerDom.classList.add('dragging');
        wrap.setPointerCapture?.(e.pointerId);
        return;
      }
    }

    isDragging = true;
    startX = lastX = e.clientX;
    startY = lastY = e.clientY;
    angVelX = 0;
    angVelY = 0;
    animatingTarget = false;
    targetHoldUntil = 0;
    wrap.setPointerCapture?.(e.pointerId);
  });

  probeMarkerDom.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    registerUserInput();
    isDraggingMarker = true;
    isDragging = false;
    probeMarkerDom.classList.add('dragging');
    wrap.setPointerCapture?.(e.pointerId);
  });

  let pendingPointerMoveEvent = null;
  let pointerMoveRafId = null;

  function handlePointerMove(e) {
    const isProbe = modeProgress > 0.5 || currentScreenMode === 'probe';

    if (isProbe) {
      if (cursorReticle) cursorReticle.style.display = 'none';
      if (reticleLabel) reticleLabel.style.display = 'none';

      const midX = window.innerWidth * 0.5;
      const midY = window.innerHeight * 0.5;
      targetTiltY = ((e.clientX - midX) / midX) * 0.07;
      targetTiltX = -((e.clientY - midY) / midY) * 0.07;

      // Cheap 2D distance test for marker hover (NO raycast on hover)
      if (probeMarkerScreenPos.facing > -0.05 && !probeMarkerScreenPos.behind) {
        const dist = Math.hypot(e.clientX - probeMarkerScreenPos.x, e.clientY - probeMarkerScreenPos.y);
        if (dist <= 24) {
          wrap.style.cursor = isDraggingMarker ? 'grabbing' : 'grab';
        } else if (!isDragging && !isDraggingMarker) {
          wrap.style.cursor = 'auto';
        }
      } else if (!isDragging && !isDraggingMarker) {
        wrap.style.cursor = 'auto';
      }

      if (isDraggingMarker) {
        registerUserInput();
        const rect = canvas.getBoundingClientRect();
        mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouseNDC, camera);
        const intersects = raycaster.intersectObject(skyHitSphere);
        if (intersects.length > 0) {
          const hitPt = intersects[0].point;
          const invMat = userOrientationGroup.matrixWorld.clone().invert();
          const localPt = hitPt.clone().applyMatrix4(invMat).normalize();
          const dec = Math.asin(Math.max(-1, Math.min(1, localPt.y))) * (180 / Math.PI);
          let ra = Math.atan2(-localPt.z, localPt.x) * (180 / Math.PI);
          if (ra < 0) ra += 360;
          setProbeCoordinates(ra, dec);
          if (typeof onProbeMarkerChange === 'function') {
            onProbeMarkerChange({ ra, dec });
          }
        }
        return;
      }

      if (isDragging) {
        registerUserInput();
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;

        const rotX = dy * 0.006;
        const rotY = dx * 0.006;

        const qx = new THREE.Quaternion().setFromAxisAngle(SCREEN_AXIS_X, rotX);
        const qy = new THREE.Quaternion().setFromAxisAngle(SCREEN_AXIS_Y, rotY);
        const deltaQ = new THREE.Quaternion().multiplyQuaternions(qx, qy);

        Q_user.premultiply(deltaQ);
        Q_user.normalize();
        userOrientationGroup.quaternion.copy(Q_user);

        angVelX = rotX;
        angVelY = rotY;
      }
      return;
    }

    // Landing mode pointermove
    wrap.style.cursor = 'none';
    if (cursorReticle) {
      cursorReticle.style.display = 'block';
      cursorReticle.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    }

    const midX = window.innerWidth * 0.5;
    const midY = window.innerHeight * 0.5;
    targetTiltY = ((e.clientX - midX) / midX) * 0.07;
    targetTiltX = -((e.clientY - midY) / midY) * 0.07;

    const coords = getCelestialCoords(e.clientX, e.clientY);
    if (coords && reticleLabel && modeProgress < 0.5) {
      reticleLabel.textContent = `RA ${coords.ra.toFixed(2)}°\nDEC ${coords.dec >= 0 ? '+' : ''}${coords.dec.toFixed(2)}°`;
      reticleLabel.style.display = 'block';
    } else if (reticleLabel) {
      reticleLabel.style.display = 'none';
    }

    if (isDragging) {
      registerUserInput();
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;

      const rotX = dy * 0.006;
      const rotY = dx * 0.006;

      const qx = new THREE.Quaternion().setFromAxisAngle(SCREEN_AXIS_X, rotX);
      const qy = new THREE.Quaternion().setFromAxisAngle(SCREEN_AXIS_Y, rotY);
      const deltaQ = new THREE.Quaternion().multiplyQuaternions(qx, qy);

      Q_user.premultiply(deltaQ);
      Q_user.normalize();
      userOrientationGroup.quaternion.copy(Q_user);

      angVelX = rotX;
      angVelY = rotY;
    }
  }

  window.addEventListener('pointermove', (e) => {
    const isProbe = modeProgress > 0.5 || currentScreenMode === 'probe';
    if (isProbe) {
      pendingPointerMoveEvent = e;
      if (!pointerMoveRafId) {
        pointerMoveRafId = requestAnimationFrame(() => {
          pointerMoveRafId = null;
          if (pendingPointerMoveEvent) {
            handlePointerMove(pendingPointerMoveEvent);
            pendingPointerMoveEvent = null;
          }
        });
      }
    } else {
      handlePointerMove(e);
    }
  });

  window.addEventListener('pointerup', (e) => {
    registerUserInput();
    if (isDraggingMarker) {
      isDraggingMarker = false;
      probeMarkerDom.classList.remove('dragging');
      wrap.releasePointerCapture?.(e.pointerId);
      return;
    }

    if (isDragging) {
      isDragging = false;
      wrap.releasePointerCapture?.(e.pointerId);

      const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
      if (dist < 5 && modeProgress < 0.5) {
        const coords = getCelestialCoords(e.clientX, e.clientY);
        if (coords) {
          targetMarker = { id: 'USER COORD', ra: coords.ra, dec: coords.dec };
          if (typeof onGlobeClick === 'function') {
            onGlobeClick(coords);
          }
        }
      }
    }
  });

  window.addEventListener('pointercancel', () => {
    registerUserInput();
    isDragging = false;
    isDraggingMarker = false;
    probeMarkerDom.classList.remove('dragging');
  });

  window.addEventListener('wheel', (e) => {
    registerUserInput();
    targetZoom = THREE.MathUtils.clamp(targetZoom - e.deltaY * 0.001, 0.8, 1.3);
  }, { passive: true });

  // ── Target Rotation & 4s Hold Controller ───────────────────────────────────
  let animatingTarget = false;
  let targetAnimStart = 0;
  let targetAnimDur = 0;
  let targetAnimFrom = 0;
  let targetAnimTo = 0;
  let targetHoldUntil = 0;

  function rotateTo(raDeg, decDeg, ms) {
    let targetAngle = -(raDeg * Math.PI) / 180;
    const currentAngle = spinGroup.rotation.y;
    const diff = ((targetAngle - currentAngle) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;

    targetAnimFrom = currentAngle;
    targetAnimTo = currentAngle + diff;
    targetAnimStart = performance.now();
    targetAnimDur = ms || 900;
    animatingTarget = true;
    targetHoldUntil = 0;
    angVelX = 0;
    angVelY = 0;

    if (typeof onTargetLock === 'function') {
      onTargetLock({ ra: raDeg, dec: decDeg, duration: ms });
    }
  }

  // ── Section G: Face Target Quaternion (Upright Celestial North Pole) ─────────
  function computeFaceTargetQuaternion(raDeg, decDeg) {
    const vm = getSkyPoint(raDeg, decDeg, 1.0).normalize();
    const dCam = camera.position.clone().normalize();

    const absDec = Math.abs(decDeg);
    if (absDec > 85.0) {
      // Skip roll constraint if |dec| > 85 deg: shortest vector alignment
      const currentWorldU = vm.clone().applyQuaternion(Q_user).normalize();
      const rotQ = new THREE.Quaternion().setFromUnitVectors(currentWorldU, dCam);
      const targetQ = rotQ.clone().multiply(Q_user).normalize();
      if (Q_user.dot(targetQ) < 0) {
        targetQ.x = -targetQ.x;
        targetQ.y = -targetQ.y;
        targetQ.z = -targetQ.z;
        targetQ.w = -targetQ.w;
      }
      return targetQ;
    }

    // Orthonormal frame in celestial local space:
    const fLoc = vm.clone().normalize();
    const pLoc = new THREE.Vector3(0, 1, 0); // North Celestial Pole
    const uLoc = pLoc.clone().sub(fLoc.clone().multiplyScalar(fLoc.dot(pLoc))).normalize();
    const rLoc = new THREE.Vector3().crossVectors(fLoc, uLoc).normalize();

    // Orthonormal frame in world camera space:
    const fWorld = dCam.clone().normalize();
    const camUp = camera.up.clone().normalize();
    const uWorld = camUp.clone().sub(fWorld.clone().multiplyScalar(fWorld.dot(camUp))).normalize();
    const rWorld = new THREE.Vector3().crossVectors(fWorld, uWorld).normalize();

    const mLoc = new THREE.Matrix4().makeBasis(rLoc, uLoc, fLoc);
    const mLocT = mLoc.clone().transpose();
    const mWorld = new THREE.Matrix4().makeBasis(rWorld, uWorld, fWorld);
    const mFace = new THREE.Matrix4().multiplyMatrices(mWorld, mLocT);

    const targetQ = new THREE.Quaternion().setFromRotationMatrix(mFace).normalize();
    if (Q_user.dot(targetQ) < 0) {
      targetQ.x = -targetQ.x;
      targetQ.y = -targetQ.y;
      targetQ.z = -targetQ.z;
      targetQ.w = -targetQ.w;
    }
    return targetQ;
  }

  // ── Probe Screen "CENTER ON TARGET" & Auto-Follow Controller ────────────────
  let easingOrientation = false;
  let easeStart = 0;
  let easeDuration = 700;
  const easeFromQ = new THREE.Quaternion();
  const easeToQ = new THREE.Quaternion();

  function centerOnTarget(raOrDur = 700, maybeDec, maybeDur) {
    let ra = currentProbeRa;
    let dec = currentProbeDec;
    let duration = 700;
    if (typeof raOrDur === 'number' && typeof maybeDec === 'number') {
      ra = raOrDur;
      dec = maybeDec;
      duration = typeof maybeDur === 'number' ? maybeDur : 700;
    } else if (typeof raOrDur === 'number') {
      duration = raOrDur;
    }

    const targetQ = computeFaceTargetQuaternion(ra, dec);
    easeToQ.copy(targetQ);
    easeFromQ.copy(Q_user);
    easeStart = performance.now();
    easeDuration = duration;
    if (duration <= 0) {
      Q_user.copy(targetQ);
      userOrientationGroup.quaternion.copy(Q_user);
      userOrientationGroup.updateMatrixWorld(true);
      easingOrientation = false;
    } else {
      easingOrientation = true;
    }
    isResettingView = false;
    hasPendingReset = false;
    angVelX = 0;
    angVelY = 0;
  }

  function pauseAutoFollow(ms = 2000) {
    registerUserInput();
  }

  // ── Section E: FLY Animation (Slerp along great circle with trail & pulse) ──
  let isFlying = false;
  let flyResolve = null;
  let flyStart = 0;
  let flyDuration = 900;
  let flyFromVec = new THREE.Vector3();
  let flyToVec = new THREE.Vector3();
  let flyRotAxis = new THREE.Vector3(0, 1, 0);
  let flyRotAngle = 0;
  let flyTrailCount = 0;

  function flyTo(targetRa, targetDec, duration = 900) {
    hasTarget = true;
    lastUserInputTime = performance.now();

    return new Promise((resolve) => {
      isFlying = true;
      flyResolve = resolve;
      flyStart = performance.now();
      flyDuration = duration;

      flyFromVec.copy(currentMarkerVecU).normalize();
      flyToVec.copy(getSkyPoint(targetRa, targetDec, 1.0)).normalize();

      const dot = THREE.MathUtils.clamp(flyFromVec.dot(flyToVec), -1.0, 1.0);
      flyRotAngle = Math.acos(dot);

      if (flyRotAngle < 1e-4) {
        flyRotAxis.set(0, 1, 0);
      } else {
        flyRotAxis.crossVectors(flyFromVec, flyToVec).normalize();
      }

      flyTrailCount = 0;
      flyTrailMat.opacity = 0.85;

      // Auto-rotate view to face target coordinates on arrival
      centerOnTarget(targetRa, targetDec, duration);
    });
  }

  const btnCenterTarget = document.getElementById('btn-center-target');
  if (btnCenterTarget) {
    btnCenterTarget.addEventListener('click', () => {
      registerUserInput();
      centerOnTarget(700);
    });
  }

  // ── Resize Observer ───────────────────────────────────────────────────────
  const ro = new ResizeObserver(() => {
    renderer.setSize(W(), H());
    composer.setSize(W(), H());
    bloomPass.resolution.set(W(), H());
    camera.aspect = W() / H();
    camera.updateProjectionMatrix();

    const updatedPx = ((2.0 * SPHERE_R) / 0.70) / (H() || 800);
    satellites.forEach(s => {
      s.sprite.scale.set(18 * updatedPx, 18 * updatedPx, 1.0);
    });
  });
  ro.observe(canvas);

  // ── Animation Loop ────────────────────────────────────────────────────────
  let frameId;
  const clock = new THREE.Clock();
  const bootStartTime = performance.now();
  let lastNow = performance.now();

  function animate() {
    frameId = requestAnimationFrame(animate);

    if (document.hidden) return;

    const dt = clock.getDelta();
    const elapsedTime = clock.getElapsedTime();
    const now = performance.now();
    const delta = Math.min((now - lastNow) / 1000, 0.1);
    lastNow = now;

    const bootProgress = Math.min((now - bootStartTime) / 2000, 1.0);
    globeMat.uniforms.uAssemble.value = bootProgress;
    bordersMat.uniforms.uAssemble.value = bootProgress;
    globeDust.material.uniforms.uAssemble.value = bootProgress;
    globeDust.material.uniforms.uTime.value = elapsedTime;

    curTiltX += (targetTiltX - curTiltX) * 0.08;
    curTiltY += (targetTiltY - curTiltY) * 0.08;
    parallaxGroup.rotation.x = curTiltX;
    parallaxGroup.rotation.y = curTiltY;

    curZoom += (targetZoom - curZoom) * 0.08;
    camera.zoom = curZoom;
    camera.updateProjectionMatrix();

    // ── Screen Mode Transition (landing <-> probe) ───────────────────────────
    if (isTransitioningMode) {
      const elapsed = now - modeTransitionStart;
      const t = Math.min(elapsed / modeTransitionDur, 1.0);
      const ease = easeInOutCubic(t);
      modeProgress = THREE.MathUtils.lerp(modeTransitionFrom, modeTransitionTo, ease);
      if (t >= 1.0) {
        isTransitioningMode = false;
        if (currentScreenMode === 'landing') {
          skySphereGroup.visible = false;
          hideAllSkyLabels();
        }
      }
    }

    // Dynamic Earth Scaling: 1.0 in landing -> 0.34 in probe
    spinGroup.scale.setScalar(THREE.MathUtils.lerp(1.0, 0.34, modeProgress));

    // Section F: Sky sphere dots and lines implode to center during back transition
    skySphereGroup.scale.setScalar(Math.max(0.001, modeProgress));

    // Earth Axial Tilt: -GLOBE_TILT_DEG on both screens (0 deg = normal view)
    tiltedGroup.rotation.z = -GLOBE_TILT_DEG * (Math.PI / 180);

    // Camera pullback and 20 degree elevation in probe mode
    const camElevRad = (20 * Math.PI) / 180;
    const camDist0 = CAM_DIST;
    const camDist1 = CAM_DIST * 1.15;
    const camTargetY = THREE.MathUtils.lerp(0, camDist1 * Math.sin(camElevRad), modeProgress);
    const camTargetZ = THREE.MathUtils.lerp(camDist0, camDist1 * Math.cos(camElevRad), modeProgress);
    camera.position.set(0, camTargetY, camTargetZ);
    camera.lookAt(0, 0, 0);

    // Landing Orbit Rings & Fragments visibility/fading
    landingOrbitGroup.visible = (modeProgress < 0.99);

    // 1. REDUCE GLOW (30% lower bloom strength on probe screen, threshold stays 0.7)
    bloomPass.strength = THREE.MathUtils.lerp(0.30, 0.21, modeProgress);
    globeMat.uniforms.uColorScale.value = THREE.MathUtils.lerp(0.96, 0.96 * 0.70, modeProgress);

    // Opacity fade of Sky Sphere elements in probe mode
    if (modeProgress > 0.001) {
      skySphereGroup.visible = true;
      skyWireMat.opacity = 0.102 * modeProgress; // Dimmed by 15% from 0.12
      eqMat.opacity = (0.85 * 0.65) * modeProgress;
      eclMat.opacity = (0.85 * 0.65) * modeProgress;
      zeroHMat.opacity = (0.85 * 0.50) * modeProgress;
      axisMat.opacity = 0.50 * modeProgress;
      markerMeridianMat.opacity = 0.35 * modeProgress;

      // Flow chevrons along line from 0.34 to 0.90 at 0.5 units/s spaced 0.06
      const u = currentMarkerVecU;
      let v1 = new THREE.Vector3(0, 1, 0).cross(u);
      if (v1.lengthSq() < 1e-4) {
        v1 = new THREE.Vector3(1, 0, 0).cross(u);
      }
      v1.normalize();
      const v2 = u.clone().cross(v1).normalize();

      const flowOffset = (elapsedTime * 0.5) % 0.06;
      let segIdx = 0;
      const wingB = 0.016;
      const wingW = 0.014;
      const posArray = chevronGeo.attributes.position.array;

      for (let s = 0.34 + flowOffset; s <= 0.90; s += 0.06) {
        if (s < 0.355) continue;
        const ax = s * u.x, ay = s * u.y, az = s * u.z;
        const bx = (s - wingB) * u.x, by = (s - wingB) * u.y, bz = (s - wingB) * u.z;

        // Wing 1 (v1 positive) -> Apex
        posArray[segIdx++] = bx + wingW * v1.x;
        posArray[segIdx++] = by + wingW * v1.y;
        posArray[segIdx++] = bz + wingW * v1.z;
        posArray[segIdx++] = ax; posArray[segIdx++] = ay; posArray[segIdx++] = az;

        // Wing 2 (v1 negative) -> Apex
        posArray[segIdx++] = bx - wingW * v1.x;
        posArray[segIdx++] = by - wingW * v1.y;
        posArray[segIdx++] = bz - wingW * v1.z;
        posArray[segIdx++] = ax; posArray[segIdx++] = ay; posArray[segIdx++] = az;

        // Wing 3 (v2 positive) -> Apex
        posArray[segIdx++] = bx + wingW * v2.x;
        posArray[segIdx++] = by + wingW * v2.y;
        posArray[segIdx++] = bz + wingW * v2.z;
        posArray[segIdx++] = ax; posArray[segIdx++] = ay; posArray[segIdx++] = az;

        // Wing 4 (v2 negative) -> Apex
        posArray[segIdx++] = bx - wingW * v2.x;
        posArray[segIdx++] = by - wingW * v2.y;
        posArray[segIdx++] = bz - wingW * v2.z;
        posArray[segIdx++] = ax; posArray[segIdx++] = ay; posArray[segIdx++] = az;
      }
      chevronGeo.setDrawRange(0, segIdx / 3);
      chevronGeo.attributes.position.needsUpdate = true;
    }

    // Orbit rings continuous rotation (0.03-0.08 rad/s, different directions)
    if (landingOrbitGroup.visible) {
      ringMeshes.forEach(rm => {
        rm.group.rotation.y += rm.rotSpeed * delta;
      });
      wideGroup.rotation.y += wideRotSpeed * delta;
    }

    // Globe spin & target control: 0.08 rad/s in landing, 0.04 rad/s on vertical axis in probe
    const currentSpinRate = THREE.MathUtils.lerp(0.08, 0.04, modeProgress);

    // After the reset, the slow continuous spin resumes by ramping its speed from 0 to full over 3 seconds (no jerk)
    let spinMultiplier = 1.0;
    if (isResettingView) {
      spinMultiplier = 0.0;
    } else if (now - spinRampStart < spinRampDur) {
      spinMultiplier = Math.min((now - spinRampStart) / spinRampDur, 1.0);
    }

    if (animatingTarget) {
      const p = Math.min((now - targetAnimStart) / targetAnimDur, 1.0);
      spinGroup.rotation.y = THREE.MathUtils.lerp(targetAnimFrom, targetAnimTo, easeInOutCubic(p));
      if (p >= 1.0) {
        animatingTarget = false;
        targetHoldUntil = now + 4000; // Hold for 4 seconds!
      }
    } else if (now < targetHoldUntil) {
      // Hold at target
    } else if (!isResettingView) {
      // Continuous spin west to east
      spinGroup.rotation.y += currentSpinRate * spinMultiplier * delta;
    }

    // Drag inertia decay (0.95 per frame)
    if (!isDragging && !isDraggingMarker && !isResettingView && !easingOrientation && (Math.abs(angVelX) > 0.0001 || Math.abs(angVelY) > 0.0001)) {
      if (now - lastUserInputTime >= RESET_DELAY_MS) {
        angVelX = 0;
        angVelY = 0;
      } else {
        const qx = new THREE.Quaternion().setFromAxisAngle(SCREEN_AXIS_X, angVelX);
        const qy = new THREE.Quaternion().setFromAxisAngle(SCREEN_AXIS_Y, angVelY);
        const deltaQ = new THREE.Quaternion().multiplyQuaternions(qx, qy);

        Q_user.premultiply(deltaQ);
        Q_user.normalize();
        userOrientationGroup.quaternion.copy(Q_user);

        angVelX *= 0.95;
        angVelY *= 0.95;
      }
    }

    // Manual Orientation easing (CENTER ON TARGET button)
    if (easingOrientation) {
      const elapsed = now - easeStart;
      const t = Math.min(elapsed / easeDuration, 1.0);
      const ease = easeInOutCubic(t);
      Q_user.copy(easeFromQ).slerp(easeToQ, ease);
      userOrientationGroup.quaternion.copy(Q_user);
      if (t >= 1.0) {
        easingOrientation = false;
      }
    } else if (isResettingView) {
      // ── Auto Reset in Progress (over RESET_DURATION_MS = 1100ms with ease in-out cubic) ──
      const elapsed = now - resetStart;
      const t = Math.min(elapsed / RESET_DURATION_MS, 1.0);
      const ease = easeInOutCubic(t);

      Q_user.copy(resetFromQ).slerp(resetToQ, ease);
      userOrientationGroup.quaternion.copy(Q_user);

      if (RESET_FACING === 'india') {
        spinGroup.rotation.y = THREE.MathUtils.lerp(resetFromSpin, resetToSpin, ease);
      }

      if (t >= 1.0) {
        isResettingView = false;
        hasPendingReset = false;
        Q_user.copy(resetToQ);
        userOrientationGroup.quaternion.copy(Q_user);
        if (RESET_FACING === 'india') {
          spinGroup.rotation.y = resetToSpin;
        }
        spinRampStart = now; // Resume spin smoothly over 3 seconds
      }
    } else if (!isDragging && !isDraggingMarker && !isFlying && !animatingTarget && !isTransitioningMode && !isFlowActive) {
      // ── FIX 2: Auto Reset to Normal View after RESET_DELAY_MS (1500ms) of Inactivity ──
      if (hasPendingReset && now - lastUserInputTime >= RESET_DELAY_MS) {
        const targetQ = (RESET_FACING === 'target' && modeProgress > 0.5)
          ? computeFaceTargetQuaternion(currentProbeRa, currentProbeDec)
          : new THREE.Quaternion(0, 0, 0, 1);

        // Shortest path on sphere: negate if dot product < 0
        let dotVal = Q_user.dot(targetQ);
        if (dotVal < 0) {
          targetQ.x = -targetQ.x;
          targetQ.y = -targetQ.y;
          targetQ.z = -targetQ.z;
          targetQ.w = -targetQ.w;
          dotVal = -dotVal;
        }
        dotVal = Math.min(Math.max(dotVal, 0), 1);
        const qAngleDeg = 2 * Math.acos(dotVal) * (180 / Math.PI);

        // Shortest angular path for spin angle so longitude 78E faces camera
        let spinDiff = 0;
        let spinDiffDeg = 0;
        if (RESET_FACING === 'india') {
          const targetBase = -78 * (Math.PI / 180);
          const currentSpin = spinGroup.rotation.y;
          spinDiff = ((targetBase - currentSpin) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
          spinDiffDeg = Math.abs(spinDiff) * (180 / Math.PI);
        }

        // If the view is already within 1 degree of normal, do nothing
        if (qAngleDeg >= 1.0 || (RESET_FACING === 'india' && spinDiffDeg >= 1.0)) {
          isResettingView = true;
          hasPendingReset = false;
          resetStart = now;
          resetFromQ.copy(Q_user);
          resetToQ.copy(targetQ);
          resetFromSpin = spinGroup.rotation.y;
          resetToSpin = spinGroup.rotation.y + spinDiff;
          angVelX = 0;
          angVelY = 0;
        } else {
          hasPendingReset = false;
        }
      }
    }

    // Section E: Great circle FLY animation
    if (isFlying) {
      const elapsed = now - flyStart;
      const t = Math.min(elapsed / flyDuration, 1.0);
      const ease = easeInOutCubic(t);

      const currentAngle = flyRotAngle * ease;
      const currentRotQ = new THREE.Quaternion().setFromAxisAngle(flyRotAxis, currentAngle);
      const curVec = flyFromVec.clone().applyQuaternion(currentRotQ).normalize();

      const curDec = Math.asin(THREE.MathUtils.clamp(curVec.y, -1, 1)) * (180 / Math.PI);
      let curRa = Math.atan2(-curVec.z, curVec.x) * (180 / Math.PI);
      if (curRa < 0) curRa += 360;

      setProbeCoordinates(curRa, curDec);

      if (flyTrailCount < MAX_FLY_TRAIL) {
        const idx = flyTrailCount * 3;
        const pt = curVec.clone().multiplyScalar(SPHERE_R);
        flyTrailPositions[idx]     = pt.x;
        flyTrailPositions[idx + 1] = pt.y;
        flyTrailPositions[idx + 2] = pt.z;
        flyTrailCount++;
        flyTrailGeo.attributes.position.needsUpdate = true;
        flyTrailGeo.setDrawRange(0, flyTrailCount);
      }

      if (t >= 1.0) {
        isFlying = false;
        setProbeCoordinates(curRa, curDec);
        const finalQ = computeFaceTargetQuaternion(curRa, curDec);
        Q_user.copy(finalQ);
        userOrientationGroup.quaternion.copy(Q_user);
        userOrientationGroup.updateMatrixWorld(true);
        easingOrientation = false;
        // Ring pulse on arrival
        const ringEl = probeMarkerDom ? probeMarkerDom.querySelector('.marker-pulse-ring') : null;
        if (ringEl) {
          ringEl.style.animation = 'none';
          void ringEl.offsetWidth;
          ringEl.style.animation = 'probeMarkerPulse 0.8s cubic-bezier(0.2, 0.8, 0.4, 1) 2';
        }

        // Fade trail
        const trailFadeStart = now;
        const fadeTimer = setInterval(() => {
          const e = (performance.now() - trailFadeStart) / 500;
          if (e >= 1.0) {
            flyTrailMat.opacity = 0;
            flyTrailCount = 0;
            flyTrailGeo.setDrawRange(0, 0);
            clearInterval(fadeTimer);
          } else {
            flyTrailMat.opacity = 0.85 * (1 - e);
          }
        }, 16);

        if (flyResolve) {
          const cb = flyResolve;
          flyResolve = null;
          cb();
        }
      }
    }

    if (landingOrbitGroup.visible) {
      satellites.forEach(s => {
        s.angle += s.speed * dt;
        s.sprite.position.set(
          s.ring.ra * Math.cos(s.angle),
          0,
          s.ring.rb * Math.sin(s.angle)
        );
      });

      fragMeshes.forEach((mesh, idx) => {
        mesh.rotation.z += mesh.userData.rotSpeed[0] * dt;
        mesh.rotation.x += mesh.userData.rotSpeed[1] * dt;
        if (Math.random() < 0.02) {
          mesh.material.opacity = (idx % 2 === 0) ? 0.25 : 0.70;
        } else if (mesh.material.opacity !== 0.55) {
          mesh.material.opacity = 0.55;
        }
      });
    }

    userOrientationGroup.updateMatrixWorld(true);
    spinGroup.updateMatrixWorld(true);

    // ── Update Markers & Links in Landing Mode ─────────────────────────────────
    if (modeProgress < 0.95) {
      const fourMarkers = [targetMarker, ...companionMarkers];
      const activeMarkerVecs = [];

      fourMarkers.forEach(m => {
        const localVec = raDecToVec3(m.ra, m.dec, SPHERE_R);
        activeMarkerVecs.push(localVec);

        const el = ensureMarkerDom(m.id);
        const worldPos = localVec.clone().applyMatrix4(spinGroup.matrixWorld);

        const normWorld = worldPos.clone().normalize();
        const cameraDir = camera.position.clone().sub(worldPos).normalize();
        const facing = normWorld.dot(cameraDir);

        const { x, y, behind } = projectToScreen(worldPos);

        if (facing > 0.05 && !behind) {
          el.style.display = 'block';
          el.style.left = x + 'px';
          el.style.top  = y + 'px';
          el.style.opacity = Math.max(0, 1.0 - modeProgress * 1.2);
        } else {
          el.style.display = 'none';
        }
      });

      if (activeMarkerVecs.length >= 4) {
        for (let a = 0; a < 3; a++) {
          updateArcLine(arcLines[a], activeMarkerVecs[a], activeMarkerVecs[a + 1], SPHERE_R * 1.015);
        }
      }
    } else {
      // Hide all landing markers in probe mode
      for (const [, el] of markerDomMap) {
        el.style.display = 'none';
      }
    }

    // ── Update Sky Sphere Marker & Labels in Probe Mode ────────────────────────
    const isViewer = currentScreenMode === 'viewer' || (typeof document !== 'undefined' && document.body.classList.contains('screen-viewer'));
    if (isViewer) {
      if (probeBehindBadge) probeBehindBadge.style.display = 'none';
      if (probeTargetTag) probeTargetTag.style.display = 'none';
      if (probeMarkerDom) probeMarkerDom.style.display = 'none';
      hideAllSkyLabels();
    } else if (modeProgress > 0.01) {
      // 1. Red Marker on Sky Sphere
      const P = getSkyPoint(currentProbeRa, currentProbeDec, SPHERE_R);
      const markerWorld = P.clone().applyMatrix4(userOrientationGroup.matrixWorld);
      const frontDot = markerWorld.clone().normalize().dot(camera.position.clone().normalize());
      const { x, y, behind } = projectToScreen(markerWorld);

      probeMarkerScreenPos = { x, y, facing: frontDot, behind };

      // DOM reticle marker for interactions
      if (!behind) {
        probeMarkerDom.style.display = 'block';
        probeMarkerDom.style.left = x + 'px';
        probeMarkerDom.style.top  = y + 'px';
        probeMarkerDom.style.opacity = frontDot > -0.05 ? modeProgress : modeProgress * 0.85;
      } else {
        probeMarkerDom.style.display = 'none';
      }

      // Arrow cone world & screen projection
      const arrowWorld = currentMarkerVecU.clone().multiplyScalar(0.91 * SPHERE_R).applyMatrix4(userOrientationGroup.matrixWorld);
      const arrowScr = projectToScreen(arrowWorld);

      // Section I: If marker is on far side of sphere (frontDot < 0): show BEHIND badge and target tag
      if (frontDot < 0 && !behind) {
        if (probeBehindBadge) {
          probeBehindBadge.style.display = 'block';
          probeBehindBadge.style.left = x + 'px';
          probeBehindBadge.style.top  = y + 'px';
          probeBehindBadge.style.opacity = modeProgress;
        }

        if (probeTargetTag && !arrowScr.behind) {
          probeTargetTag.style.display = 'block';
          probeTargetTag.style.left = arrowScr.x + 'px';
          probeTargetTag.style.top  = (arrowScr.y - 24) + 'px';
          probeTargetTag.style.opacity = modeProgress;

          const h = currentProbeRa / 15;
          const hFloor = Math.floor(h);
          const mFloor = Math.floor((h - hFloor) * 60);
          const hStr = (hFloor < 10 ? '0' : '') + hFloor;
          const mStr = (mFloor < 10 ? '0' : '') + mFloor;
          const dStr = (currentProbeDec >= 0 ? '+' : '') + currentProbeDec.toFixed(1);
          probeTargetTag.textContent = `TARGET RA ${hStr}h ${mStr}m / DEC ${dStr}`;
        }
      } else {
        if (probeBehindBadge) probeBehindBadge.style.display = 'none';
        if (probeTargetTag) probeTargetTag.style.display = 'none';
      }

      // 2. Projected Sky Labels (hidden on back side)
      // CELESTIAL EQUATOR label on equator at ra = 45, dec = 0
      updateSkyLabel(lblCelestialEquator, getSkyPoint(45, 0, SPHERE_R * 1.02));
      // N CELESTIAL POLE label at north pole - clamped so never overlaps ARGUS
      updateSkyLabel(lblNorthCelestialPole, new THREE.Vector3(0, SPHERE_R * 1.03, 0), 84);
      // 0h label at ra = 0, dec = 0
      updateSkyLabel(lbl0h, getSkyPoint(0, 0, SPHERE_R * 1.02));
      // ECLIPTIC label
      updateSkyLabel(lblEcliptic, new THREE.Vector3(0, SPHERE_R * 1.02 * Math.sin(23.44 * Math.PI / 180), -SPHERE_R * 1.02 * Math.cos(23.44 * Math.PI / 180)));
      // N label at top of shortened axis (1.11 * SPHERE_R) - clamped so never overlaps ARGUS
      updateSkyLabel(lblAxisN, new THREE.Vector3(0, SPHERE_R * 1.11, 0), 84);
      // RA Arc midpoint label
      updateSkyLabel(lblRaArc, getSkyPoint(currentProbeRa * 0.5, 0, SPHERE_R * 1.03));
      // DEC Arc midpoint label
      updateSkyLabel(lblDecArc, getSkyPoint(currentProbeRa, currentProbeDec * 0.5, SPHERE_R * 1.03));

      // Section I: Line of Sight label at 35% of arrow length (0.54 * SPHERE_R), offset perpendicular
      const losWorld = currentMarkerVecU.clone().multiplyScalar(0.54 * SPHERE_R).applyMatrix4(userOrientationGroup.matrixWorld);
      const losScr = projectToScreen(losWorld);
      const earthScr = projectToScreen(new THREE.Vector3(0, 0, 0));

      if (!losScr.behind && modeProgress > 0.05) {
        let dx = arrowScr.x - earthScr.x;
        let dy = arrowScr.y - earthScr.y;
        const len = Math.hypot(dx, dy);
        let nx = 0, ny = -1;
        if (len > 1e-3) {
          nx = -dy / len;
          ny = dx / len;
        }
        const losPosX = losScr.x + nx * 24;
        const losPosY = losScr.y + ny * 24;

        lblLineOfSight.style.display = 'block';
        lblLineOfSight.style.left = losPosX + 'px';
        lblLineOfSight.style.top  = losPosY + 'px';

        // Collision check with target tag, behind badge, or marker
        let overlaps = false;
        const rLos = lblLineOfSight.getBoundingClientRect();
        if (rLos.width > 0 && rLos.height > 0) {
          if (probeTargetTag && probeTargetTag.style.display !== 'none') {
            const rTag = probeTargetTag.getBoundingClientRect();
            if (!(rLos.right < rTag.left || rLos.left > rTag.right || rLos.bottom < rTag.top || rLos.top > rTag.bottom)) {
              overlaps = true;
            }
          }
          if (!overlaps && probeBehindBadge && probeBehindBadge.style.display !== 'none') {
            const rBadge = probeBehindBadge.getBoundingClientRect();
            if (!(rLos.right < rBadge.left || rLos.left > rBadge.right || rLos.bottom < rBadge.top || rLos.top > rBadge.bottom)) {
              overlaps = true;
            }
          }
          if (!overlaps && probeMarkerDom && probeMarkerDom.style.display !== 'none') {
            const rMarker = probeMarkerDom.getBoundingClientRect();
            if (!(rLos.right < rMarker.left || rLos.left > rMarker.right || rLos.bottom < rMarker.top || rLos.top > rMarker.bottom)) {
              overlaps = true;
            }
          }
        }
        lblLineOfSight.style.opacity = overlaps ? '0' : modeProgress;
      } else {
        lblLineOfSight.style.display = 'none';
      }
    } else {
      probeMarkerDom.style.display = 'none';
      hideAllSkyLabels();
    }

    composer.render();

    // ── Crisp Post-Bloom Overlay Pass (zero bloom smearing, depthTest: false) ──
    if (modeProgress > 0.001) {
      crispParallaxGroup.rotation.copy(parallaxGroup.rotation);
      crispUserOrientationGroup.quaternion.copy(userOrientationGroup.quaternion);

      losLineMat.resolution.set(canvas.clientWidth || W(), canvas.clientHeight || H());
      raLineMat.resolution.set(canvas.clientWidth || W(), canvas.clientHeight || H());
      decLineMat.resolution.set(canvas.clientWidth || W(), canvas.clientHeight || H());

      const prevAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.render(crispScene, camera);
      renderer.autoClear = prevAutoClear;
    }
  }

  animate();

  // Helper for telemetry & automated verification
  window.__argusTelemetry = {
    getCenterLongitude: () => {
      const lon = ((-spinGroup.rotation.y * 180 / Math.PI) % 360 + 360) % 360;
      return lon;
    },
    getSpinGroupRotation: () => spinGroup.rotation.y,
    getQUser: () => ({
      x: Q_user.x,
      y: Q_user.y,
      z: Q_user.z,
      w: Q_user.w,
    }),
    applyDragDelta: (dx, dy) => {
      const rotX = dy * 0.006;
      const rotY = dx * 0.006;
      const qx = new THREE.Quaternion().setFromAxisAngle(SCREEN_AXIS_X, rotX);
      const qy = new THREE.Quaternion().setFromAxisAngle(SCREEN_AXIS_Y, rotY);
      const deltaQ = new THREE.Quaternion().multiplyQuaternions(qx, qy);
      Q_user.premultiply(deltaQ);
      Q_user.normalize();
      userOrientationGroup.quaternion.copy(Q_user);
      userOrientationGroup.updateMatrixWorld(true);
      return {
        x: Q_user.x,
        y: Q_user.y,
        z: Q_user.z,
        w: Q_user.w,
      };
    },
    sampleLandPixels: () => {
      const gl = renderer.getContext();
      const w = canvas.width;
      const h = canvas.height;
      const pixels = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

      // Globe is centered, radius is SPHERE_R
      let totalR = 0, totalG = 0, totalB = 0;
      let count = 0;
      let maxR = 0, maxG = 0, maxB = 0;
      let maxTripleAbove235 = 0;

      const cx = Math.floor(w / 2);
      const cy = Math.floor(h / 2);
      const searchR = Math.floor(Math.min(w, h) * 0.32);

      for (let y = cy - searchR; y <= cy + searchR; y += 2) {
        for (let x = cx - searchR; x <= cx + searchR; x += 2) {
          const idx = (y * w + x) * 4;
          const r = pixels[idx];
          const g = pixels[idx + 1];
          const b = pixels[idx + 2];

          // Check if pixel is part of land dot (blueish: B > 50 and B > R)
          if (b > 50 && b >= r && g > 40) {
            totalR += r;
            totalG += g;
            totalB += b;
            count++;
            if (r > maxR) maxR = r;
            if (g > maxG) maxG = g;
            if (b > maxB) maxB = b;
            if (r > 235 && g > 235 && b > 235) {
              maxTripleAbove235++;
            }
          }
        }
      }

      return {
        sampleCount: count,
        avgR: count ? Math.round(totalR / count) : 0,
        avgG: count ? Math.round(totalG / count) : 0,
        avgB: count ? Math.round(totalB / count) : 0,
        maxR, maxG, maxB,
        pixelsAbove235AllChannels: maxTripleAbove235,
      };
    },
    getProbeCoordinates: () => ({ ra: currentProbeRa, dec: currentProbeDec }),
    getProbeMarkerPosition: () => getSkyPoint(currentProbeRa, currentProbeDec, SPHERE_R),
    setProbeCoordinates: (ra, dec) => setProbeCoordinates(ra, dec),
    getScreenMode: () => currentScreenMode,
    getModeProgress: () => modeProgress,
    getBloomStrength: () => bloomPass.strength,
    getRingBrightnessMultipliers: () => ({
      celestialEquator: 0.65,
      ecliptic: 0.65,
      earthDots: 0.70,
      zeroHMeridian: 0.50,
    }),
    getArrowDetails: () => ({
      linewidth: losLineMat.linewidth,
      color: '#' + losLineMat.color.getHexString(),
      chevronColor: '#' + chevronMat.color.getHexString(),
      coneColor: '#' + coneMat.color.getHexString(),
      hasWhiteEdges: losArrowCone.children.length > 0,
      coneRadius,
      coneLength,
      chevronsVisible: chevronLines.visible,
    }),
    getWireframeAlpha: () => skyWireMat.opacity,
    getMarkerAngleToCamera: () => {
      userOrientationGroup.updateMatrixWorld(true);
      const P = getSkyPoint(currentProbeRa, currentProbeDec, SPHERE_R);
      const markerWorld = P.clone().applyMatrix4(userOrientationGroup.matrixWorld);
      const dot = THREE.MathUtils.clamp(markerWorld.clone().normalize().dot(camera.position.clone().normalize()), -1, 1);
      return Math.acos(dot) * (180 / Math.PI);
    },
    getArrowScreenPosition: () => {
      userOrientationGroup.updateMatrixWorld(true);
      const arrowWorld = currentMarkerVecU.clone().multiplyScalar(0.625 * SPHERE_R).applyMatrix4(userOrientationGroup.matrixWorld);
      const mid = projectToScreen(arrowWorld);
      const baseWorld = currentMarkerVecU.clone().multiplyScalar(0.34 * SPHERE_R).applyMatrix4(userOrientationGroup.matrixWorld);
      const base = projectToScreen(baseWorld);
      const endWorld = currentMarkerVecU.clone().multiplyScalar(0.91 * SPHERE_R).applyMatrix4(userOrientationGroup.matrixWorld);
      const end = projectToScreen(endWorld);
      return { mid, base, end };
    },
    getLastUserInputTime: () => lastUserInputTime,
    isAutoRecentering: () => isResettingView,
    isResettingView: () => isResettingView,
    hasPendingReset: () => hasPendingReset,
    getFlags: () => ({ isDragging, isDraggingMarker, isFlying, animatingTarget, isTransitioningMode, isFlowActive }),
    getResetDelayMs: () => RESET_DELAY_MS,
    getResetDurationMs: () => RESET_DURATION_MS,
    getResetFacing: () => RESET_FACING,
    getGlobeTiltDeg: () => GLOBE_TILT_DEG,
    getQUserAngleFromIdentity: () => {
      let dot = Math.abs(Q_user.w);
      dot = Math.max(0, Math.min(1, dot));
      return +(2 * Math.acos(dot) * (180 / Math.PI)).toFixed(2);
    },
    getCenterLongitudeDeg: () => {
      const centerLon = ((-spinGroup.rotation.y * 180 / Math.PI) % 360 + 360) % 360;
      const lonDeg = centerLon > 180 ? centerLon - 360 : centerLon;
      return +lonDeg.toFixed(2);
    },
    getNorthPoleAngleFromVerticalDeg: () => {
      userOrientationGroup.updateMatrixWorld(true);
      const northWorld = new THREE.Vector3(0, 1, 0).applyMatrix4(userOrientationGroup.matrixWorld).normalize();
      const northInCam = northWorld.clone().applyMatrix4(camera.matrixWorldInverse).normalize();
      const angleDeg = Math.abs(Math.atan2(northInCam.x, northInCam.y)) * (180 / Math.PI);
      return +angleDeg.toFixed(2);
    },
    setFlowActive: (active) => { isFlowActive = active; registerUserInput(); },
    registerUserInput: () => registerUserInput(),
    setTargetExists: (exists) => setTargetExists(exists),
    flyTo: (ra, dec, dur) => flyTo(ra, dec, dur),
    centerOnTarget: (raOrDur, maybeDec, maybeDur) => centerOnTarget(raOrDur, maybeDec, maybeDur),
    pauseAutoFollow: (ms) => pauseAutoFollow(ms),
    isMarkerBehind: () => {
      const P = getSkyPoint(currentProbeRa, currentProbeDec, SPHERE_R);
      const markerWorld = P.clone().applyMatrix4(userOrientationGroup.matrixWorld);
      return markerWorld.clone().normalize().dot(camera.position.clone().normalize()) < 0;
    },
    getDriftAngleDeg: () => {
      const u = currentMarkerVecU;
      const camDir = camera.position.clone().normalize();
      const currentWorldU = u.clone().applyQuaternion(Q_user).normalize();
      const dot = THREE.MathUtils.clamp(currentWorldU.dot(camDir), -1.0, 1.0);
      return Math.acos(dot) * (180 / Math.PI);
    },
    getLabelsVisibility: () => ({
      lblCelestialEquator: lblCelestialEquator.style.display !== 'none',
      lblNorthCelestialPole: lblNorthCelestialPole.style.display !== 'none',
      lbl0h: lbl0h.style.display !== 'none',
      lblEcliptic: lblEcliptic.style.display !== 'none',
      lblAxisN: lblAxisN.style.display !== 'none',
      lblRaArc: lblRaArc.style.display !== 'none',
      lblDecArc: lblDecArc.style.display !== 'none',
      lblLineOfSight: lblLineOfSight.style.display !== 'none',
      probeMarker: probeMarkerDom.style.display !== 'none',
    }),
  };

  const onArgusProbe = (e) => {
    const { ra, dec } = e.detail || {};
    if (typeof ra === 'number' && typeof dec === 'number') {
      setProbeCoordinates(ra, dec);
      centerOnTarget(ra, dec, 0);
    }
  };
  window.addEventListener('argus:probe', onArgusProbe);

  function dispose() {
    window.removeEventListener('argus:probe', onArgusProbe);
    cancelAnimationFrame(frameId);
    ro.disconnect();
    for (const [, el] of markerDomMap) {
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    renderer.dispose();
    composer.dispose();
  }

  return {
    rotateTo,
    setMarkers,
    dispose,
    getCelestialCoords,
    setScreenMode,
    setProbeCoordinates,
    centerOnTarget,
    pauseAutoFollow,
    registerUserInput,
    setTargetExists,
    flyTo,
    getProbeCoordinates: () => ({ ra: currentProbeRa, dec: currentProbeDec }),
    getProbeMarkerPosition: () => getSkyPoint(currentProbeRa, currentProbeDec, SPHERE_R),
    getScreenMode: () => currentScreenMode,
  };
}
