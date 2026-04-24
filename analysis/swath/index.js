import { createLegacyMetadata, createSwathPluginManifest } from "./manifest.js";
import { createSwathFlowMethodHandlers as createSwathFlowMethodHandlersRuntime } from "./flowHandlers.js";

const WGS84_A = 6378137.0;
const WGS84_B = 6356752.3142451793;
const WGS84_A2 = WGS84_A * WGS84_A;
const WGS84_B2 = WGS84_B * WGS84_B;
const WGS84_E2 = 1.0 - WGS84_B2 / WGS84_A2;
const WGS84_EP2 = WGS84_A2 / WGS84_B2 - 1.0;
const FOOTPRINT_VERTEX_SIZE = 64;
const GROUND_TRACK_POINT_SIZE = 64;
const SWATH_SEGMENT_SIZE = 64;
const STATE_RECORD_SIZE = 64;
const SENSOR_RECORD_SIZE = 576;
const EMBEDDED_MANIFEST_SOURCE = "embedded-flatbuffer";

const STATIC_MANIFEST = createSwathPluginManifest();
const STATIC_METADATA = createLegacyMetadata(STATIC_MANIFEST, {
  encrypted: false,
  requiresProtection: false,
});

function magnitude(vector) {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function dot(left, right) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function cross(left, right) {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function add(left, right) {
  return {
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z,
  };
}

function subtract(left, right) {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  };
}

function scale(vector, scalar) {
  return {
    x: vector.x * scalar,
    y: vector.y * scalar,
    z: vector.z * scalar,
  };
}

function normalize(vector) {
  const length = magnitude(vector);
  if (length <= 0.0) {
    return { x: 0.0, y: 0.0, z: 0.0 };
  }
  return scale(vector, 1.0 / length);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function rotateAroundAxis(vector, axis, angle) {
  if (!Number.isFinite(angle) || Math.abs(angle) < 1e-15) {
    return vector;
  }
  const unitAxis = normalize(axis);
  const cosAngle = Math.cos(angle);
  const sinAngle = Math.sin(angle);
  const axisDot = dot(unitAxis, vector);
  return add(
    add(scale(vector, cosAngle), scale(cross(unitAxis, vector), sinAngle)),
    scale(unitAxis, axisDot * (1.0 - cosAngle)),
  );
}

function geodeticToEcef(longitude, latitude, altitude = 0.0) {
  const cosLat = Math.cos(latitude);
  const sinLat = Math.sin(latitude);
  const cosLon = Math.cos(longitude);
  const sinLon = Math.sin(longitude);
  const primeVertical = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinLat * sinLat);
  return {
    x: (primeVertical + altitude) * cosLat * cosLon,
    y: (primeVertical + altitude) * cosLat * sinLon,
    z: (primeVertical * (1.0 - WGS84_E2) + altitude) * sinLat,
  };
}

function ecefToGeodetic(position) {
  const x = position.x;
  const y = position.y;
  const z = position.z;
  const p = Math.hypot(x, y);
  const longitude = Math.atan2(y, x);
  const theta = Math.atan2(z * WGS84_A, p * WGS84_B);
  const sinTheta = Math.sin(theta);
  const cosTheta = Math.cos(theta);
  const latitude = Math.atan2(
    z + WGS84_EP2 * WGS84_B * sinTheta * sinTheta * sinTheta,
    p - WGS84_E2 * WGS84_A * cosTheta * cosTheta * cosTheta,
  );
  const sinLat = Math.sin(latitude);
  const primeVertical = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinLat * sinLat);
  const altitude = p / Math.max(Math.cos(latitude), 1e-12) - primeVertical;
  return {
    longitude,
    latitude,
    altitude,
  };
}

function haversineDistance(left, right, radius = WGS84_A) {
  const dLat = right.latitude - left.latitude;
  const dLon = right.longitude - left.longitude;
  const sinLat = Math.sin(dLat * 0.5);
  const sinLon = Math.sin(dLon * 0.5);
  const a =
    sinLat * sinLat +
    Math.cos(left.latitude) * Math.cos(right.latitude) * sinLon * sinLon;
  const c = 2.0 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(1.0 - a, 0.0)));
  return radius * c;
}

function normalizeAngle(angle) {
  let value = angle;
  while (value <= -Math.PI) {
    value += Math.PI * 2.0;
  }
  while (value > Math.PI) {
    value -= Math.PI * 2.0;
  }
  return value;
}

