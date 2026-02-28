const canvas = document.getElementById("gl");
const statusEl = document.getElementById("status");
const screenshotButton = document.getElementById("screenshot");

const gl =
  canvas.getContext("webgl", {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    powerPreference: "high-performance",
    premultipliedAlpha: false,
  }) ||
  canvas.getContext("experimental-webgl");

if (!gl) {
  throw new Error("WebGL is required for this simulation.");
}

const fragmentPrecision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
const precisionQualifier = fragmentPrecision && fragmentPrecision.precision > 0 ? "highp" : "mediump";

const state = {
  camera: {
    yaw: 0.18,
    pitch: 0.7,
    distance: 9.8,
    targetYaw: 0.18,
    targetPitch: 0.7,
    targetDistance: 9.8,
    yawVelocity: 0,
    pitchVelocity: 0,
    distanceVelocity: 0,
  },
  params: {
    spin: 0.2,
    mass: 0.6,
    tilt: 0.42,
    diskSize: 1.0,
    exposure: 1.12,
    temperature: 1.28,
    density: 1.18,
    lensing: 1.25,
    bloom: 0.52,
    stars: 3.4,
  },
  pointer: {
    active: false,
    x: 0,
    y: 0,
  },
  renderScale: 1,
  performance: {
    avgFrameMs: 16.7,
    qualityBias: 1,
    lastScaleAdjust: 0,
  },
};

function setStatus(message) {
  statusEl.textContent = message;
}

[
  ["spin", "spinValue", "spin"],
  ["mass", "massValue", "mass"],
  ["tilt", "tiltValue", "tilt"],
  ["diskSize", "diskSizeValue", "diskSize"],
  ["exposure", "exposureValue", "exposure"],
  ["temperature", "temperatureValue", "temperature"],
  ["density", "densityValue", "density"],
  ["lensing", "lensingValue", "lensing"],
  ["bloom", "bloomValue", "bloom"],
  ["stars", "starsValue", "stars"],
].forEach(([inputId, outputId, key]) => {
  const input = document.getElementById(inputId);
  const output = document.getElementById(outputId);
  const update = () => {
    state.params[key] = Number(input.value);
    output.value = Number(input.value).toFixed(2);
  };
  input.addEventListener("input", update);
  update();
});

const vertexSource = `
attribute vec2 a_position;
varying vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const fragmentSource = `
precision ${precisionQualifier} float;

varying vec2 v_uv;

uniform vec2 u_resolution;
uniform float u_time;
uniform vec4 u_camera;
uniform vec4 u_paramsA;
uniform vec4 u_paramsB;
uniform vec4 u_paramsC;

const int STEPS = 96;
const float FAR_PLANE = 54.0;
const float PI = 3.14159265359;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}

float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);

  float n000 = hash31(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash31(i + vec3(1.0, 1.0, 1.0));

  float nx00 = mix(n000, n100, f.x);
  float nx10 = mix(n010, n110, f.x);
  float nx01 = mix(n001, n101, f.x);
  float nx11 = mix(n011, n111, f.x);
  float nxy0 = mix(nx00, nx10, f.y);
  float nxy1 = mix(nx01, nx11, f.y);
  return mix(nxy0, nxy1, f.z);
}

float fbm(vec3 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 3; i++) {
    value += amplitude * noise3(p);
    p = p * 2.03 + vec3(17.0, 31.0, 11.0);
    amplitude *= 0.5;
  }
  return value;
}

float cubicRoot(float x) {
  return sign(x) * pow(abs(x), 1.0 / 3.0);
}

float kerrIsco(float spin) {
  float a = clamp(spin, 0.0, 0.999);
  float z1 = 1.0 + cubicRoot(1.0 - a * a) * (cubicRoot(1.0 + a) + cubicRoot(1.0 - a));
  float z2 = sqrt(3.0 * a * a + z1 * z1);
  return 3.0 + z2 - sqrt(max(0.0, (3.0 - z1) * (3.0 + z1 + 2.0 * z2)));
}

