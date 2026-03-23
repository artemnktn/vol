/**
 * OpenFreeMap Positron — light gray OSM basemap.
 * Adds fill-extrusion layer for 3D buildings (not included in Positron by default).
 * 3D: Three.js wireframe cage (outer + inner box) around track; volumetric steam + orbit.
 * Track: data/track.geojson
 */

const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
const TRACK_URL = new URL("data/track.geojson", window.location.href).href;
const VOL_URL = new URL("data/test_trans.geojson", window.location.href).href;

/** Source CRS of test_trans.geojson (matches file crs / PROJ) */
const VOL_PROJ_DEF =
  "+proj=utm +zone=36 +ellps=WGS72 +towgs84=0,0,4.5,0,0,0.554,0.219 +units=m +no_defs";
const VOL_PROJ_KEY = "VOL_SRC_EPSG32236";

/** Map circle radius (pixels) — default and enlarged subset */
const VOL_POINT_RADIUS_PX = 7;
const VOL_POINT_RADIUS_LARGE_PX = 12;
/** Every n-th point (0-based) uses large radius unless overridden by GeoJSON */
const VOL_POINT_LARGE_EVERY_N = 3;

const LAYER_VOL_POINTS = "volumetric-points";
const SOURCE_VOL_POINTS = "volumetric-points-src";

/** Steam-like rise: particles per source point, cycle length, max vertical drift (m), lateral wobble speed */
const STEAM_PARTICLES_PER_POINT = 8;
const STEAM_CYCLE_SEC = 2.75;
const STEAM_MAX_RISE_M = 18;
const STEAM_WOBBLE_RAD_S = 2.4;

/** Automatic camera orbit (bearing) around track while Volumetric is on */
const VOL_ORBIT_DEG_PER_SEC = 9;

const LAYER_BUILDING_3D = "building-3d";

/** Three.js wireframe: outer + inner rectangular cage (meters tall) — only in 3D view */
const LAYER_TRACK_CAGE = "track-3d-cage";
const TRACK_BOX_BUFFER_M = 16;
const TRACK_CAGE_HEIGHT_M = 85;
/** Edge thickness in meters (local space, Three.js cage) */
const TRACK_CAGE_EDGE_RADIUS_M = 0.55;

/** Track bbox container: GeoJSON line layers (outer + inner ring), always visible under the track */
const LAYER_TRACK_CONTAINER = "track-container-lines";
const SOURCE_TRACK_CONTAINER = "track-container-src";
const TRACK_CONTAINER_COLOR = "#141414";
const TRACK_CONTAINER_WIDTH_OUTER = 3.5;
const TRACK_CONTAINER_WIDTH_INNER = 2.2;

/** Hollow 3D prism (fill-extrusion ring) — same footprint as container; visible only in 3D view */
const SOURCE_TRACK_BOX_3D = "track-box-3d-src";
const LAYER_TRACK_BOX_3D = "track-box-3d-extrusion";
const TRACK_BOX_3D_OPACITY = 0.28;
const TRACK_BOX_3D_COLOR = "#c8c8c8";

/** @type {{ w: number; s: number; e: number; n: number; heightM: number; bufferM: number } | null} */
let trackCageSpec = null;

/** White buildings, semi-transparent */
const BUILDING_FILL = "#ffffff";
const BUILDING_OPACITY = 0.5;
const BUILDING_OUTLINE = "rgba(255, 255, 255, 0.35)";

/** Track line (lime) */
const TRACK_COLOR = "#d0ff00";
const TRACK_LINE_OPACITY = 0.95;
const TRACK_OUTLINE_OPACITY = 0.92;

/** @type {boolean} */
let view3d = false;

/** @type {boolean} */
let volumetricOn = false;

/** @type {number | null} */
let volumetricAnimRafId = null;

function ensureVolProj4() {
  if (typeof proj4 === "undefined") {
    return false;
  }
  try {
    proj4.defs(VOL_PROJ_KEY, VOL_PROJ_DEF);
  } catch {
    /* already defined */
  }
  return true;
}

/** Matplotlib viridis-like stops (t 0…1 → RGB). */
const VIRIDIS_STOPS = [
  { t: 0, c: [68, 1, 84] },
  { t: 0.25, c: [59, 82, 139] },
  { t: 0.5, c: [33, 145, 140] },
  { t: 0.75, c: [94, 201, 98] },
  { t: 1, c: [253, 231, 37] },
];

function lerpChannel(a, b, u) {
  return Math.round(a + (b - a) * u);
}

/** Viridis → #rrggbb for circle layer (t ∈ [0,1]). */
function viridisHex(t) {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 0; i < VIRIDIS_STOPS.length - 1; i++) {
    const a = VIRIDIS_STOPS[i];
    const b = VIRIDIS_STOPS[i + 1];
    if (x <= b.t) {
      const u = b.t === a.t ? 0 : (x - a.t) / (b.t - a.t);
      const r = lerpChannel(a.c[0], b.c[0], u);
      const g = lerpChannel(a.c[1], b.c[1], u);
      const bl = lerpChannel(a.c[2], b.c[2], u);
      return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
    }
  }
  const c = VIRIDIS_STOPS[VIRIDIS_STOPS.length - 1].c;
  return `#${c[0].toString(16).padStart(2, "0")}${c[1].toString(16).padStart(2, "0")}${c[2].toString(16).padStart(2, "0")}`;
}