function decimateVertices(vertices, maxVertices) {
  const limit = Number(maxVertices);
  if (!Number.isFinite(limit) || limit < 2 || vertices.length <= limit) {
    return vertices;
  }

  const result = [];
  const stride = (vertices.length - 1) / (limit - 1);
  for (let index = 0; index < limit; index += 1) {
    const sourceIndex =
      index === limit - 1 ? vertices.length - 1 : Math.round(index * stride);
    result.push(vertices[sourceIndex]);
  }
  return result;
}

function headingBetween(left, right) {
  const dLon = normalizeAngle(right.longitude - left.longitude);
  const y = Math.sin(dLon) * Math.cos(right.latitude);
  const x =
    Math.cos(left.latitude) * Math.sin(right.latitude) -
    Math.sin(left.latitude) * Math.cos(right.latitude) * Math.cos(dLon);
  return Math.atan2(y, x);
}

function createEnuFrame(longitude, latitude) {
  const sinLon = Math.sin(longitude);
  const cosLon = Math.cos(longitude);
  const sinLat = Math.sin(latitude);
  const cosLat = Math.cos(latitude);
  return {
    east: { x: -sinLon, y: cosLon, z: 0.0 },
    north: {
      x: -sinLat * cosLon,
      y: -sinLat * sinLon,
      z: cosLat,
    },
    up: {
      x: cosLat * cosLon,
      y: cosLat * sinLon,
      z: sinLat,
    },
  };
}

function pointOnSegment(point, start, end) {
  const crossValue =
    (point.latitude - start.latitude) * (end.longitude - start.longitude) -
    (point.longitude - start.longitude) * (end.latitude - start.latitude);
  if (Math.abs(crossValue) > 1e-12) {
    return false;
  }
  const dotValue =
    (point.longitude - start.longitude) * (end.longitude - start.longitude) +
    (point.latitude - start.latitude) * (end.latitude - start.latitude);
  if (dotValue < 0.0) {
    return false;
  }
  const segmentLengthSquared =
    (end.longitude - start.longitude) * (end.longitude - start.longitude) +
    (end.latitude - start.latitude) * (end.latitude - start.latitude);
  return dotValue <= segmentLengthSquared;
}

function pointInPolygon(point, vertices) {
  if (!Array.isArray(vertices) || vertices.length < 3) {
    return false;
  }
  let inside = false;
  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    if (pointOnSegment(point, current, next)) {
      return true;
    }
    const intersects =
      current.latitude > point.latitude !== next.latitude > point.latitude;
    if (!intersects) {
      continue;
    }
    const intersectLon =
      ((next.longitude - current.longitude) *
        (point.latitude - current.latitude)) /
        (next.latitude - current.latitude) +
      current.longitude;
    if (point.longitude <= intersectLon) {
      inside = !inside;
    }
  }
  return inside;
}

function readFloat64(bytes, offset) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getFloat64(offset, true);
}

function readUint32(bytes, offset) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, true);
}

function writeFloat64(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setFloat64(
    offset,
    value,
    true,
  );
}

function writeUint32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
    offset,
    value,
    true,
  );
}

function normalizeTarget(target = {}) {
  return {
    longitude: Number(target.longitude ?? 0.0),
    latitude: Number(target.latitude ?? 0.0),
    altitude: Number(target.altitude ?? 0.0),
  };
}

function normalizeSensorConfig(sensor = {}) {
  const rawType = String(
    sensor.sensorType ?? sensor.sensor_type ?? "conical",
  ).toLowerCase();
  const sensorType =
    rawType === "rectangular" || rawType === "custom" ? rawType : "conical";
  const customDirections = Array.isArray(sensor.customDirections)
    ? sensor.customDirections.map((entry) => ({
        x: Number(entry?.x ?? 0.0),
        y: Number(entry?.y ?? 0.0),
        z: Number(entry?.z ?? 1.0),
      }))
    : [];

  return {
    sensorType,
    halfAngleRad: Number(sensor.halfAngleRad ?? 0.1),
    alongTrackFovRad: Number(sensor.alongTrackFovRad ?? 0.05),
    crossTrackFovRad: Number(sensor.crossTrackFovRad ?? 0.2),
    angularResolutionRad: Number(
      sensor.angularResolutionRad ?? Math.PI / 180.0,
    ),
    rollRad: Number(sensor.rollRad ?? 0.0),
    pitchRad: Number(sensor.pitchRad ?? 0.0),
    yawRad: Number(sensor.yawRad ?? 0.0),
    minRangeM: Number(sensor.minRangeM ?? 0.0),
    maxRangeM: Number(sensor.maxRangeM ?? 1.0e9),
    minElevationRad: Number(sensor.minElevationRad ?? 0.0),
    maxElevationRad: Number(sensor.maxElevationRad ?? Math.PI * 0.5),
    customDirections,
  };
}

