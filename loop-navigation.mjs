export function validateLoopManifest(data) {
  if (!data || data.closed !== true) throw new Error('Loop manifest must declare closed: true.');
  if (!Number.isFinite(data.durationSeconds) || data.durationSeconds <= 0) throw new Error('Loop durationSeconds must be positive.');
  if (data.residentRadius !== undefined && ![1, 2].includes(data.residentRadius)) throw new Error('Loop residentRadius must be 1 or 2.');
  if (data.sceneMode !== undefined && !['nearby', 'complete'].includes(data.sceneMode)) throw new Error('Loop sceneMode must be nearby or complete.');
  if (!Array.isArray(data.up) || data.up.length !== 3 || !data.up.every(Number.isFinite) || Math.hypot(...data.up) < 1e-8) throw new Error('Loop up must be a non-zero three-value vector.');
  const frames = data.camera_path;
  if (!Array.isArray(frames) || frames.length < 2) throw new Error('Loop camera_path needs at least two frames.');
  for (const [i, frame] of frames.entries()) {
    if (!Array.isArray(frame?.camera_to_world) || frame.camera_to_world.length !== 16 || !frame.camera_to_world.every(Number.isFinite) || !Number.isFinite(frame.fov) || frame.fov <= 0 || frame.fov >= 180) throw new Error('Loop camera_path has an invalid frame at ' + i + '.');
  }
  if (!Array.isArray(data.chunks) || data.chunks.length < 1) throw new Error('Loop manifest needs at least one chunk.');
  const ids = new Set();
  for (const chunk of data.chunks) {
    if (!chunk || typeof chunk.id !== 'string' || !chunk.id || ids.has(chunk.id)) throw new Error('Chunk ids must be unique non-empty strings.');
    ids.add(chunk.id);
    if (typeof chunk.url !== 'string' || !chunk.url || !Array.isArray(chunk.matrix) || chunk.matrix.length !== 16 || !chunk.matrix.every(Number.isFinite)) throw new Error('Chunk "' + chunk.id + '" needs a URL and a 16-value world matrix.');
    if (!Number.isInteger(chunk.startFrame) || !Number.isInteger(chunk.endFrame) || chunk.startFrame < 0 || chunk.endFrame < chunk.startFrame || chunk.endFrame >= frames.length) throw new Error('Chunk "' + chunk.id + '" has an invalid core frame range.');
  }
  for (let frame = 0; frame < frames.length; frame++) if (!data.chunks.some(chunk => frame >= chunk.startFrame && frame <= chunk.endFrame)) throw new Error('Chunk core ranges do not cover frame ' + frame + '.');
  return true;
}

export function wrappedFrameIndex(frame, frameCount) {
  if (!Number.isInteger(frameCount) || frameCount < 1) throw new Error('frameCount must be a positive integer.');
  return ((Math.round(frame) % frameCount) + frameCount) % frameCount;
}

export function chunkIndexForFrame(chunks, frame, frameCount) {
  const f = frameCount ? wrappedFrameIndex(frame, frameCount) : Math.max(0, Math.round(frame));
  return chunks.findIndex(chunk => f >= chunk.startFrame && f <= chunk.endFrame);
}

export function chunkNeighborhood(chunks, frame, frameCount, radius = 1) {
  if (!Array.isArray(chunks) || !chunks.length) return [];
  const i = chunkIndexForFrame(chunks, frame, frameCount);
  if (i < 0) return [];
  const indices = new Set([i]);
  for (let distance = 1; distance <= radius; distance++) {
    indices.add(((i - distance) % chunks.length + chunks.length) % chunks.length);
    indices.add((i + distance) % chunks.length);
  }
  return [...indices].map(index => chunks[index]);
}

export function selectSceneChunks(chunks, sceneMode, frame, heldId, frameCount, maxResident, radius = 1) {
  if (sceneMode === 'complete') return [...chunks];
  return transitionChunkSet(chunks, frame, heldId, frameCount, maxResident, radius);
}

export function sceneReady(sceneMode, chunks, loadedIds, frame, frameCount) {
  return sceneMode === 'complete'
    ? chunks.every(chunk => loadedIds.has(chunk.id))
    : hasFrameCoverage(chunks, frame, loadedIds, frameCount);
}

export function transitionChunkSet(chunks, frame, heldId, frameCount, maxResident = 3, radius = 1) {
  const neighborhood = chunkNeighborhood(chunks, frame, frameCount, radius);
  const core = chunks[chunkIndexForFrame(chunks, frame, frameCount)];
  if (!core) return [];
  const held = chunks.find(chunk => chunk.id === heldId);
  const ordered = [core, ...(held && held.id !== core.id ? [held] : []), ...neighborhood.filter(chunk => chunk.id !== core.id && chunk.id !== held?.id)];
  return ordered.slice(0, Math.max(1, maxResident));
}

export function createLoadTransitionState(frame = 0) { return { currentFrame: frame, pendingFrame: null }; }
export function requestLoadTransition(state, frame, loaded) {
  if (loaded(frame)) { state.currentFrame = frame; state.pendingFrame = null; return true; }
  state.pendingFrame = frame; return false;
}
export function resolveLoadTransition(state, loaded) {
  if (state.pendingFrame === null || !loaded(state.pendingFrame)) return null;
  state.currentFrame = state.pendingFrame; state.pendingFrame = null; return state.currentFrame;
}
export function failLoadTransition(state, frame) {
  if (state.pendingFrame === null || frame === undefined || Math.round(state.pendingFrame) === Math.round(frame)) { state.pendingFrame = null; return true; }
  return false;
}

export function hasFrameCoverage(chunks, frame, loadedIds, frameCount) {
  const chunk = chunks[chunkIndexForFrame(chunks, frame, frameCount)];
  return !!chunk && loadedIds.has(chunk.id);
}

export function nearestPathHeight(xz, points) {
  if (!Array.isArray(points) || points.length === 0) throw new Error('A captured path needs at least one point.');
  if (points.length === 1) return points[0][1];
  const [x, z] = xz; let bestDistanceSq = Infinity, bestHeight = points[0][1];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], dx = b[0] - a[0], dz = b[2] - a[2], lengthSq = dx * dx + dz * dz;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / lengthSq));
    const nearX = a[0] + t * dx, nearZ = a[2] + t * dz, distanceSq = (x - nearX) ** 2 + (z - nearZ) ** 2;
    if (distanceSq < bestDistanceSq) { bestDistanceSq = distanceSq; bestHeight = a[1] + t * (b[1] - a[1]); }
  }
  return bestHeight;
}

export function nearestPathFrame(xz, points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  const [x, z] = xz; let bestDistanceSq = Infinity, bestFrame = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], dx = b[0] - a[0], dz = b[2] - a[2], lengthSq = dx * dx + dz * dz;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / lengthSq));
    const nearX = a[0] + t * dx, nearZ = a[2] + t * dz, distanceSq = (x - nearX) ** 2 + (z - nearZ) ** 2;
    if (distanceSq < bestDistanceSq) { bestDistanceSq = distanceSq; bestFrame = (i + t) % points.length; }
  }
  return bestFrame;
}

export function closedPathLength(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return total;
}