/** Mix hex color toward white (w=0 → original, w=1 → white). */
function mixHexToWhite(hex, w) {
  const x = Math.max(0, Math.min(1, w));
  const h = String(hex).replace("#", "");
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (![r, g, b].every((n) => Number.isFinite(n))) return hex;
  const rr = Math.round(r + (255 - r) * x);
  const gg = Math.round(g + (255 - g) * x);
  const bb = Math.round(b + (255 - b) * x);
  return `#${rr.toString(16).padStart(2, "0")}${gg.toString(16).padStart(2, "0")}${bb.toString(16).padStart(2, "0")}`;
}

/** East offset in meters at given latitude → Δlng */
function offsetEastMeters(latDeg, lngDeg, eastM) {
  const cos = Math.cos((latDeg * Math.PI) / 180);
  const mPerDegLon = 111320 * Math.max(0.2, Math.abs(cos));
  return lngDeg + eastM / mPerDegLon;
}

/**
 * Reproject EPSG:32236 points → WGS84 Point features for a circle layer.
 * Properties: vol_color, vol_radius (px). Optional radius override from source:
 *   radius_px | vol_radius_px | point_radius | size (clamped 3…24 px).
 * Otherwise every VOL_POINT_LARGE_EVERY_N-th point is enlarged.
 */