function decodeState(bytes, offset = 0) {
  return {
    position: {
      x: readFloat64(bytes, offset),
      y: readFloat64(bytes, offset + 8),
      z: readFloat64(bytes, offset + 16),
    },
    velocity: {
      x: readFloat64(bytes, offset + 24),
      y: readFloat64(bytes, offset + 32),
      z: readFloat64(bytes, offset + 40),
    },
    julianDate: readFloat64(bytes, offset + 48),
  };
}

function decodeSensor(bytes, offset = 0) {
  const sensorTypeValue = readUint32(bytes, offset);
  const sensorType =
    sensorTypeValue === 1
      ? "rectangular"
      : sensorTypeValue === 2
        ? "custom"
        : "conical";
  const customDirectionCount = readUint32(bytes, offset + 8);
  const customDirections = [];
  for (let index = 0; index < customDirectionCount; index += 1) {
    const base = offset + 160 + index * 24;
    customDirections.push({
      x: readFloat64(bytes, base),
      y: readFloat64(bytes, base + 8),
      z: readFloat64(bytes, base + 16),
    });
  }
  return normalizeSensorConfig({
    sensorType,
    halfAngleRad: readFloat64(bytes, offset + 16),
    alongTrackFovRad: readFloat64(bytes, offset + 24),
    crossTrackFovRad: readFloat64(bytes, offset + 32),
    angularResolutionRad: readFloat64(bytes, offset + 40),
    rollRad: readFloat64(bytes, offset + 48),
    pitchRad: readFloat64(bytes, offset + 56),
    yawRad: readFloat64(bytes, offset + 64),
    minRangeM: readFloat64(bytes, offset + 72),
    maxRangeM: readFloat64(bytes, offset + 80),
    minElevationRad: readFloat64(bytes, offset + 88),
    maxElevationRad: readFloat64(bytes, offset + 96),
    customDirections,
  });
}

function decodeTarget(bytes, offset = 0) {
  return normalizeTarget({
    longitude: readFloat64(bytes, offset),
    latitude: readFloat64(bytes, offset + 8),
    altitude: readFloat64(bytes, offset + 16),
  });
}

function decodeStateBatch(bytes, offset = 0) {
  const count = readUint32(bytes, offset);
  const states = [];
  let cursor = offset + 16;
  for (let index = 0; index < count; index += 1) {
    states.push(decodeState(bytes, cursor));
    cursor += STATE_RECORD_SIZE;
  }
  return states;
}

function composeSensorAxes(frame, sensor) {
  let xAxis = frame.alongTrack;
  let yAxis = frame.crossTrack;
  let zAxis = frame.nadir;

  yAxis = rotateAroundAxis(yAxis, xAxis, sensor.rollRad);
  zAxis = rotateAroundAxis(zAxis, xAxis, sensor.rollRad);
  xAxis = rotateAroundAxis(xAxis, yAxis, sensor.pitchRad);
  zAxis = rotateAroundAxis(zAxis, yAxis, sensor.pitchRad);
  xAxis = rotateAroundAxis(xAxis, zAxis, sensor.yawRad);
  yAxis = rotateAroundAxis(yAxis, zAxis, sensor.yawRad);

  return {
    x: normalize(xAxis),
    y: normalize(yAxis),
    z: normalize(zAxis),
  };
}

function buildConicalDirections(axes, sensor) {
  const sampleCount = Math.max(
    16,
    Math.ceil((Math.PI * 2.0) / Math.max(sensor.angularResolutionRad, 1e-3)),
  );
  const directions = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const angle = (index / sampleCount) * Math.PI * 2.0;
    const lateral = add(
      scale(axes.x, Math.cos(angle)),
      scale(axes.y, Math.sin(angle)),
    );
    directions.push(
      normalize(
        add(
          scale(axes.z, Math.cos(sensor.halfAngleRad)),
          scale(lateral, Math.sin(sensor.halfAngleRad)),
        ),
      ),
    );
  }
  return directions;
}

