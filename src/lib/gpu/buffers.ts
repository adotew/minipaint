import { COPY_BYTES_PER_ROW_ALIGNMENT, FLOATS_PER_STAMP, MAX_STAMPS_PER_FRAME } from "../core/constants";

export function createStampBuffer(dev: GPUDevice) {
  return dev.createBuffer({
    size: FLOATS_PER_STAMP * MAX_STAMPS_PER_FRAME * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
}

export function createStampUniformBuffer(dev: GPUDevice, width: number, height: number) {
  const buffer = dev.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  dev.queue.writeBuffer(buffer, 0, new Float32Array([width, height, 0, 0]));
  return buffer;
}

export function createViewUniformBuffer(dev: GPUDevice) {
  return dev.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
}

export function createEyedropperReadBuffer(dev: GPUDevice) {
  return dev.createBuffer({
    size: COPY_BYTES_PER_ROW_ALIGNMENT,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
}