function buildVolumetricPointsGeoJSON(featureCollection) {
  if (!ensureVolProj4()) {
    return { type: "FeatureCollection", features: [] };
  }

  const candidates = [];
  for (const f of featureCollection.features || []) {
    const g = f.geometry;
    if (!g || g.type !== "Point") continue;
    const [x, y] = g.coordinates;
    const [lng, lat] = proj4(VOL_PROJ_KEY, "WGS84", [x, y]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const p = f.properties || {};
    candidates.push({ lng, lat, id: p.id, srcProps: p });
  }

  const n = candidates.length;
  const features = candidates.map((c, i) => {
    const tVir = n <= 1 ? 0.5 : i / (n - 1);
    const p = c.srcProps || {};
    const customR = Number(p.radius_px ?? p.vol_radius_px ?? p.point_radius ?? p.size);
    let vol_radius = VOL_POINT_RADIUS_PX;
    if (Number.isFinite(customR) && customR > 0) {
      vol_radius = Math.min(24, Math.max(3, customR));
    } else if (i % VOL_POINT_LARGE_EVERY_N === 0) {
      vol_radius = VOL_POINT_RADIUS_LARGE_PX;
    }

    const vol_pulse_phase = (i * 2.417 + (typeof c.id === "number" ? c.id * 0.07 : 0)) % (Math.PI * 2);

    return {
      type: "Feature",
      properties: {
        vol_color: viridisHex(tVir),
        vol_radius,
        vol_radius_base: vol_radius,
        vol_pulse_phase,
        vol_pulse_opacity: 1,
        ...(c.id !== undefined && c.id !== null ? { src_id: c.id } : {}),
      },
      geometry: {
        type: "Point",
        coordinates: [c.lng, c.lat],
      },
    };
  });

  return { type: "FeatureCollection", features };
}

/**
 * Gas / steam visualization: soft core + staggered puffs drifting up (north) with lateral wobble,
 * growing paler and fading like evaporating vapor.
 */
function steamVolFeatureCollection(fc, tSec) {
  const out = [];

  for (const f of fc.features || []) {
    const g = f.geometry;
    if (!g || g.type !== "Point") continue;
    const [lng, lat] = g.coordinates;
    const p = f.properties || {};
    const baseR = Number(p.vol_radius_base ?? p.vol_radius) || VOL_POINT_RADIUS_PX;
    const col = p.vol_color || "#9aa0a8";
    const phase = Number(p.vol_pulse_phase) || 0;

    const coreOp = 0.2 + 0.14 * Math.sin(tSec * 4.8 + phase);
    out.push({
      type: "Feature",
      properties: {
        vol_color: mixHexToWhite(col, 0.12),
        vol_radius: Math.max(2.5, baseR * 0.48),
        vol_pulse_opacity: coreOp,
      },
      geometry: { type: "Point", coordinates: [lng, lat] },
    });

    for (let k = 0; k < STEAM_PARTICLES_PER_POINT; k++) {
      const u =
        (tSec / STEAM_CYCLE_SEC + k / STEAM_PARTICLES_PER_POINT + phase * 0.09) % 1;
      const riseM = STEAM_MAX_RISE_M * Math.pow(u, 0.9);
      const eastM =
        Math.sin(tSec * STEAM_WOBBLE_RAD_S + k * 2.05 + phase) * (2 + u * 6) +
        Math.sin(tSec * 3.7 + k * 1.3 + phase * 1.7) * (1.2 + u * 3);

      const lat2 = lat + riseM / 111320;
      const lng2 = offsetEastMeters(lat, lng, eastM);

      const fade = Math.pow(1 - u, 1.35);
      const puff = Math.sin(u * Math.PI);
      const r = Math.max(
        2,
        baseR * (0.38 + 0.42 * (1 - u) * (0.85 + 0.35 * puff)),
      );
      const whiteness = 0.22 + 0.58 * u;
      const op = fade * (0.5 + 0.48 * (1 - u)) * (0.72 + 0.28 * puff);

      out.push({
        type: "Feature",
        properties: {
          vol_color: mixHexToWhite(col, whiteness),
          vol_radius: r,
          vol_pulse_opacity: Math.max(0, Math.min(1, op)),
        },
        geometry: { type: "Point", coordinates: [lng2, lat2] },
      });
    }
  }

  return { type: "FeatureCollection", features: out };
}

function resetVolumetricAnimationVisuals(map, volSnapshot) {
  if (map.getSource(SOURCE_VOL_POINTS) && volSnapshot?.features?.length) {
    map.getSource(SOURCE_VOL_POINTS).setData(JSON.parse(JSON.stringify(volSnapshot)));
  }
}

function stopVolumetricAnimation(map, volSnapshot) {
  if (volumetricAnimRafId !== null) {
    cancelAnimationFrame(volumetricAnimRafId);
    volumetricAnimRafId = null;
  }
  resetVolumetricAnimationVisuals(map, volSnapshot);
}

function startVolumetricAnimation(map, volSnapshotFrozen) {
  stopVolumetricAnimation(map, volSnapshotFrozen);

  let prevNow = performance.now();

  function frame(now) {
    if (!volumetricOn) {
      stopVolumetricAnimation(map, volSnapshotFrozen);
      return;
    }
    const t = now / 1000;
    const dt = Math.min(0.05, (now - prevNow) / 1000);
    prevNow = now;

    if (map.getSource(SOURCE_VOL_POINTS)) {
      map.getSource(SOURCE_VOL_POINTS).setData(steamVolFeatureCollection(volSnapshotFrozen, t));
    }

    try {
      map.setBearing(map.getBearing() + VOL_ORBIT_DEG_PER_SEC * dt);
    } catch {
      /* map not ready */
    }

    volumetricAnimRafId = requestAnimationFrame(frame);
  }

  volumetricAnimRafId = requestAnimationFrame(frame);
}

/** Bounding box [minLng, minLat, maxLng, maxLat] for LineString / MultiLineString */
function geojsonLineBbox(geojson) {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  function extendPoint(lng, lat) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  function walkLineString(coords) {
    for (const p of coords) {
      extendPoint(p[0], p[1]);
    }
  }

  function walkGeometry(geom) {
    if (!geom) return;
    const { type, coordinates } = geom;
    if (type === "LineString") {
      walkLineString(coordinates);
    } else if (type === "MultiLineString") {
      for (const line of coordinates) {
        walkLineString(line);
      }
    }
  }

  for (const f of geojson.features || []) {
    walkGeometry(f.geometry);
  }

  if (!Number.isFinite(minLng)) {
    return [114.16, 22.3, 114.19, 22.32];
  }
  return [minLng, minLat, maxLng, maxLat];
}

function metersToLatDelta(m) {
  return m / 111320;
}

function metersToLngDelta(m, atLatDeg) {
  const cos = Math.cos((atLatDeg * Math.PI) / 180);
  return m / (111320 * Math.max(0.2, Math.abs(cos)));
}

/** Closed LineStrings: outer (bbox + buffer) and inner (tight track bbox). */
function buildTrackContainerLinesGeoJSON(w, s, e, n) {
  const midLat = (s + n) / 2;
  const dLat = metersToLatDelta(TRACK_BOX_BUFFER_M);
  const dLng = metersToLngDelta(TRACK_BOX_BUFFER_M, midLat);
  const wo = w - dLng;
  const so = s - dLat;
  const eo = e + dLng;
  const no = n + dLat;
  if (!Number.isFinite(wo) || eo - wo < 1e-7 || no - so < 1e-7) {
    return { type: "FeatureCollection", features: [] };
  }
  const outer = [
    [wo, so],
    [eo, so],
    [eo, no],
    [wo, no],
    [wo, so],
  ];
  const inner = [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ];
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { ring: "outer" },
        geometry: { type: "LineString", coordinates: outer },
      },
      {
        type: "Feature",
        properties: { ring: "inner" },
        geometry: { type: "LineString", coordinates: inner },
      },
    ],
  };
}

/** Polygon with hole: extruded vertical “box” shell around track (outer = bbox+buffer, inner = tight bbox). */
function buildTrackBoxRingExtrusionGeoJSON(w, s, e, n) {
  const midLat = (s + n) / 2;
  const dLat = metersToLatDelta(TRACK_BOX_BUFFER_M);
  const dLng = metersToLngDelta(TRACK_BOX_BUFFER_M, midLat);
  const wo = w - dLng;
  const so = s - dLat;
  const eo = e + dLng;
  const no = n + dLat;
  if (!Number.isFinite(wo) || eo - wo < 1e-7 || no - so < 1e-7) {
    return { type: "FeatureCollection", features: [] };
  }
  const outer = [
    [wo, so],
    [eo, so],
    [eo, no],
    [wo, no],
    [wo, so],
  ];
  /** Opposite winding from outer so MapLibre treats it as a hole */
  const inner = [
    [w, n],
    [e, n],
    [e, s],
    [w, s],
    [w, n],
  ];
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { extrude_h: TRACK_CAGE_HEIGHT_M },
        geometry: {
          type: "Polygon",
          coordinates: [outer, inner],
        },
      },
    ],
  };
}