mat3 rotateY(float a) {
  float s = sin(a);
  float c = cos(a);
  return mat3(
    c, 0.0, -s,
    0.0, 1.0, 0.0,
    s, 0.0, c
  );
}

mat3 rotateX(float a) {
  float s = sin(a);
  float c = cos(a);
  return mat3(
    1.0, 0.0, 0.0,
    0.0, c, -s,
    0.0, s, c
  );
}

vec3 temperatureColor(float t) {
  float x = clamp(t / 19000.0, 0.0, 1.0);
  vec3 cool = vec3(1.25, 0.42, 0.09);
  vec3 warm = vec3(1.45, 0.96, 0.58);
  vec3 hot = vec3(0.72, 0.86, 1.24);
  return mix(mix(cool, warm, smoothstep(0.0, 0.48, x)), hot, smoothstep(0.48, 1.0, x));
}

float diskTemperature(float r, float innerEdge, float temperatureBoost) {
  float x = max(r / innerEdge, 1.0);
  float profile = pow(x, -0.75) * max(0.0, 1.0 - sqrt(innerEdge / max(r, innerEdge + 0.001)));
  return (17500.0 * temperatureBoost) * pow(max(profile, 0.0), 0.25) + 1400.0;
}

float diskThickness(float r, float innerEdge, float outerEdge) {
  float t = clamp((r - innerEdge) / max(outerEdge - innerEdge, 0.001), 0.0, 1.0);
  return mix(0.03, 0.26, t * t);
}

vec3 starField(vec3 rd, float density) {
  vec2 sphereUv = vec2(atan(rd.z, rd.x) / (2.0 * PI) + 0.5, asin(clamp(rd.y, -1.0, 1.0)) / PI + 0.5);
  vec2 grid = vec2(680.0, 400.0) * density;
  vec2 uv = sphereUv * grid;
  vec2 cell = floor(uv);
  vec2 local = fract(uv) - 0.5;
  vec3 stars = vec3(0.007, 0.010, 0.018);

  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 offset = vec2(float(x), float(y));
      vec2 id = cell + offset;
      float seed = hash21(id);
      float rarity = mix(0.991, 0.936, clamp((density - 1.2) / 3.0, 0.0, 1.0));
      if (seed > rarity) {
        vec2 p = vec2(hash21(id + 1.7), hash21(id + 7.9)) - 0.5;
        vec2 delta = local - offset - p;
        float d = length(delta);
        float core = 1.0 - smoothstep(0.0, 0.24, d);
        float halo = 1.0 - smoothstep(0.0, 0.68, d);
        vec3 tint = mix(vec3(0.68, 0.82, 1.0), vec3(1.0, 0.82, 0.64), hash21(id + 9.1));
        stars += tint * (core * 1.35 + halo * 0.14) * (0.38 + seed * 1.8);
      }
    }
  }

  vec3 galaxyAxis = normalize(vec3(0.74, 0.18, -0.64));
  float galaxyLat = dot(rd, galaxyAxis);
  float bandWide = exp(-pow((galaxyLat + 0.05 * sin(rd.x * 7.0)) / 0.28, 2.0));
  float bandCore = exp(-pow((galaxyLat + 0.03 * cos(rd.z * 8.0)) / 0.11, 2.0));
  float dustLane = 1.0 - smoothstep(0.0, 0.06, abs(galaxyLat + 0.04 * sin(rd.z * 12.0)));

  stars += vec3(0.055, 0.085, 0.145) * bandWide;
  stars += vec3(0.105, 0.145, 0.235) * bandCore * (0.7 + 0.3 * sin(sphereUv.x * 18.0));
  stars *= 1.0 - dustLane * 0.26;
  stars += vec3(0.03, 0.024, 0.07) * bandWide * (0.5 + 0.5 * sin(sphereUv.x * 22.0 + sphereUv.y * 9.0));

  vec3 galaxyAxis2 = normalize(vec3(-0.56, 0.46, 0.69));
  float galaxyLat2 = dot(rd, galaxyAxis2);
  float bandWide2 = exp(-pow((galaxyLat2 + 0.04 * cos(rd.y * 6.0)) / 0.24, 2.0));
  float bandCore2 = exp(-pow((galaxyLat2 + 0.03 * sin(rd.x * 9.0 - rd.z * 4.0)) / 0.085, 2.0));
  float dustLane2 = 1.0 - smoothstep(0.0, 0.045, abs(galaxyLat2 + 0.03 * sin(rd.z * 10.0)));

  stars += vec3(0.08, 0.055, 0.04) * bandWide2;
  stars += vec3(0.16, 0.11, 0.07) * bandCore2 * (0.65 + 0.35 * cos(sphereUv.x * 13.0 + sphereUv.y * 8.0));
  stars *= 1.0 - dustLane2 * 0.18;
  stars += vec3(0.045, 0.02, 0.018) * bandWide2 * (0.45 + 0.55 * sin(sphereUv.x * 17.0 - sphereUv.y * 11.0));

  stars *= 0.82;
  return stars;
}