function buildRectangularDirections(axes, sensor) {
  const halfAlong = sensor.alongTrackFovRad * 0.5;
  const halfCross = sensor.crossTrackFovRad * 0.5;
  const alongSamples = Math.max(
    3,
    Math.ceil(
      sensor.alongTrackFovRad / Math.max(sensor.angularResolutionRad, 1e-3),
    ) + 1,
  );
  const crossSamples = Math.max(
    3,
    Math.ceil(
      sensor.crossTrackFovRad / Math.max(sensor.angularResolutionRad, 1e-3),
    ) + 1,
  );
  const directions = [];

  const pushDirection = (alongAngle, crossAngle) => {
    directions.push(
      normalize(
        add(
          add(axes.z, scale(axes.x, Math.tan(alongAngle))),
          scale(axes.y, Math.tan(crossAngle)),
        ),
      ),
    );
  };

  for (let index = 0; index < alongSamples; index += 1) {
    const t = alongSamples === 1 ? 0.5 : index / (alongSamples - 1);
    const alongAngle = -halfAlong + t * sensor.alongTrackFovRad;
    pushDirection(alongAngle, -halfCross);
  }
  for (let index = 1; index < crossSamples - 1; index += 1) {
    const t = index / (crossSamples - 1);
    const crossAngle = -halfCross + t * sensor.crossTrackFovRad;
    pushDirection(halfAlong, crossAngle);
  }
  for (let index = alongSamples - 1; index >= 0; index -= 1) {
    const t = alongSamples === 1 ? 0.5 : index / (alongSamples - 1);
    const alongAngle = -halfAlong + t * sensor.alongTrackFovRad;
    pushDirection(alongAngle, halfCross);
  }
  for (let index = crossSamples - 2; index > 0; index -= 1) {
    const t = index / (crossSamples - 1);
    const crossAngle = -halfCross + t * sensor.crossTrackFovRad;
    pushDirection(-halfAlong, crossAngle);
  }

  return directions;
}

function buildCustomDirections(axes, sensor) {
  if (
    !Array.isArray(sensor.customDirections) ||
    sensor.customDirections.length === 0
  ) {
    return buildConicalDirections(axes, sensor);
  }
  return sensor.customDirections.map((direction) =>
    normalize(
      add(
        add(scale(axes.x, direction.x), scale(axes.y, direction.y)),
        scale(axes.z, direction.z),
      ),
    ),
  );
}

function buildRayDirections(frame, sensor) {
  const axes = composeSensorAxes(frame, sensor);
  if (sensor.sensorType === "rectangular") {
    return buildRectangularDirections(axes, sensor);
  }
  if (sensor.sensorType === "custom") {
    return buildCustomDirections(axes, sensor);
  }
  return buildConicalDirections(axes, sensor);
}

function projectRayToEllipsoid(ray) {
  const origin = ray.origin;
  const direction = normalize(ray.direction);
  const scaledOrigin = {
    x: origin.x / WGS84_A,
    y: origin.y / WGS84_A,
    z: origin.z / WGS84_B,
  };
  const scaledDirection = {
    x: direction.x / WGS84_A,
    y: direction.y / WGS84_A,
    z: direction.z / WGS84_B,
  };
  const a =
    scaledDirection.x * scaledDirection.x +
    scaledDirection.y * scaledDirection.y +
    scaledDirection.z * scaledDirection.z;
  const b =
    2.0 *
    (scaledOrigin.x * scaledDirection.x +
      scaledOrigin.y * scaledDirection.y +
      scaledOrigin.z * scaledDirection.z);
  const c =
    scaledOrigin.x * scaledOrigin.x +
    scaledOrigin.y * scaledOrigin.y +
    scaledOrigin.z * scaledOrigin.z -
    1.0;
  const discriminant = b * b - 4.0 * a * c;
  if (discriminant < 0.0) {
    return { hit: false };
  }
  const sqrtDiscriminant = Math.sqrt(discriminant);
  let t = (-b - sqrtDiscriminant) / (2.0 * a);
  if (t < 0.0) {
    t = (-b + sqrtDiscriminant) / (2.0 * a);
    if (t < 0.0) {
      return { hit: false };
    }
  }
  const position = add(origin, scale(direction, t));
  return {
    hit: true,
    position,
    cartographic: ecefToGeodetic(position),
    distance: magnitude(scale(direction, t)),
  };
}

function computeLVLHFrame(state) {
  const radial = normalize(state.position);
  const velocityProjection = subtract(
    state.velocity,
    scale(radial, dot(state.velocity, radial)),
  );
  const alongTrack =
    magnitude(velocityProjection) > 0.0
      ? normalize(velocityProjection)
      : normalize(cross({ x: 0.0, y: 0.0, z: 1.0 }, radial));
  const crossTrack = normalize(cross(radial, alongTrack));
  return {
    radial,
    alongTrack,
    crossTrack,
    nadir: scale(radial, -1.0),
  };
}