function isMat16(m) {
  return (
    (Array.isArray(m) || m instanceof Float32Array) &&
    m.length === 16
  );
}

/**
 * MapLibre custom layer: 3D cage around track (cylinder edges).
 * Uses the same projection contract as MapLibre’s official Three.js example:
 *   camera.projectionMatrix = defaultProjectionData.mainMatrix * localMatrix
 * where localMatrix = translate(anchorMercator) * scale(meters→mercator, with Y flip),
 * and geometry lives in **local meters** (Y = up) relative to track bbox center.
 * (modelViewProjectionMatrix alone does not match raw MercatorCoordinate vertices.)
 */
function createTrackCageCustomLayer(spec) {
  if (typeof THREE === "undefined") {
    throw new Error("THREE is not loaded");
  }

  return {
    id: LAYER_TRACK_CAGE,
    type: "custom",
    renderingMode: "3d",

    onAdd(map, gl) {
      this.map = map;
      const { w, s, e, n, heightM, bufferM } = spec;
      const clng = (w + e) / 2;
      const clat = (s + n) / 2;
      const mPerLat = 111320;
      const mPerLng = 111320 * Math.max(0.2, Math.abs(Math.cos((clat * Math.PI) / 180)));

      const midLat = (s + n) / 2;
      const dLat = metersToLatDelta(bufferM);
      const dLng = metersToLngDelta(bufferM, midLat);
      const wo = w - dLng;
      const so = s - dLat;
      const eo = e + dLng;
      const no = n + dLat;
      const h = heightM;

      function localM(lng, lat, altM) {
        const x = (lng - clng) * mPerLng;
        const z = (lat - clat) * mPerLat;
        return new THREE.Vector3(x, altM, z);
      }

      const segments = [];
      function pushSeg(a, b) {
        segments.push([a, b]);
      }

      function addBox(ww, ss, ee, nn) {
        const b = [
          localM(ww, ss, 0),
          localM(ee, ss, 0),
          localM(ee, nn, 0),
          localM(ww, nn, 0),
        ];
        const t = [
          localM(ww, ss, h),
          localM(ee, ss, h),
          localM(ee, nn, h),
          localM(ww, nn, h),
        ];
        for (let i = 0; i < 4; i++) {
          const j = (i + 1) % 4;
          pushSeg(b[i], b[j]);
          pushSeg(t[i], t[j]);
          pushSeg(b[i], t[i]);
        }
      }

      addBox(wo, so, eo, no);
      addBox(w, s, e, n);

      const ob = [
        localM(wo, so, 0),
        localM(eo, so, 0),
        localM(eo, no, 0),
        localM(wo, no, 0),
      ];
      const ib = [
        localM(w, s, 0),
        localM(e, s, 0),
        localM(e, n, 0),
        localM(w, n, 0),
      ];
      const ot = [
        localM(wo, so, h),
        localM(eo, so, h),
        localM(eo, no, h),
        localM(wo, no, h),
      ];
      const it = [
        localM(w, s, h),
        localM(e, s, h),
        localM(e, n, h),
        localM(w, n, h),
      ];
      for (let i = 0; i < 4; i++) {
        pushSeg(ob[i], ib[i]);
        pushSeg(ot[i], it[i]);
      }

      const anchorMc = maplibregl.MercatorCoordinate.fromLngLat([clng, clat], 0);
      const sMerc = anchorMc.meterInMercatorCoordinateUnits();
      this.localMatrix = new THREE.Matrix4()
        .makeTranslation(anchorMc.x, anchorMc.y, anchorMc.z)
        .scale(new THREE.Vector3(sMerc, -sMerc, sMerc));

      const mat = new THREE.MeshBasicMaterial({
        color: 0x1a1a1a,
        depthTest: false,
        depthWrite: false,
      });

      const group = new THREE.Group();
      const up = new THREE.Vector3(0, 1, 0);
      const radius = TRACK_CAGE_EDGE_RADIUS_M;

      for (const [a, b] of segments) {
        const dir = new THREE.Vector3().subVectors(b, a);
        const len = dir.length();
        if (len < 1e-8) continue;
        const geom = new THREE.CylinderGeometry(radius, radius, len, 10);
        const mesh = new THREE.Mesh(geom, mat);
        const midPt = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
        mesh.position.copy(midPt);
        mesh.quaternion.setFromUnitVectors(up, dir.clone().normalize());
        group.add(mesh);
      }

      this.scene = new THREE.Scene();
      this.scene.add(group);
      this.camera = new THREE.Camera();

      this.renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl,
        antialias: true,
      });
      this.renderer.autoClear = false;
    },

    render(gl, opts) {
      if (!this.renderer || !this.scene || !this.localMatrix) return;
      const main = opts.defaultProjectionData?.mainMatrix;
      if (!isMat16(main)) return;

      const m = new THREE.Matrix4().fromArray(main);
      this.camera.projectionMatrix.copy(m).multiply(this.localMatrix);
      this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
      this.renderer.resetState();
      this.renderer.render(this.scene, this.camera);
    },

    onRemove() {
      let sharedMat = null;
      this.scene?.traverse((obj) => {
        if (obj.isMesh) {
          obj.geometry?.dispose();
          sharedMat = obj.material;
        }
      });
      sharedMat?.dispose();
      this.scene?.clear();
      this.localMatrix = null;
    },
  };
}

