import { MAX_ZOOM, MIN_ZOOM } from "../core/constants";

export type ViewState = {
  zoom: number;
  offsetX: number;
  offsetY: number;
};

export function screenToCanvas(screenX: number, screenY: number, view: ViewState) {
  return {
    x: screenX / view.zoom + view.offsetX,
    y: screenY / view.zoom + view.offsetY,
  };
}

export function applyZoomAt(view: ViewState, factor: number, cursorX: number, cursorY: number): ViewState {
  const oldZoom = view.zoom;
  const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldZoom * factor));
  if (newZoom === oldZoom) return view;

  return {
    zoom: newZoom,
    offsetX: view.offsetX + cursorX * (1 / oldZoom - 1 / newZoom),
    offsetY: view.offsetY + cursorY * (1 / oldZoom - 1 / newZoom),
  };
}

export function fitDocumentToViewport(
  viewportWidth: number,
  viewportHeight: number,
  documentWidth: number,
  documentHeight: number,
): ViewState {
  const zoom = Math.min(
    MAX_ZOOM,
    Math.max(MIN_ZOOM, Math.min(viewportWidth / documentWidth, viewportHeight / documentHeight)),
  );
  const visibleWidth = viewportWidth / zoom;
  const visibleHeight = viewportHeight / zoom;
  return {
    zoom,
    offsetX: (documentWidth - visibleWidth) / 2,
    offsetY: (documentHeight - visibleHeight) / 2,
  };
}

export function zoomToActualSize(): ViewState {
  return {
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
  };
}

export function panView(
  panStart: { clientX: number; clientY: number; offsetX: number; offsetY: number },
  clientX: number,
  clientY: number,
  zoom: number,
) {
  return {
    offsetX: panStart.offsetX - (clientX - panStart.clientX) / zoom,
    offsetY: panStart.offsetY - (clientY - panStart.clientY) / zoom,
  };
}