function computeFootprint(state, sensorConfig) {
  const sensor = normalizeSensorConfig(sensorConfig);
  const frame = computeLVLHFrame(state);
  const directions = buildRayDirections(frame, sensor);
  const subpoint = ecefToGeodetic(scale(normalize(state.position), WGS84_A));
  const vertices = [];

  directions.forEach((direction, index) => {
    const intersection = projectRayToEllipsoid({
      origin: state.position,
      direction,
    });
    if (!intersection.hit) {
      return;
    }
    const range =
      intersection.distance ??
      magnitude(subtract(intersection.position, state.position));
    if (range < sensor.minRangeM || range > sensor.maxRangeM) {
      return;
    }
    const cartographic = intersection.cartographic;
    const lookAngle = Math.acos(
      clamp(
        dot(
          frame.nadir,
          normalize(subtract(intersection.position, state.position)),
        ),
        -1.0,
        1.0,
      ),
    );
    vertices.push({
      longitude: cartographic.longitude,
      latitude: cartographic.latitude,
      altitude: cartographic.altitude,
      julianDate: Number(state.julianDate ?? 0.0),
      groundRange: haversineDistance(subpoint, cartographic),
      lookAngle,
      flags: 0x03,
      vertexIndex: index,
    });
  });

  return { vertices };
}

function computeGroundTrack(states) {
  const track = states.map((state) => {
    const cartographic = ecefToGeodetic(state.position);
    return {
      julianDate: Number(state.julianDate ?? 0.0),
      longitude: cartographic.longitude,
      latitude: cartographic.latitude,
      altitude: cartographic.altitude,
      heading: 0.0,
      speed: 0.0,
      flags: 0,
    };
  });

  for (let index = 0; index < track.length; index += 1) {
    const current = track[index];
    const next =
      track[Math.min(index + 1, track.length - 1)] ??
      track[Math.max(index - 1, 0)];
    const prev = track[Math.max(index - 1, 0)] ?? next;
    const reference = next === current ? prev : next;
    current.heading = headingBetween(current, reference);
    const deltaDays = Math.abs(
      Number(reference.julianDate ?? 0.0) - Number(current.julianDate ?? 0.0),
    );
    const deltaSeconds = Math.max(deltaDays * 86400.0, 1e-6);
    current.speed = haversineDistance(current, reference) / deltaSeconds;
  }

  return track;
}

function pointInFootprint(state, sensorConfig, target) {
  const point = normalizeTarget(target);
  const footprint = computeFootprint(state, sensorConfig);
  return pointInPolygon(point, footprint.vertices);
}

function computeAccessGeometry(state, sensorConfig, target) {
  const normalizedTarget = normalizeTarget(target);
  const targetPosition = geodeticToEcef(
    normalizedTarget.longitude,
    normalizedTarget.latitude,
    normalizedTarget.altitude,
  );
  const sensorToTarget = subtract(targetPosition, state.position);
  const targetToSensor = subtract(state.position, targetPosition);
  const range = magnitude(sensorToTarget);
  const sensorToTargetUnit = normalize(sensorToTarget);
  const targetToSensorUnit = normalize(targetToSensor);
  const targetEnu = createEnuFrame(
    normalizedTarget.longitude,
    normalizedTarget.latitude,
  );
  const east = dot(targetToSensorUnit, targetEnu.east);
  const north = dot(targetToSensorUnit, targetEnu.north);
  const up = dot(targetToSensorUnit, targetEnu.up);
  const elevation = Math.asin(clamp(up, -1.0, 1.0));
  let azimuth = Math.atan2(east, north);
  if (azimuth < 0.0) {
    azimuth += Math.PI * 2.0;
  }
  const frame = computeLVLHFrame(state);
  const lookAngle = Math.acos(
    clamp(dot(frame.nadir, sensorToTargetUnit), -1.0, 1.0),
  );
  const insideFootprint = pointInFootprint(
    state,
    sensorConfig,
    normalizedTarget,
  );
  return {
    range,
    elevation,
    azimuth,
    slantRange: range,
    lookAngle,
    isVisible: insideFootprint,
    isOccluded: false,
  };
}