function firstSymbolLayerId(map) {
  const layers = map.getStyle().layers || [];
  const sym = layers.find((l) => l.type === "symbol");
  return sym ? sym.id : undefined;
}

/** Positron only has flat `building`; add extrusion before labels */
function ensureBuilding3dLayer(map) {
  if (map.getLayer(LAYER_BUILDING_3D) || !map.getSource("openmaptiles")) {
    return;
  }

  map.addLayer(
    {
      id: LAYER_BUILDING_3D,
      type: "fill-extrusion",
      source: "openmaptiles",
      "source-layer": "building",
      minzoom: 14,
      filter: ["!=", ["get", "hide_3d"], true],
      layout: {
        visibility: "none",
      },
      paint: {
        "fill-extrusion-color": BUILDING_FILL,
        "fill-extrusion-opacity": BUILDING_OPACITY,
        "fill-extrusion-height": [
          "coalesce",
          ["get", "render_height"],
          ["get", "height"],
          12,
        ],
        "fill-extrusion-base": [
          "coalesce",
          ["get", "render_min_height"],
          ["get", "min_height"],
          0,
        ],
      },
    },
    firstSymbolLayerId(map),
  );
}

function tuneGrayBasemap(map) {
  /** Monochrome gray basemap — no green / blue land tints (OpenFreeMap Positron) */
  if (map.getLayer("background")) {
    map.setPaintProperty("background", "background-color", "#d6d6da");
  }

  const fillTweaks = [
    ["water", "fill-color", "#96989f"],
    ["park", "fill-color", "#c2c2c6"],
    ["landcover_wood", "fill-color", "#bdbdc2"],
    ["landuse_residential", "fill-color", "#c4c4c8"],
    ["landcover_ice_shelf", "fill-color", "#d0d0d4"],
    ["landcover_glacier", "fill-color", "#d0d0d4"],
    ["aeroway-area", "fill-color", "#babac0"],
    ["road_area_pier", "fill-color", "#b2b2b8"],
  ];

  for (const [id, prop, color] of fillTweaks) {
    if (map.getLayer(id)) {
      try {
        map.setPaintProperty(id, prop, color);
      } catch {
        /* layer paint may use data-driven expressions */
      }
    }
  }

  const lineTweaks = [["waterway", "line-color", "hsl(0, 0%, 74%)"]];
  for (const [id, prop, val] of lineTweaks) {
    if (map.getLayer(id)) {
      try {
        map.setPaintProperty(id, prop, val);
      } catch {
        /* ignore */
      }
    }
  }

  const labelTweaks = [
    ["water_name_point_label", "text-color", "#5c5e66"],
    ["water_name_line_label", "text-color", "#5c5e66"],
  ];
  for (const [id, prop, val] of labelTweaks) {
    if (map.getLayer(id)) {
      try {
        map.setPaintProperty(id, prop, val);
      } catch {
        /* ignore */
      }
    }
  }

  if (map.getLayer("building")) {
    map.setPaintProperty("building", "fill-color", BUILDING_FILL);
    map.setPaintProperty("building", "fill-opacity", BUILDING_OPACITY);
    map.setPaintProperty("building", "fill-outline-color", BUILDING_OUTLINE);
  }
}

function enhanceBuildings3d(map) {
  if (!map.getLayer(LAYER_BUILDING_3D)) return;

  map.setPaintProperty(LAYER_BUILDING_3D, "fill-extrusion-color", BUILDING_FILL);
  map.setPaintProperty(LAYER_BUILDING_3D, "fill-extrusion-opacity", BUILDING_OPACITY);
  map.setPaintProperty(LAYER_BUILDING_3D, "fill-extrusion-height", [
    "coalesce",
    ["get", "render_height"],
    ["get", "height"],
    12,
  ]);
  map.setPaintProperty(LAYER_BUILDING_3D, "fill-extrusion-base", [
    "coalesce",
    ["get", "render_min_height"],
    ["get", "min_height"],
    0,
  ]);
}

/** Flat footprints z12–14 only while 3D view is on (handoff to extrusions); full range in 2D */
function syncBuildingFootprintZoomRange(map) {
  if (!map.getLayer("building")) return;

  if (view3d && map.getLayer(LAYER_BUILDING_3D)) {
    map.setLayerZoomRange("building", 12, 14);
  } else {
    map.setLayerZoomRange("building", 12, 24);
  }
}

