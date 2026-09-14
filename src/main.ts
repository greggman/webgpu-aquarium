import {initGPU, markReady, reportError} from './gpu/device.ts';

async function main() {
  const canvas = document.getElementById('screen') as HTMLCanvasElement;
  const gpu = await initGPU(canvas);
  const {device, context} = gpu;

  const frame = () => {
    const encoder = device.createCommandEncoder({label: 'frame:encoder'});
    const pass = encoder.beginRenderPass({
      label: 'frame:clear-pass',
      colorAttachments: [
        {
          view: context.getCurrentTexture(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0.02, 0.2, 0.3, 1],
        },
      ],
    });
    pass.end();
    device.queue.submit([encoder.finish({label: 'frame:commands'})]);
    window.__aquarium.frame++;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  document.getElementById('loading')!.style.opacity = '0';
  markReady();
}

main().catch(e => reportError(`[fatal] ${e?.stack ?? e}`));