function computeSwath(states, sensorConfig, options = {}) {
  const normalizedStates = Array.isArray(states) ? states : [];
  const groundTrack = computeGroundTrack(normalizedStates);
  const segments = [];
  const vertices = [];
  const maxVerticesPerSide = Number(
    options.maxVerticesPerSide ?? sensorConfig?.maxVerticesPerSide,
  );

  normalizedStates.forEach((state, index) => {
    const footprint = computeFootprint(state, sensorConfig).vertices;
    const frame = computeLVLHFrame(state);
    const centerTrack = groundTrack[index];
    const subpoint = geodeticToEcef(
      centerTrack.longitude,
      centerTrack.latitude,
      0.0,
    );

    const leftVertices = [];
    const rightVertices = [];
    for (const vertex of footprint) {
      const vertexPosition = geodeticToEcef(
        vertex.longitude,
        vertex.latitude,
        vertex.altitude,
      );
      const offset = subtract(vertexPosition, subpoint);
      const along = dot(offset, frame.alongTrack);
      const crossTrack = dot(offset, frame.crossTrack);
      const decorated = {
        ...vertex,
        _alongTrack: along,
        _crossTrack: crossTrack,
      };
      if (crossTrack <= 0.0) {
        leftVertices.push(decorated);
      } else {
        rightVertices.push(decorated);
      }
    }

    if (leftVertices.length === 0 && footprint.length > 0) {
      leftVertices.push({
        ...footprint[0],
        _alongTrack: 0.0,
        _crossTrack: 0.0,
      });
    }
    if (rightVertices.length === 0 && footprint.length > 1) {
      rightVertices.push({
        ...footprint[footprint.length - 1],
        _alongTrack: 0.0,
        _crossTrack: 0.0,
      });
    }

    leftVertices.sort((left, right) => left._alongTrack - right._alongTrack);
    rightVertices.sort((left, right) => left._alongTrack - right._alongTrack);
    const optimizedLeftVertices = decimateVertices(
      leftVertices,
      maxVerticesPerSide,
    );
    const optimizedRightVertices = decimateVertices(
      rightVertices,
      maxVerticesPerSide,
    );

    const leftVertexStart = vertices.length;
    vertices.push(
      ...optimizedLeftVertices.map(
        ({ _alongTrack, _crossTrack, ...vertex }) => vertex,
      ),
    );
    const rightVertexStart = vertices.length;
    vertices.push(
      ...optimizedRightVertices.map(
        ({ _alongTrack, _crossTrack, ...vertex }) => vertex,
      ),
    );

    segments.push({
      startTime: Number(state.julianDate ?? 0.0),
      endTime: Number(
        normalizedStates[index + 1]?.julianDate ?? state.julianDate ?? 0.0,
      ),
      centerLon: centerTrack.longitude,
      centerLat: centerTrack.latitude,
      leftVertexStart,
      leftVertexCount: optimizedLeftVertices.length,
      rightVertexStart,
      rightVertexCount: optimizedRightVertices.length,
      leftVertices: optimizedLeftVertices.map(
        ({ _alongTrack, _crossTrack, ...vertex }) => vertex,
      ),
      rightVertices: optimizedRightVertices.map(
        ({ _alongTrack, _crossTrack, ...vertex }) => vertex,
      ),
    });
  });

  return {
    segments,
    vertices,
    groundTrack,
  };
}

function encodeFootprint(vertices) {
  const bytes = new Uint8Array(16 + vertices.length * FOOTPRINT_VERTEX_SIZE);
  writeUint32(bytes, 0, vertices.length);
  writeUint32(bytes, 4, FOOTPRINT_VERTEX_SIZE);
  vertices.forEach((vertex, index) => {
    const base = 16 + index * FOOTPRINT_VERTEX_SIZE;
    writeFloat64(bytes, base, vertex.longitude);
    writeFloat64(bytes, base + 8, vertex.latitude);
    writeFloat64(bytes, base + 16, vertex.altitude);
    writeFloat64(bytes, base + 24, vertex.julianDate);
    writeFloat64(bytes, base + 32, vertex.groundRange);
    writeFloat64(bytes, base + 40, vertex.lookAngle);
    writeUint32(bytes, base + 48, vertex.flags ?? 0);
    writeUint32(bytes, base + 52, vertex.vertexIndex ?? index);
  });
  return bytes;
}