/** Show extruded buildings only in 3D view mode */
function applyBuildingsForViewMode(map) {
  if (!map.isStyleLoaded()) return;

  const has3d = map.getLayer(LAYER_BUILDING_3D);

  if (view3d) {
    if (has3d) {
      map.setLayoutProperty(LAYER_BUILDING_3D, "visibility", "visible");
    }
    if (
      typeof THREE !== "undefined" &&
      trackCageSpec &&
      !map.getLayer(LAYER_TRACK_CAGE)
    ) {
      try {
        map.addLayer(
          createTrackCageCustomLayer(trackCageSpec),
          "user-track-line-outline",
        );
      } catch (e) {
        console.warn("Track 3D cage layer failed:", e);
      }
    }
  } else {
    if (has3d) {
      map.setLayoutProperty(LAYER_BUILDING_3D, "visibility", "none");
    }
    if (map.getLayer(LAYER_TRACK_CAGE)) {
      map.removeLayer(LAYER_TRACK_CAGE);
    }
    if (map.getLayer(LAYER_TRACK_BOX_3D)) {
      map.setLayoutProperty(LAYER_TRACK_BOX_3D, "visibility", "none");
    }
  }

  if (view3d && map.getLayer(LAYER_TRACK_BOX_3D)) {
    map.setLayoutProperty(LAYER_TRACK_BOX_3D, "visibility", "visible");
  }

  syncBuildingFootprintZoomRange(map);
}

/** Planar vs Three dimensional — mutually exclusive pressed state */
function syncViewModeButtons(btnPlanar, btnThreeDimensional) {
  if (!btnPlanar || !btnThreeDimensional) return;
  const planar = !view3d;
  btnPlanar.setAttribute("aria-pressed", planar ? "true" : "false");
  btnPlanar.classList.toggle("map-tool-btn--on", planar);
  btnThreeDimensional.setAttribute("aria-pressed", view3d ? "true" : "false");
  btnThreeDimensional.classList.toggle("map-tool-btn--on", view3d);
}

/** Great-circle distance between two WGS84 points, meters */
function haversineMeters(lon1, lat1, lon2, lat2) {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * @returns {{ d: number, z: number }[] | null}
 */
function buildProfileSeriesFromGeoJson(geojson) {
  const raw = [];

  function pushLine(coords) {
    for (const p of coords) {
      const z = p.length >= 3 && Number.isFinite(p[2]) ? p[2] : null;
      raw.push({ lng: p[0], lat: p[1], z });
    }
  }

  for (const f of geojson.features || []) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "LineString") {
      pushLine(g.coordinates);
    } else if (g.type === "MultiLineString") {
      for (const line of g.coordinates) {
        pushLine(line);
      }
    }
  }

  if (raw.length === 0) return null;

  const hasZ = raw.some((r) => r.z != null && Number.isFinite(r.z));
  if (!hasZ) return null;

  let lastZ = 0;
  for (const r of raw) {
    if (r.z != null && Number.isFinite(r.z)) {
      lastZ = r.z;
    }
    r.zUse = lastZ;
  }

  let dist = 0;
  const dense = [{ d: 0, z: raw[0].zUse }];
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1];
    const b = raw[i];
    dist += haversineMeters(a.lng, a.lat, b.lng, b.lat);
    dense.push({ d: dist, z: b.zUse });
  }

  const maxPts = 450;
  if (dense.length <= maxPts) {
    return dense;
  }

  const out = [];
  const n = dense.length;
  for (let i = 0; i < maxPts; i++) {
    const t = i / (maxPts - 1);
    const idx = Math.round(t * (n - 1));
    out.push(dense[idx]);
  }
  return out;
}

function elevationGainM(series) {
  let g = 0;
  for (let i = 1; i < series.length; i++) {
    const dz = series[i].z - series[i - 1].z;
    if (dz > 0) g += dz;
  }
  return g;
}

