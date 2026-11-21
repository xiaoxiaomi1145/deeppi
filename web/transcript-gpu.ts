export interface HistorySample {
  id: string;
  toolCount: number;
  hasError: boolean;
  active: boolean;
}

export interface HistoryPoint extends HistorySample {
  index: number;
  density: number;
}

export interface HistoryCanvasLike {
  width: number;
  height: number;
  clientWidth?: number;
  clientHeight?: number;
  getContext(contextId: string): unknown;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export interface HistoryNavigatorOptions {
  points: readonly HistorySample[];
  onSelect?: (id: string, index: number) => void;
}

export interface HistoryNavigator {
  update(points: readonly HistorySample[]): void;
  destroy(): void;
}

export const HISTORY_WGSL = /* wgsl */ `
struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec3<f32>,
};

@vertex
fn vertexMain(
  @location(0) position: vec2<f32>,
  @location(1) density: f32,
  @location(2) color: vec3<f32>,
) -> VertexOut {
  var out: VertexOut;
  out.position = vec4<f32>(position, 0.0, 1.0);
  out.color = color * (0.72 + density * 0.28);
  return out;
}

@fragment
fn fragmentMain(@location(0) color: vec3<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(color, 1.0);
}
`;

const VERTEX_BUFFER_USAGE = 0x20 | 0x08;

interface GpuBufferLike {
  destroy(): void;
}

interface GpuPassLike {
  setPipeline(pipeline: unknown): void;
  setVertexBuffer(slot: number, buffer: GpuBufferLike): void;
  draw(vertexCount: number): void;
  end(): void;
}

interface GpuEncoderLike {
  beginRenderPass(descriptor: unknown): GpuPassLike;
  finish(): unknown;
}

interface GpuDeviceLike {
  createShaderModule(descriptor: { code: string }): unknown;
  createRenderPipeline(descriptor: unknown): unknown;
  createBuffer(descriptor: { size: number; usage: number }): GpuBufferLike;
  createCommandEncoder(): GpuEncoderLike;
  queue: {
    writeBuffer(buffer: GpuBufferLike, offset: number, data: ArrayBuffer): void;
    submit(commands: readonly unknown[]): void;
  };
  lost?: Promise<{ reason?: string; message?: string }>;
  destroy?(): void;
}

interface GpuAdapterLike {
  requestDevice(): Promise<GpuDeviceLike>;
}

interface GpuCanvasContextLike {
  configure(config: { device: GpuDeviceLike; format: string; alphaMode: 'premultiplied' }): void;
  getCurrentTexture(): { createView(): unknown };
}

interface GpuApiLike {
  requestAdapter(): Promise<GpuAdapterLike | null>;
  getPreferredCanvasFormat(): string;
}

interface Canvas2dLike {
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  fillStyle: string;
}

function getGpuApi(): GpuApiLike | undefined {
  const globalNavigator = (globalThis as unknown as { navigator?: { gpu?: GpuApiLike } }).navigator;
  return globalNavigator?.gpu;
}

export function clampHistoryIndex(index: number, length: number) {
  if (length <= 0) return -1;
  return Math.min(length - 1, Math.max(0, Math.round(index)));
}

export function buildHistoryPoints(samples: readonly HistorySample[]): HistoryPoint[] {
  const maxTools = samples.reduce((maximum, sample) => Math.max(maximum, sample.toolCount), 0);
  return samples.map((sample, index) => ({
    ...sample,
    index,
    density: maxTools === 0 ? 0 : Math.min(1, Math.max(0, sample.toolCount / maxTools)),
  }));
}

function pointsKey(points: readonly HistoryPoint[]) {
  return points.map((point) => `${point.id}:${point.toolCount}:${point.hasError ? 1 : 0}:${point.active ? 1 : 0}`).join('|');
}

function canvasSize(canvas: HistoryCanvasLike) {
  return {
    width: canvas.clientWidth && canvas.clientWidth > 0 ? canvas.clientWidth : canvas.width || 1,
    height: canvas.clientHeight && canvas.clientHeight > 0 ? canvas.clientHeight : canvas.height || 1,
  };
}

function renderCanvas2d(context: Canvas2dLike, canvas: HistoryCanvasLike, points: readonly HistoryPoint[]) {
  const { width, height } = canvasSize(canvas);
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  const gap = Math.max(1, Math.min(3, width / Math.max(24, points.length * 5)));
  const barWidth = Math.max(2, (width - gap * Math.max(0, points.length - 1)) / Math.max(1, points.length));
  const baseline = height - 2;
  for (const point of points) {
    const x = point.index * (barWidth + gap);
    const barHeight = Math.max(3, (height - 5) * (0.15 + point.density * 0.85));
    context.fillStyle = point.hasError ? '#c35e63' : point.active ? '#4a83c7' : '#8c9aaa';
    context.fillRect(x, baseline - barHeight, barWidth, barHeight);
  }
}

function makeVertices(points: readonly HistoryPoint[]) {
  const vertices: number[] = [];
  const count = Math.max(1, points.length);
  for (const point of points) {
    const center = -1 + ((point.index + 0.5) * 2) / count;
    const halfWidth = Math.max(0.008, 0.72 / count);
    const bottom = -0.92;
    const top = bottom + Math.max(0.04, point.density * 1.72);
    const color = point.hasError ? [0.76, 0.26, 0.3] : point.active ? [0.28, 0.52, 0.8] : [0.48, 0.57, 0.67];
    const a = [center - halfWidth, bottom, point.density, ...color];
    const b = [center + halfWidth, bottom, point.density, ...color];
    const c = [center + halfWidth, top, point.density, ...color];
    const d = [center - halfWidth, top, point.density, ...color];
    vertices.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return new Float32Array(vertices);
}

function samePoints(left: readonly HistoryPoint[], right: readonly HistoryPoint[]) {
  return pointsKey(left) === pointsKey(right);
}

export function createHistoryNavigator(canvas: HistoryCanvasLike, options: HistoryNavigatorOptions): HistoryNavigator {
  let points = buildHistoryPoints(options.points);
  let destroyed = false;
  let canvasContext: Canvas2dLike | null = null;
  let canvasListener: ((event: Event) => void) | null = null;
  let device: GpuDeviceLike | null = null;
  let buffer: GpuBufferLike | null = null;
  let pipeline: unknown;
  let gpuContext: GpuCanvasContextLike | null = null;
  let gpuFormat = '';

  function handlePointer(event: Event) {
    if (!options.onSelect || points.length === 0) return;
    const pointer = event as PointerEvent;
    const x = pointer.offsetX ?? 0;
    const { width } = canvasSize(canvas);
    const index = clampHistoryIndex((x / Math.max(1, width)) * points.length - 0.5, points.length);
    if (index >= 0) options.onSelect(points[index].id, index);
  }

  function activateCanvasFallback() {
    if (destroyed || canvasContext) return;
    const context = canvas.getContext('2d') as Canvas2dLike | null;
    if (!context) return;
    canvasContext = context;
    renderCanvas2d(canvasContext, canvas, points);
  }

  function releaseGpu() {
    buffer?.destroy();
    buffer = null;
    device?.destroy?.();
    device = null;
    pipeline = undefined;
    gpuContext = null;
  }

  function renderGpu() {
    if (destroyed || !device || !pipeline || !gpuContext) return;
    const vertices = makeVertices(points);
    buffer?.destroy();
    buffer = device.createBuffer({ size: Math.max(4, vertices.byteLength), usage: VERTEX_BUFFER_USAGE });
    device.queue.writeBuffer(buffer, 0, vertices.buffer);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: gpuContext.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, buffer);
    pass.draw(vertices.length / 6);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  async function activateGpu() {
    const gpu = getGpuApi();
    if (!gpu || destroyed) return false;
    const adapter = await gpu.requestAdapter();
    if (!adapter || destroyed) return false;
    const nextDevice = await adapter.requestDevice();
    if (destroyed) {
      nextDevice.destroy?.();
      return false;
    }
    device = nextDevice;
    const context = canvas.getContext('webgpu') as GpuCanvasContextLike | null;
    if (!context) {
      releaseGpu();
      return false;
    }
    const format = gpu.getPreferredCanvasFormat();
    context.configure({ device: nextDevice, format, alphaMode: 'premultiplied' });
    const shader = nextDevice.createShaderModule({ code: HISTORY_WGSL });
    const nextPipeline = nextDevice.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: shader,
        entryPoint: 'vertexMain',
        buffers: [{
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32' },
            { shaderLocation: 2, offset: 12, format: 'float32x3' },
          ],
        }],
      },
      fragment: { module: shader, entryPoint: 'fragmentMain', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    pipeline = nextPipeline;
    gpuContext = context;
    gpuFormat = format;
    renderGpu();
    nextDevice.lost?.then(() => {
      if (!destroyed && device === nextDevice) {
        releaseGpu();
        activateCanvasFallback();
      }
    }).catch(() => {
      if (!destroyed && device === nextDevice) {
        releaseGpu();
        activateCanvasFallback();
      }
    });
    return Boolean(gpuFormat);
  }

  const gpu = getGpuApi();
  canvasListener = handlePointer;
  canvas.addEventListener('pointerdown', canvasListener);
  if (gpu) {
    void activateGpu().then((ready) => {
      if (!ready && !destroyed) activateCanvasFallback();
    }).catch(() => {
      if (!destroyed) {
        releaseGpu();
        activateCanvasFallback();
      }
    });
  } else {
    activateCanvasFallback();
  }

  return {
    update(nextSamples) {
      const nextPoints = buildHistoryPoints(nextSamples);
      if (samePoints(points, nextPoints)) return;
      points = nextPoints;
      if (canvasContext) renderCanvas2d(canvasContext, canvas, points);
      else renderGpu();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (canvasListener) canvas.removeEventListener('pointerdown', canvasListener);
      canvasListener = null;
      canvasContext = null;
      releaseGpu();
    },
  };
}