function encodeGroundTrack(points) {
  const bytes = new Uint8Array(16 + points.length * GROUND_TRACK_POINT_SIZE);
  writeUint32(bytes, 0, points.length);
  writeUint32(bytes, 4, GROUND_TRACK_POINT_SIZE);
  points.forEach((point, index) => {
    const base = 16 + index * GROUND_TRACK_POINT_SIZE;
    writeFloat64(bytes, base, point.julianDate);
    writeFloat64(bytes, base + 8, point.longitude);
    writeFloat64(bytes, base + 16, point.latitude);
    writeFloat64(bytes, base + 24, point.altitude);
    writeFloat64(bytes, base + 32, point.heading);
    writeFloat64(bytes, base + 40, point.speed);
    writeUint32(bytes, base + 48, point.flags ?? 0);
  });
  return bytes;
}

function encodeSwath(swath) {
  const bytes = new Uint8Array(
    32 +
      swath.segments.length * SWATH_SEGMENT_SIZE +
      swath.vertices.length * FOOTPRINT_VERTEX_SIZE,
  );
  writeUint32(bytes, 0, swath.segments.length);
  writeUint32(bytes, 4, swath.vertices.length);
  writeUint32(bytes, 8, SWATH_SEGMENT_SIZE);
  writeUint32(bytes, 12, FOOTPRINT_VERTEX_SIZE);
  swath.segments.forEach((segment, index) => {
    const base = 32 + index * SWATH_SEGMENT_SIZE;
    writeFloat64(bytes, base, segment.startTime);
    writeFloat64(bytes, base + 8, segment.endTime);
    writeFloat64(bytes, base + 16, segment.centerLon);
    writeFloat64(bytes, base + 24, segment.centerLat);
    writeUint32(bytes, base + 32, segment.leftVertexStart);
    writeUint32(bytes, base + 36, segment.leftVertexCount);
    writeUint32(bytes, base + 40, segment.rightVertexStart);
    writeUint32(bytes, base + 44, segment.rightVertexCount);
  });
  swath.vertices.forEach((vertex, index) => {
    const base =
      32 +
      swath.segments.length * SWATH_SEGMENT_SIZE +
      index * FOOTPRINT_VERTEX_SIZE;
    writeFloat64(bytes, base, vertex.longitude);
    writeFloat64(bytes, base + 8, vertex.latitude);
    writeFloat64(bytes, base + 16, vertex.altitude);
    writeFloat64(bytes, base + 24, vertex.julianDate ?? 0.0);
    writeFloat64(bytes, base + 32, vertex.groundRange ?? 0.0);
    writeFloat64(bytes, base + 40, vertex.lookAngle ?? 0.0);
    writeUint32(bytes, base + 48, vertex.flags ?? 0);
    writeUint32(bytes, base + 52, vertex.vertexIndex ?? index);
  });
  return bytes;
}

function encodeContainmentResult(inside) {
  const bytes = new Uint8Array(16);
  writeUint32(bytes, 0, inside ? 1 : 0);
  return bytes;
}

function encodeAccessGeometry(geometry) {
  const bytes = new Uint8Array(64);
  writeFloat64(bytes, 0, geometry.range);
  writeFloat64(bytes, 8, geometry.elevation);
  writeFloat64(bytes, 16, geometry.azimuth);
  writeFloat64(bytes, 24, geometry.slantRange);
  writeFloat64(bytes, 32, geometry.lookAngle);
  writeUint32(bytes, 48, geometry.isVisible ? 1 : 0);
  writeUint32(bytes, 52, geometry.isOccluded ? 1 : 0);
  return bytes;
}

function normalizeBinaryInput(input = {}) {
  const bytes =
    input.bytes ?? input.payloadBytes ?? input.data ?? input.payload ?? null;
  if (bytes instanceof Uint8Array) {
    return bytes;
  }
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (bytes instanceof ArrayBuffer) {
    return new Uint8Array(bytes);
  }
  throw new Error(
    "Swath streamInvoke expects aligned binary Uint8Array or ArrayBuffer inputs.",
  );
}

function createStreamOutput(bytes, portId = "results", input = {}) {
  return {
    portId,
    typeRef: input.typeRef ?? null,
    alignment: input.alignment ?? 8,
    streamId: input.streamId ?? 0,
    sequence: input.sequence ?? 0n,
    traceToken: input.traceToken ?? 0n,
    endOfStream: false,
    bytes,
    payloadBytes: bytes,
  };
}