function drawElevationProfile(series) {
  const canvas = document.getElementById("profile-canvas");
  const statsEl = document.getElementById("profile-stats");
  if (!canvas || !statsEl) return;

  if (!series || series.length < 2) {
    statsEl.textContent = "No elevation data in the track (needs Z per point).";
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const w = canvas.parentElement?.clientWidth || 300;
      canvas.width = w;
      canvas.height = 120;
      ctx.clearRect(0, 0, w, 120);
      ctx.fillStyle = "#666";
      ctx.font = "600 13px 'Roboto Mono', ui-monospace, monospace";
      ctx.fillText("No profile to draw.", 16, 64);
    }
    return;
  }

  const wrap = canvas.parentElement;
  const w = Math.max(280, wrap?.clientWidth || 300);
  const h = 168;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const dataMinZ = Math.min(...series.map((p) => p.z));
  const dataMaxZ = Math.max(...series.map((p) => p.z));
  let minZ = dataMinZ;
  let maxZ = dataMaxZ;
  const zSpan = maxZ - minZ;
  const zPad = Math.max(1.5, zSpan * 0.12);
  minZ -= zPad;
  maxZ += zPad;

  const maxD = series[series.length - 1].d;
  const padL = 50;
  const padR = 14;
  const padT = 12;
  const padB = 34;
  const cw = w - padL - padR;
  const ch = h - padT - padB;

  const xScale = maxD > 0 ? cw / maxD : 1;
  const yScale = maxZ > minZ ? ch / (maxZ - minZ) : 1;
  const toX = (d) => padL + d * xScale;
  const toY = (z) => padT + ch - (z - minZ) * yScale;

  ctx.beginPath();
  ctx.moveTo(toX(series[0].d), toY(series[0].z));
  for (let i = 1; i < series.length; i++) {
    ctx.lineTo(toX(series[i].d), toY(series[i].z));
  }
  ctx.lineTo(toX(series[series.length - 1].d), padT + ch);
  ctx.lineTo(toX(series[0].d), padT + ch);
  ctx.closePath();
  ctx.fillStyle = "rgba(208, 255, 0, 0.2)";
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(toX(series[0].d), toY(series[0].z));
  for (let i = 1; i < series.length; i++) {
    ctx.lineTo(toX(series[i].d), toY(series[i].z));
  }
  ctx.strokeStyle = TRACK_COLOR;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  ctx.fillStyle = "#444";
  ctx.font = "500 11px 'Roboto Mono', ui-monospace, monospace";
  ctx.textAlign = "left";
  ctx.fillText(`${Math.round(dataMinZ)} m`, 6, padT + ch);
  ctx.fillText(`${Math.round(dataMaxZ)} m`, 6, padT + 12);
  ctx.textAlign = "center";
  ctx.fillText("0", padL, h - 10);
  ctx.fillText(`${Math.round(maxD)} m`, padL + cw, h - 10);

  const gain = elevationGainM(series);
  statsEl.textContent = `Distance ${Math.round(maxD)} m · elevation ${Math.round(
    Math.min(...series.map((p) => p.z)),
  )}–${Math.round(Math.max(...series.map((p) => p.z)))} m · climb ~${Math.round(gain)} m`;
}

function setupElevationProfileUI(trackGeojson) {
  const panel = document.getElementById("profile-panel");
  const btn = document.getElementById("btn-vertical");
  const closeBtn = document.getElementById("profile-close");
  const series = buildProfileSeriesFromGeoJson(trackGeojson);

  function openPanel() {
    if (!panel || !btn) return;
    panel.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    btn.classList.add("map-tool-btn--on");
    requestAnimationFrame(() => drawElevationProfile(series));
  }

  function closePanel() {
    if (!panel || !btn) return;
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    btn.classList.remove("map-tool-btn--on");
  }

  if (btn) {
    btn.addEventListener("click", () => {
      if (panel?.hidden) {
        openPanel();
      } else {
        closePanel();
      }
    });
  }

  closeBtn?.addEventListener("click", closePanel);

  window.addEventListener("resize", () => {
    if (panel && !panel.hidden) {
      drawElevationProfile(series);
    }
  });
}

