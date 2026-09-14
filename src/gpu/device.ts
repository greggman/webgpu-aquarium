// WebGPU adapter/device creation and error reporting.

export interface DevHooks {
  errors: string[];
  ready: Promise<void>;
  frame: number;
  [key: string]: unknown;
}

declare global {
  interface Window {
    __aquarium: DevHooks;
  }
}

let resolveReady: () => void;
window.__aquarium = {
  errors: [],
  ready: new Promise<void>(r => (resolveReady = r)),
  frame: 0,
};

export function markReady() {
  resolveReady();
}

/** Report an error so it shows up in puppeteer (console), on screen, and in dev hooks. */
export function reportError(msg: string) {
  console.error(msg);
  window.__aquarium.errors.push(msg);
  const el = document.getElementById('errors');
  if (el) {
    el.hidden = false;
    // Avoid flooding the overlay with a repeated per-frame validation error.
    if (el.textContent!.split('\n').length < 60) {
      el.textContent += msg + '\n';
    }
  }
}

export interface Gpu {
  adapter: GPUAdapter;
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  features: {
    timestampQuery: boolean;
    float32Filterable: boolean;
    rg11b10Renderable: boolean;
  };
  info: GPUAdapterInfo;
}

export async function initGPU(canvas: HTMLCanvasElement): Promise<Gpu> {
  if (!navigator.gpu) {
    throw new Error('WebGPU is not supported in this browser.');
  }
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance',
  });
  if (!adapter) {
    throw new Error('No WebGPU adapter available.');
  }

  const want: GPUFeatureName[] = [
    'timestamp-query',
    'float32-filterable',
    'rg11b10ufloat-renderable',
  ];
  const requiredFeatures = want.filter(f => adapter.features.has(f));

  // Only ask for defaults; everything is designed to fit the WebGPU default
  // limits so the same code runs on phones.
  const device = await adapter.requestDevice({
    label: 'aquarium:device',
    requiredFeatures,
  });

  device.addEventListener('uncapturederror', ev => {
    reportError(`[WebGPU] ${(ev as GPUUncapturedErrorEvent).error.message}`);
  });
  void device.lost.then(info => {
    reportError(`[WebGPU] device lost (${info.reason}): ${info.message}`);
  });

  enforceLabels(device);

  const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
  if (!context) {
    throw new Error('Could not get a webgpu canvas context.');
  }
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({device, format, alphaMode: 'opaque'});

  return {
    adapter,
    device,
    context,
    format,
    features: {
      timestampQuery: device.features.has('timestamp-query'),
      float32Filterable: device.features.has('float32-filterable'),
      rg11b10Renderable: device.features.has('rg11b10ufloat-renderable'),
    },
    info: adapter.info,
  };
}

/** Reports an error for every WebGPU object created without a label. */
function enforceLabels(device: GPUDevice) {
  const check = (kind: string, desc?: GPUObjectDescriptorBase) => {
    if (!desc?.label) {
      reportError(`[labels] unlabeled ${kind}\n${new Error().stack}`);
    }
  };
  const methods = [
    'createBuffer',
    'createTexture',
    'createSampler',
    'createBindGroupLayout',
    'createPipelineLayout',
    'createBindGroup',
    'createShaderModule',
    'createComputePipeline',
    'createRenderPipeline',
    'createComputePipelineAsync',
    'createRenderPipelineAsync',
    'createQuerySet',
  ] as const;
  type AnyFn = (...args: unknown[]) => unknown;
  const dev = device as unknown as Record<string, AnyFn>;
  for (const name of methods) {
    const orig = dev[name].bind(device);
    dev[name] = (desc: unknown) => {
      check(name, desc as GPUObjectDescriptorBase);
      return orig(desc);
    };
  }
  const origEncoder = device.createCommandEncoder.bind(device);
  device.createCommandEncoder = (desc?: GPUCommandEncoderDescriptor) => {
    check('createCommandEncoder', desc);
    const encoder = origEncoder(desc);
    const enc = encoder as unknown as Record<string, AnyFn>;
    for (const name of ['beginRenderPass', 'beginComputePass', 'finish']) {
      const orig = enc[name].bind(encoder);
      enc[name] = (d?: unknown) => {
        check(name, d as GPUObjectDescriptorBase);
        return orig(d);
      };
    }
    return encoder;
  };
}

/** Creates a shader module and reports compilation messages with its label. */
export function createShader(
  device: GPUDevice,
  label: string,
  code: string,
): GPUShaderModule {
  const module = device.createShaderModule({label, code});
  void module.getCompilationInfo().then(info => {
    const lines = code.split('\n');
    for (const m of info.messages) {
      const src = m.lineNum > 0 ? `\n  > ${lines[m.lineNum - 1]}` : '';
      const text = `[shader ${label}] ${m.type} at ${m.lineNum}:${m.linePos}: ${m.message}${src}`;
      if (m.type === 'error') {
        reportError(text);
      } else {
        console.warn(text);
      }
    }
  });
  return module;
}