function invokeSwathStream(methodId, inputs = []) {
  const input = inputs[0] ?? {};
  const bytes = normalizeBinaryInput(input);

  switch (methodId) {
    case "project_footprint": {
      const state = decodeState(bytes, 0);
      const sensor = decodeSensor(bytes, STATE_RECORD_SIZE);
      const result = computeFootprint(state, sensor);
      return {
        statusCode: 0,
        outputs: [
          createStreamOutput(
            encodeFootprint(result.vertices),
            "results",
            input,
          ),
        ],
        backlogRemaining: 0,
        yielded: false,
      };
    }
    case "ground_track": {
      const states = decodeStateBatch(bytes, 0);
      const result = computeGroundTrack(states);
      return {
        statusCode: 0,
        outputs: [
          createStreamOutput(encodeGroundTrack(result), "results", input),
        ],
        backlogRemaining: 0,
        yielded: false,
      };
    }
    case "generate_swath": {
      const count = readUint32(bytes, 0);
      const sensor = decodeSensor(bytes, 16);
      const states = [];
      let cursor = 16 + SENSOR_RECORD_SIZE;
      for (let index = 0; index < count; index += 1) {
        states.push(decodeState(bytes, cursor));
        cursor += STATE_RECORD_SIZE;
      }
      const result = computeSwath(states, sensor);
      return {
        statusCode: 0,
        outputs: [createStreamOutput(encodeSwath(result), "results", input)],
        backlogRemaining: 0,
        yielded: false,
      };
    }
    case "point_in_footprint": {
      const state = decodeState(bytes, 0);
      const sensor = decodeSensor(bytes, STATE_RECORD_SIZE);
      const target = decodeTarget(
        bytes,
        STATE_RECORD_SIZE + SENSOR_RECORD_SIZE,
      );
      const inside = pointInFootprint(state, sensor, target);
      return {
        statusCode: 0,
        outputs: [
          createStreamOutput(encodeContainmentResult(inside), "results", input),
        ],
        backlogRemaining: 0,
        yielded: false,
      };
    }
    case "access_geometry": {
      const state = decodeState(bytes, 0);
      const sensor = decodeSensor(bytes, STATE_RECORD_SIZE);
      const target = decodeTarget(
        bytes,
        STATE_RECORD_SIZE + SENSOR_RECORD_SIZE,
      );
      const geometry = computeAccessGeometry(state, sensor, target);
      return {
        statusCode: 0,
        outputs: [
          createStreamOutput(encodeAccessGeometry(geometry), "results", input),
        ],
        backlogRemaining: 0,
        yielded: false,
      };
    }
    default:
      return {
        statusCode: -1,
        outputs: [],
        backlogRemaining: 0,
        yielded: false,
        errorMessage: `Unknown swath stream method: ${methodId}`,
      };
  }
}

export function getSwathManifest() {
  return STATIC_MANIFEST;
}

export async function loadSwathPlugin(options = {}) {
  if (options?.requireEmbeddedManifest === true) {
    return createSwathAnalyzer(options);
  }
  return createSwathAnalyzer(options);
}

export async function createSwathAnalyzer(options = {}) {
  if (options?.requireEmbeddedManifest === true) {
    // This runtime is authored as a built-in JS plugin but presents the same
    // embedded manifest contract surface as the protected WASM plugins.
  }

  let destroyed = false;
  const module = Object.freeze({ runtime: "swath-js" });

  return {
    type: "Analysis",
    name: STATIC_METADATA.name,
    version: STATIC_METADATA.version,
    metadata: STATIC_METADATA,
    manifest: STATIC_MANIFEST,
    manifestSource: EMBEDDED_MANIFEST_SOURCE,
    module,
    supportsStreamInvoke: true,

    computeLVLHFrame(state) {
      return computeLVLHFrame(state);
    },

    projectRayToEllipsoid(ray) {
      return projectRayToEllipsoid(ray);
    },

    computeFootprint(state, sensorConfig) {
      return computeFootprint(state, sensorConfig);
    },

    computeGroundTrack(states) {
      return computeGroundTrack(states);
    },

    pointInFootprint(state, sensorConfig, target) {
      return pointInFootprint(state, sensorConfig, target);
    },

    computeAccessGeometry(state, sensorConfig, target) {
      return computeAccessGeometry(state, sensorConfig, target);
    },

    computeSwath(states, sensorConfig, options = {}) {
      return computeSwath(states, sensorConfig, options);
    },

    streamInvoke({ methodId, inputs = [] } = {}) {
      return invokeSwathStream(methodId, inputs);
    },

    isDestroyed() {
      return destroyed;
    },

    destroy() {
      destroyed = true;
    },
  };
}

export function createSwathFlowMethodHandlers(analyzer) {
  return createSwathFlowMethodHandlersRuntime(analyzer);
}

export const metadata = STATIC_METADATA;

export default createSwathAnalyzer;