async function init() {
  const res = await fetch(TRACK_URL);
  if (!res.ok) {
    throw new Error(`Failed to load track GeoJSON: ${res.status}`);
  }
  const trackData = await res.json();

  /** Volumetric: EPSG:32236 points → WGS84 (circle layer) */
  let volPointsData = { type: "FeatureCollection", features: [] };
  try {
    const vr = await fetch(VOL_URL);
    if (vr.ok) {
      const rawVol = await vr.json();
      volPointsData = buildVolumetricPointsGeoJSON(rawVol);
    }
  } catch (e) {
    console.warn("Volumetric GeoJSON load failed:", e);
  }

  const volumetricPointsSnapshot = JSON.parse(JSON.stringify(volPointsData));

  setupElevationProfileUI(trackData);

  const map = new maplibregl.Map({
    container: "map",
    style: STYLE_URL,
    center: [114.18, 22.305],
    zoom: 15,
    pitch: 0,
    bearing: 0,
    maxPitch: 78,
    antialias: true,
    canvasContextAttributes: { antialias: true },
  });

  map.addControl(
    new maplibregl.NavigationControl({ visualizePitch: true }),
    "top-right",
  );
  map.addControl(
    new maplibregl.AttributionControl({ compact: true }),
    "bottom-right",
  );

  map.on("load", () => {
    const btnPlanar = document.getElementById("btn-planar");
    const btnThreeDimensional = document.getElementById("btn-three-dimensional");

    tuneGrayBasemap(map);
    ensureBuilding3dLayer(map);
    enhanceBuildings3d(map);
    applyBuildingsForViewMode(map);

    map.addSource("user-track", {
      type: "geojson",
      data: trackData,
    });

    const [w, s, e, n] = geojsonLineBbox(trackData);
    const trackCenter = [(w + e) / 2, (s + n) / 2];
    trackCageSpec = {
      w,
      s,
      e,
      n,
      heightM: TRACK_CAGE_HEIGHT_M,
      bufferM: TRACK_BOX_BUFFER_M,
    };

    const trackContainerData = buildTrackContainerLinesGeoJSON(w, s, e, n);
    if (trackContainerData.features.length > 0) {
      map.addSource(SOURCE_TRACK_CONTAINER, {
        type: "geojson",
        data: trackContainerData,
      });
      map.addLayer(
        {
          id: LAYER_TRACK_CONTAINER,
          type: "line",
          source: SOURCE_TRACK_CONTAINER,
          layout: {
            visibility: "visible",
            "line-cap": "round",
            "line-join": "round",
          },
          paint: {
            "line-color": TRACK_CONTAINER_COLOR,
            "line-opacity": 0.95,
            "line-width": [
              "match",
              ["get", "ring"],
              "outer",
              TRACK_CONTAINER_WIDTH_OUTER,
              "inner",
              TRACK_CONTAINER_WIDTH_INNER,
              2,
            ],
          },
        },
        "user-track-line-outline",
      );
    }

    const trackBox3dData = buildTrackBoxRingExtrusionGeoJSON(w, s, e, n);
    if (trackBox3dData.features.length > 0) {
      map.addSource(SOURCE_TRACK_BOX_3D, {
        type: "geojson",
        data: trackBox3dData,
      });
      map.addLayer(
        {
          id: LAYER_TRACK_BOX_3D,
          type: "fill-extrusion",
          source: SOURCE_TRACK_BOX_3D,
          layout: {
            visibility: "none",
          },
          paint: {
            "fill-extrusion-color": TRACK_BOX_3D_COLOR,
            "fill-extrusion-opacity": TRACK_BOX_3D_OPACITY,
            "fill-extrusion-height": ["get", "extrude_h"],
            "fill-extrusion-base": 0,
          },
        },
        "user-track-line-outline",
      );
    }

    map.addLayer({
      id: "user-track-line-outline",
      type: "line",
      source: "user-track",
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": "#ffffff",
        "line-width": 7,
        "line-opacity": TRACK_OUTLINE_OPACITY,
      },
    });

    map.addLayer({
      id: "user-track-line",
      type: "line",
      source: "user-track",
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": TRACK_COLOR,
        "line-width": 5,
        "line-opacity": TRACK_LINE_OPACITY,
      },
    });

    if (volPointsData.features.length > 0) {
      map.addSource(SOURCE_VOL_POINTS, {
        type: "geojson",
        data: volPointsData,
      });
      map.addLayer({
        id: LAYER_VOL_POINTS,
        type: "circle",
        source: SOURCE_VOL_POINTS,
        layout: {
          visibility: "none",
        },
        paint: {
          "circle-radius": ["get", "vol_radius"],
          "circle-color": ["get", "vol_color"],
          "circle-opacity": [
            "*",
            0.92,
            ["coalesce", ["get", "vol_pulse_opacity"], 1],
          ],
          "circle-stroke-width": 0,
        },
      });
    }

    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: { top: 24, bottom: 48, left: 48, right: 48 }, duration: 0, maxZoom: 17 },
    );

    map.resize();

    if (btnPlanar && btnThreeDimensional) {
      syncViewModeButtons(btnPlanar, btnThreeDimensional);
      btnPlanar.addEventListener("click", () => {
        if (!view3d) return;
        view3d = false;
        syncViewModeButtons(btnPlanar, btnThreeDimensional);
        applyBuildingsForViewMode(map);
        map.easeTo({
          pitch: 0,
          bearing: 0,
          duration: 900,
          essential: true,
        });
      });
      btnThreeDimensional.addEventListener("click", () => {
        if (view3d) return;
        view3d = true;
        syncViewModeButtons(btnPlanar, btnThreeDimensional);
        applyBuildingsForViewMode(map);
        map.easeTo({
          pitch: 58,
          bearing: -28,
          duration: 900,
          essential: true,
        });
      });
    }

    const btnVol = document.getElementById("btn-volumetric");
    if (btnVol) {
      if (volPointsData.features.length === 0) {
        btnVol.disabled = true;
        btnVol.title = "No volumetric data (check data/test_trans.geojson and proj4)";
      } else {
        btnVol.addEventListener("click", () => {
          if (!map.getLayer(LAYER_VOL_POINTS)) return;
          volumetricOn = !volumetricOn;
          btnVol.setAttribute("aria-pressed", volumetricOn ? "true" : "false");
          btnVol.classList.toggle("map-tool-btn--on", volumetricOn);
          map.setLayoutProperty(
            LAYER_VOL_POINTS,
            "visibility",
            volumetricOn ? "visible" : "none",
          );
          if (volumetricOn) {
            if (btnPlanar && btnThreeDimensional && !view3d) {
              view3d = true;
              syncViewModeButtons(btnPlanar, btnThreeDimensional);
              applyBuildingsForViewMode(map);
              map.easeTo({
                center: trackCenter,
                pitch: 58,
                bearing: -28,
                duration: 1100,
                essential: true,
              });
            } else {
              map.easeTo({
                center: trackCenter,
                duration: 900,
                essential: true,
              });
            }
            startVolumetricAnimation(map, volumetricPointsSnapshot);
          } else {
            stopVolumetricAnimation(map, volumetricPointsSnapshot);
          }
        });
      }
    }
  });

  window.addEventListener("resize", () => map.resize());
}

init().catch((err) => {
  console.error(err);
  const el = document.getElementById("map");
  if (el) {
    el.innerHTML = `<p style="padding:1rem;color:#c00;font-family:'Roboto Mono',ui-monospace,monospace;background:#fff;">Map error: ${err.message}</p>`;
  }
});