vec3 postColor(vec3 color, vec2 uv, float bloom, float grain) {
  float vignette = 1.0 - smoothstep(0.24, 1.32, length(uv));
  color *= vignette;
  color += bloom * vec3(0.24, 0.16, 0.08);
  color += grain * vec3(0.06, 0.045, 0.03);
  color = color / (vec3(1.0) + color);
  return pow(max(color, vec3(0.0)), vec3(1.0 / 2.2));
}

void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - u_resolution.xy) / min(u_resolution.x, u_resolution.y);
  float yaw = u_camera.x;
  float pitch = u_camera.y;
  float distance = u_camera.z;

  float mass = u_paramsA.x;
  float spin = u_paramsA.y;
  float diskTiltAmount = u_paramsA.z;
  float diskSize = u_paramsA.w;

  float exposure = u_paramsB.x;
  float starDensity = u_paramsB.y;
  float temperatureBoost = u_paramsB.z;
  float densityBoost = u_paramsB.w;

  float bloomStrength = u_paramsC.x;
  float lensingStrength = u_paramsC.y;

  vec3 bhPos = vec3(0.0);
  vec3 orbitOffset = vec3(
    cos(pitch) * sin(yaw),
    sin(pitch),
    cos(pitch) * cos(yaw)
  ) * distance;
  vec3 cameraPos = bhPos + orbitOffset;
  vec3 forward = normalize(bhPos - cameraPos);
  vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
  if (length(right) < 0.001) {
    right = vec3(1.0, 0.0, 0.0);
  }
  vec3 up = normalize(cross(right, forward));
  vec3 dir = normalize(forward + uv.x * right + uv.y * up + 0.05 * uv.x * uv.x * forward);

  if (mass <= 0.0001) {
    vec3 skyOnly = starField(dir, starDensity) * exposure;
    skyOnly = skyOnly / (vec3(1.0) + skyOnly);
    gl_FragColor = vec4(pow(max(skyOnly, vec3(0.0)), vec3(1.0 / 2.2)), 1.0);
    return;
  }

  float horizonRadius = mass * (1.0 + sqrt(max(0.0, 1.0 - spin * spin)));
  float photonSphere = 3.0 * mass;
  float innerEdge = max(kerrIsco(spin) * mass, horizonRadius * 1.06) * diskSize;
  float outerEdge = max(innerEdge + 0.4, 10.8 * mass * diskSize);
  float diskTime = u_time * (0.72 + 0.28 * spin);

  mat3 diskTilt = rotateY(0.16) * rotateX(diskTiltAmount);
  vec3 diskNormal = normalize(diskTilt * vec3(0.0, 1.0, 0.0));
  vec3 diskAxisU = normalize(cross(vec3(0.22, 1.0, 0.0), diskNormal));
  if (length(diskAxisU) < 0.001) {
    diskAxisU = normalize(cross(vec3(1.0, 0.0, 0.0), diskNormal));
  }
  vec3 diskAxisV = normalize(cross(diskNormal, diskAxisU));

  vec3 pos = cameraPos;
  vec3 emission = vec3(0.0);
  float transmittance = 1.0;
  float traveled = 0.0;
  float closestApproach = distance;
  float shadowCapture = 0.0;

  for (int i = 0; i < STEPS; i++) {
    vec3 toBH = bhPos - pos;
    float r = length(toBH);
    closestApproach = min(closestApproach, r);

    if (r < horizonRadius) {
      transmittance = 0.0;
      shadowCapture = 1.0;
      break;
    }

    float rs = 2.0 * mass;
    float stepSize = clamp(r * 0.04, 0.024, 0.24);
    vec3 radial = toBH / max(r, 0.0001);
    float schwarzschild = rs / max(r, rs + 0.001);
    float grav = lensingStrength * mass / max(r * r, 0.28);
    grav *= 1.05 + 3.1 * schwarzschild + 10.5 * schwarzschild * schwarzschild;
    vec3 frameDrag = spin * vec3(-toBH.z, 0.0, toBH.x) / max(r * r * r, 0.45);

    vec3 bend = radial * grav + frameDrag * (1.4 + 1.2 * lensingStrength);
    vec3 halfDir = normalize(dir + bend * stepSize * 0.5);
    vec3 nextPos = pos + halfDir * stepSize;

    vec3 local = (pos + nextPos) * 0.5 - bhPos;
    vec2 diskCoord = vec2(dot(local, diskAxisU), dot(local, diskAxisV));
    float diskR = length(diskCoord);

    if (diskR > innerEdge && diskR < outerEdge) {
      float height = abs(dot(local, diskNormal));
      float thickness = max(0.012, diskThickness(diskR, innerEdge, outerEdge) * diskSize);
      if (height < thickness * 3.2) {
        float vertical = exp(-(height * height) / max(2.0 * thickness * thickness, 0.0002));
        float radialMask = smoothstep(innerEdge, innerEdge + 0.45, diskR) * (1.0 - smoothstep(outerEdge - 1.4, outerEdge, diskR));
        float phi = atan(diskCoord.y, diskCoord.x);
        float turbulence = fbm(vec3(diskCoord * 3.4, diskTime * 0.42 + diskR * 0.2));
        float clumps = 0.52 + 0.48 * noise3(vec3(diskCoord * 7.2, diskTime * 0.68 - phi * 1.7));
        float spiral = 0.5 + 0.5 * sin(phi * 2.0 - diskTime * (1.1 + 0.3 * spin) - diskR * 4.2);
        float density = densityBoost * vertical * radialMask * mix(0.52, 1.14, turbulence) * mix(0.7, 1.18, clumps) * mix(0.88, 1.18, spiral);

        if (density > 0.0001) {
          vec3 radialDir = normalize(diskAxisU * diskCoord.x + diskAxisV * diskCoord.y);
          vec3 tangent = normalize(cross(diskNormal, radialDir));
          float orbital = sqrt(mass / max(diskR, innerEdge + 0.02));
          float beta = clamp(orbital * (0.36 + 0.2 * spin), 0.0, 0.82);
          float gamma = inversesqrt(max(0.06, 1.0 - beta * beta));
          float doppler = gamma * (1.0 + dot(tangent, -halfDir) * beta);
          float gravRedshift = sqrt(max(0.08, 1.0 - rs / max(diskR, innerEdge + 0.02)));
          float gShift = max(0.22, doppler * gravRedshift);

          float temperature = diskTemperature(diskR, innerEdge, temperatureBoost) * gShift;
          vec3 source = temperatureColor(temperature);
          float emissivity = density * stepSize * (1.2 + 1.1 * pow(innerEdge / max(diskR, innerEdge), 0.85));
          float absorb = 1.0 - exp(-emissivity * 1.35);

          emission += transmittance * source * absorb;
          transmittance *= exp(-emissivity * (0.55 + 0.25 * density));
        }
      }
    }

    dir = normalize(halfDir + bend * stepSize * 0.5);
    pos = nextPos;
    traveled += stepSize;

    if (traveled > FAR_PLANE || transmittance < 0.008) {
      break;
    }
  }

  float naturalShadow = max(
    shadowCapture,
    1.0 - smoothstep(horizonRadius * 1.04, photonSphere * (1.18 + 0.16 * lensingStrength), closestApproach)
  );
  vec3 sky = starField(dir, starDensity) * (1.0 - 0.96 * naturalShadow);
  vec3 finalColor = emission + sky * transmittance;
  finalColor *= exposure;

  float bright = max(max(finalColor.r, finalColor.g), finalColor.b);
  float glow = bloomStrength * smoothstep(0.6, 1.5, bright);

  float chroma = smoothstep(0.44, 1.22, length(uv));
  finalColor.r += chroma * 0.014;
  finalColor.b -= chroma * 0.009;

  float grain = hash21(gl_FragCoord.xy + u_time) * 0.04;
  gl_FragColor = vec4(postColor(finalColor, uv, glow, grain), 1.0);
}
`;

function createShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Shader compilation failed.";
    gl.deleteShader(shader);
    throw new Error(message);
  }

  return shader;
}

function createProgram(vertexShader, fragmentShader) {
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "Program link failed.";
    gl.deleteProgram(program);
    throw new Error(message);
  }

  return program;
}

const program = createProgram(
  createShader(gl.VERTEX_SHADER, vertexSource),
  createShader(gl.FRAGMENT_SHADER, fragmentSource),
);

const positionBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
gl.bufferData(
  gl.ARRAY_BUFFER,
  new Float32Array([
    -1, -1,
    1, -1,
    -1, 1,
    -1, 1,
    1, -1,
    1, 1,
  ]),
  gl.STATIC_DRAW,
);

const locations = {
  position: gl.getAttribLocation(program, "a_position"),
  resolution: gl.getUniformLocation(program, "u_resolution"),
  time: gl.getUniformLocation(program, "u_time"),
  camera: gl.getUniformLocation(program, "u_camera"),
  paramsA: gl.getUniformLocation(program, "u_paramsA"),
  paramsB: gl.getUniformLocation(program, "u_paramsB"),
  paramsC: gl.getUniformLocation(program, "u_paramsC"),
};

function isMobileLike() {
  return matchMedia("(pointer: coarse)").matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function updateRenderScale() {
  const mobileLike = isMobileLike();
  const dpr = Math.min(window.devicePixelRatio || 1, mobileLike ? 1.0 : 1.25);
  const baseScale = mobileLike ? 0.58 : 0.72;
  const smallerDeviceScale = window.innerWidth < 700 ? 0.5 : baseScale;
  const qualityFloor = mobileLike ? 0.78 : 0.72;
  const adaptiveQuality = Math.max(qualityFloor, Math.min(1, state.performance.qualityBias));
  state.renderScale = smallerDeviceScale * dpr * adaptiveQuality;
  const width = Math.max(320, Math.floor(window.innerWidth * state.renderScale));
  const height = Math.max(180, Math.floor(window.innerHeight * state.renderScale));
  canvas.width = width;
  canvas.height = height;
  gl.viewport(0, 0, width, height);
}

function integrateCamera(dt) {
  const cam = state.camera;
  cam.targetYaw += cam.yawVelocity * dt * 60;
  cam.targetPitch = Math.max(-1.18, Math.min(1.18, cam.targetPitch + cam.pitchVelocity * dt * 60));
  cam.targetDistance = Math.max(5.8, Math.min(18, cam.targetDistance + cam.distanceVelocity * dt * 60));

  cam.yawVelocity *= Math.exp(-dt * 7.5);
  cam.pitchVelocity *= Math.exp(-dt * 7.5);
  cam.distanceVelocity *= Math.exp(-dt * 9.0);

  const follow = 1 - Math.exp(-dt * 8.0);
  cam.yaw += (cam.targetYaw - cam.yaw) * follow;
  cam.pitch += (cam.targetPitch - cam.pitch) * follow;
  cam.distance += (cam.targetDistance - cam.distance) * (1 - Math.exp(-dt * 7.0));
}

canvas.addEventListener("pointerdown", (event) => {
  state.pointer.active = true;
  state.pointer.x = event.clientX;
  state.pointer.y = event.clientY;
  if (canvas.setPointerCapture) {
    canvas.setPointerCapture(event.pointerId);
  }
});

canvas.addEventListener("pointermove", (event) => {
  if (!state.pointer.active) {
    return;
  }

  const dx = event.clientX - state.pointer.x;
  const dy = event.clientY - state.pointer.y;
  state.pointer.x = event.clientX;
  state.pointer.y = event.clientY;

  state.camera.yawVelocity -= dx * 0.00024;
  state.camera.pitchVelocity -= dy * 0.00024;
});

function releasePointer(event) {
  state.pointer.active = false;
  if (typeof event.pointerId === "number" && canvas.releasePointerCapture && canvas.hasPointerCapture && canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
}

canvas.addEventListener("pointerup", releasePointer);
canvas.addEventListener("pointercancel", releasePointer);
canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    state.camera.distanceVelocity += event.deltaY * 0.0005;
  },
  { passive: false },
);

screenshotButton.addEventListener("click", async () => {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) {
    setStatus("Screenshot failed");
    return;
  }

  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `blackhole-${Date.now()}.png`;
  link.click();
  URL.revokeObjectURL(link.href);
  setStatus("Screenshot saved");
});

gl.disable(gl.DEPTH_TEST);
gl.disable(gl.CULL_FACE);
gl.disable(gl.BLEND);

let lastTime = performance.now();

function render(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;
  const frameMs = dt * 1000;
  const qualityFloor = isMobileLike() ? 0.78 : 0.72;
  state.performance.avgFrameMs += (frameMs - state.performance.avgFrameMs) * 0.08;

  if (now - state.performance.lastScaleAdjust > 700) {
    if (state.performance.avgFrameMs > 19.5 && state.performance.qualityBias > qualityFloor) {
      state.performance.qualityBias = Math.max(qualityFloor, state.performance.qualityBias - 0.08);
      state.performance.lastScaleAdjust = now;
      updateRenderScale();
    } else if (state.performance.avgFrameMs < 14.2 && state.performance.qualityBias < 1.0) {
      state.performance.qualityBias = Math.min(1.0, state.performance.qualityBias + 0.04);
      state.performance.lastScaleAdjust = now;
      updateRenderScale();
    }
  }

  integrateCamera(dt);

  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(program);

  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.enableVertexAttribArray(locations.position);
  gl.vertexAttribPointer(locations.position, 2, gl.FLOAT, false, 0, 0);

  gl.uniform2f(locations.resolution, canvas.width, canvas.height);
  gl.uniform1f(locations.time, now * 0.001);
  gl.uniform4f(locations.camera, state.camera.yaw, state.camera.pitch, state.camera.distance, 0);
  gl.uniform4f(locations.paramsA, state.params.mass, state.params.spin, state.params.tilt, state.params.diskSize);
  gl.uniform4f(
    locations.paramsB,
    state.params.exposure,
    state.params.stars,
    state.params.temperature,
    state.params.density,
  );
  gl.uniform4f(locations.paramsC, state.params.bloom, state.params.lensing, 0, 0);

  gl.drawArrays(gl.TRIANGLES, 0, 6);
  requestAnimationFrame(render);
}

canvas.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  setStatus("WebGL context lost");
});

canvas.addEventListener("webglcontextrestored", () => {
  setStatus("WebGL context restored, reload if needed");
});

window.addEventListener("resize", updateRenderScale);
updateRenderScale();
setStatus(`GPU renderer ready (${precisionQualifier}, WebGL 1)`);
requestAnimationFrame(render);
